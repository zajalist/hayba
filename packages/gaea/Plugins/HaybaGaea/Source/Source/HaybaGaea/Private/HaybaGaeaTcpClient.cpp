#include "HaybaGaeaTcpClient.h"
#include "Serialization/JsonWriter.h"
#include "Serialization/JsonSerializer.h"
#include "SocketSubsystem.h"
#include "IPAddress.h"
#include "Logging/LogMacros.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaTcp, Log, All);

FHaybaGaeaTcpClient::FHaybaGaeaTcpClient()
{
}

FHaybaGaeaTcpClient::~FHaybaGaeaTcpClient()
{
	Disconnect();
}

bool FHaybaGaeaTcpClient::Connect(const FString& Host, int32 Port)
{
	ISocketSubsystem* SS = ISocketSubsystem::Get(PLATFORM_SOCKETSUBSYSTEM);
	if (!SS) return false;

	Socket = SS->CreateSocket(NAME_Stream, TEXT("HaybaGaeaTCP"), false);
	if (!Socket) return false;

	TSharedRef<FInternetAddr> Addr = SS->CreateInternetAddr();
	bool bValid = false;
	Addr->SetIp(*Host, bValid);
	if (!bValid)
	{
		Socket->Close();
		SS->DestroySocket(Socket);
		Socket = nullptr;
		return false;
	}
	Addr->SetPort(Port);

	if (!Socket->Connect(*Addr))
	{
		SS->DestroySocket(Socket);
		Socket = nullptr;
		return false;
	}

	return true;
}

void FHaybaGaeaTcpClient::Disconnect()
{
	if (Socket)
	{
		Socket->Close();
		ISocketSubsystem::Get(PLATFORM_SOCKETSUBSYSTEM)->DestroySocket(Socket);
		Socket = nullptr;
	}
}

bool FHaybaGaeaTcpClient::IsConnected() const
{
	return Socket != nullptr;
}

void FHaybaGaeaTcpClient::Send(const TSharedRef<FJsonObject>& Payload, FOnHaybaResponse OnResponse)
{
	if (!Socket)
	{
		OnResponse.ExecuteIfBound(false, TEXT(""));
		return;
	}

	// Serialize payload to JSON
	FString JsonStr;
	TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&JsonStr);
	FJsonSerializer::Serialize(Payload, Writer);

	// Write 4-byte LE length prefix + UTF-8 body (matches Node.js server framing)
	FTCHARToUTF8 Converter(*JsonStr);
	int32 Len = Converter.Length();
	uint8 LenBuf[4] = {
		(uint8)(Len & 0xFF),
		(uint8)((Len >> 8) & 0xFF),
		(uint8)((Len >> 16) & 0xFF),
		(uint8)((Len >> 24) & 0xFF)
	};
	int32 Sent = 0;
	Socket->Send(LenBuf, 4, Sent);
	Socket->Send((const uint8*)Converter.Get(), Len, Sent);

	// Read response length prefix
	uint8 RespLenBuf[4];
	int32 Read = 0;
	if (!Socket->Recv(RespLenBuf, 4, Read, ESocketReceiveFlags::WaitAll) || Read != 4)
	{
		UE_LOG(LogHaybaTcp, Warning, TEXT("Failed to read response length"));
		OnResponse.ExecuteIfBound(false, TEXT(""));
		return;
	}

	int32 RespLen = RespLenBuf[0] | (RespLenBuf[1] << 8) | (RespLenBuf[2] << 16) | (RespLenBuf[3] << 24);
	if (RespLen <= 0 || RespLen > 1024 * 1024)
	{
		UE_LOG(LogHaybaTcp, Warning, TEXT("Invalid response length: %d"), RespLen);
		OnResponse.ExecuteIfBound(false, TEXT(""));
		return;
	}

	TArray<uint8> RespBuf;
	RespBuf.SetNumUninitialized(RespLen + 1);
	if (!Socket->Recv(RespBuf.GetData(), RespLen, Read, ESocketReceiveFlags::WaitAll))
	{
		UE_LOG(LogHaybaTcp, Warning, TEXT("Failed to read response body"));
		OnResponse.ExecuteIfBound(false, TEXT(""));
		return;
	}
	RespBuf[RespLen] = 0;

	FString RespStr = FString(UTF8_TO_TCHAR(reinterpret_cast<const char*>(RespBuf.GetData())));
	OnResponse.ExecuteIfBound(true, RespStr);
}
