#pragma once
#include "IHaybaMCPHandler.h"

/**
 * The editor-panel mirrors: the Node side telling the UE UI what it just did.
 *
 * These three commands used to be written out inline in
 * FHaybaMCPCommandHandler::ProcessCommand, ahead of the registry lookup — so
 * GetRegisteredCommands() did not list them, and anything reasoning about the
 * command surface (the Plan Mode audit, the catalogue, the drift test) saw a
 * surface the router did not actually have. They also arrived ahead of the
 * Plan Mode gate, the transaction, the SEH guard and the journal.
 *
 * None of them needs to skip any of that. They were inline because they call
 * panel-push helpers that lived in the router's own file, and moving them was
 * left as "a separate change". It turned out to be a small one: the memory
 * push ignores its parameters entirely and just asks the panel to re-read from
 * disk, and the other two reach the module directly.
 *
 * They are a natural group: all three are fire-and-forget mirrors that touch
 * only editor UI, never the world or an asset, and each acks with
 * {received:true} rather than a result.
 *
 * hayba_propose_plan stays inline in the router, and should: it is the Plan
 * Mode gate's own control command and has to be answerable before the gate it
 * feeds.
 */
class FHaybaMCPUIBridgeHandler : public IHaybaMCPHandler
{
public:
    virtual FString GetDomain() const override { return TEXT("ui_bridge"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params) override;

private:
    FHaybaHandlerResult HandleMemorySet(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult HandleCapturePanel(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult HandleToolStream(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult HandleToolStreamNewTurn(const TSharedPtr<FJsonObject>& P);
};
