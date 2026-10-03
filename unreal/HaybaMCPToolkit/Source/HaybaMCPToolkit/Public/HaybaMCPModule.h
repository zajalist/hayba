#pragma once
#include "CoreMinimal.h"
#include "Modules/ModuleManager.h"
#include "Dom/JsonObject.h"
#include "TimerManager.h"

class FHaybaMCPTcpServer;
class FHaybaMCPCommandHandler;
class IHaybaMCPHandler;
class FHaybaPlanOverlay;
class IConsoleObject;
class FHaybaActivityModel;

// Lightweight tool-call record kept in the module so it survives tab
// navigations. The Tool Stream panel hydrates from this buffer on Construct.
struct FHaybaToolCallRecord
{
    FString ToolName;
    FString ParamsJson;
    FString ResultJson;
    FDateTime Timestamp;
};

struct FHaybaExternalPlanStep
{
    FString Title;
    FString Description;
    FString Tool;
};

// A single frozen native call. The digest covers the command and every input
// parameter; TargetFingerprint is captured from the live editor object.
// None of these fields is an authorization until ResolveExternalPlan succeeds.
struct FHaybaExactExternalApproval
{
    FString ProposalId;
    FString Command;
    FString Owner;
    FString Source;
    FString SourceBinding;
    FString OperationDigest;
    FString ReviewParamsJson;
    FString TargetRef;
    FString TargetFingerprint;
    FString LeaseBinding;
    /** Kept in memory only to revalidate the live lease at the approval click. */
    FString LeaseId;
    int32 ConnectionId = 0;
    FString PolicyVersion;
    FString Consequence;
    FDateTime ExpiresAt;

    bool IsValid() const { return !ProposalId.IsEmpty() && !OperationDigest.IsEmpty() && !TargetFingerprint.IsEmpty(); }
    bool Matches(const FString& InOwner, const FString& InCommand, const FString& InDigest,
        const FString& InTargetFingerprint, const FString& InLeaseBinding, const FString& InSourceBinding,
        const FString& InPolicyVersion, FDateTime Now) const
    {
        return IsValid() && Now <= ExpiresAt && Owner == InOwner && Command == InCommand &&
            OperationDigest == InDigest && TargetFingerprint == InTargetFingerprint &&
            LeaseBinding == InLeaseBinding && SourceBinding == InSourceBinding && PolicyVersion == InPolicyVersion;
    }
};

class FHaybaMCPModule : public IModuleInterface
{
public:
    virtual void StartupModule() override;
    virtual void ShutdownModule() override;

    /** Persistent activity history, independent of any tab or chat widget. */
    FHaybaActivityModel& GetActivityModel();
    DECLARE_MULTICAST_DELEGATE_OneParam(FOnActivityChanged, const FString& /*ActivityId*/);
    FOnActivityChanged OnActivityChanged;

    bool StartTcpServer();
    void StopTcpServer();
    bool IsTcpServerRunning() const;
    int32 GetTcpClientCount() const;
    /** Active server's immutable, clamped transport limits; null while stopped. */
    TSharedPtr<FJsonObject> GetTcpTransportLimits() const;

    bool StartMCPServer();
    void StopMCPServer();
    bool IsMCPServerRunning() const;

    FString GetDashboardURL() const;
    bool IsServerRunning() const;

    void SendTcpCommand(
        const FString& Cmd,
        const TSharedRef<FJsonObject>& Params,
        TFunction<void(bool bOk, const TSharedPtr<FJsonObject>& Response)> Callback
    );

    // Single unified panel tab.
    static const FName TabMain;

    // Semantic Studio window tab (per-asset mask + constraint authoring).
    static const FName TabStudio;

    // Weak references to live sub-panels (set by SHaybaMCPMainPanel as it builds them).
    TWeakPtr<class SHaybaMCPMainPanel>       MainPanel;
    TWeakPtr<class SHaybaMCPToolStreamPanel> ToolStreamPanel;
    TWeakPtr<class SHaybaMCPSceneMapPanel>   SceneMapPanel;
    TWeakPtr<class SHaybaMCPPlanPanel>       PlanPanel;
    TWeakPtr<class SHaybaMCPDiffPanel>       DiffPanel;
    TWeakPtr<class SHaybaMCPValidationPanel> ValidationPanel;
    TWeakPtr<class SHaybaMCPMemoryPanel>     MemoryPanel;

    // Persistent ring buffer of recent tool calls. Lives in the module so the
    // Tool Stream panel can hydrate from it after the user navigates away and
    // back, instead of seeing an empty list every time.
    void RecordToolCall(const FString& ToolName, const FString& ParamsJson, const FString& ResultJson);
    TArray<FHaybaToolCallRecord> SnapshotToolCalls() const;
    void ClearToolCallHistory();
    static constexpr int32 ToolCallHistoryMax = 200;

    // Legacy Plan panel state retained for its chat event bridge. It is not a
    // native external-command authorization; only ApprovedExternalOperation is.
    bool bPlanApproved = false;
    // Owner of the legacy prose plan, retained for display and migration only.
    FString PlanOwner;

