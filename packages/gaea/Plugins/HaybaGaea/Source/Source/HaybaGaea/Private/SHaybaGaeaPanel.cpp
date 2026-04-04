#include "SHaybaGaeaPanel.h"
#include "HaybaGaeaModule.h"
#include "HaybaGaeaSettings.h"
#include "HaybaGaeaLandscapeImporter.h"
#include "Widgets/Layout/SScrollBox.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Layout/SSeparator.h"
#include "Widgets/Layout/SWidgetSwitcher.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SMultiLineEditableTextBox.h"
#include "Widgets/Input/SEditableTextBox.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/SBoxPanel.h"
#include "Misc/DateTime.h"
#include "Misc/Paths.h"
#include "HAL/PlatformApplicationMisc.h"
#include "Styling/AppStyle.h"
#include "Interfaces/IPluginManager.h"

#define LOCTEXT_NAMESPACE "HaybaGaea"

// ---------------------------------------------------------------------------
// Construct
// ---------------------------------------------------------------------------

void SHaybaGaeaPanel::Construct(const FArguments& InArgs, FHaybaGaeaModule* InModule)
{
	Module = InModule;

	FHaybaGaeaSettings& S = FHaybaGaeaSettings::Get();
	ChosenMode = S.OperationMode;

	// Determine starting screen
	if (!S.bHasSeenWizard)
	{
		CurrentScreen = EHaybaScreen::Wizard;
		WizardPage = 0;
	}
	else
	{
		CurrentScreen = EHaybaScreen::ModeSelect;
	}

	ChildSlot
	[
		SAssignNew(ScreenSwitcher, SWidgetSwitcher)
	];

	RebuildContent();
}

// ---------------------------------------------------------------------------
// Screen routing
// ---------------------------------------------------------------------------

void SHaybaGaeaPanel::ShowScreen(EHaybaScreen Screen)
{
	CurrentScreen = Screen;
	RebuildContent();
}

void SHaybaGaeaPanel::RebuildContent()
{
	if (!ScreenSwitcher.IsValid()) return;
	ScreenSwitcher->ClearChildren();

	TSharedRef<SWidget> Content = SNullWidget::NullWidget;
	switch (CurrentScreen)
	{
	case EHaybaScreen::Wizard:       Content = BuildWizardScreen();      break;
	case EHaybaScreen::ModeSelect:   Content = BuildModeSelectScreen();  break;
	case EHaybaScreen::MCPStatus:    Content = BuildMCPStatusScreen();   break;
	case EHaybaScreen::ApiKeyPrompt: Content = BuildApiKeyPromptScreen(); break;
	}

	ScreenSwitcher->AddSlot() [ Content ];
	ScreenSwitcher->SetActiveWidgetIndex(0);
}

// ---------------------------------------------------------------------------
// Shared header
// ---------------------------------------------------------------------------

TSharedRef<SWidget> SHaybaGaeaPanel::BuildHeader(const FText& Title)
{
	return SNew(SBorder)
		.BorderImage(FAppStyle::GetBrush("ToolPanel.GroupBorder"))
		.Padding(FMargin(12, 8))
		[
			SNew(SHorizontalBox)
			+ SHorizontalBox::Slot().VAlign(VAlign_Center).FillWidth(1.0f)
			[
				SNew(STextBlock)
				.Text(Title)
				.TextStyle(FAppStyle::Get(), "NormalText")
			]
			+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
			[
				SNew(SButton)
				.Text(LOCTEXT("SetupBtn", "\u2699 Setup"))
				.OnClicked(this, &SHaybaGaeaPanel::OnSetupButton)
			]
		];
}

// ---------------------------------------------------------------------------
// Wizard screen
// ---------------------------------------------------------------------------

