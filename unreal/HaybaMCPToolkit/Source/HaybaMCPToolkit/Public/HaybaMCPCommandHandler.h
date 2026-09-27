#pragma once
#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

class IHaybaMCPHandler;
struct FHaybaMCPRequestContext;

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

    /** Parse incoming TCP JSON, auth, dispatch, journal, return response JSON.
     *  In-process callers have no connection (ConnId 0, owner "local"). */
    FString ProcessCommand(const FString& CommandJson);

    /** The TCP path: ConnId identifies the caller for leases and Plan Mode. */
    FString ProcessCommand(const FString& CommandJson, int32 ConnId);

    /**
     * One editor_batch step, through the normal path (auth, lease check, Plan
     * gate, transaction, dispatch, journal). `bPlanPreApproved` is true when
     * the batch itself passed the Plan-Mode gate: its steps are covered by
     * that approval. Game thread only; no connection (the batch owns it).
     */
    FString ProcessBatchStep(const FString& CommandJson, const FString& BatchJobId, bool bPlanPreApproved);

    /** A TCP connection closed: release the leases bound to it. Game thread. */
    void NotifyConnectionClosed(int32 ConnId);

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

    /**
     * The per-request form: the static policy above, then the caller's
     * opt-outs (`transaction:false`, python_run `world_partition:true` or a
     * script that loads/unloads World Partition actors). Only turns a
     * transaction off, never on. See HaybaMCPAccessPolicy.h.
     */
    static bool ShouldCreateEditorTransaction(const FString& Cmd, const TSharedPtr<FJsonObject>& Params);

    /** The Plan-Mode gate's verdict (IsDestructiveCommand). Public so the
     *  lease classification can default from it and its drift test can
     *  check every registered command against it. */
    static bool IsPlanGatedCommand(const FString& Cmd);

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
    /** ProcessCommand's body, run inside the request's lease context. */
    FString ProcessCommandInContext(const FString& CommandJson);

    /** Publish `Context`, run the command, then fold in any lease warning. */
    FString ProcessWithContext(const FString& CommandJson, FHaybaMCPRequestContext& Context);

    /** Rebuild CommandToHandler from the live handlers. The map is derived
     *  data and can go stale — see the call site in ProcessCommand. */
    void RebuildCommandMap();

    TMap<FString, TSharedRef<IHaybaMCPHandler>> CommandToHandler;
    TArray<TSharedRef<IHaybaMCPHandler>> Handlers;
};
