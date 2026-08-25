#include "HaybaMCPModule.h"
#include "Async/Async.h"
#include "HaybaMCPMainPanel.h"
#include "Studio/SHaybaSemanticStudio.h"
#include "HaybaMCPPlanOverlay.h"
#include "ToolMenus.h"
#include "ContentBrowserMenuContexts.h"
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
#include "Recipes/HaybaRecipeLoader.h"
#include "Editor.h"
#include "TimerManager.h"
#include "ToolMenus.h"
#include "Framework/Notifications/NotificationManager.h"
#include "Widgets/Notifications/SNotificationList.h"
#include "HaybaMCPTcpServer.h"
#include "HaybaMCPCommandHandler.h"
#include "IHaybaMCPHandler.h"
#include "handlers/HaybaMCPLegacyHandler.h"
#include "handlers/HaybaMCPActorHandler.h"
#include "handlers/HaybaMCPLevelHandler.h"
#include "handlers/HaybaMCPSceneGraphHandler.h"
#include "handlers/HaybaMCPEditorHandler.h"
#include "handlers/HaybaMCPPIEHandler.h"
#include "handlers/HaybaMCPPythonHandler.h"
#include "handlers/HaybaMCPUIBridgeHandler.h"
#include "handlers/HaybaMCPAssetHandler.h"
#include "handlers/HaybaMCPBlueprintHandler.h"
#include "handlers/HaybaMCPMaterialHandler.h"
#include "handlers/HaybaMCPFoliageHandler.h"
#include "handlers/HaybaMCPSplineHandler.h"
#include "handlers/HaybaMCPWorldPartitionHandler.h"
#include "handlers/HaybaMCPISMHandler.h"
#include "handlers/HaybaMCPPhysicsHandler.h"
#include "handlers/HaybaMCPDocsHandler.h"
#include "handlers/HaybaMCPVaultHandler.h"
// ===== Stub handlers (advertise commands; return not_implemented) =====
#include "handlers/HaybaMCPAnimationHandler.h"
#include "handlers/HaybaMCPAudioHandler.h"
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
#include "handlers/HaybaMCPIdleHandler.h"
#include "handlers/HaybaMCPRenderHandler.h"
#include "HaybaMCPCaptureActor.h"
#include "HaybaMCPSettings.h"
#include "Json.h"
#include "HAL/PlatformProcess.h"
#include "HAL/PlatformMisc.h"
#include "Misc/Paths.h"
#include "Misc/FileHelper.h"
#include "HAL/FileManager.h"
#include "Logging/LogMacros.h"
#include "Sockets.h"
#include "SocketSubsystem.h"
#include "IPAddress.h"
#include "ToolMenus.h"
#include "Styling/AppStyle.h"
#include "WorkspaceMenuStructure.h"
#include "WorkspaceMenuStructureModule.h"
#include "Widgets/Docking/SDockTab.h"
#include "Interfaces/IPluginManager.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCP, Log, All);

const FName FHaybaMCPModule::TabMain(TEXT("HaybaMCP_Main"));
const FName FHaybaMCPModule::TabStudio(TEXT("HaybaSemanticStudio"));

namespace
{
    // Parse the port out of a URL like "http://localhost:7821" or
    // "http://127.0.0.1:7821/chat". Returns DefaultPort on any parse failure.
    int32 HaybaParseSidecarPort(const FString& Url, int32 DefaultPort)
    {
        FString Rest = Url;
        int32 SchemeIdx = Rest.Find(TEXT("://"));
        if (SchemeIdx != INDEX_NONE) Rest = Rest.RightChop(SchemeIdx + 3);
        // Strip any path/query so we only look at the authority (host[:port]).
        int32 SlashIdx = INDEX_NONE;
        if (Rest.FindChar(TEXT('/'), SlashIdx)) Rest = Rest.Left(SlashIdx);
        int32 ColonIdx = INDEX_NONE;
        if (Rest.FindLastChar(TEXT(':'), ColonIdx))
        {
            const FString PortStr = Rest.RightChop(ColonIdx + 1);
            if (PortStr.IsNumeric())
            {
                const int32 P = FCString::Atoi(*PortStr);
                if (P > 0 && P <= 65535) return P;
            }
        }
        return DefaultPort;
    }

