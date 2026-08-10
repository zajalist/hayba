#include "HaybaMCPTcpServer.h"
#include "HaybaMCPCommandHandler.h"
#include "HaybaMCPFrameReadPolicy.h"
#include "HaybaMCPSettings.h"
#include "Async/Async.h"
#include "Serialization/JsonSerializer.h"
#include "SocketSubsystem.h"
#include "IPAddress.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPTCP, Log, All);

namespace
{
    constexpr int32 SocketPollMs = 100;
    constexpr int32 SendPollMs = 25;
    constexpr int32 MaxCommandsPerTick = 4;
    constexpr double MaxDrainSeconds = 0.008;

    // FUTF8ToTCHAR deliberately replaces malformed sequences with the Unicode
    // replacement character. That is friendly for display text and unsafe for
    // a framed command protocol: the bytes authenticated/hashed by a future
    // transport layer must be the exact request the JSON parser sees. Reject
    // overlong forms, surrogate encodings, truncated sequences, out-of-range
    // code points, and embedded NUL before conversion.
    bool HasStrictUtf8(const uint8* Bytes, int32 Length)
    {
        if (!Bytes || Length <= 0) return false;
        int32 I = 0;
        auto IsContinuation = [](uint8 B) { return B >= 0x80 && B <= 0xbf; };
        while (I < Length)
        {
            const uint8 B0 = Bytes[I++];
            if (B0 == 0) return false;
            if (B0 <= 0x7f) continue;

            if (B0 >= 0xc2 && B0 <= 0xdf)
            {
                if (I >= Length || !IsContinuation(Bytes[I])) return false;
                ++I;
                continue;
            }
            if (B0 >= 0xe0 && B0 <= 0xef)
            {
                if (I + 1 >= Length) return false;
                const uint8 B1 = Bytes[I];
                const uint8 B2 = Bytes[I + 1];
                if (!IsContinuation(B2)) return false;
                if (B0 == 0xe0 ? (B1 < 0xa0 || B1 > 0xbf)
                    : B0 == 0xed ? (B1 < 0x80 || B1 > 0x9f)
                                 : !IsContinuation(B1)) return false;
                I += 2;
                continue;
            }
            if (B0 >= 0xf0 && B0 <= 0xf4)
            {
                if (I + 2 >= Length) return false;
                const uint8 B1 = Bytes[I];
                if (B0 == 0xf0 ? (B1 < 0x90 || B1 > 0xbf)
                    : B0 == 0xf4 ? (B1 < 0x80 || B1 > 0x8f)
                                 : !IsContinuation(B1)) return false;
                if (!IsContinuation(Bytes[I + 1]) || !IsContinuation(Bytes[I + 2])) return false;
                I += 3;
                continue;
            }
            return false;
        }
        return true;
    }

    // Lexical, allocation-free preflight before FJsonSerializer's recursive
    // parser. A sub-megabyte payload can still contain tens of thousands of
    // nested arrays/objects and exhaust the game-thread stack. Braces inside
    // strings are ignored, including escaped quotes.
    bool HasSafeJsonNesting(const FString& Text, int32 MaxDepth)
    {
        int32 Depth = 0;
        bool bInString = false;
        bool bEscaped = false;
        for (const TCHAR Ch : Text)
        {
            if (Ch == TEXT('\0')) return false;
            if (bInString)
            {
                if (bEscaped) bEscaped = false;
                else if (Ch == TEXT('\\')) bEscaped = true;
                else if (Ch == TEXT('"')) bInString = false;
                continue;
            }

            if (Ch == TEXT('"'))
            {
                bInString = true;
            }
            else if (Ch == TEXT('{') || Ch == TEXT('['))
            {
                if (++Depth > MaxDepth) return false;
            }
            else if (Ch == TEXT('}') || Ch == TEXT(']'))
            {
                if (--Depth < 0) return false;
            }
        }
        return Depth == 0 && !bInString && !bEscaped;
    }
}

