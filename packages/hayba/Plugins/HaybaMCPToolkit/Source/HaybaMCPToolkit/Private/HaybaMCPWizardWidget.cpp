// Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/PCGExWizardWidget.cpp
#include "HaybaMCPWizardWidget.h"
#include "HaybaMCPModule.h"
#include "HaybaMCPClaudeClient.h"
#include "HaybaMCPSettings.h"
#include "HaybaMCPWizardPrompt.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SSeparator.h"
#include "Widgets/Layout/SScrollBox.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SEditableTextBox.h"
#include "Widgets/Input/SMultiLineEditableTextBox.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Notifications/SProgressBar.h"
#include "Framework/Application/SlateApplication.h"
#include "HAL/PlatformApplicationMisc.h"
#include "Logging/LogMacros.h"
#include "Misc/Guid.h"
#include "Misc/Paths.h"
#include "Json.h"
#include "JsonUtilities.h"
#include "Editor.h"
#include "Interfaces/IPluginManager.h"
#include "Styling/AppStyle.h"

#define LOCTEXT_NAMESPACE "HaybaMCPToolkit"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPWizard, Log, All);

// Status dot colors only — intentional minimal use of custom color
static const FLinearColor ColorSuccess(0.298f, 0.686f, 0.314f, 1.0f);
static const FLinearColor ColorError  (0.878f, 0.267f, 0.267f, 1.0f);
static const FLinearColor ColorMuted  (0.380f, 0.380f, 0.380f, 1.0f);

// ---------------------------------------------------------------------------
// Construct
// ---------------------------------------------------------------------------

void SHaybaMCPWizardWidget::Construct(const FArguments& InArgs, FHaybaMCPModule* InModule)
{
    Module = InModule;

    FHaybaMCPSettings& S = FHaybaMCPSettings::Get();
    ChosenMode = S.OperationMode;

    if (!S.bHasSeenWizard)
    {
        CurrentScreen = EHaybaMCPScreen::Wizard;
        WizardPage    = 0;
    }
    else
    {
        CurrentScreen = EHaybaMCPScreen::ModeSelect;
    }

    ChildSlot
    [
        SAssignNew(ScreenSwitcher, SBox)
    ];

    RebuildContent();
}

// ---------------------------------------------------------------------------
// Screen routing
// ---------------------------------------------------------------------------

void SHaybaMCPWizardWidget::ShowScreen(EHaybaMCPScreen Screen)
{
    CurrentScreen = Screen;
    RebuildContent();
}

void SHaybaMCPWizardWidget::RebuildContent()
{
    if (!ScreenSwitcher.IsValid()) return;

    TSharedRef<SWidget> Content = SNullWidget::NullWidget;
    switch (CurrentScreen)
    {
    case EHaybaMCPScreen::Wizard:     Content = BuildWizardScreen();     break;
    case EHaybaMCPScreen::ModeSelect: Content = BuildModeSelectScreen(); break;
    case EHaybaMCPScreen::MCPStatus:  Content = BuildMCPStatusScreen();  break;
    case EHaybaMCPScreen::ChatUI:     Content = BuildChatScreen();       break;
    }

    ScreenSwitcher->SetContent(Content);
}

// ---------------------------------------------------------------------------
// Shared header
// ---------------------------------------------------------------------------

TSharedRef<SWidget> SHaybaMCPWizardWidget::BuildHeader(const FText& Title)
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

            // Server status dot
            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(0, 0, 8, 0)
            [
                SNew(SBox).WidthOverride(8).HeightOverride(8)
                [
                    SNew(SBorder)
                    .BorderImage(FAppStyle::GetBrush("WhiteBrush"))
                    .BorderBackgroundColor_Lambda([this]() -> FSlateColor {
                        return (Module && Module->IsServerRunning()) ? ColorSuccess : ColorMuted;
                    })
                ]
            ]

            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
            [
                SNew(SButton)
                .Text(LOCTEXT("SetupBtn", "\u2699 Setup"))
                .OnClicked(this, &SHaybaMCPWizardWidget::OnSetupButton)
            ]
        ];
}

// ---------------------------------------------------------------------------
// Wizard screen
// ---------------------------------------------------------------------------

TSharedRef<SWidget> SHaybaMCPWizardWidget::BuildWizardScreen()
{
    TSharedRef<SWidget> PageContent = SNullWidget::NullWidget;
    switch (WizardPage)
    {
    case 0: PageContent = BuildWizardPage0_Welcome();    break;
    case 1: PageContent = BuildWizardPage1_ModeChoice(); break;
    case 2:
        PageContent = (ChosenMode == EHaybaMCPOperationMode::Integrated)
            ? BuildWizardPage2a_Integrated()
            : BuildWizardPage2b_ApiKey();
        break;
    }

    TSharedRef<SHorizontalBox> NavRow = SNew(SHorizontalBox);
    if (WizardPage > 0)
    {
        NavRow->AddSlot().AutoWidth().Padding(0, 0, 8, 0)
        [
            SNew(SButton)
            .Text(LOCTEXT("Back", "\u2190 Back"))
            .OnClicked(this, &SHaybaMCPWizardWidget::OnWizardBack)
        ];
    }
    NavRow->AddSlot().FillWidth(1.0f);
    if (WizardPage < 2)
    {
        NavRow->AddSlot().AutoWidth()
        [
            SNew(SButton)
            .Text(LOCTEXT("Next", "Next \u2192"))
            .OnClicked(this, &SHaybaMCPWizardWidget::OnWizardNext)
        ];
    }
    else
    {
        NavRow->AddSlot().AutoWidth()
        [
            SNew(SButton)
            .Text(LOCTEXT("Finish", "Finish"))
            .OnClicked(this, &SHaybaMCPWizardWidget::OnWizardFinish)
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
                .Text(LOCTEXT("WizardTitle", "HaybaPCGEx — Setup"))
                .TextStyle(FAppStyle::Get(), "NormalText")
            ]
        ]
        + SVerticalBox::Slot().FillHeight(1.0f).Padding(12)
        [ PageContent ]
        + SVerticalBox::Slot().AutoHeight().Padding(12, 8)
        [ NavRow ];
}