    // Lightweight, non-blocking TCP reachability probe against 127.0.0.1:<Port>.
    // Never throws / never hangs: a non-blocking connect + bounded Wait. Used so
    // we don't double-spawn when a sidecar (manually-run or a prior instance) is
    // already listening. Returns false on any error.
    bool HaybaIsPortReachable(int32 Port, float TimeoutSeconds)
    {
        ISocketSubsystem* SS = ISocketSubsystem::Get(PLATFORM_SOCKETSUBSYSTEM);
        if (!SS) return false;

        TSharedRef<FInternetAddr> Addr = SS->CreateInternetAddr();
        bool bAddrValid = false;
        Addr->SetIp(TEXT("127.0.0.1"), bAddrValid);
        Addr->SetPort(Port);
        if (!bAddrValid) return false;

        FSocket* Socket = SS->CreateSocket(NAME_Stream, TEXT("HaybaSidecarProbe"), false);
        if (!Socket) return false;

        Socket->SetNonBlocking(true);
        Socket->Connect(*Addr);

        bool bReachable = false;
        if (Socket->Wait(ESocketWaitConditions::WaitForWrite, FTimespan::FromSeconds(TimeoutSeconds)))
        {
            bReachable = (Socket->GetConnectionState() == SCS_Connected);
        }

        Socket->Close();
        SS->DestroySocket(Socket);
        return bReachable;
    }
}

