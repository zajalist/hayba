#include "HaybaGaeaModule.h"
#include "Framework/Docking/TabManager.h"
#include "WorkspaceMenuStructure.h"
#include "WorkspaceMenuStructureModule.h"
#include "Widgets/Docking/SDockTab.h"
#include "Styling/AppStyle.h"
#include "HAL/IConsoleManager.h"
#include "HaybaGaeaSettings.h"
#include "HaybaGaeaTcpClient.h"
#include "SHaybaGaeaPanel.h"
#include "Serialization/JsonWriter.h"
#include "Serialization/JsonSerializer.h"
#include "Dom/JsonObject.h"
#include "Misc/Guid.h"

#define LOCTEXT_NAMESPACE "HaybaGaea"
IMPLEMENT_MODULE(FHaybaGaeaModule, HaybaGaea)

void FHaybaGaeaModule::StartupModule()
{
	FHaybaGaeaSettings::Get().Load();

	FGlobalTabmanager::Get()->RegisterNomadTabSpawner(
		TEXT("HaybaGaea"),
		FOnSpawnTab::CreateRaw(this, &FHaybaGaeaModule::OnSpawnTab))
		.SetDisplayName(NSLOCTEXT("HaybaGaea", "TabTitle", "Hayba — Terrain AI"))
		.SetTooltipText(NSLOCTEXT("HaybaGaea", "TabTooltip", "AI-driven terrain generation from Gaea"))
		.SetGroup(WorkspaceMenu::GetMenuStructure().GetToolsCategory())
		.SetIcon(FSlateIcon(FAppStyle::GetAppStyleSetName(), "ClassIcon.UserDefinedStruct"));

	OpenCommand = IConsoleManager::Get().RegisterConsoleCommand(
		TEXT("HaybaGaea.Open"),
		TEXT("Opens the Hayba Gaea terrain panel"),
		FConsoleCommandDelegate::CreateLambda([]()
		{
			FGlobalTabmanager::Get()->TryInvokeTab(FName(TEXT("HaybaGaea")));
		}), ECVF_Default);
}

void FHaybaGaeaModule::ShutdownModule()
{
	FGlobalTabmanager::Get()->UnregisterNomadTabSpawner(TEXT("HaybaGaea"));
	if (OpenCommand)
	{
		IConsoleManager::Get().UnregisterConsoleObject(OpenCommand);
		OpenCommand = nullptr;
	}
}

TSharedRef<SDockTab> FHaybaGaeaModule::OnSpawnTab(const FSpawnTabArgs& Args)
{
	return SNew(SDockTab)
		.TabRole(NomadTab)
		[
			SNew(SHaybaGaeaPanel, this)
		];
}

void FHaybaGaeaModule::SendGenerateRequest(
	const FString& Prompt,
	const FString& OutputFolder,
	TFunction<void(bool, const FString&)> Callback)
{
	const FHaybaGaeaSettings& S = FHaybaGaeaSettings::Get();

	TSharedRef<FHaybaGaeaTcpClient> Client = MakeShared<FHaybaGaeaTcpClient>();
	if (!Client->Connect(S.ServerHost, S.ServerPort))
	{
		Callback(false, FString::Printf(
			TEXT("Cannot connect to hayba-gaea-server on %s:%d. Is it running?"),
			*S.ServerHost, S.ServerPort));
		return;
	}

	TSharedRef<FJsonObject> Payload = MakeShared<FJsonObject>();
	Payload->SetStringField(TEXT("id"), FGuid::NewGuid().ToString(EGuidFormats::DigitsWithHyphens));
	Payload->SetStringField(TEXT("command"), TEXT("generate_terrain"));
	Payload->SetStringField(TEXT("prompt"), Prompt);
	Payload->SetStringField(TEXT("outputFolder"), OutputFolder);
	Payload->SetNumberField(TEXT("resolution"), 1024.0);

	FOnHaybaResponse Response;
	Response.BindLambda([Callback](bool bOk, const FString& ResponseJson)
	{
		if (!bOk)
		{
			Callback(false, TEXT("No response from server"));
			return;
		}

		TSharedPtr<FJsonObject> Root;
		TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(ResponseJson);
		if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid())
		{
			Callback(false, TEXT("Invalid JSON response from server"));
			return;
		}

		bool bSuccess = false;
		Root->TryGetBoolField(TEXT("ok"), bSuccess);

		if (!bSuccess)
		{
			FString Error;
			Root->TryGetStringField(TEXT("error"), Error);
			Callback(false, Error);
			return;
		}

		FString HeightmapPath;
		Root->TryGetStringField(TEXT("heightmapPath"), HeightmapPath);
		Callback(true, HeightmapPath);
	});

	Client->Send(Payload, Response);
}

#undef LOCTEXT_NAMESPACE
