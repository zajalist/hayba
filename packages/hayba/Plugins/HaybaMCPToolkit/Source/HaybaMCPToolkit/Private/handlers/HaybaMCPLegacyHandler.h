#pragma once
#include "IHaybaMCPHandler.h"

class UPCGSettings;

class FHaybaMCPLegacyHandler : public IHaybaMCPHandler
{
public:
    FHaybaMCPLegacyHandler();
    virtual FString GetDomain() const override { return TEXT("legacy"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FString Handle(const FString& Cmd,
        const TSharedPtr<FJsonObject>& Params, const FString& Id) override;

private:
    // All 11 Cmd_* methods migrated verbatim from the old CommandHandler:
    FString Cmd_Ping(const TSharedPtr<FJsonObject>& Params, const FString& Id);
    FString Cmd_ListNodeClasses(const TSharedPtr<FJsonObject>& Params, const FString& Id);
    FString Cmd_GetNodeDetails(const TSharedPtr<FJsonObject>& Params, const FString& Id);
    FString Cmd_ListPCGAssets(const TSharedPtr<FJsonObject>& Params, const FString& Id);
    FString Cmd_ExportGraph(const TSharedPtr<FJsonObject>& Params, const FString& Id);
    FString Cmd_CreateGraph(const TSharedPtr<FJsonObject>& Params, const FString& Id);
    FString Cmd_ValidateGraph(const TSharedPtr<FJsonObject>& Params, const FString& Id);
    FString Cmd_ExecuteGraph(const TSharedPtr<FJsonObject>& Params, const FString& Id);
    FString Cmd_WizardChat(const TSharedPtr<FJsonObject>& Params, const FString& Id);
    FString Cmd_ImportLandscape(const TSharedPtr<FJsonObject>& Params, const FString& Id);
    FString Cmd_ReadNodeOutput(const TSharedPtr<FJsonObject>& Params, const FString& Id);

    // Helpers from the old CommandHandler:
    TArray<TSharedPtr<FJsonValue>> ValidateGraphJson(const TSharedPtr<FJsonObject>& Graph) const;
    TArray<UClass*> FindPCGExNodeClasses() const;
    void GetPinInfo(const UClass* SettingsClass,
                    TArray<TSharedPtr<FJsonValue>>& OutInputs,
                    TArray<TSharedPtr<FJsonValue>>& OutOutputs) const;
};
