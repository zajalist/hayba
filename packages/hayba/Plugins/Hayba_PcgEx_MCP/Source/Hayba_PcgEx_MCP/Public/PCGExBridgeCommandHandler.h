#pragma once

#include "CoreMinimal.h"
#include "Json.h"
#include "UObject/UObjectIterator.h"

class UPCGSettings;

class FPCGExBridgeCommandHandler
{
public:
	FPCGExBridgeCommandHandler();
	~FPCGExBridgeCommandHandler();

	/** Parse a JSON command string, dispatch, and return JSON response string. */
	FString ProcessCommand(const FString& CommandJson);

	/** Build a success response: {id, ok:true, data:{...}} */
	static FString MakeOkResponse(const FString& Id, const TSharedPtr<FJsonObject>& Data);

	/** Build an error response: {id, ok:false, error:"..."} */
	static FString MakeErrorResponse(const FString& Id, const FString& ErrorMessage);

private:
	// Command method signature
	typedef FString (FPCGExBridgeCommandHandler::*FCommandFunc)(const TSharedPtr<FJsonObject>& Params, const FString& Id);

	// Dispatch table
	TMap<FString, FCommandFunc> CommandMap;

	// Command implementations
	FString Cmd_Ping(const TSharedPtr<FJsonObject>& Params, const FString& Id);
	FString Cmd_ListNodeClasses(const TSharedPtr<FJsonObject>& Params, const FString& Id);
	FString Cmd_GetNodeDetails(const TSharedPtr<FJsonObject>& Params, const FString& Id);
	FString Cmd_ListPCGAssets(const TSharedPtr<FJsonObject>& Params, const FString& Id);
	FString Cmd_ExportGraph(const TSharedPtr<FJsonObject>& Params, const FString& Id);
	FString Cmd_CreateGraph(const TSharedPtr<FJsonObject>& Params, const FString& Id);
	FString Cmd_ValidateGraph(const TSharedPtr<FJsonObject>& Params, const FString& Id);
	FString Cmd_ExecuteGraph(const TSharedPtr<FJsonObject>& Params, const FString& Id);
	FString Cmd_WizardChat(const TSharedPtr<FJsonObject>& Params, const FString& Id);

	// Graph validation helper
	TArray<TSharedPtr<FJsonValue>> ValidateGraphJson(const TSharedPtr<FJsonObject>& Graph) const;

	// Helpers for node class discovery
	TArray<UClass*> FindPCGExNodeClasses() const;
	void GetPinInfo(const UClass* SettingsClass, TArray<TSharedPtr<FJsonValue>>& OutInputs, TArray<TSharedPtr<FJsonValue>>& OutOutputs) const;
};
