#include "HaybaMCPTcpServer.h"
#include "HaybaMCPCommandHandler.h"
#include "HaybaMCPThreading.h"
#include "Async/Async.h"                      // for ::AsyncTask onto background pool only
#include "Serialization/JsonSerializer.h"
#include "SocketSubsystem.h"
#include "IPAddress.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPTCP, Log, All);

FHaybaMCPConnection::~FHaybaMCPConnection()
{
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

    if (!CommandHandler.IsValid())
    {
        UE_LOG(LogHaybaMCPTCP, Warning,
            TEXT("TcpServer started without an injected CommandHandler — all commands will return Unknown."));
        CommandHandler = MakeShareable(new FHaybaMCPCommandHandler());
    }

    ListenSocket = FTcpSocketBuilder(TEXT("HaybaMCPListener"))
        .AsReusable()
        .BoundToAddress(FIPv4Address(127, 0, 0, 1))
        .BoundToPort(Port)
        .Listening(4);

    if (!ListenSocket)
    {
        UE_LOG(LogHaybaMCPTCP, Error, TEXT("Failed to create TCP listener on port %d"), Port);
        return false;
    }

    bIsRunning = true;
    Thread = FRunnableThread::Create(this, TEXT("HaybaMCPTCPServer"), 0, TPri_Normal);

    UE_LOG(LogHaybaMCPTCP, Log, TEXT("TCP server started on port %d"), Port);
    return true;
}

void FHaybaMCPTcpServer::Shutdown()
{
    if (!bIsRunning) return;

    bIsRunning = false;

    if (Thread)
    {
        Thread->WaitForCompletion();
        delete Thread;
        Thread = nullptr;
    }

    if (ListenSocket)
    {
        ListenSocket->Close();
        ISocketSubsystem::Get(PLATFORM_SOCKETSUBSYSTEM)->DestroySocket(ListenSocket);
        ListenSocket = nullptr;
    }

    // Drop all connection state. Each entry's destructor closes its FSocket
    // exactly once. Worker threads that were inside ReadMessage will get
    // FindConnState returning null on their next iteration and bail.
    {
        FScopeLock Lock(&ConnTableLock);
        ConnTable.Empty();
    }

    UE_LOG(LogHaybaMCPTCP, Log, TEXT("TCP server stopped"));
}

void FHaybaMCPTcpServer::RegisterConn(const TSharedPtr<FHaybaMCPConnection>& Conn)
{
    if (!Conn.IsValid() || !Conn->Socket) return;
    FScopeLock Lock(&ConnTableLock);
    ConnTable.Add(Conn->Socket, Conn);
}

TSharedPtr<FHaybaMCPConnection> FHaybaMCPTcpServer::FindConnState(FSocket* Socket) const
{
    if (!Socket) return nullptr;
    FScopeLock Lock(&ConnTableLock);
    if (const TSharedPtr<FHaybaMCPConnection>* Found = ConnTable.Find(Socket))
    {
        return *Found;
    }
    return nullptr;
}

void FHaybaMCPTcpServer::UnregisterConn(FSocket* Socket)
{
    if (!Socket) return;
    FScopeLock Lock(&ConnTableLock);
    ConnTable.Remove(Socket);
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
                const int32 NewCount = ClientCount.Increment();
                UE_LOG(LogHaybaMCPTCP, Log, TEXT("Client accepted (active: %d)"), NewCount);

                // Register lifetime state under the socket key BEFORE we dispatch
                // the worker. The wire-facing HandleClientConnection takes the
                // raw FSocket* (ABI-stable for Live Coding); it looks up its
                // own lifetime state internally.
                TSharedPtr<FHaybaMCPConnection> Conn = MakeShared<FHaybaMCPConnection>(ClientSocket);
                RegisterConn(Conn);
                // Worker dispatch stays on a background thread (this is the
                // ONE place we use the engine's background-task pool). The
                // worker then funnels game-thread work through
                // HaybaThreading::RunOnGameThreadAndWait instead of raw
                // AsyncTask(GameThread).
                ::AsyncTask(ENamedThreads::AnyBackgroundThreadNormalTask, [this, ClientSocket]()
                {
                    HandleClientConnection(ClientSocket);
                });
            }
        }
    }
    return 0;
}

