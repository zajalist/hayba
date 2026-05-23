#include "HaybaMCPTcpServer.h"
#include "HaybaMCPCommandHandler.h"
#include "Async/Async.h"
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

                // Wrap the raw FSocket* in a shared connection state. The
                // worker thread loop holds the first strong ref; every
                // dispatched game-thread response lambda will pin its own
                // strong ref by value. The socket survives until the last
                // ref drops — closing the use-after-free hole that crashed
                // UE in the 2026-05-23 landscape_import session.
                TSharedPtr<FHaybaMCPConnection> Conn = MakeShared<FHaybaMCPConnection>(ClientSocket);
                AsyncTask(ENamedThreads::AnyBackgroundThreadNormalTask, [this, Conn]()
                {
                    HandleClientConnection(Conn);
                });
            }
        }
    }
    return 0;
}

void FHaybaMCPTcpServer::HandleClientConnection(TSharedPtr<FHaybaMCPConnection> Conn)
{
    while (bIsRunning && Conn.IsValid() && Conn->bAlive)
    {
        FString Message;
        if (!ReadMessage(Conn, Message))
        {
            const int32 NewCount = ClientCount.Decrement();
            UE_LOG(LogHaybaMCPTCP, Log, TEXT("Client disconnected (active: %d)"), NewCount);
            // Mark dead so any in-flight game-thread response lambdas
            // skip SendMessage instead of writing into a half-closed
            // socket. The socket itself is destroyed by ~FHaybaMCPConnection
            // when the last strong ref drops (this worker's `Conn` going out
            // of scope, plus any pending response lambdas releasing theirs).
            Conn->bAlive = false;
            return;
        }

        // Capture the shared_ptr BY VALUE — this is the load-bearing fix.
        // The lambda now owns a strong ref to the connection state for the
        // entire duration of the game-thread work. If the worker thread
        // observes a disconnect and returns (releasing its own ref), the
        // socket stays alive until this lambda finishes and releases its
        // copy of the shared_ptr.
        AsyncTask(ENamedThreads::GameThread, [this, Message, Conn]()
        {
            if (!CommandHandler.IsValid()) return;
            FString ResponseString = CommandHandler->ProcessCommand(Message);
            SendMessage(Conn, ResponseString);
        });
    }
}

bool FHaybaMCPTcpServer::ReadMessage(const TSharedPtr<FHaybaMCPConnection>& Conn, FString& OutMessage)
{
    if (!Conn.IsValid() || !Conn->Socket) return false;
    FSocket* Socket = Conn->Socket;

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

void FHaybaMCPTcpServer::SendMessage(const TSharedPtr<FHaybaMCPConnection>& Conn, const FString& Message)
{
    // Three guard clauses before touching the socket:
    //   1. Shared ref is still valid (always true on game thread — the lambda
    //      owns it — but defensive).
    //   2. bAlive flag wasn't flipped by the worker (client disconnected
    //      while game thread was busy).
    //   3. Socket pointer non-null (defensive against partial-init).
    // With these, a use-after-free is no longer possible: even if every other
    // ref were gone, the lambda's own ref keeps the socket alive long enough
    // for our send attempt; even if the client is gone, we no-op instead of
    // poking a freed pointer.
    if (!Conn.IsValid() || !Conn->bAlive || !Conn->Socket) return;

    // Serialize concurrent writes. Game-thread lambdas for the same
    // connection could in principle be queued back-to-back; without this
    // lock the 4-byte header + body of a response could interleave with
    // another response's header.
    FScopeLock WriteLock(&Conn->SendLock);
    if (!Conn->bAlive || !Conn->Socket) return; // re-check after acquiring lock

    FSocket* Socket = Conn->Socket;
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
        // The peer is gone or the OS write buffer is shut. Mark dead so the
        // next read loop iteration tears down cleanly instead of stalling.
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
