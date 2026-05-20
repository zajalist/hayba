#include "HaybaMCPModule.h"
#include "Async/Async.h"
#include "HaybaMCPMainPanel.h"
#include "HaybaMCPChatPanel.h"
#include "HaybaMCPToolStreamPanel.h"
#include "HaybaMCPSceneMapPanel.h"
#include "HaybaMCPPlanPanel.h"
#include "HaybaMCPDiffPanel.h"
#include "HaybaMCPValidationPanel.h"
#include "HaybaMCPMemoryPanel.h"
#include "HaybaMCPOnboardingWidget.h"
#include "HaybaMCPPlanModeWidget.h"
#include "HaybaMCPStyle.h"
#include "Editor.h"
#include "TimerManager.h"
#include "ToolMenus.h"
#include "Framework/Notifications/NotificationManager.h"
#include "Widgets/Notifications/SNotificationList.h"
#include "HaybaMCPTcpServer.h"
#include "HaybaMCPCommandHandler.h"
#include "handlers/HaybaMCPLegacyHandler.h"
#include "handlers/HaybaMCPActorHandler.h"
#include "handlers/HaybaMCPLevelHandler.h"
#include "handlers/HaybaMCPSceneGraphHandler.h"
#include "handlers/HaybaMCPEditorHandler.h"
#include "handlers/HaybaMCPPIEHandler.h"
#include "handlers/HaybaMCPPythonHandler.h"
#include "handlers/HaybaMCPAssetHandler.h"
#include "handlers/HaybaMCPBlueprintHandler.h"
#include "handlers/HaybaMCPMaterialHandler.h"
#include "handlers/HaybaMCPFoliageHandler.h"
#include "handlers/HaybaMCPSplineHandler.h"
#include "handlers/HaybaMCPWorldPartitionHandler.h"
#include "handlers/HaybaMCPISMHandler.h"
#include "handlers/HaybaMCPPhysicsHandler.h"
#include "handlers/HaybaMCPDocsHandler.h"
// ===== Stub handlers (advertise commands; return not_implemented) =====
#include "handlers/HaybaMCPSequencerHandler.h"
#include "handlers/HaybaMCPAnimationHandler.h"
#include "handlers/HaybaMCPNiagaraHandler.h"
#include "handlers/HaybaMCPAudioHandler.h"
#include "handlers/HaybaMCPMetaSoundHandler.h"
#include "handlers/HaybaMCPGASHandler.h"
#include "handlers/HaybaMCPBehaviorTreeHandler.h"
#include "handlers/HaybaMCPInputHandler.h"
#include "handlers/HaybaMCPUIHandler.h"
#include "handlers/HaybaMCPNetworkHandler.h"
#include "handlers/HaybaMCPStaticMeshHandler.h"
#include "handlers/HaybaMCPTextureHandler.h"
#include "handlers/HaybaMCPDataAssetHandler.h"
#include "handlers/HaybaMCPProjectHandler.h"
#include "handlers/HaybaMCPBuildHandler.h"
#include "handlers/HaybaMCPTestHandler.h"
#include "handlers/HaybaMCPPerfHandler.h"
#include "HaybaMCPCaptureActor.h"
#include "HaybaMCPSettings.h"
#include "Json.h"
#include "HAL/PlatformProcess.h"
#include "HAL/PlatformMisc.h"
#include "Misc/Paths.h"
#include "Misc/FileHelper.h"
#include "HAL/FileManager.h"
#include "Logging/LogMacros.h"
#include "ToolMenus.h"
#include "Styling/AppStyle.h"
#include "WorkspaceMenuStructure.h"
#include "WorkspaceMenuStructureModule.h"
#include "Widgets/Docking/SDockTab.h"
#include "Interfaces/IPluginManager.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCP, Log, All);

const FName FHaybaMCPModule::TabMain(TEXT("HaybaMCP_Main"));