void FHaybaMCPModule::StartupModule()
{
    PluginBaseDir = IPluginManager::Get().FindPlugin(TEXT("HaybaMCPToolkit"))->GetBaseDir();
    UE_LOG(LogHaybaMCP, Log, TEXT("HaybaMCPToolkit module started. Base dir: %s"), *PluginBaseDir);

    FHaybaMCPStyle::Initialize();
    FHaybaMCPSettings::Get().Load();

    // Adopt a pre-rename recipe library. This belongs at startup, not in the
    // Recipes panel: a data migration that only runs if the user happens to
    // open a particular tab is not a migration, it is a coin flip. The MCP
    // server performs the same move on its own startup and the two are
    // expected to race -- the move is atomic, so losing is harmless.
    FHaybaRecipeLoader::MigrateLegacyLibrary(
        FHaybaRecipeLoader::LegacyUserRecipesDir(),
        FHaybaRecipeLoader::DefaultUserRecipesDir());

    CommandHandler = MakeShared<FHaybaMCPCommandHandler>();
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPLegacyHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPActorHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPLevelHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPSceneGraphHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPEditorHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPPIEHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPPythonHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPUIBridgeHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPAssetHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPBlueprintHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPMaterialHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPFoliageHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPSplineHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPWorldPartitionHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPISMHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPPhysicsHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPDocsHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPVaultHandler>());

    // ===== Domains split out to satellite plugins, plus the rest =====
    //
    // This block was headed "Stub handlers (advertise commands; return
    // not_implemented)". That has not been true for some time: every handler
    // below is a real implementation — Animation 454 lines, UI 3109, Render 610,
    // Test 543, StaticMesh 586, and so on, with no not_implemented among them.
    // The comment mattered because it told a reader these domains do not work,
    // so the honest ones were as likely to be avoided as the stubs ever were.
    //
    // seq_* commands now live in the optional HaybaMCPSequencer satellite plugin.
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPAnimationHandler>());
    // niagara_* commands now live in the optional HaybaMCPNiagara satellite plugin.
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPAudioHandler>());
    // metasound_* commands now live in the optional HaybaMCPMetaSound satellite plugin.
    // gas_* commands now live in the optional HaybaMCPGAS satellite plugin,
    // which self-registers via FHaybaMCPModule::RegisterExternalHandler.
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
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPIdleHandler>());
    CommandHandler->RegisterHandler(MakeShared<FHaybaMCPRenderHandler>());

    // Optional-capability check: warn (log + editor notification) for any
    // satellite plugin that is disabled, so the user understands why a command
    // domain is missing. IPluginManager knows enablement even before the
    // satellite's own module loads, so this is safe here at core startup.
    {
        const TPair<const TCHAR*, const TCHAR*> Satellites[] = {
            { TEXT("HaybaMCPGAS"),       TEXT("gas_*") },
            { TEXT("HaybaMCPNiagara"),   TEXT("niagara_*") },
            { TEXT("HaybaMCPMetaSound"), TEXT("metasound_*") },
            { TEXT("HaybaMCPSequencer"), TEXT("seq_*") },
        };
        TArray<FString> Missing;
        for (const auto& S : Satellites)
        {
            TSharedPtr<IPlugin> P = IPluginManager::Get().FindPlugin(S.Key);
            if (!P.IsValid() || !P->IsEnabled())
            {
                Missing.Add(FString::Printf(TEXT("%s (%s)"), S.Value, S.Key));
            }
        }
        if (Missing.Num() > 0)
        {
            const FString List = FString::Join(Missing, TEXT(", "));
            UE_LOG(LogHaybaMCP, Warning,
                TEXT("Optional command domains unavailable — satellite plugin(s) disabled: %s. Enable the plugin (and its backing engine plugin) to use these commands."),
                *List);
            AsyncTask(ENamedThreads::GameThread, [List]()
            {
                FNotificationInfo Info(FText::FromString(FString::Printf(
                    TEXT("Hayba MCP: optional command domains disabled — %s. Enable the matching plugins to use them."), *List)));
                Info.ExpireDuration = 8.f;
                FSlateNotificationManager::Get().AddNotification(Info);
            });
        }
    }

    // Auto-start the TCP listener so external MCP clients (Claude Code, Cline,
    // OpenCode, …) can connect as soon as the editor is up. The MCP node
    // server itself can still be started/stopped independently via the panel.
    if (!StartTcpServer())
    {
        UE_LOG(LogHaybaMCP, Error, TEXT("Failed to start TCP listener on port %d at module startup"), TcpPort);
    }

    // Auto-start the Node chat sidecar so the in-editor chat works with no manual
    // step. Skip if disabled, or if something is already listening on the sidecar
    // port (a manually-run sidecar or a prior instance) — in that case we reuse it.
    if (FHaybaMCPSettings::Get().bAutoStartSidecar)
    {
        const int32 SidecarPort = HaybaParseSidecarPort(FHaybaMCPSettings::Get().SidecarURL, 7821);
        // Short, bounded probe so we never block editor startup.
        if (HaybaIsPortReachable(SidecarPort, 0.25f))
        {
            UE_LOG(LogHaybaMCP, Log, TEXT("Chat sidecar already reachable on port %d — reusing it (not spawning)."), SidecarPort);
        }
        else if (!StartMCPServer())
        {
            UE_LOG(LogHaybaMCP, Warning, TEXT("Auto-start of chat sidecar failed — start it manually from the Hayba panel."));
        }
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

    // Semantic Studio — per-asset mask + constraint authoring window.
    TM->RegisterNomadTabSpawner(TabStudio, FOnSpawnTab::CreateRaw(this, &FHaybaMCPModule::SpawnStudioTab))
        .SetDisplayName(NSLOCTEXT("Hayba", "StudioTab", "Hayba Semantic Studio"))
        .SetGroup(ToolsGroup)
        .SetIcon(FSlateIcon(FHaybaMCPStyle::GetStyleSetName(), "Hayba.Icon.Toolkit"));

    IConsoleManager::Get().RegisterConsoleCommand(
        TEXT("Hayba.Studio.Open"),
        TEXT("Opens the Hayba Semantic Studio. Optional arg: an asset path to target."),
        FConsoleCommandWithArgsDelegate::CreateLambda([](const TArray<FString>& Args)
        {
            if (Args.Num() > 0)
            {
                if (FHaybaMCPModule* M = FModuleManager::GetModulePtr<FHaybaMCPModule>("HaybaMCPToolkit"))
                {
                    M->OpenStudioForAsset(Args[0]);
                    return;
                }
            }
            FGlobalTabmanager::Get()->TryInvokeTab(FHaybaMCPModule::TabStudio);
        }),
        ECVF_Default
    );

    // "Open with Hayba" content-browser action — registered once ToolMenus is up.
    UToolMenus::RegisterStartupCallback(
        FSimpleMulticastDelegate::FDelegate::CreateRaw(this, &FHaybaMCPModule::RegisterStudioContentMenu));

    // Green/red plan-mode viewport overlay (reads .scratch/verdicts.json).
    PlanOverlay = MakeUnique<FHaybaPlanOverlay>();
    PlanOverlay->Register();

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

    // Recipes live as a page inside the main toolkit panel (EHaybaPanel::Recipes).
    // Only the param-widget factory registry needs module-level init.
    extern void HaybaRecipe_RegisterBuiltinParamWidgets();
    HaybaRecipe_RegisterBuiltinParamWidgets();
}

