#pragma once
#include "CoreMinimal.h"
#include "Modules/ModuleManager.h"
#include "Dom/JsonObject.h"

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

    // Multicast — fires on the GameThread every time a tool call is recorded.
    // Subscribers: Chat panel's in-flight trace, future agent observability.
    DECLARE_MULTICAST_DELEGATE_OneParam(FOnToolCallRecorded, const FHaybaToolCallRecord&);
    FOnToolCallRecorded OnToolCallRecorded;

private:
    mutable FCriticalSection ToolCallHistoryLock;
    TArray<FHaybaToolCallRecord> ToolCallHistory;

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
