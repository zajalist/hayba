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

    static FString MakeOkResponse(
        const FString& Id,
        const TSharedPtr<FJsonObject>& Data,
        const FString& Operation = FString());
    static FString MakeErrorResponse(
        const FString& Id,
        const FString& ErrorMessage,
        const FString& Operation = FString(),
        bool bSessionSuspect = false,
        /** True only when dispatch/Execute provably never began. */
        bool bKnownPreflight = false);

private:
    /** Rebuild CommandToHandler from the live handlers. The map is derived
     *  data and can go stale — see the call site in ProcessCommand. */
    void RebuildCommandMap();

    TMap<FString, TSharedRef<IHaybaMCPHandler>> CommandToHandler;
    TArray<TSharedRef<IHaybaMCPHandler>> Handlers;
};
