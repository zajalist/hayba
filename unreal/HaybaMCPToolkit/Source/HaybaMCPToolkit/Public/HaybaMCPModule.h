#pragma once
#include "CoreMinimal.h"
#include "Modules/ModuleManager.h"
#include "Dom/JsonObject.h"

class FHaybaMCPTcpServer;
class FHaybaMCPCommandHandler;
class IHaybaMCPHandler;
class FHaybaPlanOverlay;

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

    // Semantic Studio window tab (per-asset mask + constraint authoring).
    static const FName TabStudio;

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

    // Satellite modules (HaybaMCPGAS/Niagara/MetaSound/Sequencer) register their
    // command handlers into the core router at their own StartupModule, so an
    // optional-plugin module that fails to load simply leaves its commands
    // unregistered (the router returns a clean "unknown command" instead of the
    // whole plugin failing to load). No-ops safely if the core router isn't up.
    HAYBAMCPTOOLKIT_API void RegisterExternalHandler(TSharedRef<IHaybaMCPHandler> Handler);
    HAYBAMCPTOOLKIT_API void UnregisterExternalHandler(const TSharedRef<IHaybaMCPHandler>& Handler);

    // Multicast — fires on the GameThread every time a tool call is recorded.
    // Subscribers: Chat panel's in-flight trace, future agent observability.
    DECLARE_MULTICAST_DELEGATE_OneParam(FOnToolCallRecorded, const FHaybaToolCallRecord&);
    FOnToolCallRecorded OnToolCallRecorded;

    // Fires on the GameThread when the user clicks Approve in the Plan panel.
    // The chat panel subscribes while a plan_request is pending so it can POST
    // /chat/approve and resume the paused streaming turn. Explicit human action
    // only — never auto-fired.
    DECLARE_MULTICAST_DELEGATE(FOnPlanApproved);
    FOnPlanApproved OnPlanApproved;

private:
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
    FString PendingStudioAsset;
    TWeakPtr<class SHaybaSemanticStudio> StudioWidget;
    TUniquePtr<FHaybaPlanOverlay> PlanOverlay;

    FString FindNodeExecutable() const;
    FString GetMCPServerPath() const;

    TSharedPtr<FHaybaMCPTcpServer> TcpServer;
    TSharedPtr<FHaybaMCPCommandHandler> CommandHandler;
    mutable FProcHandle MCPProcessHandle;
    int32 MCPPort = 0;
    int32 TcpPort = 52342;
    FString PluginBaseDir;
};
