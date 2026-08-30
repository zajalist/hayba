#pragma once

#include "CoreMinimal.h"
#include "HAL/Runnable.h"
#include "HAL/ThreadSafeBool.h"
#include "Containers/Queue.h"
#include "Containers/Ticker.h"
#include "Dom/JsonObject.h"
#include "Networking.h"
#include "HaybaMCPJoinableWorker.h"
#include "HaybaMCPTransportPolicy.h"

class FHaybaMCPCommandHandler;

/** A response plus the accepted-request reservation it must complete once. */
struct FHaybaMCPOutboundResponse
{
	FString Message;
	FHaybaMCPCountReservationPtr ResponseReservation;
	FHaybaMCPOutboundBudgetReservationPtr MemoryReservation;
};

/**
 * Shared owner of a single client socket. Both the background read loop and
 * any in-flight game-thread response task hold a reference, so the socket is
 * only Close()/DestroySocket()'d once the LAST reference drops. `bAlive` goes
 * false the moment the client disconnects, so a late response task skips the
 * send instead of writing to a freed socket (the access-violation crash).
 */
struct FHaybaMCPClientConnection
{
	FHaybaMCPClientConnection(
		FSocket* InSocket,
		FHaybaMCPCountReservationPtr InClientReservation,
		int64 InMaxOutboundMemoryBytes);
	~FHaybaMCPClientConnection();

	FSocket* Socket = nullptr;
	FThreadSafeBool bAlive{ true };
	// Number of accepted requests whose response has not finished sending.
	// The reader uses this to distinguish a healthy long-running command from
	// an idle/slow client while it waits for the next frame.
	FThreadSafeCounter ResponsesPending;
	// Incremented before ResponsesPending is cleared, so a descheduled reader
	// cannot miss a complete response lifecycle and reuse a stale idle deadline.
	FThreadSafeCounter ResponseGeneration;
	FThreadSafeCounter RequestsReceived;
	double AcceptedAtSeconds = 0.0;
	FHaybaMCPOutboundBudgetPtr OutboundBudget;
	TQueue<FHaybaMCPOutboundResponse, EQueueMode::Mpsc> OutboundResponses;
	FEvent* OutboundEvent = nullptr;
	FCriticalSection SendMutex;
	// Both the reader and serial writer occupy this client slot. The second one
	// to finish releases it; destruction covers a worker-launch failure.
	FHaybaMCPWorkerQuorum ClientWorkers;
};

using FHaybaMCPClientConnectionPtr = TSharedPtr<FHaybaMCPClientConnection, ESPMode::ThreadSafe>;

/** A received command awaiting execution on the game thread. */
struct FHaybaMCPPendingCommand
{
	FString Message;
	FHaybaMCPClientConnectionPtr Conn;
	FHaybaMCPCountReservationPtr PendingReservation;
	FHaybaMCPCountReservationPtr ResponseReservation;
};

class FHaybaMCPTcpServer : public FRunnable, public TSharedFromThis<FHaybaMCPTcpServer, ESPMode::ThreadSafe>
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
	/** Immutable, clamped values captured by this running server instance. */
	TSharedRef<FJsonObject> GetTransportLimitsSnapshot() const;

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
	FThreadSafeCounter PendingCommandCount;
	// Effective, clamped limits captured once at Start(). Project Settings may
	// change the next server incarnation without racing live worker threads.
	int32 MaxRequestBytes = 1024 * 1024;
	int32 MaxResponseBytes = 8 * 1024 * 1024;
	int32 MaxClientConnections = 16;
	int32 MaxPendingCommands = 128;
	int32 MaxJsonNestingDepth = 64;
	int32 FrameReadTimeoutMs = 5000;
	int32 SendTimeoutMs = 1000;
	static constexpr int32 MaxPipelinedRequestsPerClient = 8;
	int64 MaxOutboundMemoryBytesPerClient = 32 * 1024 * 1024;
	int64 MaxGlobalOutboundMemoryBytes = 32 * 1024 * 1024;
	FHaybaMCPOutboundBudgetPtr GlobalOutboundBudget;
	// Actual completion handles for every background connection/read/send task.
	// Shutdown removes the ticker, joins the listener, then joins these workers
	// before module code can unload.
	FCriticalSection WorkerMutex;
	TArray<TUniquePtr<FHaybaMCPJoinableWorker>> Workers;

	// Commands run on the game thread via a TICKER drain (not AsyncTask). Running
	// inside an AsyncTask(GameThread) *task* makes any handler that itself pumps
	// the game-thread task graph (e.g. python_run -> Interchange asset import)
	// re-enter task-graph processing -> check(RecursionGuard==1) crash. A ticker
	// runs in the normal engine tick, outside task-graph task execution, so such
	// work is safe. Connection (background) threads enqueue; the ticker drains.
	TQueue<FHaybaMCPPendingCommand, EQueueMode::Mpsc> PendingCommands;
	FTSTicker::FDelegateHandle DrainTickerHandle;
	bool DrainPendingCommands(float DeltaTime);
	void RetainWorker(TUniquePtr<FHaybaMCPJoinableWorker>&& Worker);

	void HandleClientConnection(FHaybaMCPClientConnectionPtr Conn);
	void HandleClientWrites(FHaybaMCPClientConnectionPtr Conn);
	void CompleteClientWorker(const FHaybaMCPClientConnectionPtr& Conn, const TCHAR* WorkerName);
	bool ReadMessage(const FHaybaMCPClientConnectionPtr& Conn, FString& OutMessage);
	bool SendMessage(const FHaybaMCPClientConnectionPtr& Conn, const FString& Message);
};
