#pragma once
#include "IHaybaMCPHandler.h"

class UPCGSettings;

class FHaybaMCPLegacyHandler : public IHaybaMCPHandler
{
public:
    FHaybaMCPLegacyHandler();
    virtual FString GetDomain() const override { return TEXT("legacy"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Cmd,
        const TSharedPtr<FJsonObject>& Params) override;

private:
    // All 11 Cmd_* methods migrated verbatim from the old CommandHandler:
    FHaybaHandlerResult Cmd_Ping(const TSharedPtr<FJsonObject>& Params);
    FHaybaHandlerResult Cmd_ListNodeClasses(const TSharedPtr<FJsonObject>& Params);
    FHaybaHandlerResult Cmd_GetNodeDetails(const TSharedPtr<FJsonObject>& Params);
    FHaybaHandlerResult Cmd_ListPCGAssets(const TSharedPtr<FJsonObject>& Params);
    FHaybaHandlerResult Cmd_ExportGraph(const TSharedPtr<FJsonObject>& Params);
    FHaybaHandlerResult Cmd_CreateGraph(const TSharedPtr<FJsonObject>& Params);
    FHaybaHandlerResult Cmd_ValidateGraph(const TSharedPtr<FJsonObject>& Params);
    FHaybaHandlerResult Cmd_ExecuteGraph(const TSharedPtr<FJsonObject>& Params);
    FHaybaHandlerResult Cmd_WizardChat(const TSharedPtr<FJsonObject>& Params);
    FHaybaHandlerResult Cmd_ImportLandscape(const TSharedPtr<FJsonObject>& Params);
    FHaybaHandlerResult Cmd_ReadNodeOutput(const TSharedPtr<FJsonObject>& Params);

    // Helpers from the old CommandHandler:
    TArray<TSharedPtr<FJsonValue>> ValidateGraphJson(const TSharedPtr<FJsonObject>& Graph) const;
    TArray<UClass*> FindPCGExNodeClasses() const;
    void GetPinInfo(const UClass* SettingsClass,
                    TArray<TSharedPtr<FJsonValue>>& OutInputs,
                    TArray<TSharedPtr<FJsonValue>>& OutOutputs) const;
};