FHaybaMCPClientConnection::FHaybaMCPClientConnection(FSocket* InSocket)
	: Socket(InSocket)
	, AcceptedAtSeconds(FPlatformTime::Seconds())
	, OutboundEvent(FPlatformProcess::GetSynchEventFromPool(false))
{
}

FHaybaMCPClientConnection::~FHaybaMCPClientConnection()
{
	if (OutboundEvent)
	{
		FPlatformProcess::ReturnSynchEventToPool(OutboundEvent);
		OutboundEvent = nullptr;
	}
    if (Socket)
    {
        Socket->Close();
        ISocketSubsystem::Get(PLATFORM_SOCKETSUBSYSTEM)->DestroySocket(Socket);
        Socket = nullptr;
    }
}

FHaybaMCPTcpServer::FHaybaMCPTcpServer(int32 InPort)
    : Port(InPort)
{
}

FHaybaMCPTcpServer::~FHaybaMCPTcpServer()
{
    Shutdown();
}

bool FHaybaMCPTcpServer::Start()
{
    if (IsRunning())
    {
        UE_LOG(LogHaybaMCPTCP, Warning, TEXT("TCP server already running on port %d"), Port);
        return false;
    }

    // Use the injected command handler (registered by the Module with all
    // domain handlers). Fall back to a fresh empty one only as a safety net
    // — this would mean every command returns "Unknown command", which is
    // the long-standing bug this guard is here to make obvious.
    if (!CommandHandler.IsValid())
    {
        UE_LOG(LogHaybaMCPTCP, Warning,
            TEXT("TcpServer started without an injected CommandHandler — all commands will return Unknown."));
        CommandHandler = MakeShareable(new FHaybaMCPCommandHandler());
    }

    const FHaybaMCPSettings& Settings = FHaybaMCPSettings::Get();
    MaxRequestBytes = FMath::Clamp(Settings.TcpMaxRequestBytes, 64 * 1024, 16 * 1024 * 1024);
    MaxResponseBytes = FMath::Clamp(Settings.TcpMaxResponseBytes, 1024 * 1024, 64 * 1024 * 1024);
    MaxClientConnections = FMath::Clamp(Settings.TcpMaxClientConnections, 1, 64);
    MaxPendingCommands = FMath::Clamp(Settings.TcpMaxPendingCommands, 1, 1024);
    MaxJsonNestingDepth = FMath::Clamp(Settings.TcpMaxJsonNestingDepth, 8, 256);
    FrameReadTimeoutMs = FMath::Clamp(Settings.TcpFrameReadTimeoutMs, 500, 30000);
    SendTimeoutMs = FMath::Clamp(Settings.TcpSendTimeoutMs, 100, 30000);
	// Preserve the aggregate per-client outbound budget as well as the limit on
	// each individual response frame. FString character counts never exceed the
	// corresponding UTF-8 byte count, so this is conservative for non-ASCII.
	MaxQueuedResponseCharsPerClient = MaxResponseBytes;

    // Deliberately NOT .AsReusable(): the multi-instance port scan in
    // FHaybaMCPModule::StartTcpServer() depends on Listen() FAILING when the
    // port is already taken by another editor instance, so it can walk
    // forward to the next free port. SO_REUSEADDR on Windows lets a second
    // process bind+listen on an already-listening port without erroring,
    // which silently defeated the whole scan (every instance "won" the same
    // port and only one ever actually received connections).
    ListenSocket = FTcpSocketBuilder(TEXT("HaybaMCPListener"))
        .BoundToAddress(FIPv4Address(127, 0, 0, 1))
        .BoundToPort(Port)
        .Listening(MaxClientConnections);

    if (!ListenSocket)
    {
        UE_LOG(LogHaybaMCPTCP, Error, TEXT("Failed to create TCP listener on port %d"), Port);
        return false;
    }

    bIsRunning = true;

    // Drain queued commands on the game thread from the engine tick (NOT a
    // task-graph task) — see header note: running ProcessCommand inside an
    // AsyncTask(GameThread) task crashes when a handler re-enters the task graph
    // (python_run -> Interchange import: check(RecursionGuard==1)). AddTicker
    // must run on the game thread; Start() is called during game-thread plugin init.
    DrainTickerHandle = FTSTicker::GetCoreTicker().AddTicker(
        FTickerDelegate::CreateRaw(this, &FHaybaMCPTcpServer::DrainPendingCommands), 0.0f);

    Thread = FRunnableThread::Create(this, TEXT("HaybaMCPTCPServer"), 0, TPri_Normal);
    if (!Thread)
    {
        bIsRunning = false;
        FTSTicker::GetCoreTicker().RemoveTicker(DrainTickerHandle);
        DrainTickerHandle.Reset();
        ListenSocket->Close();
        ISocketSubsystem::Get(PLATFORM_SOCKETSUBSYSTEM)->DestroySocket(ListenSocket);
        ListenSocket = nullptr;
        UE_LOG(LogHaybaMCPTCP, Error, TEXT("Failed to create TCP listener thread on port %d"), Port);
        return false;
    }

    UE_LOG(LogHaybaMCPTCP, Log,
        TEXT("TCP server started on port %d (request=%d B, response=%d B, clients=%d, pending=%d, json_depth=%d, read_timeout=%d ms, send_timeout=%d ms)"),
        Port, MaxRequestBytes, MaxResponseBytes, MaxClientConnections,
        MaxPendingCommands, MaxJsonNestingDepth, FrameReadTimeoutMs, SendTimeoutMs);
    return true;
}

