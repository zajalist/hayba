#include "HaybaMCPModule.h"
#include "HaybaMCPWizardWidget.h"
#include "HaybaMCPTcpServer.h"
#include "HaybaMCPCommandHandler.h"
#include "HaybaMCPSettings.h"
#include "Json.h"
#include "HAL/PlatformProcess.h"
#include "HAL/PlatformMisc.h"
#include "Misc/Paths.h"
#include "Logging/LogMacros.h"
#include "ToolMenus.h"
#include "Styling/AppStyle.h"
#include "WorkspaceMenuStructure.h"
#include "WorkspaceMenuStructureModule.h"
#include "Widgets/Docking/SDockTab.h"
#include "Interfaces/IPluginManager.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCP, Log, All);

void FHaybaMCPModule::StartupModule()
{
    PluginBaseDir = IPluginManager::Get().FindPlugin(TEXT("HaybaMCPToolkit"))->GetBaseDir();
    UE_LOG(LogHaybaMCP, Log, TEXT("HaybaMCPToolkit module started. Base dir: %s"), *PluginBaseDir);

    FHaybaMCPSettings::Get().Load();

    CommandHandler = MakeShared<FHaybaMCPCommandHandler>();

    FGlobalTabmanager::Get()->RegisterNomadTabSpawner(
        TEXT("HaybaMCPToolkit"),
        FOnSpawnTab::CreateRaw(this, &FHaybaMCPModule::OnSpawnTab))
        .SetDisplayName(NSLOCTEXT("HaybaMCPToolkit", "TabTitle", "Hayba MCP Toolkit"))
        .SetTooltipText(NSLOCTEXT("HaybaMCPToolkit", "TabTooltip", "Open the Hayba MCP Toolkit panel"))
        .SetGroup(WorkspaceMenu::GetMenuStructure().GetToolsCategory())
        .SetIcon(FSlateIcon(FAppStyle::GetAppStyleSetName(), "ClassIcon.UserDefinedStruct"));

    IConsoleManager::Get().RegisterConsoleCommand(
        TEXT("Hayba.MCP.Open"),
        TEXT("Opens the Hayba MCP Toolkit panel"),
        FConsoleCommandDelegate::CreateLambda([]()
        {
            FGlobalTabmanager::Get()->TryInvokeTab(FName(TEXT("HaybaMCPToolkit")));
        }),
        ECVF_Default
    );
}

void FHaybaMCPModule::ShutdownModule()
{
    FGlobalTabmanager::Get()->UnregisterNomadTabSpawner(TEXT("HaybaMCPToolkit"));
    StopTcpServer();
    StopMCPServer();
    UE_LOG(LogHaybaMCP, Log, TEXT("HaybaMCPToolkit module shut down."));
}

bool FHaybaMCPModule::StartTcpServer()
{
    if (TcpServer.IsValid() && TcpServer->IsRunning())
    {
        UE_LOG(LogHaybaMCP, Warning, TEXT("TCP server already running on port %d"), TcpPort);
        return false;
    }
    TcpServer = MakeShared<FHaybaMCPTcpServer>(TcpPort);
    if (!TcpServer->Start())
    {
        UE_LOG(LogHaybaMCP, Error, TEXT("Failed to start TCP server on port %d"), TcpPort);
        TcpServer.Reset();
        return false;
    }
    UE_LOG(LogHaybaMCP, Log, TEXT("TCP server started on port %d"), TcpPort);
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
    return SNew(SDockTab)
        .TabRole(ETabRole::NomadTab)
        [
            SNew(SHaybaMCPWizardWidget, this)
        ];
}

IMPLEMENT_MODULE(FHaybaMCPModule, HaybaMCPToolkit)
