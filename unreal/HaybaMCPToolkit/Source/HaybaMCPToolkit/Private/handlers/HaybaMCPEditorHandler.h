#pragma once
#include "IHaybaMCPHandler.h"

class AHaybaMCPCaptureActor;

class FHaybaMCPEditorHandler : public IHaybaMCPHandler
{
public:
    virtual FString GetDomain() const override { return TEXT("editor"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params) override;

private:
    FHaybaHandlerResult StartPIE(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult StopPIE(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult SetCamera(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult FocusActor(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult CaptureViewport(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult RunConsoleCommand(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult GetOutputLog(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult StreamLog(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult LiveCompile(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult GetPerformanceStats(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult SetViewportMode(const TSharedPtr<FJsonObject>& P);

    AHaybaMCPCaptureActor* GetOrSpawnCaptureActor() const;
};
