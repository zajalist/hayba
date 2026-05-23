#pragma once

#include "CoreMinimal.h"
#include "HAL/Runnable.h"
#include "HAL/CriticalSection.h"
#include "Networking.h"

class FHaybaMCPCommandHandler;

/**
 * Per-connection state, lifetime-managed by TSharedPtr. The worker thread
 * holds a strong ref while the read loop is alive; every dispatched
 * AsyncTask(GameThread) ALSO captures a strong ref by value. The FSocket
 * is destroyed only when the last ref drops, which means the game-thread
 * lambda that responds to a request cannot SendMessage on a freed socket
 * even if the worker thread sees the client close while the request is
 * being processed.
 *
 * This was the root cause of the 2026-05-23 EXCEPTION_ACCESS_VIOLATION at
 * HaybaMCPTcpServer.cpp:123 — see the postmortem at
 * docs/superpowers/specs/2026-05-23-pcg-landscape-mcp-postmortem.md.
 */
struct FHaybaMCPConnection
{
    FSocket*           Socket = nullptr;
    FCriticalSection   SendLock;      // serialize concurrent writes from
                                      // multiple game-thread response lambdas
    bool               bAlive = true; // flipped to false on disconnect

    explicit FHaybaMCPConnection(FSocket* InSocket) : Socket(InSocket) {}
    ~FHaybaMCPConnection();           // closes + destroys Socket exactly once

    FHaybaMCPConnection(const FHaybaMCPConnection&) = delete;
    FHaybaMCPConnection& operator=(const FHaybaMCPConnection&) = delete;
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
	bool bIsRunning = false;
	FThreadSafeCounter ClientCount;

	// All connection-touching helpers take a shared_ptr now, not raw FSocket*.
	void HandleClientConnection(TSharedPtr<FHaybaMCPConnection> Conn);
	bool ReadMessage(const TSharedPtr<FHaybaMCPConnection>& Conn, FString& OutMessage);
	void SendMessage(const TSharedPtr<FHaybaMCPConnection>& Conn, const FString& Message);
};
