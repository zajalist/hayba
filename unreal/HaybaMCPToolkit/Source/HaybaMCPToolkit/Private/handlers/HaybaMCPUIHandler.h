#pragma once
#include "IHaybaMCPHandler.h"

class FHaybaMCPUIHandler : public IHaybaMCPHandler
{
public:
    virtual FString GetDomain() const override { return TEXT("ui"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params) override;
private:
    FHaybaHandlerResult HandleCreateWidget(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult HandleAddElement(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult HandleSetProperties(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult HandleQuery(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult HandleMutateTree(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult HandleCompile(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult HandleSave(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult HandleListTypes(const TSharedPtr<FJsonObject>& P);

    // Authoring additions
    FHaybaHandlerResult HandleBuildTree(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult HandleSetVariable(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult HandleListWidgetBlueprints(const TSharedPtr<FJsonObject>& P);

    // Measurement — facts only the engine can produce. The validation rules
    // themselves live MCP-side so they can be extended and configured without
    // a plugin rebuild; these two commands feed them.
    FHaybaHandlerResult HandleLayoutSnapshot(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult HandleMeasureText(const TSharedPtr<FJsonObject>& P);
    /** Accepts findings judged MCP-side so they can reach the Validation panel. */
    FHaybaHandlerResult HandleReportFindings(const TSharedPtr<FJsonObject>& P);
};
