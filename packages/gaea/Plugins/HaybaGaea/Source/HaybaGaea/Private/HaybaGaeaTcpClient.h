#pragma once
#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "Sockets.h"

DECLARE_DELEGATE_TwoParams(FOnHaybaResponse, bool /*bOk*/, const FString& /*ResponseJson*/);

class FHaybaGaeaTcpClient
{
public:
	FHaybaGaeaTcpClient();
	~FHaybaGaeaTcpClient();

	bool Connect(const FString& Host, int32 Port);
	void Disconnect();
	bool IsConnected() const;

	void Send(const TSharedRef<FJsonObject>& Payload, FOnHaybaResponse OnResponse);

private:
	FSocket* Socket = nullptr;
};
