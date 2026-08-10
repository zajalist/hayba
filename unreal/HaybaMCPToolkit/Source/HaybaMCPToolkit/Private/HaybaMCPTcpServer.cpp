#include "HaybaMCPTcpServer.h"
#include "HaybaMCPCommandHandler.h"
#include "HaybaMCPFrameReadPolicy.h"
#include "Async/Async.h"
#include "Serialization/JsonSerializer.h"
#include "SocketSubsystem.h"
#include "IPAddress.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPTCP, Log, All);

namespace
{
	constexpr int32 SocketPollMs = 100;
	constexpr int32 SendPollMs = 25;
	constexpr double FrameReadTimeoutSeconds = 5.0;
	constexpr double SendStallTimeoutSeconds = 5.0;
	constexpr double SendTotalTimeoutSeconds = 30.0;
	constexpr int32 MaxCommandsPerTick = 4;
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
        .Listening(4);

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

    UE_LOG(LogHaybaMCPTCP, Log, TEXT("TCP server started on port %d"), Port);
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
		// Wake the listener instead of waiting for its next poll while module
		// teardown is already in progress.
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
					ClientSocket->Close();
					ISocketSubsystem::Get(PLATFORM_SOCKETSUBSYSTEM)->DestroySocket(ClientSocket);
					UE_LOG(LogHaybaMCPTCP, Warning,
						TEXT("Rejected client above active-connection limit %d"), MaxClientConnections);
					continue;
				}
				// Polling non-blocking reads let the connection worker observe
				// shutdown and enforce bounded idle/partial-frame deadlines.
				if (!ClientSocket->SetNonBlocking(true))
				{
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
		// Increment before the reader waits for the next frame. Otherwise a
		// command can be queued just before its old idle deadline and the worker
		// can close the socket before the game-thread handler sends its response.
		Conn->ResponsesPending.Increment();
        PendingCommands.Enqueue(FHaybaMCPPendingCommand{ Message, Conn });
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
	int32 Processed = 0;
    while (Processed < MaxCommandsPerTick && PendingCommands.Dequeue(Cmd))
    {
		++Processed;
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
		ReadStartedAt, FrameReadTimeoutSeconds, Conn->ResponseGeneration.GetValue());

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

    if (MessageLength == 0 || MessageLength > 1024 * 1024)
    {
        return false;
    }

    TArray<uint8> Buffer;
    Buffer.SetNum(MessageLength + 1);
	if (!ReadBounded(Buffer.GetData(), static_cast<int32>(MessageLength))) return false;

    Buffer[MessageLength] = 0;
    OutMessage = UTF8_TO_TCHAR(Buffer.GetData());
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

    uint8 Header[4];
    Header[0] = (Length >> 24) & 0xFF;
    Header[1] = (Length >> 16) & 0xFF;
    Header[2] = (Length >> 8) & 0xFF;
    Header[3] = Length & 0xFF;

	auto SendExact = [this, &Conn, Socket](const uint8* Data, int32 NumBytes) -> bool
	{
		int32 TotalSent = 0;
		FHaybaMCPSendDeadlinePolicy Deadline(
			FPlatformTime::Seconds(), SendStallTimeoutSeconds, SendTotalTimeoutSeconds);
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