void FHaybaMCPModule::StartupModule()
{
    PluginBaseDir = IPluginManager::Get().FindPlugin(TEXT("HaybaMCPToolkit"))->GetBaseDir();
    UE_LOG(LogHaybaMCP, Log, TEXT("HaybaMCPToolkit module started. Base dir: %s"), *PluginBaseDir);

    FHaybaMCPStyle::Initialize();
    FHaybaMCPSettings::Get().Load();

    CommandHandler = MakeShared<FHaybaMCPCommandHandler>();
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPLegacyHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPActorHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPLevelHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPSceneGraphHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPEditorHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPPIEHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPPythonHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPAssetHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPBlueprintHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPMaterialHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPFoliageHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPSplineHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPWorldPartitionHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPISMHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPPhysicsHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPDocsHandler>());

    // ===== Stub handlers (advertise commands; return not_implemented) =====
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPSequencerHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPAnimationHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPNiagaraHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPAudioHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPMetaSoundHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPGASHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPBehaviorTreeHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPInputHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPUIHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPNetworkHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPStaticMeshHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPTextureHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPDataAssetHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPProjectHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPBuildHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPTestHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPPerfHandler>());

    // Auto-start the TCP listener so external MCP clients (Claude Code, Cline,
    // OpenCode, …) can connect as soon as the editor is up. The MCP node
    // server itself can still be started/stopped independently via the panel.
    if (!StartTcpServer())
    {
        UE_LOG(LogHaybaMCP, Error, TEXT("Failed to start TCP listener on port %d at module startup"), TcpPort);
    }

    auto& TM = FGlobalTabmanager::Get();
    auto ToolsGroup = WorkspaceMenu::GetMenuStructure().GetToolsCategory();

    // Single unified panel — all sub-views live inside as a sidebar.
    TM->RegisterNomadTabSpawner(TabMain, FOnSpawnTab::CreateRaw(this, &FHaybaMCPModule::SpawnMainTab))
        .SetDisplayName(NSLOCTEXT("Hayba", "MainTab", "Hayba MCP Toolkit"))
        .SetGroup(ToolsGroup)
        .SetIcon(FSlateIcon(FHaybaMCPStyle::GetStyleSetName(), "Hayba.Icon.Toolkit"));

    IConsoleManager::Get().RegisterConsoleCommand(
        TEXT("Hayba.MCP.Open"),
        TEXT("Opens the Hayba MCP Toolkit"),
        FConsoleCommandDelegate::CreateLambda([]()
        {
            FGlobalTabmanager::Get()->TryInvokeTab(FHaybaMCPModule::TabMain);
        }),
        ECVF_Default
    );

    // Auto-open the panel on first run (Setup sidebar item handles onboarding inline).
    if (!FHaybaMCPSettings::Get().bHasSeenOnboarding && GEditor)
    {
        GEditor->GetTimerManager()->SetTimerForNextTick(FTimerDelegate::CreateLambda([]()
        {
            FGlobalTabmanager::Get()->TryInvokeTab(FHaybaMCPModule::TabMain);
        }));
    }

    // Add Plan Mode toggle to the level-editor toolbar.
    UToolMenus::RegisterStartupCallback(FSimpleMulticastDelegate::FDelegate::CreateLambda([]()
    {
        if (UToolMenu* Menu = UToolMenus::Get()->ExtendMenu("LevelEditor.LevelEditorToolBar.PlayToolBar"))
        {
            FToolMenuSection& Section = Menu->FindOrAddSection("HaybaMCP");
            Section.AddEntry(FToolMenuEntry::InitWidget(
                "HaybaPlanMode",
                SNew(SHaybaMCPPlanModeWidget),
                FText::GetEmpty(),
                true));
        }
    }));
}

void FHaybaMCPModule::ShutdownModule()
{
    auto& TM = FGlobalTabmanager::Get();
    TM->UnregisterNomadTabSpawner(TabMain);
    StopTcpServer();
    StopMCPServer();
    FHaybaMCPStyle::Shutdown();
    UE_LOG(LogHaybaMCP, Log, TEXT("HaybaMCPToolkit module shut down."));
}