void FHaybaMCPModule::ShutdownModule()
{
    // Ticker lambdas execute plugin code. Remove/fail an in-flight test job
    // before module unload so no callback can jump into an unloaded DLL.
    FHaybaMCPTestHandler::ShutdownActiveRun();
    auto& TM = FGlobalTabmanager::Get();
    if (PlanOverlay) { PlanOverlay->Unregister(); PlanOverlay.Reset(); }
    TM->UnregisterNomadTabSpawner(TabMain);
    TM->UnregisterNomadTabSpawner(TabStudio);
    UToolMenus::UnRegisterStartupCallback(this);
    UToolMenus::UnregisterOwner(this);
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
        TcpServer = MakeShared<FHaybaMCPTcpServer, ESPMode::ThreadSafe>(P);
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

    // Host the sidecar (chat SSE routes + dashboard) on the port the C++ chat
    // panel talks to: HaybaMCPSettings::SidecarURL (default 7821). Parsing keeps
    // the two ends in lockstep instead of a hardcoded constant.
    const int32 SidecarPort = HaybaParseSidecarPort(FHaybaMCPSettings::Get().SidecarURL, 7821);
    FPlatformMisc::SetEnvironmentVar(TEXT("DASHBOARD_PORT"), *FString::FromInt(SidecarPort));
    FPlatformMisc::SetEnvironmentVar(TEXT("UE_TCP_PORT"), *FString::FromInt(TcpPort));

    // Point the PLUMB stores at the project's .scratch so the MCP server and the
    // plugin's Semantic Studio / Memory panels read & write the same files.
    const FString ScratchDir = FPaths::ConvertRelativePathToFull(FPaths::Combine(FPaths::ProjectDir(), TEXT(".scratch")));
    IFileManager::Get().MakeDirectory(*ScratchDir, true);
    FPlatformMisc::SetEnvironmentVar(TEXT("HAYBA_PROFILES"), *FPaths::Combine(ScratchDir, TEXT("profiles.json")));
    FPlatformMisc::SetEnvironmentVar(TEXT("HAYBA_CONSTRAINTS"), *FPaths::Combine(ScratchDir, TEXT("constraints.json")));
    FPlatformMisc::SetEnvironmentVar(TEXT("HAYBA_LESSONS"), *FPaths::Combine(ScratchDir, TEXT("lessons.json")));

    FString Params = FString::Printf(TEXT("\"%s\""), *ServerPath);
    uint32 ProcessID = 0;
    MCPProcessHandle = FPlatformProcess::CreateProc(*NodePath, *Params, false, true, true, &ProcessID, 0, nullptr, nullptr, nullptr);

    if (!MCPProcessHandle.IsValid())
    {
        UE_LOG(LogHaybaMCP, Error, TEXT("Failed to start MCP server process."));
        return false;
    }

    MCPPort = SidecarPort;
    UE_LOG(LogHaybaMCP, Log, TEXT("MCP server started (entry: %s). Dashboard/chat: http://127.0.0.1:%d"), *ServerPath, MCPPort);
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

void FHaybaMCPModule::RegisterExternalHandler(TSharedRef<IHaybaMCPHandler> Handler)
{
    if (CommandHandler.IsValid()) CommandHandler->RegisterHandler(Handler);
}

void FHaybaMCPModule::UnregisterExternalHandler(const TSharedRef<IHaybaMCPHandler>& Handler)
{
    if (CommandHandler.IsValid()) CommandHandler->UnregisterHandler(Handler);
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
    // (a) Explicit override from settings, if it points at a real file.
    const FString Override = FHaybaMCPSettings::Get().SidecarEntryPath;
    if (!Override.IsEmpty() && FPaths::FileExists(Override))
    {
        UE_LOG(LogHaybaMCP, Log, TEXT("MCP server entry (override): %s"), *Override);
        return Override;
    }

    // (b) Repo dev build. The plugin is symlinked into the project from the repo,
    // so PluginBaseDir == <repo>/unreal/HaybaMCPToolkit and "../../" reaches the
    // repo root, where the built server lives at mcp-tools/hayba-mcp/dist/index.js.
    const FString DevBuild = FPaths::ConvertRelativePathToFull(
        FPaths::Combine(PluginBaseDir, TEXT(".."), TEXT(".."),
                        TEXT("mcp-tools"), TEXT("hayba-mcp"), TEXT("dist"), TEXT("index.js")));
    if (FPaths::FileExists(DevBuild))
    {
        UE_LOG(LogHaybaMCP, Log, TEXT("MCP server entry (repo dev build): %s"), *DevBuild);
        return DevBuild;
    }

    // (b') Symlink-resolved dev build. GetBaseDir() returns the symlink path
    // (e.g. <project>/Plugins/HaybaMCPToolkit) when the plugin is symlinked into
    // the project from a repo checkout, so the "../.." above lands in the project,
    // not the repo. Resolve the on-disk target first, then reach the repo build.
    const FString ResolvedBase = IFileManager::Get().GetFilenameOnDisk(*PluginBaseDir);
    if (!ResolvedBase.IsEmpty() && ResolvedBase != PluginBaseDir)
    {
        const FString DevBuild2 = FPaths::ConvertRelativePathToFull(
            FPaths::Combine(ResolvedBase, TEXT(".."), TEXT(".."),
                            TEXT("mcp-tools"), TEXT("hayba-mcp"), TEXT("dist"), TEXT("index.js")));
        if (FPaths::FileExists(DevBuild2))
        {
            UE_LOG(LogHaybaMCP, Log, TEXT("MCP server entry (symlink-resolved dev build): %s"), *DevBuild2);
            return DevBuild2;
        }
    }

    // (c) Bundled shipping fallback under the plugin's ThirdParty.
    const FString Bundled = FPaths::Combine(PluginBaseDir, TEXT("ThirdParty"), TEXT("mcp_server"), TEXT("dist"), TEXT("index.js"));
    UE_LOG(LogHaybaMCP, Log, TEXT("MCP server entry (bundled fallback): %s"), *Bundled);
    return Bundled;
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

TSharedRef<SDockTab> FHaybaMCPModule::SpawnStudioTab(const FSpawnTabArgs&)
{
    TSharedRef<SHaybaSemanticStudio> Studio = SNew(SHaybaSemanticStudio).AssetPath(PendingStudioAsset);
    StudioWidget = Studio;
    return SNew(SDockTab).TabRole(ETabRole::NomadTab) [ Studio ];
}

void FHaybaMCPModule::OpenStudioForAsset(const FString& AssetPath)
{
    PendingStudioAsset = AssetPath;
    // If the Studio is already open, retarget it in place; otherwise invoking
    // the tab spawns a fresh one seeded with PendingStudioAsset.
    if (TSharedPtr<SHaybaSemanticStudio> Live = StudioWidget.Pin())
    {
        Live->SetAsset(AssetPath);
    }
    FGlobalTabmanager::Get()->TryInvokeTab(TabStudio);
}

void FHaybaMCPModule::RegisterStudioContentMenu()
{
    UToolMenus* ToolMenus = UToolMenus::Get();
    if (!ToolMenus) return;

    UToolMenu* Menu = ToolMenus->ExtendMenu("ContentBrowser.AssetContextMenu.StaticMesh");
    if (!Menu) return;

    FToolMenuSection& Section = Menu->FindOrAddSection("GetAssetActions");
    Section.AddMenuEntry(
        "OpenWithHayba",
        NSLOCTEXT("Hayba", "OpenWithHayba", "Open with Hayba"),
        NSLOCTEXT("Hayba", "OpenWithHaybaTip", "Open this Static Mesh in the Hayba Semantic Studio"),
        FSlateIcon(FHaybaMCPStyle::GetStyleSetName(), "Hayba.Icon.Toolkit"),
        FToolMenuExecuteAction::CreateLambda([](const FToolMenuContext& Context)
        {
            const UContentBrowserAssetContextMenuContext* Ctx =
                Context.FindContext<UContentBrowserAssetContextMenuContext>();
            if (!Ctx || Ctx->SelectedAssets.Num() == 0) return;
            const FString AssetPath = Ctx->SelectedAssets[0].GetObjectPathString();
            if (FHaybaMCPModule* Module = FModuleManager::GetModulePtr<FHaybaMCPModule>("HaybaMCPToolkit"))
            {
                Module->OpenStudioForAsset(AssetPath);
            }
        })
    );
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
