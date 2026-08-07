#pragma once
#include "IHaybaMCPHandler.h"

/**
 * Settings reads and the BYOK key vault.
 *
 * These five commands used to be written out inline in
 * FHaybaMCPCommandHandler::ProcessCommand, ahead of the point where the router
 * consults its own handler registry. That is what made the router a special
 * case rather than a seam: `GetRegisteredCommands()` did not list them, so
 * anything reasoning about the command surface — the Plan Mode audit, the
 * catalogue, the drift test — saw a surface the router did not actually have.
 *
 * They are a natural group: all five read or write user configuration, none of
 * them touch the world, an asset, or the editor UI.
 *
 * SECURITY NOTE, carried over verbatim with the code: copilot_get_key is the
 * only command that returns a plaintext key, and it FAILS CLOSED when no
 * capability token is configured, even though the rest of the surface fails
 * open. Nothing here is journalled or logged — the generic dispatch logger
 * records cmd+id only, never params.
 */
class FHaybaMCPVaultHandler : public IHaybaMCPHandler
{
public:
    virtual FString GetDomain() const override { return TEXT("vault"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params) override;

private:
    FHaybaHandlerResult HandleGetSetting(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult HandleKeyStatus(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult HandleGetKey(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult HandleKeySet(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult HandleKeyClear(const TSharedPtr<FJsonObject>& P);
};