TSharedRef<SWidget> SHaybaGaeaPanel::BuildWizardScreen()
{
	TSharedRef<SWidget> PageContent = SNullWidget::NullWidget;
	switch (WizardPage)
	{
	case 0: PageContent = BuildWizardPage0_Welcome();  break;
	case 1: PageContent = BuildWizardPage1_ModeChoice(); break;
	case 2:
		PageContent = (ChosenMode == EHaybaOperationMode::Integrated)
			? BuildWizardPage2a_Integrated()
			: BuildWizardPage2b_ApiKey();
		break;
	}

	// Nav buttons
	TSharedRef<SHorizontalBox> NavRow = SNew(SHorizontalBox);
	if (WizardPage > 0)
	{
		NavRow->AddSlot().AutoWidth().Padding(0, 0, 8, 0)
		[
			SNew(SButton)
			.Text(LOCTEXT("Back", "\u2190 Back"))
			.OnClicked(this, &SHaybaGaeaPanel::OnWizardBack)
		];
	}
	NavRow->AddSlot().FillWidth(1.0f); // spacer
	if (WizardPage < 2)
	{
		NavRow->AddSlot().AutoWidth()
		[
			SNew(SButton)
			.Text(LOCTEXT("Next", "Next \u2192"))
			.OnClicked(this, &SHaybaGaeaPanel::OnWizardNext)
		];
	}
	else
	{
		NavRow->AddSlot().AutoWidth()
		[
			SNew(SButton)
			.Text(LOCTEXT("Finish", "Finish"))
			.OnClicked(this, &SHaybaGaeaPanel::OnWizardFinish)
		];
	}

	return SNew(SVerticalBox)
		+ SVerticalBox::Slot().AutoHeight()
		[
			SNew(SBorder)
			.BorderImage(FAppStyle::GetBrush("ToolPanel.GroupBorder"))
			.Padding(FMargin(12, 8))
			[
				SNew(STextBlock)
				.Text(LOCTEXT("WizardTitle", "HaybaGaea — Setup"))
				.TextStyle(FAppStyle::Get(), "NormalText")
			]
		]
		+ SVerticalBox::Slot().FillHeight(1.0f).Padding(12)
		[ PageContent ]
		+ SVerticalBox::Slot().AutoHeight().Padding(12, 8)
		[ NavRow ];
}

TSharedRef<SWidget> SHaybaGaeaPanel::BuildWizardPage0_Welcome()
{
	return SNew(SVerticalBox)
		+ SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 12)
		[
			SNew(STextBlock)
			.Text(LOCTEXT("WelcomeTitle", "HaybaGaea"))
			.TextStyle(FAppStyle::Get(), "NormalText")
		]
		+ SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 16)
		[
			SNew(STextBlock)
			.Text(LOCTEXT("WelcomeSub", "Generate terrain from a text prompt, directly in UE5."))
			.TextStyle(FAppStyle::Get(), "SmallText")
			.AutoWrapText(true)
		]
		+ SVerticalBox::Slot().AutoHeight()
		[
			SNew(SBorder)
			.BorderImage(FAppStyle::GetBrush("ToolPanel.GroupBorder"))
			.Padding(10)
			[
				SNew(STextBlock)
				.Text(FText::FromString(TEXT("Prompt  \u2192  AI  \u2192  Gaea graph  \u2192  BuildManager  \u2192  Heightmap  \u2192  ALandscape")))
				.TextStyle(FAppStyle::Get(), "SmallText")
				.AutoWrapText(true)
			]
		];
}

TSharedRef<SWidget> SHaybaGaeaPanel::BuildWizardPage1_ModeChoice()
{
	return SNew(SVerticalBox)
		+ SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 12)
		[
			SNew(STextBlock)
			.Text(LOCTEXT("ModeChoiceTitle", "How do you want to use HaybaGaea?"))
			.TextStyle(FAppStyle::Get(), "NormalText")
		]
		+ SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 8)
		[
			BuildModeCard(
				LOCTEXT("ModeIntTitle", "Integrated AI Tools"),
				LOCTEXT("ModeIntDesc", "Use Claude Code, Cline, or OpenCode. Your AI assistant drives UE5 automatically via MCP. No typing in UE required."),
				EHaybaOperationMode::Integrated)
		]
		+ SVerticalBox::Slot().AutoHeight()
		[
			BuildModeCard(
				LOCTEXT("ModeApiTitle", "API Key"),
				LOCTEXT("ModeApiDesc", "Type terrain prompts directly in this panel. Provide your API key and generate landscapes without leaving UE5."),
				EHaybaOperationMode::ApiKey)
		];
}