bool FHaybaMCPModule::StartTcpServer()
{
    if (TcpServer.IsValid() && TcpServer->IsRunning())
    {
        UE_LOG(LogHaybaMCP, Warning, TEXT("TCP server already running on port %d"), TcpPort);
        return false;
    }
    // Initiative #3: scan a small port range so multiple UE editor instances
    // can run side-by-side without EADDRINUSE collisions. The first instance
    // claims 52342; subsequent ones walk forward. Heartbeat written to disk
    // so the Node MCP server can discover the right port.
    constexpr int32 kPortFirst = 52342;
    constexpr int32 kPortLast  = 52350;
    int32 ChosenPort = INDEX_NONE;
    for (int32 P = kPortFirst; P <= kPortLast; ++P)
    {
        TcpServer = MakeShared<FHaybaMCPTcpServer>(P);
        TcpServer->SetCommandHandler(CommandHandler);
        if (TcpServer->Start())
        {
            ChosenPort = P;
            TcpPort = P;
            break;
        }
        TcpServer.Reset();
    }
    if (ChosenPort == INDEX_NONE)
    {
        UE_LOG(LogHaybaMCP, Error, TEXT("Failed to start TCP server: no free port in %d-%d"), kPortFirst, kPortLast);
        return false;
    }
    UE_LOG(LogHaybaMCP, Log, TEXT("TCP server started on port %d"), TcpPort);

    // Heartbeat file: Saved/HaybaMCP/instances/<pid>.json. The Node MCP
    // server scans this directory at startup and picks the most-recent live
    // entry, removing entries whose PID is no longer alive.
    {
        const FString Dir = FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("HaybaMCP"), TEXT("instances"));
        IFileManager::Get().MakeDirectory(*Dir, true);
        const FString FilePath = FPaths::Combine(Dir, FString::Printf(TEXT("%u.json"), FPlatformProcess::GetCurrentProcessId()));
        const FString Json = FString::Printf(
            TEXT("{\n  \"pid\": %u,\n  \"port\": %d,\n  \"project_dir\": \"%s\",\n  \"started_at\": \"%s\"\n}\n"),
            FPlatformProcess::GetCurrentProcessId(),
            TcpPort,
            *FPaths::ConvertRelativePathToFull(FPaths::ProjectDir()).Replace(TEXT("\\"), TEXT("/")),
            *FDateTime::UtcNow().ToIso8601());
        FFileHelper::SaveStringToFile(Json, *FilePath);
    }
    return true;
}

void FHaybaMCPModule::StopTcpServer()
{
    if (TcpServer.IsValid())
    {
        TcpServer->Shutdown();
        TcpServer.Reset();
        UE_LOG(LogHaybaMCP, Log, TEXT("TCP server stopped."));
    }
}

int32 FHaybaMCPModule::GetTcpClientCount() const
{
    return TcpServer.IsValid() ? TcpServer->GetClientCount() : 0;
}

bool FHaybaMCPModule::IsTcpServerRunning() const
{
    return TcpServer.IsValid() && TcpServer->IsRunning();
}

bool FHaybaMCPModule::StartMCPServer()
{
    if (IsMCPServerRunning())
    {
        UE_LOG(LogHaybaMCP, Warning, TEXT("MCP server is already running."));
        return false;
    }
    if (!IsTcpServerRunning())
    {
        if (!StartTcpServer()) return false;
    }

    FString NodePath = FindNodeExecutable();
    if (NodePath.IsEmpty())
    {
        UE_LOG(LogHaybaMCP, Error, TEXT("Node.js not found."));
        return false;
    }

    FString ServerPath = GetMCPServerPath();
    if (!FPaths::FileExists(ServerPath))
    {
        UE_LOG(LogHaybaMCP, Error, TEXT("MCP server not found at: %s"), *ServerPath);
        return false;
    }

    FPlatformMisc::SetEnvironmentVar(TEXT("DASHBOARD_PORT"), TEXT("52341"));
    FPlatformMisc::SetEnvironmentVar(TEXT("UE_TCP_PORT"), *FString::FromInt(TcpPort));

    FString Params = FString::Printf(TEXT("\"%s\""), *ServerPath);
    uint32 ProcessID = 0;
    MCPProcessHandle = FPlatformProcess::CreateProc(*NodePath, *Params, false, true, true, &ProcessID, 0, nullptr, nullptr, nullptr);

    if (!MCPProcessHandle.IsValid())
    {
        UE_LOG(LogHaybaMCP, Error, TEXT("Failed to start MCP server process."));
        return false;
    }

    MCPPort = 52341;
    UE_LOG(LogHaybaMCP, Log, TEXT("MCP server started. Dashboard: http://127.0.0.1:%d"), MCPPort);
    return true;
}

void FHaybaMCPModule::StopMCPServer()
{
    if (MCPProcessHandle.IsValid())
    {
        FPlatformProcess::TerminateProc(MCPProcessHandle, true);
        FPlatformProcess::CloseProc(MCPProcessHandle);
        MCPProcessHandle = FProcHandle();
        MCPPort = 0;
        UE_LOG(LogHaybaMCP, Log, TEXT("MCP server stopped."));
    }
}

bool FHaybaMCPModule::IsMCPServerRunning() const
{
    return MCPProcessHandle.IsValid() && FPlatformProcess::IsProcRunning(MCPProcessHandle);
}