TSharedRef<SWidget> SHaybaMCPWizardWidget::BuildWizardPage0_Welcome()
{
    return SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 12)
        [
            SNew(STextBlock)
            .Text(LOCTEXT("WelcomeTitle", "HaybaPCGEx"))
            .TextStyle(FAppStyle::Get(), "NormalText")
        ]
        + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 16)
        [
            SNew(STextBlock)
            .Text(LOCTEXT("WelcomeSub", "Author PCG graphs with AI, directly in UE5."))
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
                .Text(FText::FromString(TEXT("Prompt  \u2192  AI  \u2192  PCGEx node graph  \u2192  UE5 PCGGraph asset")))
                .TextStyle(FAppStyle::Get(), "SmallText")
                .AutoWrapText(true)
            ]
        ];
}

TSharedRef<SWidget> SHaybaMCPWizardWidget::BuildWizardPage1_ModeChoice()
{
    return SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 12)
        [
            SNew(STextBlock)
            .Text(LOCTEXT("ModeChoiceTitle", "How do you want to use HaybaPCGEx?"))
            .TextStyle(FAppStyle::Get(), "NormalText")
        ]
        + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 8)
        [
            BuildModeCard(
                LOCTEXT("ModeIntTitle", "Integrated AI Tools"),
                LOCTEXT("ModeIntDesc", "Use Claude Code, Cline, or OpenCode. Your AI assistant drives UE5 automatically via MCP. No typing in UE required."),
                EHaybaMCPOperationMode::Integrated)
        ]
        + SVerticalBox::Slot().AutoHeight()
        [
            BuildModeCard(
                LOCTEXT("ModeApiTitle", "API Key"),
                LOCTEXT("ModeApiDesc", "Design PCG graphs directly in this panel. Provide your API key and author graphs without leaving UE5."),
                EHaybaMCPOperationMode::ApiKey)
        ];
}

TSharedRef<SWidget> SHaybaMCPWizardWidget::BuildModeCard(const FText& Title, const FText& Desc, EHaybaMCPOperationMode Mode)
{
    const bool bSelected = (ChosenMode == Mode);
    FReply (SHaybaMCPWizardWidget::*Handler)() = (Mode == EHaybaMCPOperationMode::Integrated)
        ? &SHaybaMCPWizardWidget::OnSelectIntegrated
        : &SHaybaMCPWizardWidget::OnSelectApiKey;

    return SNew(SButton)
        .OnClicked(this, Handler)
        .ButtonStyle(FAppStyle::Get(), bSelected ? "FlatButton.Success" : "FlatButton")
        [
            SNew(SVerticalBox)
            + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 4)
            [
                SNew(STextBlock).Text(Title).TextStyle(FAppStyle::Get(), "NormalText")
            ]
            + SVerticalBox::Slot().AutoHeight()
            [
                SNew(STextBlock).Text(Desc).TextStyle(FAppStyle::Get(), "SmallText").AutoWrapText(true)
            ]
        ];
}

TSharedRef<SWidget> SHaybaMCPWizardWidget::BuildWizardPage2a_Integrated()
{
    FString MCPPath = ResolveMCPServerPath();
    FString ClaudeCmd  = FString::Printf(TEXT("claude mcp add hayba-pcgex -- node \"%s\""), *MCPPath);
    FString ClineJson  = FString::Printf(
        TEXT("\"hayba-pcgex\": { \"command\": \"node\", \"args\": [\"%s\"] }"),
        *MCPPath.Replace(TEXT("\\"), TEXT("\\\\")));
    FString OpenCode   = FString::Printf(
        TEXT("{ \"mcpServers\": { \"hayba-pcgex\": { \"command\": \"node\", \"args\": [\"%s\"] } } }"),
        *MCPPath.Replace(TEXT("\\"), TEXT("\\\\")));

    auto MakeRow = [this](const FText& Label, const FString& Snippet) -> TSharedRef<SWidget>
    {
        return SNew(SVerticalBox)
            + SVerticalBox::Slot().AutoHeight().Padding(0, 8, 0, 2)
            [ SNew(STextBlock).Text(Label).TextStyle(FAppStyle::Get(), "SmallText") ]
            + SVerticalBox::Slot().AutoHeight()
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().FillWidth(1.0f)
                [
                    SNew(SBorder).BorderImage(FAppStyle::GetBrush("ToolPanel.GroupBorder")).Padding(6)
                    [
                        SNew(STextBlock).Text(FText::FromString(Snippet))
                        .TextStyle(FAppStyle::Get(), "SmallText").AutoWrapText(true)
                    ]
                ]
                + SHorizontalBox::Slot().AutoWidth().Padding(6, 0, 0, 0).VAlign(VAlign_Center)
                [
                    SNew(SButton).Text(LOCTEXT("Copy", "Copy"))
                    .OnClicked_Lambda([this, Snippet]() { return OnCopyText(Snippet); })
                ]
            ];
    };

    return SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 8)
        [ SNew(STextBlock).Text(LOCTEXT("IntSetupTitle", "Connect your AI tool")).TextStyle(FAppStyle::Get(), "NormalText") ]
        + SVerticalBox::Slot().AutoHeight()
        [ MakeRow(LOCTEXT("ClaudeCodeLabel", "Claude Code:"), ClaudeCmd) ]
        + SVerticalBox::Slot().AutoHeight()
        [ MakeRow(LOCTEXT("ClineLabel", "Cline (cline_mcp_settings.json):"), ClineJson) ]
        + SVerticalBox::Slot().AutoHeight()
        [ MakeRow(LOCTEXT("OpenCodeLabel", "OpenCode (.opencode/config.json):"), OpenCode) ];
}

