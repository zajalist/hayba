#pragma once

#include "CoreMinimal.h"
#include "HAL/Runnable.h"
#include "Networking.h"

class FPCGExBridgeCommandHandler;

class FPCGExBridgeTcpServer : public FRunnable
{
public:
	FPCGExBridgeTcpServer(int32 InPort);
	virtual ~FPCGExBridgeTcpServer();

	bool Start();
	void Shutdown();
	bool IsRunning() const { return bIsRunning; }

	// FRunnable interface
	virtual uint32 Run() override;
	virtual void Stop() override { bIsRunning = false; }
	virtual void Exit() override {}

private:
	int32 Port;
	FRunnableThread* Thread = nullptr;
	FSocket* ListenSocket = nullptr;
	TSharedPtr<FPCGExBridgeCommandHandler> CommandHandler;
	bool bIsRunning = false;

	void HandleClientConnection(FSocket* ClientSocket);
	bool ReadMessage(FSocket* Socket, FString& OutMessage);
	void SendMessage(FSocket* Socket, const FString& Message);
};