TSharedRef<SWidget> SHaybaGaeaPanel::BuildModeCard(const FText& Title, const FText& Desc, EHaybaOperationMode Mode)
{
	const bool bSelected = (ChosenMode == Mode);
	FReply (SHaybaGaeaPanel::*Handler)() = (Mode == EHaybaOperationMode::Integrated)
		? &SHaybaGaeaPanel::OnSelectIntegrated
		: &SHaybaGaeaPanel::OnSelectApiKey;

	return SNew(SButton)
		.OnClicked(this, Handler)
		.ButtonStyle(FAppStyle::Get(), bSelected ? "FlatButton.Success" : "FlatButton")
		[
			SNew(SVerticalBox)
			+ SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 4)
			[
				SNew(STextBlock)
				.Text(Title)
				.TextStyle(FAppStyle::Get(), "NormalText")
			]
			+ SVerticalBox::Slot().AutoHeight()
			[
				SNew(STextBlock)
				.Text(Desc)
				.TextStyle(FAppStyle::Get(), "SmallText")
				.AutoWrapText(true)
			]
		];
}

TSharedRef<SWidget> SHaybaGaeaPanel::BuildWizardPage2a_Integrated()
{
	FString MCPPath = ResolveMCPServerPath();
	FString ClaudeCmd = FString::Printf(TEXT("claude mcp add hayba-gaea-server -- node \"%s\""), *MCPPath);

	FString ClineJson = FString::Printf(
		TEXT("\"hayba-gaea-server\": { \"command\": \"node\", \"args\": [\"%s\"] }"),
		*MCPPath.Replace(TEXT("\\"), TEXT("\\\\")));

	FString OpenCodeJson = FString::Printf(
		TEXT("{ \"mcpServers\": { \"hayba-gaea-server\": { \"command\": \"node\", \"args\": [\"%s\"] } } }"),
		*MCPPath.Replace(TEXT("\\"), TEXT("\\\\")));

	auto MakeRow = [this](const FText& Label, const FString& Snippet) -> TSharedRef<SWidget>
	{
		return SNew(SVerticalBox)
			+ SVerticalBox::Slot().AutoHeight().Padding(0, 8, 0, 2)
			[
				SNew(STextBlock).Text(Label).TextStyle(FAppStyle::Get(), "SmallText")
			]
			+ SVerticalBox::Slot().AutoHeight()
			[
				SNew(SHorizontalBox)
				+ SHorizontalBox::Slot().FillWidth(1.0f)
				[
					SNew(SBorder)
					.BorderImage(FAppStyle::GetBrush("ToolPanel.GroupBorder"))
					.Padding(6)
					[
						SNew(STextBlock)
						.Text(FText::FromString(Snippet))
						.TextStyle(FAppStyle::Get(), "SmallText")
						.AutoWrapText(true)
					]
				]
				+ SHorizontalBox::Slot().AutoWidth().Padding(6, 0, 0, 0).VAlign(VAlign_Center)
				[
					SNew(SButton)
					.Text(LOCTEXT("Copy", "Copy"))
					.OnClicked_Lambda([this, Snippet]() { return OnCopyText(Snippet); })
				]
			];
	};

	return SNew(SVerticalBox)
		+ SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 8)
		[
			SNew(STextBlock)
			.Text(LOCTEXT("IntSetupTitle", "Connect your AI tool"))
			.TextStyle(FAppStyle::Get(), "NormalText")
		]
		+ SVerticalBox::Slot().AutoHeight()
		[ MakeRow(LOCTEXT("ClaudeCodeLabel", "Claude Code:"), ClaudeCmd) ]
		+ SVerticalBox::Slot().AutoHeight()
		[ MakeRow(LOCTEXT("ClineLabel", "Cline (cline_mcp_settings.json):"), ClineJson) ]
		+ SVerticalBox::Slot().AutoHeight()
		[ MakeRow(LOCTEXT("OpenCodeLabel", "OpenCode (.opencode/config.json):"), OpenCodeJson) ];
}