TSharedRef<SWidget> SHaybaMCPWizardWidget::BuildWizardPage2b_ApiKey()
{
    FString CurrentKey = FHaybaMCPSettings::GetSharedApiKey();

    return SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 8)
        [ SNew(STextBlock).Text(LOCTEXT("ApiKeyTitle", "Enter your API key")).TextStyle(FAppStyle::Get(), "NormalText") ]
        + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 4)
        [ SNew(STextBlock).Text(LOCTEXT("ApiKeyLabel", "AI API Key")).TextStyle(FAppStyle::Get(), "SmallText") ]
        + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 8)
        [
            SAssignNew(ApiKeyBox, SEditableTextBox)
            .Text(FText::FromString(CurrentKey))
            .IsPassword(true)
            .OnTextCommitted_Lambda([](const FText& T, ETextCommit::Type)
            {
                FHaybaMCPSettings::SetSharedApiKey(T.ToString());
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

TSharedRef<SWidget> SHaybaMCPWizardWidget::BuildModeSelectScreen()
{
    return SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight()
        [ BuildHeader(LOCTEXT("ModeSelectHeader", "HaybaPCGEx")) ]
        + SVerticalBox::Slot().FillHeight(1.0f).Padding(12)
        [
            SNew(SVerticalBox)
            + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 12)
            [ SNew(STextBlock).Text(LOCTEXT("SelectMode", "Select operating mode:")).TextStyle(FAppStyle::Get(), "NormalText") ]
            + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 8)
            [
                BuildModeCard(
                    LOCTEXT("ModeIntTitle", "Integrated AI Tools"),
                    LOCTEXT("ModeIntDesc", "Use Claude Code, Cline, or OpenCode. Your AI assistant drives UE5 automatically via MCP."),
                    EHaybaMCPOperationMode::Integrated)
            ]
            + SVerticalBox::Slot().AutoHeight()
            [
                BuildModeCard(
                    LOCTEXT("ModeApiTitle", "API Key"),
                    LOCTEXT("ModeApiDesc", "Design PCG graphs directly in this panel using your API key."),
                    EHaybaMCPOperationMode::ApiKey)
            ]
        ];
}

// ---------------------------------------------------------------------------
// MCP Status Screen (Mode A)
// ---------------------------------------------------------------------------

TSharedRef<SWidget> SHaybaMCPWizardWidget::BuildMCPStatusScreen()
{
    FHaybaMCPSettings& S = FHaybaMCPSettings::Get();
    FString StatusText = FString::Printf(TEXT("\u25CF LISTENING   127.0.0.1:52342"));
    FString MCPPath    = ResolveMCPServerPath();
    FString ClaudeCmd  = FString::Printf(TEXT("claude mcp add hayba-pcgex -- node \"%s\""), *MCPPath);

    return SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight()
        [ BuildHeader(LOCTEXT("MCPHeader", "HaybaPCGEx — Integrated Mode")) ]

        + SVerticalBox::Slot().AutoHeight().Padding(12, 8)
        [
            SNew(SBorder).BorderImage(FAppStyle::GetBrush("ToolPanel.GroupBorder")).Padding(8)
            [
                SNew(STextBlock).Text(FText::FromString(StatusText)).TextStyle(FAppStyle::Get(), "SmallText")
            ]
        ]

        + SVerticalBox::Slot().AutoHeight().Padding(12, 0, 12, 8)
        [
            SNew(SBorder).BorderImage(FAppStyle::GetBrush("ToolPanel.GroupBorder")).Padding(8)
            [
                SNew(SVerticalBox)
                + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 4)
                [ SNew(STextBlock).Text(LOCTEXT("SetupCmdsTitle", "Setup commands")).TextStyle(FAppStyle::Get(), "SmallText") ]
                + SVerticalBox::Slot().AutoHeight()
                [
                    SNew(SHorizontalBox)
                    + SHorizontalBox::Slot().FillWidth(1.0f)
                    [
                        SNew(STextBlock).Text(FText::FromString(ClaudeCmd))
                        .TextStyle(FAppStyle::Get(), "SmallText").AutoWrapText(true)
                    ]
                    + SHorizontalBox::Slot().AutoWidth().Padding(6, 0, 0, 0).VAlign(VAlign_Center)
                    [
                        SNew(SButton).Text(LOCTEXT("Copy", "Copy"))
                        .OnClicked_Lambda([this, ClaudeCmd]() { return OnCopyText(ClaudeCmd); })
                    ]
                ]
            ]
        ]

        + SVerticalBox::Slot().FillHeight(1.0f).Padding(12, 0, 12, 12)
        [
            SNew(SBorder).BorderImage(FAppStyle::GetBrush("ToolPanel.GroupBorder")).Padding(6)
            [
                SAssignNew(ActivityLog, SScrollBox)
            ]
        ];
}

void SHaybaMCPWizardWidget::AddActivity(const FString& Text)
{
    if (!ActivityLog.IsValid()) return;
    ActivityLog->AddSlot()
    [
        SNew(STextBlock)
        .Text(FText::FromString(FDateTime::Now().ToString(TEXT("[%H:%M:%S] ")) + Text))
        .TextStyle(FAppStyle::Get(), "SmallText")
        .AutoWrapText(true)
    ];
    ActivityLog->ScrollToEnd();
}

// ---------------------------------------------------------------------------
// Chat Screen (Mode B)
// ---------------------------------------------------------------------------

TSharedRef<SWidget> SHaybaMCPWizardWidget::BuildChatScreen()
{
    const FHaybaMCPSettings& S = FHaybaMCPSettings::Get();

    if (!S.HasApiKey())
        AddAIMessage(TEXT("Welcome to HaybaPCGEx!\n\nOpen \u2699 Setup, switch to API Key mode, and enter your key to get started.\n\nWorks with Anthropic Claude, OpenAI, or any compatible endpoint."));
    else if (Session.Messages.IsEmpty())
        AddAIMessage(TEXT("Welcome back!\n\nDescribe what you want to generate:\n\u2022 \"A mini city with organic roads\"\n\u2022 \"A dungeon with connected rooms\"\n\u2022 \"A forest path network\""));

    return SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight()
        [ BuildHeader(LOCTEXT("ChatHeader", "HaybaPCGEx — API Key Mode")) ]

        + SVerticalBox::Slot().AutoHeight()
        [
            SNew(SBox).Visibility(this, &SHaybaMCPWizardWidget::GetSettingsPanelVisibility)
            [ BuildSettingsPanel() ]
        ]

        + SVerticalBox::Slot().FillHeight(1.0f)
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().FillWidth(0.65f)
            [
                SNew(SVerticalBox)
                + SVerticalBox::Slot().FillHeight(1.0f)   [ BuildChatArea() ]
                + SVerticalBox::Slot().AutoHeight().Padding(8, 4) [ BuildActionBar() ]
                + SVerticalBox::Slot().AutoHeight().Padding(8, 4, 8, 8) [ BuildInputArea() ]
            ]
            + SHorizontalBox::Slot().AutoWidth()
            [ SNew(SSeparator).Orientation(Orient_Vertical) ]
            + SHorizontalBox::Slot().FillWidth(0.35f)
            [ BuildStepsSidebar() ]
        ];
}

// ---------------------------------------------------------------------------
// Settings panel (inside chat screen)
// ---------------------------------------------------------------------------

