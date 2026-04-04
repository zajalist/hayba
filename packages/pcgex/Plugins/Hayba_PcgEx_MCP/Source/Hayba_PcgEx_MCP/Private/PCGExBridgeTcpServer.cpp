#include "PCGExBridgeTcpServer.h"
#include "PCGExBridgeCommandHandler.h"
#include "Async/Async.h"
#include "Serialization/JsonSerializer.h"
#include "SocketSubsystem.h"
#include "IPAddress.h"

DEFINE_LOG_CATEGORY_STATIC(LogPCGExBridgeTCP, Log, All);

FPCGExBridgeTcpServer::FPCGExBridgeTcpServer(int32 InPort)
    : Port(InPort)
{
}

FPCGExBridgeTcpServer::~FPCGExBridgeTcpServer()
{
    Shutdown();
}

bool FPCGExBridgeTcpServer::Start()
{
    if (IsRunning())
    {
        UE_LOG(LogPCGExBridgeTCP, Warning, TEXT("TCP server already running on port %d"), Port);
        return false;
    }

    // Initialize command handler
    CommandHandler = MakeShareable(new FPCGExBridgeCommandHandler());

    ListenSocket = FTcpSocketBuilder(TEXT("PCGExBridgeListener"))
        .AsReusable()
        .BoundToAddress(FIPv4Address(127, 0, 0, 1))
        .BoundToPort(Port)
        .Listening(4);

    if (!ListenSocket)
    {
        UE_LOG(LogPCGExBridgeTCP, Error, TEXT("Failed to create TCP listener on port %d"), Port);
        return false;
    }

    bIsRunning = true;
    Thread = FRunnableThread::Create(this, TEXT("PCGExBridgeTCPServer"), 0, TPri_Normal);

    UE_LOG(LogPCGExBridgeTCP, Log, TEXT("TCP server started on port %d"), Port);
    return true;
}

void FPCGExBridgeTcpServer::Shutdown()
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

    UE_LOG(LogPCGExBridgeTCP, Log, TEXT("TCP server stopped"));
}

uint32 FPCGExBridgeTcpServer::Run()
{
    while (bIsRunning)
    {
        bool bHasPending = false;
        ListenSocket->WaitForPendingConnection(bHasPending, FTimespan::FromMilliseconds(100));
        if (bHasPending)
        {
            FSocket* ClientSocket = ListenSocket->Accept(TEXT("PCGExBridgeClient"));
            if (ClientSocket)
            {
                UE_LOG(LogPCGExBridgeTCP, Log, TEXT("Client accepted"));
                AsyncTask(ENamedThreads::AnyBackgroundThreadNormalTask, [this, ClientSocket]()
                {
                    HandleClientConnection(ClientSocket);
                });
            }
        }
    }
    return 0;
}

void FPCGExBridgeTcpServer::HandleClientConnection(FSocket* ClientSocket)
{
    while (bIsRunning)
    {
        FString Message;
        if (!ReadMessage(ClientSocket, Message))
        {
            UE_LOG(LogPCGExBridgeTCP, Log, TEXT("Client disconnected"));
            ClientSocket->Close();
            ISocketSubsystem::Get(PLATFORM_SOCKETSUBSYSTEM)->DestroySocket(ClientSocket);
            return;
        }

        AsyncTask(ENamedThreads::GameThread, [this, Message, ClientSocket]()
        {
            if (CommandHandler.IsValid())
            {
                FString ResponseString = CommandHandler->ProcessCommand(Message);
                SendMessage(ClientSocket, ResponseString);
            }
        });
    }
}

bool FPCGExBridgeTcpServer::ReadMessage(FSocket* Socket, FString& OutMessage)
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

void FPCGExBridgeTcpServer::SendMessage(FSocket* Socket, const FString& Message)
{
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