TSharedRef<SWidget> SHaybaGaeaPanel::BuildWizardPage2b_ApiKey()
{
	FString CurrentKey = FHaybaGaeaSettings::GetSharedApiKey();

	return SNew(SVerticalBox)
		+ SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 8)
		[
			SNew(STextBlock)
			.Text(LOCTEXT("ApiKeyTitle", "Enter your API key"))
			.TextStyle(FAppStyle::Get(), "NormalText")
		]
		+ SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 4)
		[
			SNew(STextBlock)
			.Text(LOCTEXT("ApiKeyLabel", "AI API Key"))
			.TextStyle(FAppStyle::Get(), "SmallText")
		]
		+ SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 8)
		[
			SAssignNew(ApiKeyBox, SEditableTextBox)
			.Text(FText::FromString(CurrentKey))
			.IsPassword(true)
			.OnTextCommitted_Lambda([](const FText& T, ETextCommit::Type)
			{
				FHaybaGaeaSettings::SetSharedApiKey(T.ToString());
			})
		]
		+ SVerticalBox::Slot().AutoHeight()
		[
			SNew(STextBlock)
			.Text(LOCTEXT("ApiKeyNote", "Compatible with Anthropic Claude, OpenAI, and any OpenAI-compatible endpoint."))
			.TextStyle(FAppStyle::Get(), "SmallText")
			.AutoWrapText(true)
		];
}

// ---------------------------------------------------------------------------
// Mode Selection Screen
// ---------------------------------------------------------------------------

TSharedRef<SWidget> SHaybaGaeaPanel::BuildModeSelectScreen()
{
	return SNew(SVerticalBox)
		+ SVerticalBox::Slot().AutoHeight()
		[ BuildHeader(LOCTEXT("ModeSelectHeader", "HaybaGaea")) ]
		+ SVerticalBox::Slot().FillHeight(1.0f).Padding(12)
		[
			SNew(SVerticalBox)
			+ SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 12)
			[
				SNew(STextBlock)
				.Text(LOCTEXT("SelectMode", "Select operating mode:"))
				.TextStyle(FAppStyle::Get(), "NormalText")
			]
			+ SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 8)
			[
				BuildModeCard(
					LOCTEXT("ModeIntTitle", "Integrated AI Tools"),
					LOCTEXT("ModeIntDesc", "Use Claude Code, Cline, or OpenCode. Your AI assistant drives UE5 automatically via MCP. No typing in UE required."),
					EHaybaOperationMode::Integrated)
			]
			+ SVerticalBox::Slot().AutoHeight()
			[
				BuildModeCard(
					LOCTEXT("ModeApiTitle", "API Key"),
					LOCTEXT("ModeApiDesc", "Type terrain prompts directly in this panel. Provide your API key and generate landscapes without leaving UE5."),
					EHaybaOperationMode::ApiKey)
			]
		];
}

// ---------------------------------------------------------------------------
// MCP Status Screen (Mode A)
// ---------------------------------------------------------------------------

TSharedRef<SWidget> SHaybaGaeaPanel::BuildMCPStatusScreen()
{
	FHaybaGaeaSettings& S = FHaybaGaeaSettings::Get();
	FString StatusText = FString::Printf(TEXT("\u25CF LISTENING   %s:%d"), *S.ServerHost, S.ServerPort);

	FString MCPPath = ResolveMCPServerPath();
	FString ClaudeCmd = FString::Printf(TEXT("claude mcp add hayba-gaea-server -- node \"%s\""), *MCPPath);

	return SNew(SVerticalBox)
		+ SVerticalBox::Slot().AutoHeight()
		[ BuildHeader(LOCTEXT("MCPHeader", "HaybaGaea — Integrated Mode")) ]

		// Status bar
		+ SVerticalBox::Slot().AutoHeight().Padding(12, 8)
		[
			SNew(SBorder)
			.BorderImage(FAppStyle::GetBrush("ToolPanel.GroupBorder"))
			.Padding(8)
			[
				SNew(STextBlock)
				.Text(FText::FromString(StatusText))
				.TextStyle(FAppStyle::Get(), "SmallText")
			]
		]

		// Setup commands
		+ SVerticalBox::Slot().AutoHeight().Padding(12, 0, 12, 8)
		[
			SNew(SBorder)
			.BorderImage(FAppStyle::GetBrush("ToolPanel.GroupBorder"))
			.Padding(8)
			[
				SNew(SVerticalBox)
				+ SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 4)
				[
					SNew(STextBlock).Text(LOCTEXT("SetupCmdsTitle", "Setup commands")).TextStyle(FAppStyle::Get(), "SmallText")
				]
				+ SVerticalBox::Slot().AutoHeight()
				[
					SNew(SHorizontalBox)
					+ SHorizontalBox::Slot().FillWidth(1.0f)
					[
						SNew(STextBlock).Text(FText::FromString(ClaudeCmd)).TextStyle(FAppStyle::Get(), "SmallText").AutoWrapText(true)
					]
					+ SHorizontalBox::Slot().AutoWidth().Padding(6, 0, 0, 0).VAlign(VAlign_Center)
					[
						SNew(SButton).Text(LOCTEXT("Copy", "Copy"))
						.OnClicked_Lambda([this, ClaudeCmd]() { return OnCopyText(ClaudeCmd); })
					]
				]
			]
		]

		// Activity log
		+ SVerticalBox::Slot().FillHeight(1.0f).Padding(12, 0, 12, 12)
		[
			SNew(SBorder)
			.BorderImage(FAppStyle::GetBrush("ToolPanel.GroupBorder"))
			.Padding(6)
			[
				SAssignNew(ActivityLog, SScrollBox)
			]
		];
}