TSharedRef<SWidget> SHaybaMCPWizardWidget::BuildSettingsPanel()
{
    const FHaybaMCPSettings& S = FHaybaMCPSettings::Get();
    FString CurrentKey = FHaybaMCPSettings::GetSharedApiKey();

    auto MakeField = [&](const FText& Label, TSharedPtr<SEditableTextBox>& OutBox,
                         const FString& Value, const FText& Hint, bool bPassword = false) -> TSharedRef<SWidget>
    {
        return SNew(SVerticalBox)
            + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 3)
            [ SNew(STextBlock).Text(Label).TextStyle(FAppStyle::Get(), "SmallText") ]
            + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 8)
            [
                SAssignNew(OutBox, SEditableTextBox)
                .Text(FText::FromString(Value))
                .HintText(Hint)
                .IsPassword(bPassword)
            ];
    };

    return SNew(SBorder)
        .BorderImage(FAppStyle::GetBrush("ToolPanel.GroupBorder"))
        .Padding(12, 10)
        [
            SNew(SVerticalBox)
            + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 10)
            [ SNew(STextBlock).Text(LOCTEXT("SettingsTitle", "Settings")).TextStyle(FAppStyle::Get(), "NormalText") ]

            + SVerticalBox::Slot().AutoHeight()
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().FillWidth(1.0f).Padding(0, 0, 8, 0)
                [ MakeField(LOCTEXT("ApiKeyField", "API Key"), ApiKeyBox, CurrentKey,
                    LOCTEXT("ApiKeyHint", "sk-ant-...  or  sk-..."), true) ]
                + SHorizontalBox::Slot().FillWidth(1.0f)
                [ MakeField(LOCTEXT("EndpointField", "Endpoint URL"), BaseUrlBox, S.BaseURL,
                    LOCTEXT("EndpointHint", "https://api.anthropic.com/v1/messages")) ]
            ]

            + SVerticalBox::Slot().AutoHeight()
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().FillWidth(1.0f).Padding(0, 0, 8, 0)
                [ MakeField(LOCTEXT("ModelField", "Model"), ModelBox, S.Model,
                    LOCTEXT("ModelHint", "claude-opus-4-6-20251101")) ]
                + SHorizontalBox::Slot().FillWidth(1.0f)
                [ MakeField(LOCTEXT("OutputPathField", "Output Path"), OutputPathBox, S.OutputPath,
                    LOCTEXT("OutputPathHint", "/Game/HaybaMCP/Generated")) ]
            ]

            + SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Right)
            [
                SNew(SButton)
                .Text(LOCTEXT("SaveSettings", "Save"))
                .OnClicked(this, &SHaybaMCPWizardWidget::OnSaveSettings)
            ]
        ];
}

// ---------------------------------------------------------------------------
// Steps sidebar
// ---------------------------------------------------------------------------

TSharedRef<SWidget> SHaybaMCPWizardWidget::BuildStepsSidebar()
{
    return SNew(SBorder)
        .BorderImage(FAppStyle::GetBrush("ToolPanel.GroupBorder"))
        .Padding(0)
        [
            SNew(SVerticalBox)
            + SVerticalBox::Slot().AutoHeight().Padding(10, 8, 10, 6)
            [ SNew(STextBlock).Text(LOCTEXT("StepsLabel", "STEPS")).TextStyle(FAppStyle::Get(), "SmallText") ]

            + SVerticalBox::Slot().AutoHeight().Padding(10, 0, 10, 8)
            [
                SNew(SProgressBar)
                .Percent_Lambda([this]() -> TOptional<float>
                {
                    if (Session.Steps.IsEmpty()) return 0.0f;
                    return (float)(Session.CurrentStep + 1) / (float)Session.Steps.Num();
                })
            ]

            + SVerticalBox::Slot().FillHeight(1.0f)
            [
                SNew(SScrollBox)
                + SScrollBox::Slot()
                [ SAssignNew(StepListBox, SVerticalBox) ]
            ]

            + SVerticalBox::Slot().AutoHeight()
            [ SNew(SSeparator) ]

            + SVerticalBox::Slot().AutoHeight().Padding(10, 8)
            [
                SNew(SVerticalBox)
                + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 4)
                [ SNew(STextBlock).Text(LOCTEXT("BridgeLabel", "BRIDGE")).TextStyle(FAppStyle::Get(), "SmallText") ]
                + SVerticalBox::Slot().AutoHeight()
                [
                    SNew(STextBlock)
                    .Text_Lambda([this]() -> FText
                    {
                        if (!Module) return FText::FromString(TEXT("No module"));
                        return FText::FromString(Module->IsServerRunning()
                            ? TEXT("TCP :52342  MCP :52341") : TEXT("Not running"));
                    })
                    .TextStyle(FAppStyle::Get(), "SmallText")
                    .ColorAndOpacity_Lambda([this]() -> FSlateColor
                    {
                        return (Module && Module->IsServerRunning()) ? ColorSuccess : ColorError;
                    })
                ]
            ]

            + SVerticalBox::Slot().AutoHeight().Padding(10, 0, 10, 10)
            [
                SNew(SVerticalBox)
                + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 4)
                [ SNew(STextBlock).Text(LOCTEXT("AILabel", "AI")).TextStyle(FAppStyle::Get(), "SmallText") ]
                + SVerticalBox::Slot().AutoHeight()
                [
                    SNew(STextBlock)
                    .Text_Lambda([this]() -> FText
                    {
                        if (!FHaybaMCPSettings::Get().HasApiKey())
                            return FText::FromString(TEXT("No key set"));
                        FString Display = FHaybaMCPSettings::Get().BaseURL;
                        Display.RemoveFromStart(TEXT("https://"));
                        Display.RemoveFromStart(TEXT("http://"));
                        int32 Slash = INDEX_NONE;
                        if (Display.FindChar('/', Slash)) Display = Display.Left(Slash);
                        return FText::FromString(Display);
                    })
                    .TextStyle(FAppStyle::Get(), "SmallText")
                    .ColorAndOpacity_Lambda([this]() -> FSlateColor
                    {
                        return FHaybaMCPSettings::Get().HasApiKey() ? ColorSuccess : ColorError;
                    })
                    .AutoWrapText(true)
                ]
            ]
        ];
}

// ---------------------------------------------------------------------------
// Chat area, input, action bar
// ---------------------------------------------------------------------------

TSharedRef<SWidget> SHaybaMCPWizardWidget::BuildChatArea()
{
    return SAssignNew(ChatScrollBox, SScrollBox).Orientation(Orient_Vertical);
}

