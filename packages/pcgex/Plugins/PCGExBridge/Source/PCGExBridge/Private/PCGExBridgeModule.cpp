#include "PCGExBridgeModule.h"
#include "PCGExWizardWidget.h"
#include "PCGExBridgeTcpServer.h"
#include "PCGExBridgeCommandHandler.h"
#include "PCGExBridgeSettings.h"
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

DEFINE_LOG_CATEGORY_STATIC(LogPCGExBridge, Log, All);

void FPCGExBridgeModule::StartupModule()
{
    PluginBaseDir = IPluginManager::Get().FindPlugin(TEXT("PCGExBridge"))->GetBaseDir();
    UE_LOG(LogPCGExBridge, Log, TEXT("PCGExBridge module started. Base dir: %s"), *PluginBaseDir);

    FPCGExBridgeSettings::Get().Load();

    CommandHandler = MakeShared<FPCGExBridgeCommandHandler>();

    FGlobalTabmanager::Get()->RegisterNomadTabSpawner(
        TEXT("PCGExBridge"),
        FOnSpawnTab::CreateRaw(this, &FPCGExBridgeModule::OnSpawnTab))
        .SetDisplayName(NSLOCTEXT("PCGExBridge", "TabTitle", "PCGEx Bridge"))
        .SetTooltipText(NSLOCTEXT("PCGExBridge", "TabTooltip", "Open the PCGEx Bridge wizard panel"))
        .SetGroup(WorkspaceMenu::GetMenuStructure().GetToolsCategory())
        .SetIcon(FSlateIcon(FAppStyle::GetAppStyleSetName(), "ClassIcon.UserDefinedStruct"));

    // Also register a console command to open the tab
    IConsoleManager::Get().RegisterConsoleCommand(
        TEXT("PCGExBridge.Open"),
        TEXT("Opens the PCGEx Bridge wizard panel"),
        FConsoleCommandDelegate::CreateLambda([]()
        {
            FGlobalTabmanager::Get()->TryInvokeTab(FName(TEXT("PCGExBridge")));
        }),
        ECVF_Default
    );
}

void FPCGExBridgeModule::ShutdownModule()
{
    FGlobalTabmanager::Get()->UnregisterNomadTabSpawner(TEXT("PCGExBridge"));
    StopTcpServer();
    StopMCPServer();
    UE_LOG(LogPCGExBridge, Log, TEXT("PCGExBridge module shut down."));
}

bool FPCGExBridgeModule::StartTcpServer()
{
    if (TcpServer.IsValid() && TcpServer->IsRunning())
    {
        UE_LOG(LogPCGExBridge, Warning, TEXT("TCP server already running on port %d"), TcpPort);
        return false;
    }

    TcpServer = MakeShared<FPCGExBridgeTcpServer>(TcpPort);

    if (!TcpServer->Start())
    {
        UE_LOG(LogPCGExBridge, Error, TEXT("Failed to start TCP server on port %d"), TcpPort);
        TcpServer.Reset();
        return false;
    }

    UE_LOG(LogPCGExBridge, Log, TEXT("TCP server started on port %d"), TcpPort);
    return true;
}

void FPCGExBridgeModule::StopTcpServer()
{
    if (TcpServer.IsValid())
    {
        TcpServer->Shutdown();
        TcpServer.Reset();
        UE_LOG(LogPCGExBridge, Log, TEXT("TCP server stopped."));
    }
}

bool FPCGExBridgeModule::IsTcpServerRunning() const
{
    return TcpServer.IsValid() && TcpServer->IsRunning();
}

