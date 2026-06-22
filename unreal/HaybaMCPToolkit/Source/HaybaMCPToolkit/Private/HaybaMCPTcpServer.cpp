#include "HaybaMCPTcpServer.h"
#include "HaybaMCPCommandHandler.h"
#include "Async/Async.h"
#include "Serialization/JsonSerializer.h"
#include "SocketSubsystem.h"
#include "IPAddress.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPTCP, Log, All);

FHaybaMCPClientConnection::~FHaybaMCPClientConnection()
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
    if (!bIsRunning) return;

    bIsRunning = false;

    if (DrainTickerHandle.IsValid())
    {
        FTSTicker::GetCoreTicker().RemoveTicker(DrainTickerHandle);
        DrainTickerHandle.Reset();
    }

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
                const int32 NewCount = ClientCount.Increment();
                UE_LOG(LogHaybaMCPTCP, Log, TEXT("Client accepted (active: %d)"), NewCount);
                FHaybaMCPClientConnectionPtr Conn = MakeShared<FHaybaMCPClientConnection, ESPMode::ThreadSafe>(ClientSocket);
                AsyncTask(ENamedThreads::AnyBackgroundThreadNormalTask, [this, Conn]()
                {
                    HandleClientConnection(Conn);
                });
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
        if (!ReadMessage(Conn->Socket, Message))
        {
            // Client disconnected. Mark dead so any in-flight response task
            // skips its send; the socket is destroyed once the last shared
            // reference (this loop + any queued game-thread task) drops.
            Conn->bAlive = false;
            const int32 NewCount = ClientCount.Decrement();
            UE_LOG(LogHaybaMCPTCP, Log, TEXT("Client disconnected (active: %d)"), NewCount);
            return;
        }

        // Enqueue for the game-thread ticker drain (Conn captured by value so the
        // socket outlives this read loop). NOT AsyncTask(GameThread) — see header:
        // running a handler inside a task-graph task crashes when it re-enters the
        // task graph (python_run -> Interchange import).
        PendingCommands.Enqueue(FHaybaMCPPendingCommand{ Message, Conn });
    }

    // Server is shutting down while this client is still connected.
    Conn->bAlive = false;
    ClientCount.Decrement();
}

bool FHaybaMCPTcpServer::DrainPendingCommands(float /*DeltaTime*/)
{
    // Runs on the game thread from the engine tick (outside task-graph task
    // execution), so a handler may safely pump the task graph (asset import etc).
    // Drain all pending commands this tick — each command is one game-thread
    // command, matching the historical one-task-per-command behaviour.
    FHaybaMCPPendingCommand Cmd;
    while (PendingCommands.Dequeue(Cmd))
    {
        if (!Cmd.Conn.IsValid() || !Cmd.Conn->bAlive || !CommandHandler.IsValid())
        {
            continue;
        }
        const FString ResponseString = CommandHandler->ProcessCommand(Cmd.Message);
        SendMessage(Cmd.Conn, ResponseString);
    }
    return true; // keep ticking
}

bool FHaybaMCPTcpServer::ReadMessage(FSocket* Socket, FString& OutMessage)
{
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

void FHaybaMCPTcpServer::SendMessage(const FHaybaMCPClientConnectionPtr& Conn, const FString& Message)
{
    if (!Conn.IsValid())
    {
        return;
    }

    // Serialize sends and re-check liveness under the lock: the read loop may
    // have flagged the client dead between the task's guard and here. The
    // shared Conn keeps the socket alive for the duration of this call.
    FScopeLock Lock(&Conn->SendMutex);
    if (!Conn->bAlive || Conn->Socket == nullptr)
    {
        return;
    }
    FSocket* Socket = Conn->Socket;

    FTCHARToUTF8 Utf8Msg(*Message);
    uint32 Length = Utf8Msg.Length();

    uint8 Header[4];
    Header[0] = (Length >> 24) & 0xFF;
    Header[1] = (Length >> 16) & 0xFF;
    Header[2] = (Length >> 8) & 0xFF;
    Header[3] = Length & 0xFF;

    int32 BytesSent;
    Socket->Send(Header, 4, BytesSent);
    if (BytesSent == 4)
    {
        Socket->Send(reinterpret_cast<const uint8*>(Utf8Msg.Get()), Length, BytesSent);
    }
}