void FHaybaMCPTcpServer::Shutdown()
{
    bIsRunning = false;

    if (DrainTickerHandle.IsValid())
    {
        FTSTicker::GetCoreTicker().RemoveTicker(DrainTickerHandle);
        DrainTickerHandle.Reset();
    }

    if (ListenSocket)
    {
        // Closing first wakes WaitForPendingConnection immediately instead of
        // relying on its timeout while the module is trying to unload.
        ListenSocket->Close();
    }

    if (Thread)
    {
        Thread->WaitForCompletion();
        delete Thread;
        Thread = nullptr;
    }

    if (ListenSocket)
    {
        ISocketSubsystem::Get(PLATFORM_SOCKETSUBSYSTEM)->DestroySocket(ListenSocket);
        ListenSocket = nullptr;
    }

	// No new read workers can be added after the listener is joined, and no
	// response workers can be added after the ticker is removed. Read/send loops
	// poll bIsRunning, so each future leaves promptly without raw module access.
	TArray<TFuture<void>> WorkersToJoin;
	{
		FScopeLock Lock(&WorkerMutex);
		WorkersToJoin = MoveTemp(Workers);
	}
	for (TFuture<void>& Worker : WorkersToJoin)
	{
		Worker.Wait();
	}

    // No producer or consumer remains after the listener and exact worker
    // futures are joined. Drain every unexecuted command and balance both
    // reservations so a later Start() cannot inherit phantom pressure.
    FHaybaMCPPendingCommand Discarded;
    while (PendingCommands.Dequeue(Discarded))
    {
        PendingCommandCount.Decrement();
		if (Discarded.Conn.IsValid())
		{
			Discarded.Conn->ResponsesPending.Decrement();
		}
    }

    UE_LOG(LogHaybaMCPTCP, Log, TEXT("TCP server stopped"));
}

