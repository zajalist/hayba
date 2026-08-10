#pragma once
#include "IHaybaMCPHandler.h"

#if WITH_EDITOR
#include "Delegates/IDelegateInstance.h"
#endif

/**
 * PIE test-harness commands: assert / wait_for / press_key / screenshot.
 *
 * Lifecycle hooks (BeginPIE / EndPIE / CancelPIE) are bound lazily on first
 * use of any command, and torn down by the destructor.
 */
class FHaybaMCPPIEHandler : public IHaybaMCPHandler
{
public:
    FHaybaMCPPIEHandler() = default;
    virtual ~FHaybaMCPPIEHandler();

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

#if WITH_EDITOR
    void EnsureLifecycleHooks();
    void OnBeginPIE(const bool bIsSimulating);
    void OnEndPIE(const bool bIsSimulating);

    bool bHooksBound = false;
    FDelegateHandle BeginPIEHandle;
    FDelegateHandle EndPIEHandle;
    FDelegateHandle CancelPIEHandle;

    // Set when EndPIE/CancelPIE fires while a wait loop is running — checked
    // each iteration to abort cleanly.
    bool bCancelPending = false;

    friend FHaybaHandlerResult FHaybaMCPPIEHandler_WaitLoop(
        FHaybaMCPPIEHandler& Self, const TSharedPtr<class FJsonObject>& P, const FString& Comparator);
#endif
};