void SHaybaGaeaPanel::AddActivity(const FString& Text)
{
	if (!ActivityLog.IsValid()) return;
	FString Entry = FDateTime::Now().ToString(TEXT("[%H:%M:%S] ")) + Text;
	ActivityLog->AddSlot()
	[
		SNew(STextBlock)
		.Text(FText::FromString(Entry))
		.TextStyle(FAppStyle::Get(), "SmallText")
		.AutoWrapText(true)
	];
	ActivityLog->ScrollToEnd();
}

// ---------------------------------------------------------------------------
// API Key / Prompt Screen (Mode B)
// ---------------------------------------------------------------------------

TSharedRef<SWidget> SHaybaGaeaPanel::BuildApiKeyPromptScreen()
{
	const FHaybaGaeaSettings& S = FHaybaGaeaSettings::Get();
	FString CurrentKey = FHaybaGaeaSettings::GetSharedApiKey();

	return SNew(SVerticalBox)
		+ SVerticalBox::Slot().AutoHeight()
		[ BuildHeader(LOCTEXT("ApiPromptHeader", "HaybaGaea — API Key Mode")) ]

		// API key field
		+ SVerticalBox::Slot().AutoHeight().Padding(12, 8, 12, 0)
		[
			SNew(SHorizontalBox)
			+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(0, 0, 8, 0)
			[
				SNew(STextBlock).Text(LOCTEXT("ApiKeyLabel", "AI API Key")).TextStyle(FAppStyle::Get(), "SmallText")
			]
			+ SHorizontalBox::Slot().FillWidth(1.0f)
			[
				SAssignNew(ApiKeyBox, SEditableTextBox)
				.Text(FText::FromString(CurrentKey))
				.IsPassword(true)
				.OnTextCommitted_Lambda([](const FText& T, ETextCommit::Type)
				{
					FHaybaGaeaSettings::SetSharedApiKey(T.ToString());
				})
			]
		]

		// Output folder
		+ SVerticalBox::Slot().AutoHeight().Padding(12, 6, 12, 0)
		[
			SNew(SHorizontalBox)
			+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(0, 0, 8, 0)
			[
				SNew(STextBlock).Text(LOCTEXT("OutputFolderLabel", "Output folder:")).TextStyle(FAppStyle::Get(), "SmallText")
			]
			+ SHorizontalBox::Slot().FillWidth(1.0f)
			[
				SAssignNew(OutputFolderBox, SEditableTextBox)
				.Text(FText::FromString(S.HeightmapOutputFolder))
			]
		]

		// Prompt box + generate button
		+ SVerticalBox::Slot().AutoHeight().Padding(12, 8, 12, 0)
		[
			SAssignNew(PromptBox, SMultiLineEditableTextBox)
			.HintText(LOCTEXT("PromptHint", "Describe your terrain... e.g. 'A dramatic mountain range with heavy erosion and snow caps'"))
			.AutoWrapText(true)
		]
		+ SVerticalBox::Slot().AutoHeight().Padding(12, 6, 12, 0)
		[
			SNew(SButton)
			.Text(LOCTEXT("GenerateBtn", "Generate Landscape"))
			.OnClicked(this, &SHaybaGaeaPanel::OnGenerate)
			.IsEnabled(this, &SHaybaGaeaPanel::CanGenerate)
		]

		// Log
		+ SVerticalBox::Slot().FillHeight(1.0f).Padding(12, 8, 12, 12)
		[
			SNew(SBorder)
			.BorderImage(FAppStyle::GetBrush("ToolPanel.GroupBorder"))
			.Padding(6)
			[
				SAssignNew(LogBox, SScrollBox)
			]
		];
}