uint32 FHaybaMCPTcpServer::Run()
{
    while (bIsRunning)
    {
        bool bHasPending = false;
        ListenSocket->WaitForPendingConnection(bHasPending, FTimespan::FromMilliseconds(100));
        if (bHasPending)
        {
            FSocket* ClientSocket = ListenSocket->Accept(TEXT("HaybaMCPClient"));
            if (ClientSocket)
            {
				if (ClientCount.GetValue() >= MaxClientConnections)
				{
					UE_LOG(LogHaybaMCPTCP, Warning,
						TEXT("Rejecting client: active-connection limit %d reached"),
						MaxClientConnections);
					ClientSocket->Close();
					ISocketSubsystem::Get(PLATFORM_SOCKETSUBSYSTEM)->DestroySocket(ClientSocket);
					continue;
				}
				// Polling non-blocking reads let the connection worker observe
				// shutdown and enforce bounded idle/partial-frame deadlines.
				if (!ClientSocket->SetNonBlocking(true))
				{
					UE_LOG(LogHaybaMCPTCP, Warning,
						TEXT("Rejecting client: could not enable non-blocking I/O"));
					ClientSocket->Close();
					ISocketSubsystem::Get(PLATFORM_SOCKETSUBSYSTEM)->DestroySocket(ClientSocket);
					continue;
				}
				ClientSocket->SetNoDelay(true);
                const int32 NewCount = ClientCount.Increment();
                UE_LOG(LogHaybaMCPTCP, Log, TEXT("Client accepted (active: %d)"), NewCount);
                FHaybaMCPClientConnectionPtr Conn = MakeShared<FHaybaMCPClientConnection, ESPMode::ThreadSafe>(ClientSocket);
				TSharedRef<FHaybaMCPTcpServer, ESPMode::ThreadSafe> Self = AsShared();
				// A bounded reader and serial writer per connection prevent persistent
				// reads from starving response work in the global task pool.
				RetainWorker(Async(EAsyncExecution::Thread, [Self, Conn]()
                {
					Self->HandleClientConnection(Conn);
				}));
				RetainWorker(Async(EAsyncExecution::Thread, [Self, Conn]()
				{
					Self->HandleClientWrites(Conn);
				}));
            }
        }
    }
    return 0;
}

void FHaybaMCPTcpServer::HandleClientConnection(FHaybaMCPClientConnectionPtr Conn)
{
    while (bIsRunning)
    {
        FString Message;
        if (!ReadMessage(Conn, Message))
        {
            // Client disconnected. Mark dead so any in-flight response task
            // skips its send; the socket is destroyed once the last shared
            // reference (this loop + any queued game-thread task) drops.
            Conn->bAlive = false;
			break;
        }
		Conn->RequestsReceived.Increment();
		if (Conn->ResponsesPending.GetValue() >= MaxPipelinedRequestsPerClient)
		{
			UE_LOG(LogHaybaMCPTCP, Warning,
				TEXT("Disconnecting client above pipelined-request limit %d"),
				MaxPipelinedRequestsPerClient);
			break;
		}

        // Enqueue for the game-thread ticker drain (Conn captured by value so the
        // socket outlives this read loop). NOT AsyncTask(GameThread) — see header:
        // running a handler inside a task-graph task crashes when it re-enters the
        // task graph (python_run -> Interchange import).
		const int32 NewPending = PendingCommandCount.Increment();
		if (NewPending > MaxPendingCommands)
		{
			PendingCommandCount.Decrement();
			UE_LOG(LogHaybaMCPTCP, Warning,
				TEXT("Disconnecting client: pending-command limit %d reached"),
				MaxPendingCommands);
			break;
		}
		// Increment before the reader waits for the next frame. Otherwise a
		// command can be queued just before its old idle deadline and the worker
		// can close the socket before the game-thread handler sends its response.
		Conn->ResponsesPending.Increment();
		PendingCommands.Enqueue(FHaybaMCPPendingCommand{ MoveTemp(Message), Conn });
    }

    Conn->bAlive = false;
	if (Conn->Socket)
	{
		Conn->Socket->Shutdown(ESocketShutdownMode::ReadWrite);
	}
	const int32 NewCount = ClientCount.Decrement();
	UE_LOG(LogHaybaMCPTCP, Log, TEXT("Client disconnected (active: %d)"), NewCount);
}

