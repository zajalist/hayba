#include "SHaybaGaeaPanel.h"
#include "HaybaGaeaModule.h"
#include "HaybaGaeaSettings.h"
#include "HaybaGaeaLandscapeImporter.h"
#include "Widgets/Layout/SScrollBox.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Layout/SSeparator.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SMultiLineEditableTextBox.h"
#include "Widgets/Input/SEditableTextBox.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/SBoxPanel.h"
#include "Misc/DateTime.h"
#include "Styling/CoreStyle.h"

static const FLinearColor HaybaOrange(1.0f, 0.42f, 0.21f, 1.0f);   // #ff6b35
static const FLinearColor HaybaBG(0.07f, 0.07f, 0.07f, 1.0f);
static const FLinearColor HaybaPanel(0.11f, 0.11f, 0.11f, 1.0f);
static const FLinearColor HaybaText(0.85f, 0.85f, 0.85f, 1.0f);
static const FLinearColor HaybaMuted(0.3f, 0.3f, 0.3f, 1.0f);
static const FLinearColor HaybaSuccess(0.26f, 0.7f, 0.26f, 1.0f);
static const FLinearColor HaybaError(0.87f, 0.2f, 0.2f, 1.0f);

void SHaybaGaeaPanel::Construct(const FArguments& InArgs, FHaybaGaeaModule* InModule)
{
	Module = InModule;
	const FHaybaGaeaSettings& S = FHaybaGaeaSettings::Get();

	ChildSlot
	[
		SNew(SBorder)
		.BorderBackgroundColor(HaybaBG)
		.Padding(0)
		[
			SNew(SVerticalBox)
			+ SVerticalBox::Slot().AutoHeight()
			[ BuildTopBar() ]
			+ SVerticalBox::Slot().AutoHeight().Padding(8, 6)
			[ BuildSettingsRow() ]
			+ SVerticalBox::Slot().AutoHeight().Padding(8, 0, 8, 8)
			[ BuildPromptArea() ]
			+ SVerticalBox::Slot().FillHeight(1.0f).Padding(8, 0, 8, 8)
			[ BuildLog() ]
		]
	];

	AddLog(TEXT("Ready. Enter a terrain description and click Generate Landscape."));
	AddLog(FString::Printf(
		TEXT("Server: 127.0.0.1:%d  —  run 'node packages/haybagaea-server/dist/index.js' before generating."),
		S.ServerPort));
}

TSharedRef<SWidget> SHaybaGaeaPanel::BuildTopBar()
{
	return SNew(SBorder)
		.BorderBackgroundColor(HaybaPanel)
		.Padding(FMargin(12, 8))
		[
			SNew(SHorizontalBox)
			+ SHorizontalBox::Slot().VAlign(VAlign_Center)
			[
				SNew(STextBlock)
				.Text(FText::FromString(TEXT("HAYBA — TERRAIN AI")))
				.Font(FCoreStyle::GetDefaultFontStyle("Bold", 11))
				.ColorAndOpacity(HaybaOrange)
			]
		];
}

TSharedRef<SWidget> SHaybaGaeaPanel::BuildSettingsRow()
{
	const FHaybaGaeaSettings& S = FHaybaGaeaSettings::Get();

	return SNew(SHorizontalBox)
		+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(0, 0, 6, 0)
		[
			SNew(STextBlock)
			.Text(FText::FromString(TEXT("Output folder:")))
			.Font(FCoreStyle::GetDefaultFontStyle("Regular", 8))
			.ColorAndOpacity(HaybaMuted)
		]
		+ SHorizontalBox::Slot().FillWidth(1.0f)
		[
			SAssignNew(OutputFolderBox, SEditableTextBox)
			.Text(FText::FromString(S.HeightmapOutputFolder))
			.Font(FCoreStyle::GetDefaultFontStyle("Regular", 8))
		];
}

TSharedRef<SWidget> SHaybaGaeaPanel::BuildPromptArea()
{
	return SNew(SVerticalBox)
		+ SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 6)
		[
			SAssignNew(PromptBox, SMultiLineEditableTextBox)
			.HintText(FText::FromString(TEXT("Describe your terrain... e.g. 'A dramatic mountain range with heavy erosion and snow caps'")))
			.Font(FCoreStyle::GetDefaultFontStyle("Regular", 9))
			.AutoWrapText(true)
		]
		+ SVerticalBox::Slot().AutoHeight()
		[
			SNew(SButton)
			.Text(FText::FromString(TEXT("Generate Landscape")))
			.OnClicked(this, &SHaybaGaeaPanel::OnGenerate)
			.IsEnabled(this, &SHaybaGaeaPanel::CanGenerate)
			.ButtonColorAndOpacity(HaybaOrange)
		];
}

TSharedRef<SWidget> SHaybaGaeaPanel::BuildLog()
{
	return SNew(SBorder)
		.BorderBackgroundColor(HaybaPanel)
		.Padding(6)
		[
			SAssignNew(LogBox, SScrollBox)
		];
}

FReply SHaybaGaeaPanel::OnGenerate()
{
	if (!CanGenerate()) return FReply::Handled();

	FString Prompt = PromptBox->GetText().ToString().TrimStartAndEnd();
	if (Prompt.IsEmpty())
	{
		AddLog(TEXT("Please enter a terrain description."), true);
		return FReply::Handled();
	}

	FString OutputFolder;
	if (OutputFolderBox.IsValid()) OutputFolder = OutputFolderBox->GetText().ToString();
	if (OutputFolder.IsEmpty()) OutputFolder = FHaybaGaeaSettings::Get().HeightmapOutputFolder;

	bGenerating = true;
	AddLog(FString::Printf(TEXT("Generating terrain: \"%s\"..."), *Prompt));

	Module->SendGenerateRequest(Prompt, OutputFolder,
		[this](bool bOk, const FString& Result)
		{
			bGenerating = false;
			if (!bOk)
			{
				AddLog(FString::Printf(TEXT("Failed: %s"), *Result), true);
				return;
			}

			AddLog(FString::Printf(TEXT("Heightmap ready: %s"), *Result));
			AddLog(TEXT("Importing as landscape..."));

			bool bImported = FHaybaGaeaLandscapeImporter::ImportHeightmap(Result);
			if (bImported)
				AddLog(TEXT("Landscape created successfully!"));
			else
				AddLog(TEXT("Landscape import failed — check Output Log for details."), true);
		});

	return FReply::Handled();
}

void SHaybaGaeaPanel::AddLog(const FString& Text, bool bError)
{
	if (!LogBox.IsValid()) return;

	FString Timestamp = FDateTime::Now().ToString(TEXT("[%H:%M:%S] "));
	FLinearColor Color = bError ? HaybaError : HaybaText;

	LogBox->AddSlot()
	[
		SNew(STextBlock)
		.Text(FText::FromString(Timestamp + Text))
		.Font(FCoreStyle::GetDefaultFontStyle("Regular", 8))
		.ColorAndOpacity(Color)
		.AutoWrapText(true)
	];

	LogBox->ScrollToEnd();
}

bool SHaybaGaeaPanel::CanGenerate() const
{
	return !bGenerating && Module != nullptr;
}