// ---------------------------------------------------------------------------
// Wizard navigation
// ---------------------------------------------------------------------------

FReply SHaybaGaeaPanel::OnWizardNext()
{
	WizardPage = FMath::Min(WizardPage + 1, 2);
	RebuildContent();
	return FReply::Handled();
}

FReply SHaybaGaeaPanel::OnWizardBack()
{
	WizardPage = FMath::Max(WizardPage - 1, 0);
	RebuildContent();
	return FReply::Handled();
}

FReply SHaybaGaeaPanel::OnWizardFinish()
{
	FHaybaGaeaSettings& S = FHaybaGaeaSettings::Get();
	S.bHasSeenWizard = true;
	S.OperationMode = ChosenMode;
	S.Save();

	if (ChosenMode == EHaybaOperationMode::Integrated)
		ShowScreen(EHaybaScreen::MCPStatus);
	else
		ShowScreen(EHaybaScreen::ApiKeyPrompt);

	return FReply::Handled();
}

FReply SHaybaGaeaPanel::OnSelectIntegrated()
{
	ChosenMode = EHaybaOperationMode::Integrated;

	// If we're in the wizard, just update the card highlight
	if (CurrentScreen == EHaybaScreen::Wizard)
	{
		RebuildContent();
	}
	else
	{
		FHaybaGaeaSettings& S = FHaybaGaeaSettings::Get();
		S.OperationMode = ChosenMode;
		S.Save();
		ShowScreen(EHaybaScreen::MCPStatus);
	}
	return FReply::Handled();
}

FReply SHaybaGaeaPanel::OnSelectApiKey()
{
	ChosenMode = EHaybaOperationMode::ApiKey;

	if (CurrentScreen == EHaybaScreen::Wizard)
	{
		RebuildContent();
	}
	else
	{
		FHaybaGaeaSettings& S = FHaybaGaeaSettings::Get();
		S.OperationMode = ChosenMode;
		S.Save();
		ShowScreen(EHaybaScreen::ApiKeyPrompt);
	}
	return FReply::Handled();
}

// ---------------------------------------------------------------------------
// Generate / Log (Mode B)
// ---------------------------------------------------------------------------

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
	FString Entry = FDateTime::Now().ToString(TEXT("[%H:%M:%S] ")) + Text;
	const FSlateColor Color = bError
		? FSlateColor(FLinearColor(0.87f, 0.2f, 0.2f))
		: FSlateColor::UseForeground();

	LogBox->AddSlot()
	[
		SNew(STextBlock)
		.Text(FText::FromString(Entry))
		.TextStyle(FAppStyle::Get(), "SmallText")
		.ColorAndOpacity(Color)
		.AutoWrapText(true)
	];
	LogBox->ScrollToEnd();
}

bool SHaybaGaeaPanel::CanGenerate() const
{
	return !bGenerating && Module != nullptr;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

FReply SHaybaGaeaPanel::OnCopyText(FString Text)
{
	FPlatformApplicationMisc::ClipboardCopy(*Text);
	return FReply::Handled();
}

FString SHaybaGaeaPanel::ResolveMCPServerPath() const
{
	TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("HaybaGaea"));
	if (Plugin.IsValid())
	{
		FString Base = Plugin->GetBaseDir();
		return FPaths::ConvertRelativePathToFull(Base / TEXT("ThirdParty/gaea_server/dist/index.js"));
	}
	return TEXT("<plugin-dir>/ThirdParty/gaea_server/dist/index.js");
}

#undef LOCTEXT_NAMESPACE