    // External MCP proposals survive navigation and tab recreation. Chat has
    // its own exact-call approval protocol; never broadcast chat approval here.
    FString PendingExternalPlan;
    FString PendingExternalPlanId;
    TArray<FHaybaExternalPlanStep> PendingExternalSteps;
    FHaybaExactExternalApproval PendingExternalOperation;
    FHaybaExactExternalApproval ApprovedExternalOperation;
    bool PendingExternalPlanIsExact = false;
    void ProposeExternalPlan(const FString& Summary,
        TArray<FHaybaExternalPlanStep> Steps = {})
    {
        bPlanApproved = false;
        PendingExternalPlan = Summary;
        PendingExternalPlanId = FGuid::NewGuid().ToString(EGuidFormats::Digits);
        PendingExternalSteps = MoveTemp(Steps);
        PendingExternalOperation = {};
        ApprovedExternalOperation = {};
        PendingExternalPlanIsExact = false;
    }
    /** Legacy no-token approval is intentionally non-authorizing. */
    bool ResolveExternalPlan(bool /*bApprove*/) { return false; }
    bool ResolveExternalPlan(const FString& ExpectedProposalId, bool bApprove);
    void ProposeExactExternalOperation(FHaybaExactExternalApproval Operation);
    void InvalidateExternalApproval();
    bool ConsumeExactExternalApproval(const FString& Owner, const FString& Command,
        const FString& OperationDigest, const FString& TargetFingerprint, const FString& LeaseBinding,
        const FString& SourceBinding,
        const FString& PolicyVersion);

    // Satellite modules (HaybaMCPGAS/Niagara/MetaSound/Sequencer) register their
    // command handlers into the core router at their own StartupModule, so an
    // optional-plugin module that fails to load simply leaves its commands
    // unregistered (the router returns a clean "unknown command" instead of the
    // whole plugin failing to load). No-ops safely if the core router isn't up.
    HAYBAMCPTOOLKIT_API void RegisterExternalHandler(TSharedRef<IHaybaMCPHandler> Handler);

    /** The live command router (tests read its registered command set). */
    TSharedPtr<FHaybaMCPCommandHandler> GetCommandHandler() const { return CommandHandler; }
    HAYBAMCPTOOLKIT_API void UnregisterExternalHandler(const TSharedRef<IHaybaMCPHandler>& Handler);

    // Multicast — fires synchronously when a tool call is recorded on the Game
    // Thread. Unexpected off-thread calls retain locked history but skip this
    // Slate-facing notification. Subscribers: Chat panel's in-flight trace,
    // future agent observability.
    DECLARE_MULTICAST_DELEGATE_OneParam(FOnToolCallRecorded, const FHaybaToolCallRecord&);
    FOnToolCallRecorded OnToolCallRecorded;

    // Fires on the GameThread when the user clicks Approve in the Plan panel.
    // The chat panel subscribes while a plan_request is pending so it can POST
    // /chat/approve and resume the paused streaming turn. Explicit human action
    // only — never auto-fired.
    //
    // INVARIANT: these are parameterless multicasts that assume exactly ONE chat
    // panel is ever awaiting approval at a time (the plugin has a single chat
    // surface). Because the broadcast carries no session/plan token, every
    // subscriber that is armed (bAwaitingPlanApproval) treats the event as its
    // own — the receiving handler re-validates bAwaitingPlanApproval to ignore
    // strays. If a second concurrent chat surface is ever added, these must
    // carry a session/plan id so the right panel resumes/aborts.
    DECLARE_MULTICAST_DELEGATE(FOnPlanApproved);
    FOnPlanApproved OnPlanApproved;

    // Fires on the GameThread when the user clicks Reject in the Plan panel.
    // Mirrors FOnPlanApproved (same single-awaiting-subscriber invariant above):
    // the awaiting chat panel clears its armed state and cancels the paused turn
    // so a later, unrelated Approve can't resume the rejected turn.
    DECLARE_MULTICAST_DELEGATE(FOnPlanRejected);
    FOnPlanRejected OnPlanRejected;

private:
    TSharedPtr<FHaybaActivityModel> ActivityModel;
    mutable FCriticalSection ToolCallHistoryLock;
    TArray<FHaybaToolCallRecord> ToolCallHistory;

    TSharedRef<class SDockTab> OnSpawnTab(const class FSpawnTabArgs& Args);
    TSharedRef<class SDockTab> SpawnMainTab(const class FSpawnTabArgs& Args);
    TSharedRef<class SDockTab> SpawnStudioTab(const class FSpawnTabArgs& Args);

public:
    /** Open (or retarget) the Semantic Studio on a specific asset path. */
    void OpenStudioForAsset(const FString& AssetPath);
private:
    /** Adds the "Open with Hayba" entry to the StaticMesh content-browser menu. */
    void RegisterStudioContentMenu();
    /** Tracked next-tick onboarding action; ShutdownModule cancels it if pending. */
    void OpenOnboardingTab();
    FString PendingStudioAsset;
    TWeakPtr<class SHaybaSemanticStudio> StudioWidget;
    TUniquePtr<FHaybaPlanOverlay> PlanOverlay;
    IConsoleObject* OpenToolkitConsoleCommand = nullptr;
    IConsoleObject* OpenStudioConsoleCommand = nullptr;
    FTimerHandle AutoOpenTimerHandle;
    FDelegateHandle StudioMenuStartupHandle;

    FString FindNodeExecutable() const;
    FString GetMCPServerPath() const;

    // Connection workers retain the server while they exit during shutdown,
    // so the shared controller crosses the game/listener/connection threads.
    TSharedPtr<FHaybaMCPTcpServer, ESPMode::ThreadSafe> TcpServer;
    TSharedPtr<FHaybaMCPCommandHandler> CommandHandler;
    mutable FProcHandle MCPProcessHandle;
    int32 MCPPort = 0;
    int32 TcpPort = 52342;
    FString PluginBaseDir;
};