TSharedRef<SWidget> SHaybaMCPWizardWidget::BuildInputArea()
{
    return SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 4)
        [
            SAssignNew(InputBox, SMultiLineEditableTextBox)
            .HintText(LOCTEXT("InputHint", "Describe what you want to generate..."))
            .AutoWrapText(true)
            .OnKeyDownHandler_Lambda([this](const FGeometry&, const FKeyEvent& Key) -> FReply
            {
                if (Key.GetKey() == EKeys::Enter && !Key.IsShiftDown())
                {
                    OnSendMessage();
                    return FReply::Handled();
                }
                return FReply::Unhandled();
            })
            .IsEnabled_Lambda([this]() { return CanSendMessage(); })
        ]
        + SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Right)
        [
            SNew(SButton)
            .Text(LOCTEXT("SendBtn", "Send \u23CE"))
            .OnClicked(this, &SHaybaMCPWizardWidget::OnSendMessage)
            .IsEnabled_Lambda([this]() { return CanSendMessage(); })
        ];
}

TSharedRef<SWidget> SHaybaMCPWizardWidget::BuildActionBar()
{
    return SNew(SBox)
        .Visibility(this, &SHaybaMCPWizardWidget::GetActionBarVisibility)
        [
            SNew(SBorder)
            .BorderImage(FAppStyle::GetBrush("ToolPanel.GroupBorder"))
            .Padding(8, 6)
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().FillWidth(1.0f).Padding(0, 0, 6, 0)
                [
                    SNew(SButton)
                    .Text(LOCTEXT("ApproveBtn", "\u2713  Approve & Continue"))
                    .OnClicked(this, &SHaybaMCPWizardWidget::OnApproveStep)
                ]
                + SHorizontalBox::Slot().AutoWidth().Padding(0, 0, 6, 0)
                [
                    SNew(SButton)
                    .Text(LOCTEXT("TestBtn", "\u25B6  Test"))
                    .OnClicked(this, &SHaybaMCPWizardWidget::OnTestIt)
                ]
                + SHorizontalBox::Slot().AutoWidth()
                [
                    SNew(SButton)
                    .Text(LOCTEXT("RedoBtn", "\u21ba  Redo"))
                    .OnClicked(this, &SHaybaMCPWizardWidget::OnRedoStep)
                ]
            ]
        ];
}

// ---------------------------------------------------------------------------
// Message widgets — plain rows, no colored bubbles
// ---------------------------------------------------------------------------

TSharedRef<SWidget> SHaybaMCPWizardWidget::BuildMessageWidget(const FHaybaMCPChatMessage& Message)
{
    FText RoleLabel = Message.bFromUser
        ? LOCTEXT("YouLabel", "You")
        : LOCTEXT("AILabel2", "AI");

    TSharedRef<SVerticalBox> Content = SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight()
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().AutoWidth().Padding(0, 0, 8, 0)
            [
                SNew(STextBlock)
                .Text(RoleLabel)
                .TextStyle(FAppStyle::Get(), "SmallText")
                .ColorAndOpacity(FSlateColor(FLinearColor(0.5f, 0.5f, 0.5f)))
            ]
            + SHorizontalBox::Slot().FillWidth(1.0f)
            [
                SNew(STextBlock)
                .Text(FText::FromString(Message.Text))
                .TextStyle(FAppStyle::Get(), "SmallText")
                .AutoWrapText(true)
            ]
        ];

    if (Message.bShowActions && Message.AttachedGraph.IsValid())
    {
        Content->AddSlot().AutoHeight().Padding(0, 6, 0, 0)
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().AutoWidth().Padding(0, 0, 4, 0)
            [
                SNew(SButton)
                .Text(LOCTEXT("PreviewBtn", "Preview"))
                .OnClicked(this, &SHaybaMCPWizardWidget::OnPreviewGraph)
            ]
            + SHorizontalBox::Slot().AutoWidth()
            [
                SNew(SButton)
                .Text(LOCTEXT("CreateBtn", "\u2B06  Create in UE"))
                .OnClicked(this, &SHaybaMCPWizardWidget::OnCreateInUE)
            ]
        ];
    }

    return SNew(SBox).Padding(FMargin(8, 3))
    [ Content ];
}

TSharedRef<SWidget> SHaybaMCPWizardWidget::BuildStepActionButtons(int32 StepIndex)
{
    return SNew(SHorizontalBox)
        + SHorizontalBox::Slot().AutoWidth().Padding(0, 0, 4, 0)
        [
            SNew(SButton)
            .Text(LOCTEXT("ApproveStepBtn", "\u2713"))
            .OnClicked(this, &SHaybaMCPWizardWidget::OnApproveStep)
        ]
        + SHorizontalBox::Slot().AutoWidth()
        [
            SNew(SButton)
            .Text(LOCTEXT("RedoStepBtn", "\u21ba"))
            .OnClicked(this, &SHaybaMCPWizardWidget::OnRedoStep)
        ];
}

// ---------------------------------------------------------------------------
// Chat management
// ---------------------------------------------------------------------------

void SHaybaMCPWizardWidget::RebuildChatUI()
{
    if (!ChatScrollBox.IsValid()) return;
    ChatScrollBox->ClearChildren();
    for (const FHaybaMCPChatMessage& Msg : Session.Messages)
        ChatScrollBox->AddSlot()[ BuildMessageWidget(Msg) ];
    ScrollToBottom();
}