void FHaybaMCPTcpServer::HandleClientWrites(FHaybaMCPClientConnectionPtr Conn)
{
	while (bIsRunning && Conn.IsValid() && Conn->bAlive)
	{
		FString Response;
		if (!Conn->OutboundResponses.Dequeue(Response))
		{
			if (Conn->OutboundEvent)
			{
				Conn->OutboundEvent->Wait(SocketPollMs);
			}
			continue;
		}

		Conn->QueuedResponseChars.Subtract(Response.Len());
		SendMessage(Conn, Response);
		Conn->ResponseGeneration.Increment();
		Conn->ResponsesPending.Decrement();
	}
}

void FHaybaMCPTcpServer::RetainWorker(TFuture<void>&& Worker)
{
	FScopeLock Lock(&WorkerMutex);
	Workers.RemoveAll([](const TFuture<void>& Existing)
	{
		return Existing.IsReady();
	});
	Workers.Add(MoveTemp(Worker));
}

bool FHaybaMCPTcpServer::DrainPendingCommands(float /*DeltaTime*/)
{
    // Runs on the game thread from the engine tick (outside task-graph task
    // execution), so a handler may safely pump the task graph (asset import etc).
    // Drain all pending commands this tick — each command is one game-thread
    // command, matching the historical one-task-per-command behaviour.
    FHaybaMCPPendingCommand Cmd;
    const double Deadline = FPlatformTime::Seconds() + MaxDrainSeconds;
    int32 Processed = 0;
    while (Processed < MaxCommandsPerTick && PendingCommands.Dequeue(Cmd))
    {
        ++Processed;
        PendingCommandCount.Decrement();
		if (!Cmd.Conn.IsValid())
		{
			continue;
		}
		if (!Cmd.Conn->bAlive || !CommandHandler.IsValid())
        {
			Cmd.Conn->ResponsesPending.Decrement();
            continue;
        }
        const FString ResponseString = CommandHandler->ProcessCommand(Cmd.Message);

		// The serial per-connection writer keeps socket backpressure off the
		// game-thread ticker and preserves response order. Bound queued output so
		// a pipelined local peer cannot turn responses into unbounded memory.
		const int32 QueuedChars = Cmd.Conn->QueuedResponseChars.Add(ResponseString.Len());
		if (QueuedChars > MaxQueuedResponseCharsPerClient)
		{
			Cmd.Conn->QueuedResponseChars.Subtract(ResponseString.Len());
			Cmd.Conn->ResponsesPending.Decrement();
			Cmd.Conn->bAlive = false;
			if (Cmd.Conn->Socket)
			{
				Cmd.Conn->Socket->Shutdown(ESocketShutdownMode::ReadWrite);
			}
			UE_LOG(LogHaybaMCPTCP, Warning,
				TEXT("Disconnected client above queued-response budget %d chars"),
				MaxQueuedResponseCharsPerClient);
			continue;
		}
		Cmd.Conn->OutboundResponses.Enqueue(ResponseString);
		if (Cmd.Conn->OutboundEvent)
		{
			Cmd.Conn->OutboundEvent->Trigger();
		}
        if (FPlatformTime::Seconds() >= Deadline)
        {
            break;
        }
    }
    return true; // keep ticking
}

