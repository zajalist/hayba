#pragma once
#include "CoreMinimal.h"
#include "Modules/ModuleManager.h"
#include "Dom/JsonObject.h"

class FHaybaMCPTcpServer;
class FHaybaMCPCommandHandler;

class FHaybaMCPModule : public IModuleInterface
{
public:
    virtual void StartupModule() override;
    virtual void ShutdownModule() override;

    bool StartTcpServer();
    void StopTcpServer();
    bool IsTcpServerRunning() const;

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

    // ── Hayba panel tab IDs ──────────────────────────────────────────────────
    static const FName TabChat;
    static const FName TabToolStream;
    static const FName TabSceneMap;
    static const FName TabPlan;
    static const FName TabDiff;
    static const FName TabValidation;
    static const FName TabMemory;
    static const FName TabOnboarding;

    // Weak references to opened panels so the TCP handler can push data into them.
    TWeakPtr<class SHaybaMCPToolStreamPanel> ToolStreamPanel;
    TWeakPtr<class SHaybaMCPSceneMapPanel> SceneMapPanel;
    TWeakPtr<class SHaybaMCPPlanPanel> PlanPanel;
    TWeakPtr<class SHaybaMCPDiffPanel> DiffPanel;
    TWeakPtr<class SHaybaMCPValidationPanel> ValidationPanel;
    TWeakPtr<class SHaybaMCPMemoryPanel> MemoryPanel;

private:
    TSharedRef<class SDockTab> OnSpawnTab(const class FSpawnTabArgs& Args);

    TSharedRef<class SDockTab> SpawnChatTab(const class FSpawnTabArgs& Args);
    TSharedRef<class SDockTab> SpawnToolStreamTab(const class FSpawnTabArgs& Args);
    TSharedRef<class SDockTab> SpawnSceneMapTab(const class FSpawnTabArgs& Args);
    TSharedRef<class SDockTab> SpawnPlanTab(const class FSpawnTabArgs& Args);
    TSharedRef<class SDockTab> SpawnDiffTab(const class FSpawnTabArgs& Args);
    TSharedRef<class SDockTab> SpawnValidationTab(const class FSpawnTabArgs& Args);
    TSharedRef<class SDockTab> SpawnMemoryTab(const class FSpawnTabArgs& Args);
    TSharedRef<class SDockTab> SpawnOnboardingTab(const class FSpawnTabArgs& Args);

    FString FindNodeExecutable() const;
    FString GetMCPServerPath() const;

    TSharedPtr<FHaybaMCPTcpServer> TcpServer;
    TSharedPtr<FHaybaMCPCommandHandler> CommandHandler;
    mutable FProcHandle MCPProcessHandle;
    int32 MCPPort = 0;
    int32 TcpPort = 52342;
    FString PluginBaseDir;
};
