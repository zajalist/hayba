#pragma once

#include "CoreMinimal.h"
#include "HAL/Runnable.h"
#include "HAL/CriticalSection.h"
#include "Networking.h"

class FHaybaMCPCommandHandler;

/**
 * Per-connection lifetime state. Owned by FHaybaMCPTcpServer's internal
 * connection table; every dispatched AsyncTask(GameThread) lambda also
 * pins a strong ref to keep the FSocket alive across the worker→game-thread
 * boundary. See FHaybaMCPTcpServer::FindConnState for the lookup pattern.
 *
 * The previous shape of this struct was passed in as a parameter to
 * ReadMessage / SendMessage — that exposed the layout to Live Coding's
 * ABI-stability constraints and caused EXCEPTION_ACCESS_VIOLATION when
 * a stale worker thread (compiled against the old `FSocket*` signature)
 * called a patched function expecting a `TSharedPtr` parameter. We now
 * keep the lifetime bookkeeping ENTIRELY internal to the server (lookup
 * by raw FSocket* pointer key) so the wire-facing function signatures
 * stay byte-for-byte stable across Live Coding patches.
 */
struct FHaybaMCPConnection
{
    FSocket*           Socket = nullptr;
    FCriticalSection   SendLock;
    bool               bAlive = true;

    explicit FHaybaMCPConnection(FSocket* InSocket) : Socket(InSocket) {}
    ~FHaybaMCPConnection();

    FHaybaMCPConnection(const FHaybaMCPConnection&) = delete;
    FHaybaMCPConnection& operator=(const FHaybaMCPConnection&) = delete;
};

class FHaybaMCPTcpServer : public FRunnable
{
public:
	FHaybaMCPTcpServer(int32 InPort);
	virtual ~FHaybaMCPTcpServer();

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

	// Lifetime table keyed by FSocket* — ABI-stable wire-facing functions
	// look up their connection state through here. Game-thread response
	// lambdas pin a strong ref by capturing a TSharedPtr<FHaybaMCPConnection>
	// from FindConnState, NOT by capturing FSocket* directly.
	mutable FCriticalSection ConnTableLock;
	TMap<FSocket*, TSharedPtr<FHaybaMCPConnection>> ConnTable;
	void RegisterConn(const TSharedPtr<FHaybaMCPConnection>& Conn);
	TSharedPtr<FHaybaMCPConnection> FindConnState(FSocket* Socket) const;
	void UnregisterConn(FSocket* Socket);

	// Wire-facing helpers — SIGNATURES MUST NOT CHANGE for Live Coding
	// compatibility. They look up lifetime via FindConnState internally.
	void HandleClientConnection(FSocket* ClientSocket);
	bool ReadMessage(FSocket* Socket, FString& OutMessage);
	void SendMessage(FSocket* Socket, const FString& Message);
};