bool FHaybaMCPTcpServer::ReadMessage(const FHaybaMCPClientConnectionPtr& Conn, FString& OutMessage)
{
	if (!Conn.IsValid() || !Conn->Socket)
	{
		return false;
	}
	FSocket* Socket = Conn->Socket;
	// The first idle deadline starts at accept time, not whenever a saturated
	// thread pool eventually schedules this worker. Later waits start now; their
	// response generation then refreshes them after each completed send.
	const double ReadStartedAt = Conn->RequestsReceived.GetValue() == 0
		? Conn->AcceptedAtSeconds
		: FPlatformTime::Seconds();
	FHaybaMCPFrameReadPolicy ReadPolicy(
		ReadStartedAt, static_cast<double>(FrameReadTimeoutMs) / 1000.0,
		Conn->ResponseGeneration.GetValue());

	auto ReadBounded = [this, &Conn, Socket, &ReadPolicy](uint8* Destination, int32 NumBytes) -> bool
	{
		int32 TotalRead = 0;
		while (TotalRead < NumBytes && bIsRunning && Conn->bAlive)
		{
			if (ReadPolicy.ShouldDisconnect(
				FPlatformTime::Seconds(), Conn->ResponsesPending.GetValue() > 0,
				Conn->ResponseGeneration.GetValue()))
			{
				return false;
			}
			if (!Socket->Wait(ESocketWaitConditions::WaitForRead,
				FTimespan::FromMilliseconds(SocketPollMs)))
			{
				if (Socket->GetConnectionState() != SCS_Connected
					|| ReadPolicy.ShouldDisconnect(
						FPlatformTime::Seconds(), Conn->ResponsesPending.GetValue() > 0,
						Conn->ResponseGeneration.GetValue()))
				{
					return false;
				}
				continue;
			}
			if (ReadPolicy.ShouldDisconnect(
				FPlatformTime::Seconds(), Conn->ResponsesPending.GetValue() > 0,
				Conn->ResponseGeneration.GetValue()))
			{
				return false;
			}

			int32 BytesRead = 0;
			if (!Socket->Recv(Destination + TotalRead, NumBytes - TotalRead, BytesRead))
			{
				if (Socket->GetConnectionState() != SCS_Connected)
				{
					return false;
				}
				continue;
			}
			if (BytesRead <= 0)
			{
				return false;
			}
			const double ReceivedAt = FPlatformTime::Seconds();
			// Once a frame started, bytes observed at/after its deadline are late
			// even if WaitForRead returned true just before the cutoff.
			if (ReadPolicy.HasStartedFrame()
				&& ReadPolicy.ShouldDisconnect(ReceivedAt, Conn->ResponsesPending.GetValue() > 0,
					Conn->ResponseGeneration.GetValue()))
			{
				return false;
			}
			ReadPolicy.MarkFrameStarted(ReceivedAt);
			TotalRead += BytesRead;
		}
		return TotalRead == NumBytes;
	};

    uint8 Header[4];
	if (!ReadBounded(Header, UE_ARRAY_COUNT(Header))) return false;

    uint32 MessageLength = (static_cast<uint32>(Header[0]) << 24) |
                           (static_cast<uint32>(Header[1]) << 16) |
                           (static_cast<uint32>(Header[2]) << 8) |
                           static_cast<uint32>(Header[3]);

    if (MessageLength == 0 || MessageLength > static_cast<uint32>(MaxRequestBytes))
    {
        return false;
    }

    TArray<uint8> Buffer;
    Buffer.SetNum(MessageLength + 1);
	if (!ReadBounded(Buffer.GetData(), static_cast<int32>(MessageLength))) return false;

    if (!HasStrictUtf8(Buffer.GetData(), static_cast<int32>(MessageLength)))
    {
        UE_LOG(LogHaybaMCPTCP, Warning, TEXT("Rejecting request with malformed UTF-8 or embedded NUL"));
        return false;
    }

    Buffer[MessageLength] = 0;
    // Use the declared byte length instead of a NUL-terminated macro. An
    // embedded NUL used to truncate the command silently, so the bytes that
    // were authenticated/hashed could differ from what the sender framed.
    const FUTF8ToTCHAR Converted(
        reinterpret_cast<const ANSICHAR*>(Buffer.GetData()),
        static_cast<int32>(MessageLength));
    OutMessage = FString(Converted.Length(), Converted.Get());
    if (!HasSafeJsonNesting(OutMessage, MaxJsonNestingDepth))
    {
        UE_LOG(LogHaybaMCPTCP, Warning,
            TEXT("Rejecting request with invalid structure or JSON nesting deeper than %d"),
            MaxJsonNestingDepth);
        OutMessage.Reset();
        return false;
    }
    return true;
}