void SHaybaMCPWizardWidget::RebuildSidebar()
{
    if (!StepListBox.IsValid()) return;
    StepListBox->ClearChildren();

    if (Session.Steps.IsEmpty())
    {
        StepListBox->AddSlot().AutoHeight().Padding(10, 6)
        [
            SNew(STextBlock)
            .Text(LOCTEXT("NoSteps", "Steps will appear\nonce you describe\nyour goal."))
            .TextStyle(FAppStyle::Get(), "SmallText")
            .AutoWrapText(true)
        ];
        return;
    }

    for (int32 i = 0; i < Session.Steps.Num(); ++i)
    {
        const FHaybaMCPWizardStep& Step = Session.Steps[i];
        const bool bIsCurrent = (i == Session.CurrentStep);

        FLinearColor IndicatorColor = ColorMuted;
        FString StatusSymbol = TEXT("\u25CB");
        if (Step.Status == EHaybaMCPWizardStepStatus::Approved)       { IndicatorColor = ColorSuccess; StatusSymbol = TEXT("\u2713"); }
        else if (Step.Status == EHaybaMCPWizardStepStatus::InProgress) { IndicatorColor = ColorSuccess; StatusSymbol = TEXT("\u25CF"); }
        else if (Step.Status == EHaybaMCPWizardStepStatus::Redoing)    { IndicatorColor = ColorError;   StatusSymbol = TEXT("\u21ba"); }

        StepListBox->AddSlot().AutoHeight()
        [
            SNew(SBorder)
            .BorderImage(FAppStyle::GetBrush(bIsCurrent ? "ToolPanel.GroupBorder" : "NoBrush"))
            .Padding(10, 6)
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(0, 0, 6, 0)
                [
                    SNew(STextBlock)
                    .Text(FText::FromString(StatusSymbol))
                    .TextStyle(FAppStyle::Get(), "SmallText")
                    .ColorAndOpacity(FSlateColor(IndicatorColor))
                ]
                + SHorizontalBox::Slot().FillWidth(1.0f).VAlign(VAlign_Center)
                [
                    SNew(STextBlock)
                    .Text(FText::FromString(FString::Printf(TEXT("%d. %s"), i + 1, *Step.Name)))
                    .TextStyle(FAppStyle::Get(), "SmallText")
                    .AutoWrapText(true)
                ]
            ]
        ];
    }
}

void SHaybaMCPWizardWidget::ScrollToBottom()
{
    if (!ChatScrollBox.IsValid()) return;
    TWeakPtr<SScrollBox> WeakScroll = ChatScrollBox;
    GEditor->GetTimerManager()->SetTimerForNextTick([WeakScroll]()
    {
        if (WeakScroll.IsValid()) WeakScroll.Pin()->ScrollToEnd();
    });
}

void SHaybaMCPWizardWidget::AddAIMessage(const FString& Text, TSharedPtr<FJsonObject> Graph, bool bShowActions)
{
    FHaybaMCPChatMessage Msg;
    Msg.bFromUser     = false;
    Msg.Text          = Text;
    Msg.AttachedGraph = Graph;
    Msg.bShowActions  = bShowActions;
    Session.Messages.Add(Msg);
    RebuildChatUI();
}

void SHaybaMCPWizardWidget::AddUserMessage(const FString& Text)
{
    FHaybaMCPChatMessage Msg;
    Msg.bFromUser = true;
    Msg.Text      = Text;
    Session.Messages.Add(Msg);
    RebuildChatUI();
}

void SHaybaMCPWizardWidget::AddTypingIndicator()
{
    if (bTypingIndicatorVisible) return;
    bTypingIndicatorVisible = true;
    FHaybaMCPChatMessage Msg;
    Msg.bFromUser    = false;
    Msg.Text         = TEXT("AI is thinking...");
    Msg.bShowActions = false;
    Session.Messages.Add(Msg);
    RebuildChatUI();
}

void SHaybaMCPWizardWidget::RemoveTypingIndicator()
{
    if (!bTypingIndicatorVisible) return;
    bTypingIndicatorVisible = false;
    if (!Session.Messages.IsEmpty()
        && !Session.Messages.Last().bFromUser
        && Session.Messages.Last().Text == TEXT("AI is thinking..."))
    {
        Session.Messages.RemoveAt(Session.Messages.Num() - 1);
    }
    RebuildChatUI();
}

// ---------------------------------------------------------------------------
// State queries
// ---------------------------------------------------------------------------

FText SHaybaMCPWizardWidget::GetStepProgressText() const
{
    if (Session.Steps.IsEmpty()) return FText::GetEmpty();
    return FText::FromString(FString::Printf(TEXT("Step %d / %d"),
        Session.CurrentStep + 1, Session.Steps.Num()));
}

EVisibility SHaybaMCPWizardWidget::GetActionBarVisibility() const
{
    if (!Session.HasCurrentStep()) return EVisibility::Collapsed;
    const FHaybaMCPWizardStep& Step = Session.Steps[Session.CurrentStep];
    return (Step.Status == EHaybaMCPWizardStepStatus::InProgress && Step.Graph.IsValid())
        ? EVisibility::Visible : EVisibility::Collapsed;
}

EVisibility SHaybaMCPWizardWidget::GetServerPromptVisibility() const
{
    return (Module && !Module->IsServerRunning()) ? EVisibility::Visible : EVisibility::Collapsed;
}

EVisibility SHaybaMCPWizardWidget::GetSettingsPanelVisibility() const
{
    return bSettingsVisible ? EVisibility::Visible : EVisibility::Collapsed;
}

