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
	TSharedPtr<FHaybaMCPCommandHandler> CommandHandler;
	bool bIsRunning = false;

	void HandleClientConnection(FSocket* ClientSocket);
	bool ReadMessage(FSocket* Socket, FString& OutMessage);
	void SendMessage(FSocket* Socket, const FString& Message);
};