void FHaybaMCPTcpServer::HandleClientConnection(FSocket* ClientSocket)
{
    // Pin a strong ref for the entire worker loop. If we don't, a slow
    // game-thread response could be the only remaining ref by the time the
    // worker's next ReadMessage iteration runs.
    TSharedPtr<FHaybaMCPConnection> ConnRef = FindConnState(ClientSocket);
    if (!ConnRef.IsValid())
    {
        UE_LOG(LogHaybaMCPTCP, Warning, TEXT("HandleClientConnection called for socket with no registered conn state — bail"));
        return;
    }

    while (bIsRunning && ConnRef.IsValid() && ConnRef->bAlive)
    {
        FString Message;
        if (!ReadMessage(ClientSocket, Message))
        {
            const int32 NewCount = ClientCount.Decrement();
            UE_LOG(LogHaybaMCPTCP, Log, TEXT("Client disconnected (active: %d)"), NewCount);
            ConnRef->bAlive = false;
            UnregisterConn(ClientSocket);
            // ConnRef going out of scope drops the worker's strong ref. If
            // any game-thread lambda still holds one, the FSocket survives
            // until that lambda finishes. Otherwise destructor runs now and
            // closes + destroys the socket cleanly.
            return;
        }

        // Capture the SHARED REF (not the raw socket pointer) into the
        // closure by value — the closure owns a strong ref so the
        // FSocket can't be freed under it even if the worker observes
        // disconnect in the meantime.
        TSharedPtr<FHaybaMCPConnection> ConnForLambda = ConnRef;

        // RunOnGameThreadAndWait routes through the OnEndFrame-driven
        // dispatcher in HaybaThreading instead of UE's TaskGraph queue.
        // The dispatcher runs OUTSIDE any TaskGraph processing window,
        // so handlers can themselves enqueue more game-thread work
        // (notifications, panel updates, etc.) without re-entering the
        // RecursionGuard and crashing the editor. Per-connection
        // serialisation is preserved: the worker blocks on the wait
        // until the closure completes, and only then reads the next
        // message. Timeout of 0 = wait forever (heavy editor ops can
        // take many seconds; a timeout would leak the in-flight closure
        // onto the next Drain while we read the next message).
        HaybaThreading::RunOnGameThreadAndWait([this, Message, ConnForLambda]()
        {
            if (!CommandHandler.IsValid()) return;
            FString ResponseString = CommandHandler->ProcessCommand(Message);
            if (ConnForLambda.IsValid() && ConnForLambda->bAlive && ConnForLambda->Socket)
            {
                SendMessage(ConnForLambda->Socket, ResponseString);
            }
        }, /*TimeoutSeconds=*/ 0.0);
    }
}

bool FHaybaMCPTcpServer::ReadMessage(FSocket* Socket, FString& OutMessage)
{
    // ABI-stable wire-facing function: do not change this signature without a
    // full plugin rebuild. The 2026-05-23 EXCEPTION_ACCESS_VIOLATION at
    // this exact line was caused by a Live Coding patch that changed the
    // parameter from FSocket* to TSharedPtr<>, leaving stale worker
    // threads reinterpreting an FSocket* as a TSharedPtr and deref'ing
    // garbage. Lifetime is now tracked internally via FindConnState so the
    // signature can stay stable indefinitely.
    if (!Socket) return false;
    TSharedPtr<FHaybaMCPConnection> Conn = FindConnState(Socket);
    if (!Conn.IsValid() || !Conn->bAlive) return false;

    uint8 Header[4];
    int32 HeaderBytesRead = 0;

    while (HeaderBytesRead < 4)
    {
        int32 BytesRead = 0;
        if (!Socket->Recv(Header + HeaderBytesRead, 4 - HeaderBytesRead, BytesRead))
        {
            return false;
        }
        HeaderBytesRead += BytesRead;
    }

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
    int32 TotalBytesRead = 0;

    while (TotalBytesRead < static_cast<int32>(MessageLength))
    {
        int32 BytesRead = 0;
        if (!Socket->Recv(Buffer.GetData() + TotalBytesRead, MessageLength - TotalBytesRead, BytesRead))
        {
            return false;
        }
        TotalBytesRead += BytesRead;
    }

    Buffer[MessageLength] = 0;
    OutMessage = UTF8_TO_TCHAR(Buffer.GetData());
    return true;
}

void FHaybaMCPTcpServer::SendMessage(FSocket* Socket, const FString& Message)
{
    // ABI-stable. See ReadMessage comment.
    if (!Socket) return;
    TSharedPtr<FHaybaMCPConnection> Conn = FindConnState(Socket);
    if (!Conn.IsValid() || !Conn->bAlive) return;

    // Serialize concurrent writes. Game-thread response lambdas for the same
    // connection could in principle queue back-to-back; without this lock
    // the 4-byte header + body of a response could interleave with another
    // response's header.
    FScopeLock WriteLock(&Conn->SendLock);
    if (!Conn->bAlive) return;

    FTCHARToUTF8 Utf8Msg(*Message);
    uint32 Length = Utf8Msg.Length();

    uint8 Header[4];
    Header[0] = (Length >> 24) & 0xFF;
    Header[1] = (Length >> 16) & 0xFF;
    Header[2] = (Length >> 8) & 0xFF;
    Header[3] = Length & 0xFF;

    int32 BytesSent = 0;
    const bool bHeaderOk = Socket->Send(Header, 4, BytesSent) && BytesSent == 4;
    if (!bHeaderOk)
    {
        UE_LOG(LogHaybaMCPTCP, Verbose, TEXT("SendMessage: header write failed; marking conn dead"));
        Conn->bAlive = false;
        return;
    }
    const bool bBodyOk = Socket->Send(reinterpret_cast<const uint8*>(Utf8Msg.Get()), Length, BytesSent) && BytesSent == static_cast<int32>(Length);
    if (!bBodyOk)
    {
        UE_LOG(LogHaybaMCPTCP, Verbose, TEXT("SendMessage: body write failed; marking conn dead"));
        Conn->bAlive = false;
    }
}