bool FHaybaMCPTcpServer::SendMessage(const FHaybaMCPClientConnectionPtr& Conn, const FString& Message)
{
    if (!Conn.IsValid())
    {
		return false;
    }

    // Serialize sends and re-check liveness under the lock: the read loop may
    // have flagged the client dead between the task's guard and here. The
    // shared Conn keeps the socket alive for the duration of this call.
    FScopeLock Lock(&Conn->SendMutex);
    if (!Conn->bAlive || Conn->Socket == nullptr)
    {
		return false;
    }
    FSocket* Socket = Conn->Socket;

    FTCHARToUTF8 Utf8Msg(*Message);
    uint32 Length = Utf8Msg.Length();
    if (Length == 0 || Length > static_cast<uint32>(MaxResponseBytes))
    {
        UE_LOG(LogHaybaMCPTCP, Error,
            TEXT("Refusing response frame of %u bytes (limit %d)"),
            Length, MaxResponseBytes);
        Conn->bAlive = false;
        Socket->Shutdown(ESocketShutdownMode::ReadWrite);
        return false;
    }

    uint8 Header[4];
    Header[0] = (Length >> 24) & 0xFF;
    Header[1] = (Length >> 16) & 0xFF;
    Header[2] = (Length >> 8) & 0xFF;
    Header[3] = Length & 0xFF;

	// The configured timeout is the truthful absolute ceiling for the complete
	// response (header plus payload). Progress also refreshes a shorter stall
	// window, while never extending that absolute ceiling.
	const double SendTotalTimeoutSeconds = static_cast<double>(SendTimeoutMs) / 1000.0;
	const double SendStallTimeoutSeconds = FMath::Min(5.0, SendTotalTimeoutSeconds);
	FHaybaMCPSendDeadlinePolicy Deadline(
		FPlatformTime::Seconds(), SendStallTimeoutSeconds, SendTotalTimeoutSeconds);
	auto SendExact = [this, &Conn, Socket, &Deadline](const uint8* Data, int32 NumBytes) -> bool
	{
		int32 TotalSent = 0;
		while (TotalSent < NumBytes && bIsRunning && Conn->bAlive)
		{
			if (Deadline.ShouldAbort(FPlatformTime::Seconds()))
			{
				return false;
			}
			if (!Socket->Wait(ESocketWaitConditions::WaitForWrite,
				FTimespan::FromMilliseconds(SendPollMs)))
			{
				if (Socket->GetConnectionState() != SCS_Connected
					|| Deadline.ShouldAbort(FPlatformTime::Seconds()))
				{
					return false;
				}
				continue;
			}

			int32 BytesSent = 0;
			if (!Socket->Send(Data + TotalSent, NumBytes - TotalSent, BytesSent))
			{
				if (Socket->GetConnectionState() != SCS_Connected
					|| Deadline.ShouldAbort(FPlatformTime::Seconds()))
				{
					return false;
				}
				continue;
			}
			if (BytesSent <= 0)
			{
				return false;
			}
			TotalSent += BytesSent;
			Deadline.MarkProgress(FPlatformTime::Seconds());
		}
		return TotalSent == NumBytes;
	};

	const bool bSent = SendExact(Header, UE_ARRAY_COUNT(Header))
		&& SendExact(reinterpret_cast<const uint8*>(Utf8Msg.Get()), static_cast<int32>(Length));
	if (!bSent)
    {
		Conn->bAlive = false;
		Socket->Shutdown(ESocketShutdownMode::ReadWrite);
    }
	return bSent;
}