bool FPCGExBridgeModule::StartMCPServer()
{
    if (IsMCPServerRunning())
    {
        UE_LOG(LogPCGExBridge, Warning, TEXT("MCP server is already running."));
        return false;
    }

    if (!IsTcpServerRunning())
    {
        if (!StartTcpServer())
        {
            return false;
        }
    }

    FString NodePath = FindNodeExecutable();
    if (NodePath.IsEmpty())
    {
        UE_LOG(LogPCGExBridge, Error, TEXT("Node.js not found."));
        return false;
    }

    FString ServerPath = GetMCPServerPath();
    if (!FPaths::FileExists(ServerPath))
    {
        UE_LOG(LogPCGExBridge, Error, TEXT("MCP server not found at: %s"), *ServerPath);
        return false;
    }

    FString Params = FString::Printf(TEXT("\"%s\""), *ServerPath);

    FPlatformMisc::SetEnvironmentVar(TEXT("DASHBOARD_PORT"), TEXT("52341"));
    FPlatformMisc::SetEnvironmentVar(TEXT("UE_TCP_PORT"), *FString::FromInt(TcpPort));

    uint32 ProcessID = 0;
    MCPProcessHandle = FPlatformProcess::CreateProc(*NodePath, *Params, false, true, true, &ProcessID, 0, nullptr, nullptr, nullptr);

    if (!MCPProcessHandle.IsValid())
    {
        UE_LOG(LogPCGExBridge, Error, TEXT("Failed to start MCP server process."));
        return false;
    }

    MCPPort = 52341;
    UE_LOG(LogPCGExBridge, Log, TEXT("MCP server started. Dashboard: http://127.0.0.1:%d"), MCPPort);
    return true;
}

void FPCGExBridgeModule::StopMCPServer()
{
    if (MCPProcessHandle.IsValid())
    {
        FPlatformProcess::TerminateProc(MCPProcessHandle, true);
        FPlatformProcess::CloseProc(MCPProcessHandle);
        MCPProcessHandle = FProcHandle();
        MCPPort = 0;
        UE_LOG(LogPCGExBridge, Log, TEXT("MCP server stopped."));
    }
}

bool FPCGExBridgeModule::IsMCPServerRunning() const
{
    return MCPProcessHandle.IsValid() && FPlatformProcess::IsProcRunning(MCPProcessHandle);
}

FString FPCGExBridgeModule::GetDashboardURL() const
{
    if (MCPPort > 0) return FString::Printf(TEXT("http://127.0.0.1:%d"), MCPPort);
    return TEXT("");
}

bool FPCGExBridgeModule::IsServerRunning() const
{
    return IsTcpServerRunning() && IsMCPServerRunning();
}

void FPCGExBridgeModule::SendTcpCommand(
    const FString& Cmd,
    const TSharedRef<FJsonObject>& Params,
    TFunction<void(bool bOk, const TSharedPtr<FJsonObject>& Response)> Callback)
{
    if (!CommandHandler.IsValid())
    {
        Callback(false, nullptr);
        return;
    }

    // Build the command JSON and process it synchronously through the command handler
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

    // Parse the response
    TSharedPtr<FJsonObject> ResponseObj;
    TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(ResponseStr);
    if (FJsonSerializer::Deserialize(Reader, ResponseObj) && ResponseObj.IsValid())
    {
        bool bOk = false;
        ResponseObj->TryGetBoolField(TEXT("ok"), bOk);
        TSharedPtr<FJsonObject> Data = ResponseObj->GetObjectField(TEXT("data"));
        Callback(bOk, Data);
    }
    else
    {
        Callback(false, nullptr);
    }
}

FString FPCGExBridgeModule::FindNodeExecutable() const
{
    FString BundledNode = FPaths::Combine(PluginBaseDir, TEXT("ThirdParty"), TEXT("node"), TEXT("node.exe"));
    if (FPaths::FileExists(BundledNode)) return BundledNode;

    TArray<FString> Candidates = {
        TEXT("C:/Program Files/nodejs/node.exe"),
        TEXT("C:/Program Files (x86)/nodejs/node.exe")
    };
    for (const FString& C : Candidates)
    {
        if (FPaths::FileExists(C)) return C;
    }
    return TEXT("");
}

FString FPCGExBridgeModule::GetMCPServerPath() const
{
    return FPaths::Combine(PluginBaseDir, TEXT("ThirdParty"), TEXT("mcp_server"), TEXT("dist"), TEXT("index.js"));
}

TSharedRef<SDockTab> FPCGExBridgeModule::OnSpawnTab(const FSpawnTabArgs& Args)
{
    return SNew(SDockTab)
        .TabRole(ETabRole::NomadTab)
        [
            SNew(SPCGExWizardWidget, this)
        ];
}

IMPLEMENT_MODULE(FPCGExBridgeModule, PCGExBridge)
