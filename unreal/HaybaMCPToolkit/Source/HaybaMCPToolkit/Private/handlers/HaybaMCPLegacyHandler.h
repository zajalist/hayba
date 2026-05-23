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
    // All Cmd_* methods. Several mutate world state or call LoadObject /
    // SpawnActor — those MUST run on the game thread (see Handle() which
    // marshals through RunOnGameThread for the world-mutating subset).
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
    FHaybaHandlerResult Cmd_DescribeAssets(const TSharedPtr<FJsonObject>& Params);

    // Helpers from the old CommandHandler:
    TArray<TSharedPtr<FJsonValue>> ValidateGraphJson(const TSharedPtr<FJsonObject>& Graph) const;
    TArray<UClass*> FindPCGExNodeClasses() const;
    void GetPinInfo(const UClass* SettingsClass,
                    TArray<TSharedPtr<FJsonValue>>& OutInputs,
                    TArray<TSharedPtr<FJsonValue>>& OutOutputs) const;

    /**
     * Run Work on the game thread synchronously, returning its result.
     * If we're already on the game thread, runs inline. Otherwise marshals
     * via AsyncTask + FEvent and blocks the caller until completion.
     *
     * Required for any command that calls World->SpawnActor, LoadObject,
     * EditorAssetLibrary, IAssetRegistry mutations, or otherwise touches
     * GEditor / UWorld state — the TCP server already marshals to GameThread
     * before dispatch today, but this guards against future direct invocations
     * (and against the race that crashed UE in the 2026-05-23 postmortem).
     */
    static FHaybaHandlerResult RunOnGameThread(TFunction<FHaybaHandlerResult()> Work);
};
