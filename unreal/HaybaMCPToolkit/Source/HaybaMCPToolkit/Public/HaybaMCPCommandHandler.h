#pragma once
#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

class IHaybaMCPHandler;

class FHaybaMCPCommandHandler
{
public:
    FHaybaMCPCommandHandler();
    ~FHaybaMCPCommandHandler();

    /** Register a handler for its commands. Called at startup. */
    void RegisterHandler(TSharedRef<IHaybaMCPHandler> Handler);

    /**
     * Remove a previously-registered handler (and all its command mappings).
     * Used by satellite modules (GAS/Niagara/MetaSound/Sequencer) that register
     * into the core at their StartupModule and must cleanly detach on shutdown.
     */
    void UnregisterHandler(const TSharedRef<IHaybaMCPHandler>& Handler);

    /** Parse incoming TCP JSON, auth, dispatch, journal, return response JSON. */
    FString ProcessCommand(const FString& CommandJson);

    /** Returns all registered command names. */
    TArray<FString> GetAllCommands() const;

    /**
     * Whether a destructive command should also receive a global editor undo
     * transaction.  This is deliberately narrower than the Plan Mode gate:
     * some consequential operations (notably UMG compilation) create engine
     * validation previews which must never be captured by UTransBuffer.
     *
     * Public so native policy regressions can prove that safety exception
     * without routing through authentication or changing editor settings.
     */
    static bool ShouldCreateEditorTransaction(const FString& Cmd);

    static FString MakeOkResponse(const FString& Id, const TSharedPtr<FJsonObject>& Data);
    static FString MakeErrorResponse(const FString& Id, const FString& ErrorMessage);

private:
    /** Rebuild CommandToHandler from the live handlers. The map is derived
     *  data and can go stale — see the call site in ProcessCommand. */
    void RebuildCommandMap();

    TMap<FString, TSharedRef<IHaybaMCPHandler>> CommandToHandler;
    TArray<TSharedRef<IHaybaMCPHandler>> Handlers;
};