FString FHaybaMCPModule::GetDashboardURL() const
{
    if (MCPPort > 0) return FString::Printf(TEXT("http://127.0.0.1:%d"), MCPPort);
    return TEXT("");
}

bool FHaybaMCPModule::IsServerRunning() const
{
    return IsTcpServerRunning() && IsMCPServerRunning();
}

void FHaybaMCPModule::SendTcpCommand(
    const FString& Cmd,
    const TSharedRef<FJsonObject>& Params,
    TFunction<void(bool bOk, const TSharedPtr<FJsonObject>& Response)> Callback)
{
    if (!CommandHandler.IsValid()) { Callback(false, nullptr); return; }

    FString RequestId = FString::Printf(TEXT("module_%lld"), FPlatformTime::Cycles64());
    TSharedRef<FJsonObject> Command = MakeShareable(new FJsonObject());
    Command->SetStringField(TEXT("cmd"), Cmd);
    Command->SetStringField(TEXT("id"), RequestId);
    Command->SetObjectField(TEXT("params"), Params);

    FString CommandStr;
    TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
        TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&CommandStr);
    FJsonSerializer::Serialize(Command, Writer);

    FString ResponseStr = CommandHandler->ProcessCommand(CommandStr);

    TSharedPtr<FJsonObject> ResponseObj;
    TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(ResponseStr);
    if (FJsonSerializer::Deserialize(Reader, ResponseObj) && ResponseObj.IsValid())
    {
        bool bOk = false;
        ResponseObj->TryGetBoolField(TEXT("ok"), bOk);
        TSharedPtr<FJsonObject> Data = ResponseObj->GetObjectField(TEXT("data"));
        Callback(bOk, Data);
    }
    else { Callback(false, nullptr); }
}

FString FHaybaMCPModule::FindNodeExecutable() const
{
    FString BundledNode = FPaths::Combine(PluginBaseDir, TEXT("ThirdParty"), TEXT("node"), TEXT("node.exe"));
    if (FPaths::FileExists(BundledNode)) return BundledNode;
    TArray<FString> Candidates = {
        TEXT("C:/Program Files/nodejs/node.exe"),
        TEXT("C:/Program Files (x86)/nodejs/node.exe")
    };
    for (const FString& C : Candidates) { if (FPaths::FileExists(C)) return C; }
    return TEXT("");
}

FString FHaybaMCPModule::GetMCPServerPath() const
{
    return FPaths::Combine(PluginBaseDir, TEXT("ThirdParty"), TEXT("mcp_server"), TEXT("dist"), TEXT("index.js"));
}

TSharedRef<SDockTab> FHaybaMCPModule::OnSpawnTab(const FSpawnTabArgs& Args)
{
    return SpawnMainTab(Args);
}

TSharedRef<SDockTab> FHaybaMCPModule::SpawnMainTab(const FSpawnTabArgs&)
{
    return SNew(SDockTab).TabRole(ETabRole::NomadTab)
        [ SNew(SHaybaMCPMainPanel, this) ];
}

void FHaybaMCPModule::RecordToolCall(const FString& ToolName, const FString& ParamsJson, const FString& ResultJson)
{
    FHaybaToolCallRecord Rec;
    Rec.ToolName   = ToolName;
    Rec.ParamsJson = ParamsJson;
    Rec.ResultJson = ResultJson;
    Rec.Timestamp  = FDateTime::Now();

    {
        FScopeLock Lock(&ToolCallHistoryLock);
        ToolCallHistory.Add(Rec);
        while (ToolCallHistory.Num() > ToolCallHistoryMax)
        {
            ToolCallHistory.RemoveAt(0, 1, EAllowShrinking::No);
        }
    }

    // Marshal to GameThread before firing so Slate subscribers don't have to
    // worry about thread-safety in their handlers.
    AsyncTask(ENamedThreads::GameThread, [this, Rec]()
    {
        OnToolCallRecorded.Broadcast(Rec);
    });
}

TArray<FHaybaToolCallRecord> FHaybaMCPModule::SnapshotToolCalls() const
{
    FScopeLock Lock(&ToolCallHistoryLock);
    return ToolCallHistory;
}

void FHaybaMCPModule::ClearToolCallHistory()
{
    FScopeLock Lock(&ToolCallHistoryLock);
    ToolCallHistory.Empty();
}

IMPLEMENT_MODULE(FHaybaMCPModule, HaybaMCPToolkit)
