#pragma once
#include "CoreMinimal.h"
#include "Modules/ModuleManager.h"
#include "Dom/JsonObject.h"
#include "HAL/CriticalSection.h"
#include "HaybaMCPPlanTypes.h"

class FHaybaMCPTcpServer;
class FHaybaMCPCommandHandler;

// Lightweight tool-call record kept in the module so it survives tab
// navigations. The Tool Stream panel hydrates from this buffer on Construct.
struct FHaybaToolCallRecord
{
    FString ToolName;
    FString ParamsJson;
    FString ResultJson;
    FDateTime Timestamp;
};

class FHaybaMCPModule : public IModuleInterface
{
public:
    virtual void StartupModule() override;
    virtual void ShutdownModule() override;

    bool StartTcpServer();
    void StopTcpServer();
    bool IsTcpServerRunning() const;
    int32 GetTcpClientCount() const;

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

    // Weak references to live sub-panels (set by SHaybaMCPMainPanel as it builds them).
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

    // Plan Mode handshake — set by Plan panel's Approve click, reset by every
    // destructive command so each plan must be approved exactly once.
    bool bPlanApproved = false;

    // Pending-plan buffer — survives the gap between the agent's
    // hayba_propose_plan TCP call and the user actually opening the Plan
    // tab. Without this, plans proposed before first tab visit silently
    // dropped on the floor because Module->PlanPanel.Pin() returned null.
    //
    // Flow:
    //   - HandleProposePlan() always calls StashPendingPlan().
    //   - If PlanPanel is alive RIGHT NOW, HandleProposePlan also calls
    //     LoadPlan() on it and marks ConsumePendingPlan() — the buffer
    //     stays in sync with the panel's current view.
    //   - When MainPanel constructs the Plan tab (lazy), it calls
    //     ConsumePendingPlan() right after wiring PlanPanel — any plan
    //     proposed before the tab existed becomes visible.
    void StashPendingPlan(const TArray<FHaybaPlanStep>& Steps, int32 AwaitSecs);
    bool ConsumePendingPlan(TArray<FHaybaPlanStep>& OutSteps, int32& OutAwaitSecs);
    bool HasPendingPlan() const;

    // Multicast — fires on the GameThread every time a tool call is recorded.
    // Subscribers: Chat panel's in-flight trace, future agent observability.
    DECLARE_MULTICAST_DELEGATE_OneParam(FOnToolCallRecorded, const FHaybaToolCallRecord&);
    FOnToolCallRecorded OnToolCallRecorded;

private:
    mutable FCriticalSection ToolCallHistoryLock;
    TArray<FHaybaToolCallRecord> ToolCallHistory;

    mutable FCriticalSection PendingPlanLock;
    TArray<FHaybaPlanStep> PendingPlanSteps;
    int32 PendingPlanAwaitSecs = 30;
    bool bPendingPlanConsumed = true;

    TSharedRef<class SDockTab> OnSpawnTab(const class FSpawnTabArgs& Args);
    TSharedRef<class SDockTab> SpawnMainTab(const class FSpawnTabArgs& Args);

    FString FindNodeExecutable() const;
    FString GetMCPServerPath() const;

    TSharedPtr<FHaybaMCPTcpServer> TcpServer;
    TSharedPtr<FHaybaMCPCommandHandler> CommandHandler;
    mutable FProcHandle MCPProcessHandle;
    int32 MCPPort = 0;
    int32 TcpPort = 52342;
    FString PluginBaseDir;
};
