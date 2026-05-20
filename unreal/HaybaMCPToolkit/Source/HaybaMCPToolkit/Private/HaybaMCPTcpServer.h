#pragma once

#include "CoreMinimal.h"
#include "HAL/Runnable.h"
#include "Networking.h"

class FHaybaMCPCommandHandler;

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

	void HandleClientConnection(FSocket* ClientSocket);
	bool ReadMessage(FSocket* Socket, FString& OutMessage);
	void SendMessage(FSocket* Socket, const FString& Message);
};
