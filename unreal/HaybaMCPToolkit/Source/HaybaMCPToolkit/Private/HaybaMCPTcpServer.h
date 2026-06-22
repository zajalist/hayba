#pragma once

#include "CoreMinimal.h"
#include "HAL/Runnable.h"
#include "HAL/ThreadSafeBool.h"
#include "Containers/Queue.h"
#include "Containers/Ticker.h"
#include "Networking.h"

class FHaybaMCPCommandHandler;

/**
 * Shared owner of a single client socket. Both the background read loop and
 * any in-flight game-thread response task hold a reference, so the socket is
 * only Close()/DestroySocket()'d once the LAST reference drops. `bAlive` goes
 * false the moment the client disconnects, so a late response task skips the
 * send instead of writing to a freed socket (the access-violation crash).
 */
struct FHaybaMCPClientConnection
{
	explicit FHaybaMCPClientConnection(FSocket* InSocket) : Socket(InSocket) {}
	~FHaybaMCPClientConnection();

	FSocket* Socket = nullptr;
	FThreadSafeBool bAlive{ true };
	FCriticalSection SendMutex;
};

using FHaybaMCPClientConnectionPtr = TSharedPtr<FHaybaMCPClientConnection, ESPMode::ThreadSafe>;

/** A received command awaiting execution on the game thread. */
struct FHaybaMCPPendingCommand
{
	FString Message;
	FHaybaMCPClientConnectionPtr Conn;
};

class FHaybaMCPTcpServer : public FRunnable
{
public:
	FHaybaMCPTcpServer(int32 InPort);
	virtual ~FHaybaMCPTcpServer();

	/**
	 * Inject the command handler the TCP thread should route requests to.
	 * Must be called BEFORE Start(); otherwise Start() falls back to a fresh
	 * handler with no domain handlers registered (every command returns
	 * "Unknown command"). Module::StartTcpServer() is responsible for wiring
	 * its fully-registered handler in.
	 */
	void SetCommandHandler(TSharedPtr<FHaybaMCPCommandHandler> InHandler) { CommandHandler = InHandler; }

	bool Start();
	void Shutdown();
	bool IsRunning() const { return bIsRunning; }
	int32 GetClientCount() const { return ClientCount.GetValue(); }

	// FRunnable interface
	virtual uint32 Run() override;
	virtual void Stop() override { bIsRunning = false; }
	virtual void Exit() override {}

private:
	int32 Port;
	FRunnableThread* Thread = nullptr;
	FSocket* ListenSocket = nullptr;
	TSharedPtr<FHaybaMCPCommandHandler> CommandHandler;
	// Read by the listener thread (Run) and connection threads, written by
	// Shutdown/Stop on the game thread — must be thread-safe (a plain bool is a
	// data race the compiler may hoist, never seeing shutdown).
	FThreadSafeBool bIsRunning{ false };
	FThreadSafeCounter ClientCount;

	// Commands run on the game thread via a TICKER drain (not AsyncTask). Running
	// inside an AsyncTask(GameThread) *task* makes any handler that itself pumps
	// the game-thread task graph (e.g. python_run -> Interchange asset import)
	// re-enter task-graph processing -> check(RecursionGuard==1) crash. A ticker
	// runs in the normal engine tick, outside task-graph task execution, so such
	// work is safe. Connection (background) threads enqueue; the ticker drains.
	TQueue<FHaybaMCPPendingCommand, EQueueMode::Mpsc> PendingCommands;
	FTSTicker::FDelegateHandle DrainTickerHandle;
	bool DrainPendingCommands(float DeltaTime);

	void HandleClientConnection(FHaybaMCPClientConnectionPtr Conn);
	bool ReadMessage(FSocket* Socket, FString& OutMessage);
	void SendMessage(const FHaybaMCPClientConnectionPtr& Conn, const FString& Message);
};