bool SHaybaMCPWizardWidget::CanSendMessage() const
{
    return !Session.bWaitingForAI;
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

void SHaybaMCPWizardWidget::Tick(const FGeometry& AllottedGeometry, double InCurrentTime, float InDeltaTime)
{
    SCompoundWidget::Tick(AllottedGeometry, InCurrentTime, InDeltaTime);
}

// ---------------------------------------------------------------------------
// Wizard navigation
// ---------------------------------------------------------------------------

FReply SHaybaMCPWizardWidget::OnWizardNext()
{
    WizardPage = FMath::Min(WizardPage + 1, 2);
    RebuildContent();
    return FReply::Handled();
}

FReply SHaybaMCPWizardWidget::OnWizardBack()
{
    WizardPage = FMath::Max(WizardPage - 1, 0);
    RebuildContent();
    return FReply::Handled();
}

FReply SHaybaMCPWizardWidget::OnWizardFinish()
{
    FHaybaMCPSettings& S = FHaybaMCPSettings::Get();
    S.bHasSeenWizard = true;
    S.OperationMode  = ChosenMode;
    S.Save();

    ShowScreen(ChosenMode == EHaybaMCPOperationMode::Integrated
        ? EHaybaMCPScreen::MCPStatus
        : EHaybaMCPScreen::ChatUI);
    return FReply::Handled();
}

FReply SHaybaMCPWizardWidget::OnSelectIntegrated()
{
    ChosenMode = EHaybaMCPOperationMode::Integrated;
    if (CurrentScreen == EHaybaMCPScreen::Wizard)
    {
        RebuildContent();
    }
    else
    {
        FHaybaMCPSettings& S = FHaybaMCPSettings::Get();
        S.OperationMode = ChosenMode;
        S.Save();
        ShowScreen(EHaybaMCPScreen::MCPStatus);
    }
    return FReply::Handled();
}

FReply SHaybaMCPWizardWidget::OnSelectApiKey()
{
    ChosenMode = EHaybaMCPOperationMode::ApiKey;
    if (CurrentScreen == EHaybaMCPScreen::Wizard)
    {
        RebuildContent();
    }
    else
    {
        FHaybaMCPSettings& S = FHaybaMCPSettings::Get();
        S.OperationMode = ChosenMode;
        S.Save();
        ShowScreen(EHaybaMCPScreen::ChatUI);
    }
    return FReply::Handled();
}

// ---------------------------------------------------------------------------
// Action handlers (chat)
// ---------------------------------------------------------------------------

FReply SHaybaMCPWizardWidget::OnSendMessage()
{
    if (!InputBox.IsValid()) return FReply::Handled();
    FString Text = InputBox->GetText().ToString().TrimStartAndEnd();
    if (Text.IsEmpty()) return FReply::Handled();

    InputBox->SetText(FText::GetEmpty());
    AddUserMessage(Text);

    if (Session.Goal.IsEmpty()) InitializeSession(Text);
    else SendToMCP(Text);

    return FReply::Handled();
}

FReply SHaybaMCPWizardWidget::OnApproveStep()
{
    if (!Session.HasCurrentStep()) return FReply::Handled();
    Session.GetCurrentStep().Status = EHaybaMCPWizardStepStatus::Approved;
    RebuildSidebar();
    AdvanceToNextStep();
    return FReply::Handled();
}

FReply SHaybaMCPWizardWidget::OnRedoStep()
{
    if (!Session.HasCurrentStep()) return FReply::Handled();
    Session.GetCurrentStep().Status = EHaybaMCPWizardStepStatus::Redoing;
    Session.GetCurrentStep().Graph.Reset();
    RebuildSidebar();
    AddAIMessage(FString::Printf(TEXT("Let's redo \"%s\". What would you like to change?"),
        *Session.GetCurrentStep().Name));
    return FReply::Handled();
}

FReply SHaybaMCPWizardWidget::OnPreviewGraph()
{
    if (!Session.HasCurrentStep()) return FReply::Handled();
    TSharedPtr<FJsonObject> Graph = Session.GetCurrentStep().Graph;
    if (!Graph.IsValid()) return FReply::Handled();

    const TArray<TSharedPtr<FJsonValue>>* Nodes;
    const TArray<TSharedPtr<FJsonValue>>* Edges;
    int32 NodeCount = Graph->TryGetArrayField(TEXT("nodes"), Nodes) ? Nodes->Num() : 0;
    int32 EdgeCount = Graph->TryGetArrayField(TEXT("edges"), Edges) ? Edges->Num() : 0;

    AddAIMessage(FString::Printf(
        TEXT("Graph \"%s\": %d nodes, %d edges.\n\nUse Create in UE to materialize it."),
        *Session.GetCurrentStep().Name, NodeCount, EdgeCount));
    return FReply::Handled();
}

FReply SHaybaMCPWizardWidget::OnCreateInUE()
{
    if (!Session.HasCurrentStep() || !Module) return FReply::Handled();
    TSharedPtr<FJsonObject> Graph = Session.GetCurrentStep().Graph;
    if (!Graph.IsValid()) return FReply::Handled();

    FString GraphStr;
    TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&GraphStr);
    FJsonSerializer::Serialize(Graph.ToSharedRef(), Writer);

    FString AssetName = FString::Printf(TEXT("Wizard_%s_Step%d_%s"),
        *FDateTime::Now().ToString(TEXT("%H%M%S")),
        Session.CurrentStep + 1,
        *Session.GetCurrentStep().Name.Replace(TEXT(" "), TEXT("_")));

    TSharedRef<FJsonObject> Params = MakeShared<FJsonObject>();
    Params->SetStringField(TEXT("name"),  AssetName);
    Params->SetStringField(TEXT("graph"), GraphStr);

    AddAIMessage(FString::Printf(TEXT("Creating \"%s\"..."), *AssetName));

    int32 StepIndex = Session.CurrentStep;
    TWeakPtr<SHaybaMCPWizardWidget> WeakSelf = SharedThis(this);
    Module->SendTcpCommand(TEXT("create_graph"), Params,
        [WeakSelf, AssetName, StepIndex](bool bOk, const TSharedPtr<FJsonObject>& Response)
    {
        TSharedPtr<SHaybaMCPWizardWidget> Self = WeakSelf.Pin();
        if (!Self.IsValid()) return;

        if (!bOk || !Response.IsValid())
        {
            Self->AddAIMessage(TEXT("Failed to create graph. Check the Output Log."));
            return;
        }

        bool bCreated = false;
        Response->TryGetBoolField(TEXT("created"), bCreated);
        FString AssetPath;
        Response->TryGetStringField(TEXT("assetPath"), AssetPath);

        if (bCreated && Self->Session.Steps.IsValidIndex(StepIndex))
        {
            Self->Session.Steps[StepIndex].AssetPath = AssetPath;
            Self->AddAIMessage(FString::Printf(
                TEXT("Created: %s\n\nTest it or Approve & Continue."), *AssetPath));
        }
        else
        {
            Self->AddAIMessage(TEXT("Creation failed. I'll fix the errors and retry."));
            Self->SendToMCP(FString::Printf(TEXT("[FIX_ERRORS] step %d"), StepIndex));
        }
    });

    return FReply::Handled();
}

FReply SHaybaMCPWizardWidget::OnTestIt()
{
    if (!Session.HasCurrentStep() || !Module) return FReply::Handled();
    FString AssetPath = Session.GetCurrentStep().AssetPath;
    if (AssetPath.IsEmpty())
    {
        AddAIMessage(TEXT("Create the graph in UE first, then test it."));
        return FReply::Handled();
    }

    TSharedRef<FJsonObject> Params = MakeShared<FJsonObject>();
    Params->SetStringField(TEXT("assetPath"), AssetPath);

    TWeakPtr<SHaybaMCPWizardWidget> WeakSelf = SharedThis(this);
    Module->SendTcpCommand(TEXT("execute_graph"), Params,
        [WeakSelf](bool bOk, const TSharedPtr<FJsonObject>& Response)
    {
        TSharedPtr<SHaybaMCPWizardWidget> Self = WeakSelf.Pin();
        if (!Self.IsValid()) return;

        if (!bOk || !Response.IsValid()) { Self->AddAIMessage(TEXT("Failed to execute graph.")); return; }

        int32 Count = 0;
        if (Response->HasField(TEXT("componentsExecuted")))
            Count = (int32)Response->GetNumberField(TEXT("componentsExecuted"));

        if (Count > 0)
            Self->AddAIMessage(FString::Printf(TEXT("Executed on %d PCG component(s). Check the viewport!"), Count));
        else
        {
            FString Note;
            Response->TryGetStringField(TEXT("note"), Note);
            Self->AddAIMessage(FString::Printf(TEXT("No PCG components found.\n%s"), *Note));
        }
    });

    return FReply::Handled();
}

