#pragma once
#include "IHaybaMCPHandler.h"
#include "Containers/Ticker.h"

struct FHaybaPIECaptureState;

/**
 * PIE test-harness commands: assert / wait_for / press_key / screenshot.
 *
 * PIE state (who owns the session, whether it is queued) lives in FHaybaMCPEditorState, whose hooks are bound at module startup.
 */
class FHaybaMCPPIEHandler : public IHaybaMCPHandler
{
public:
    FHaybaMCPPIEHandler();
    virtual ~FHaybaMCPPIEHandler() override;

    virtual FString GetDomain() const override { return TEXT("editor"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params) override;

private:
    FHaybaHandlerResult PIEAssert(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult PIEWaitFor(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult PIEPressKey(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult PIEScreenshot(const TSharedPtr<FJsonObject>& P);

    // Interaction surface: everything an agent needs to drive a running game.
    FHaybaHandlerResult PIEMouse(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult PIETypeText(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult PIEAxis(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult PIEWidgetTree(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult PIEClickWidget(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult PIESetText(const TSharedPtr<FJsonObject>& P);

    // Read-only runtime scene grounding for headless visual gauntlets.
    FHaybaHandlerResult PIEActorList(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult PIEActorInspect(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult PIEProjectWorld(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult PIESightlines(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult PIEClickActor(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult PIECaptureStart(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult PIECaptureGet(const TSharedPtr<FJsonObject>& P);

    TUniquePtr<FHaybaPIECaptureState> Capture;
    FTSTicker::FDelegateHandle CaptureTicker;
    bool TickCapture(float DeltaSeconds);
};