FReply SHaybaMCPWizardWidget::OnStartServer()
{
    if (Module) Module->StartMCPServer();
    return FReply::Handled();
}

FReply SHaybaMCPWizardWidget::OnToggleSettings()
{
    bSettingsVisible = !bSettingsVisible;
    return FReply::Handled();
}

FReply SHaybaMCPWizardWidget::OnSaveSettings()
{
    FHaybaMCPSettings& S = FHaybaMCPSettings::Get();
    if (ApiKeyBox.IsValid())     FHaybaMCPSettings::SetSharedApiKey(ApiKeyBox->GetText().ToString().TrimStartAndEnd());
    if (BaseUrlBox.IsValid())    S.BaseURL    = BaseUrlBox->GetText().ToString().TrimStartAndEnd();
    if (ModelBox.IsValid())      S.Model      = ModelBox->GetText().ToString().TrimStartAndEnd();
    if (OutputPathBox.IsValid()) S.OutputPath = OutputPathBox->GetText().ToString().TrimStartAndEnd();

    if (S.BaseURL.IsEmpty())    S.BaseURL    = TEXT("https://api.anthropic.com/v1/messages");
    if (S.Model.IsEmpty())      S.Model      = TEXT("claude-opus-4-6-20251101");
    if (S.OutputPath.IsEmpty()) S.OutputPath = TEXT("/Game/HaybaMCP/Generated");

    S.Save();
    bSettingsVisible = false;

    AddAIMessage(S.HasApiKey()
        ? FString::Printf(TEXT("Settings saved. Endpoint: %s"), *S.BaseURL)
        : TEXT("Settings saved. No API key set \u2014 add one to use the AI."));

    return FReply::Handled();
}

// ---------------------------------------------------------------------------
// Step flow
// ---------------------------------------------------------------------------

void SHaybaMCPWizardWidget::SendToMCP(const FString& UserMessage)
{
    const FHaybaMCPSettings& S = FHaybaMCPSettings::Get();
    if (!S.HasApiKey())
    {
        AddAIMessage(TEXT("No API key set. Open \u2699 Setup and enter your key."));
        return;
    }

    Session.bWaitingForAI = true;
    AddTypingIndicator();

    FOnClaudeResponse Callback;
    Callback.BindSP(this, &SHaybaMCPWizardWidget::OnClaudeResponse);
    FHaybaMCPClaudeClient::SendMessage(GetPCGExWizardSystemPrompt(), UserMessage,
        FHaybaMCPSettings::GetSharedApiKey(), S.Model, Callback);
}

void SHaybaMCPWizardWidget::OnClaudeResponse(bool bSuccess, const FString& ResponseText)
{
    RemoveTypingIndicator();
    Session.bWaitingForAI = false;

    if (!bSuccess) { AddAIMessage(ResponseText); return; }

    TSharedPtr<FJsonObject> Root;
    TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(ResponseText);
    FString ReplyText = ResponseText;
    TSharedPtr<FJsonObject> Graph;

    if (FJsonSerializer::Deserialize(Reader, Root) && Root.IsValid())
    {
        Root->TryGetStringField(TEXT("reply"), ReplyText);
        const TSharedPtr<FJsonObject>* GraphObj;
        if (Root->TryGetObjectField(TEXT("graph"), GraphObj) && GraphObj->IsValid())
            Graph = *GraphObj;
    }

    if (Graph.IsValid())
    {
        if (Session.HasCurrentStep())
        {
            Session.GetCurrentStep().Graph  = Graph;
            Session.GetCurrentStep().Status = EHaybaMCPWizardStepStatus::InProgress;
            RebuildSidebar();
        }
        AddAIMessage(ReplyText, Graph, true);
    }
    else
    {
        AddAIMessage(ReplyText);
    }
}

void SHaybaMCPWizardWidget::OnMCPResponse(bool bSuccess, const FString& ResponseText, TSharedPtr<FJsonObject> Graph)
{
    UE_LOG(LogHaybaMCPWizard, Log, TEXT("OnMCPResponse: %s"), *ResponseText);
}

void SHaybaMCPWizardWidget::InitializeSession(const FString& Goal)
{
    Session.Goal      = Goal;
    Session.SessionId = FGuid::NewGuid().ToString();
    RebuildSidebar();
    AddAIMessage(TEXT("Planning your project steps..."));
    SendToMCP(FString::Printf(TEXT("[INIT] Goal: %s"), *Goal));
}

void SHaybaMCPWizardWidget::AdvanceToNextStep()
{
    int32 Next = Session.CurrentStep + 1;
    if (Session.Steps.IsValidIndex(Next))
    {
        Session.CurrentStep         = Next;
        Session.Steps[Next].Status  = EHaybaMCPWizardStepStatus::InProgress;
        RebuildSidebar();
        AddAIMessage(FString::Printf(TEXT("Moving to step %d: \"%s\".\n\nHow would you like to approach this?"),
            Next + 1, *Session.Steps[Next].Name));
    }
    else
    {
        AddAIMessage(TEXT("All steps approved! Combining into the final graph..."));
        SendToMCP(TEXT("[FINALIZE]"));
    }
}

void SHaybaMCPWizardWidget::RedoCurrentStep()
{
    OnRedoStep();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

FReply SHaybaMCPWizardWidget::OnCopyText(FString Text)
{
    FPlatformApplicationMisc::ClipboardCopy(*Text);
    return FReply::Handled();
}

FString SHaybaMCPWizardWidget::ResolveMCPServerPath() const
{
    TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("HaybaMCPToolkit"));
    if (Plugin.IsValid())
    {
        FString Base = Plugin->GetBaseDir();
        return FPaths::ConvertRelativePathToFull(Base / TEXT("ThirdParty/mcp_server/dist/index.js"));
    }
    return TEXT("<plugin-dir>/ThirdParty/mcp_server/dist/index.js");
}

#undef LOCTEXT_NAMESPACE
