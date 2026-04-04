// Plugins/Hayba_PcgEx_MCP/Source/Hayba_PcgEx_MCP/Private/PCGExWizardWidget.cpp
#include "PCGExWizardWidget.h"
#include "PCGExBridgeModule.h"
#include "PCGExClaudeClient.h"
#include "PCGExBridgeSettings.h"
#include "PCGExWizardPrompt.h"
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

#define LOCTEXT_NAMESPACE "HaybaPCGEx"

DEFINE_LOG_CATEGORY_STATIC(LogPCGExWizard, Log, All);

// Status dot colors only — intentional minimal use of custom color
static const FLinearColor ColorSuccess(0.298f, 0.686f, 0.314f, 1.0f);
static const FLinearColor ColorError  (0.878f, 0.267f, 0.267f, 1.0f);
static const FLinearColor ColorMuted  (0.380f, 0.380f, 0.380f, 1.0f);

// ---------------------------------------------------------------------------
// Construct
// ---------------------------------------------------------------------------

void SPCGExWizardWidget::Construct(const FArguments& InArgs, FPCGExBridgeModule* InModule)
{
    Module = InModule;

    FPCGExBridgeSettings& S = FPCGExBridgeSettings::Get();
    ChosenMode = S.OperationMode;

    if (!S.bHasSeenWizard)
    {
        CurrentScreen = EPCGExScreen::Wizard;
        WizardPage    = 0;
    }
    else
    {
        CurrentScreen = EPCGExScreen::ModeSelect;
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

void SPCGExWizardWidget::ShowScreen(EPCGExScreen Screen)
{
    CurrentScreen = Screen;
    RebuildContent();
}

void SPCGExWizardWidget::RebuildContent()
{
    if (!ScreenSwitcher.IsValid()) return;

    TSharedRef<SWidget> Content = SNullWidget::NullWidget;
    switch (CurrentScreen)
    {
    case EPCGExScreen::Wizard:     Content = BuildWizardScreen();     break;
    case EPCGExScreen::ModeSelect: Content = BuildModeSelectScreen(); break;
    case EPCGExScreen::MCPStatus:  Content = BuildMCPStatusScreen();  break;
    case EPCGExScreen::ChatUI:     Content = BuildChatScreen();       break;
    }

    ScreenSwitcher->SetContent(Content);
}

// ---------------------------------------------------------------------------
// Shared header
// ---------------------------------------------------------------------------

TSharedRef<SWidget> SPCGExWizardWidget::BuildHeader(const FText& Title)
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
                .OnClicked(this, &SPCGExWizardWidget::OnSetupButton)
            ]
        ];
}

// ---------------------------------------------------------------------------
// Wizard screen
// ---------------------------------------------------------------------------

TSharedRef<SWidget> SPCGExWizardWidget::BuildWizardScreen()
{
    TSharedRef<SWidget> PageContent = SNullWidget::NullWidget;
    switch (WizardPage)
    {
    case 0: PageContent = BuildWizardPage0_Welcome();    break;
    case 1: PageContent = BuildWizardPage1_ModeChoice(); break;
    case 2:
        PageContent = (ChosenMode == EPCGExOperationMode::Integrated)
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
            .OnClicked(this, &SPCGExWizardWidget::OnWizardBack)
        ];
    }
    NavRow->AddSlot().FillWidth(1.0f);
    if (WizardPage < 2)
    {
        NavRow->AddSlot().AutoWidth()
        [
            SNew(SButton)
            .Text(LOCTEXT("Next", "Next \u2192"))
            .OnClicked(this, &SPCGExWizardWidget::OnWizardNext)
        ];
    }
    else
    {
        NavRow->AddSlot().AutoWidth()
        [
            SNew(SButton)
            .Text(LOCTEXT("Finish", "Finish"))
            .OnClicked(this, &SPCGExWizardWidget::OnWizardFinish)
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

TSharedRef<SWidget> SPCGExWizardWidget::BuildWizardPage0_Welcome()
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

TSharedRef<SWidget> SPCGExWizardWidget::BuildWizardPage1_ModeChoice()
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
                EPCGExOperationMode::Integrated)
        ]
        + SVerticalBox::Slot().AutoHeight()
        [
            BuildModeCard(
                LOCTEXT("ModeApiTitle", "API Key"),
                LOCTEXT("ModeApiDesc", "Design PCG graphs directly in this panel. Provide your API key and author graphs without leaving UE5."),
                EPCGExOperationMode::ApiKey)
        ];
}

TSharedRef<SWidget> SPCGExWizardWidget::BuildModeCard(const FText& Title, const FText& Desc, EPCGExOperationMode Mode)
{
    const bool bSelected = (ChosenMode == Mode);
    FReply (SPCGExWizardWidget::*Handler)() = (Mode == EPCGExOperationMode::Integrated)
        ? &SPCGExWizardWidget::OnSelectIntegrated
        : &SPCGExWizardWidget::OnSelectApiKey;

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

TSharedRef<SWidget> SPCGExWizardWidget::BuildWizardPage2a_Integrated()
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

TSharedRef<SWidget> SPCGExWizardWidget::BuildWizardPage2b_ApiKey()
{
    FString CurrentKey = FPCGExBridgeSettings::GetSharedApiKey();

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
                FPCGExBridgeSettings::SetSharedApiKey(T.ToString());
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

TSharedRef<SWidget> SPCGExWizardWidget::BuildModeSelectScreen()
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
                    EPCGExOperationMode::Integrated)
            ]
            + SVerticalBox::Slot().AutoHeight()
            [
                BuildModeCard(
                    LOCTEXT("ModeApiTitle", "API Key"),
                    LOCTEXT("ModeApiDesc", "Design PCG graphs directly in this panel using your API key."),
                    EPCGExOperationMode::ApiKey)
            ]
        ];
}

// ---------------------------------------------------------------------------
// MCP Status Screen (Mode A)
// ---------------------------------------------------------------------------

TSharedRef<SWidget> SPCGExWizardWidget::BuildMCPStatusScreen()
{
    FPCGExBridgeSettings& S = FPCGExBridgeSettings::Get();
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

void SPCGExWizardWidget::AddActivity(const FString& Text)
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

TSharedRef<SWidget> SPCGExWizardWidget::BuildChatScreen()
{
    const FPCGExBridgeSettings& S = FPCGExBridgeSettings::Get();

    if (!S.HasApiKey())
        AddAIMessage(TEXT("Welcome to HaybaPCGEx!\n\nOpen \u2699 Setup, switch to API Key mode, and enter your key to get started.\n\nWorks with Anthropic Claude, OpenAI, or any compatible endpoint."));
    else if (Session.Messages.IsEmpty())
        AddAIMessage(TEXT("Welcome back!\n\nDescribe what you want to generate:\n\u2022 \"A mini city with organic roads\"\n\u2022 \"A dungeon with connected rooms\"\n\u2022 \"A forest path network\""));

    return SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight()
        [ BuildHeader(LOCTEXT("ChatHeader", "HaybaPCGEx — API Key Mode")) ]

        + SVerticalBox::Slot().AutoHeight()
        [
            SNew(SBox).Visibility(this, &SPCGExWizardWidget::GetSettingsPanelVisibility)
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

TSharedRef<SWidget> SPCGExWizardWidget::BuildSettingsPanel()
{
    const FPCGExBridgeSettings& S = FPCGExBridgeSettings::Get();
    FString CurrentKey = FPCGExBridgeSettings::GetSharedApiKey();

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
                    LOCTEXT("OutputPathHint", "/Game/PCGExBridge/Generated")) ]
            ]

            + SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Right)
            [
                SNew(SButton)
                .Text(LOCTEXT("SaveSettings", "Save"))
                .OnClicked(this, &SPCGExWizardWidget::OnSaveSettings)
            ]
        ];
}

// ---------------------------------------------------------------------------
// Steps sidebar
// ---------------------------------------------------------------------------

TSharedRef<SWidget> SPCGExWizardWidget::BuildStepsSidebar()
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
                        if (!FPCGExBridgeSettings::Get().HasApiKey())
                            return FText::FromString(TEXT("No key set"));
                        FString Display = FPCGExBridgeSettings::Get().BaseURL;
                        Display.RemoveFromStart(TEXT("https://"));
                        Display.RemoveFromStart(TEXT("http://"));
                        int32 Slash = INDEX_NONE;
                        if (Display.FindChar('/', Slash)) Display = Display.Left(Slash);
                        return FText::FromString(Display);
                    })
                    .TextStyle(FAppStyle::Get(), "SmallText")
                    .ColorAndOpacity_Lambda([this]() -> FSlateColor
                    {
                        return FPCGExBridgeSettings::Get().HasApiKey() ? ColorSuccess : ColorError;
                    })
                    .AutoWrapText(true)
                ]
            ]
        ];
}

// ---------------------------------------------------------------------------
// Chat area, input, action bar
// ---------------------------------------------------------------------------

TSharedRef<SWidget> SPCGExWizardWidget::BuildChatArea()
{
    return SAssignNew(ChatScrollBox, SScrollBox).Orientation(Orient_Vertical);
}

TSharedRef<SWidget> SPCGExWizardWidget::BuildInputArea()
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
            .OnClicked(this, &SPCGExWizardWidget::OnSendMessage)
            .IsEnabled_Lambda([this]() { return CanSendMessage(); })
        ];
}

TSharedRef<SWidget> SPCGExWizardWidget::BuildActionBar()
{
    return SNew(SBox)
        .Visibility(this, &SPCGExWizardWidget::GetActionBarVisibility)
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
                    .OnClicked(this, &SPCGExWizardWidget::OnApproveStep)
                ]
                + SHorizontalBox::Slot().AutoWidth().Padding(0, 0, 6, 0)
                [
                    SNew(SButton)
                    .Text(LOCTEXT("TestBtn", "\u25B6  Test"))
                    .OnClicked(this, &SPCGExWizardWidget::OnTestIt)
                ]
                + SHorizontalBox::Slot().AutoWidth()
                [
                    SNew(SButton)
                    .Text(LOCTEXT("RedoBtn", "\u21ba  Redo"))
                    .OnClicked(this, &SPCGExWizardWidget::OnRedoStep)
                ]
            ]
        ];
}

// ---------------------------------------------------------------------------
// Message widgets — plain rows, no colored bubbles
// ---------------------------------------------------------------------------

TSharedRef<SWidget> SPCGExWizardWidget::BuildMessageWidget(const FPCGExChatMessage& Message)
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
                .OnClicked(this, &SPCGExWizardWidget::OnPreviewGraph)
            ]
            + SHorizontalBox::Slot().AutoWidth()
            [
                SNew(SButton)
                .Text(LOCTEXT("CreateBtn", "\u2B06  Create in UE"))
                .OnClicked(this, &SPCGExWizardWidget::OnCreateInUE)
            ]
        ];
    }

    return SNew(SBox).Padding(FMargin(8, 3))
    [ Content ];
}

TSharedRef<SWidget> SPCGExWizardWidget::BuildStepActionButtons(int32 StepIndex)
{
    return SNew(SHorizontalBox)
        + SHorizontalBox::Slot().AutoWidth().Padding(0, 0, 4, 0)
        [
            SNew(SButton)
            .Text(LOCTEXT("ApproveStepBtn", "\u2713"))
            .OnClicked(this, &SPCGExWizardWidget::OnApproveStep)
        ]
        + SHorizontalBox::Slot().AutoWidth()
        [
            SNew(SButton)
            .Text(LOCTEXT("RedoStepBtn", "\u21ba"))
            .OnClicked(this, &SPCGExWizardWidget::OnRedoStep)
        ];
}

// ---------------------------------------------------------------------------
// Chat management
// ---------------------------------------------------------------------------

void SPCGExWizardWidget::RebuildChatUI()
{
    if (!ChatScrollBox.IsValid()) return;
    ChatScrollBox->ClearChildren();
    for (const FPCGExChatMessage& Msg : Session.Messages)
        ChatScrollBox->AddSlot()[ BuildMessageWidget(Msg) ];
    ScrollToBottom();
}

void SPCGExWizardWidget::RebuildSidebar()
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
        const FPCGExWizardStep& Step = Session.Steps[i];
        const bool bIsCurrent = (i == Session.CurrentStep);

        FLinearColor IndicatorColor = ColorMuted;
        FString StatusSymbol = TEXT("\u25CB");
        if (Step.Status == EPCGExWizardStepStatus::Approved)       { IndicatorColor = ColorSuccess; StatusSymbol = TEXT("\u2713"); }
        else if (Step.Status == EPCGExWizardStepStatus::InProgress) { IndicatorColor = ColorSuccess; StatusSymbol = TEXT("\u25CF"); }
        else if (Step.Status == EPCGExWizardStepStatus::Redoing)    { IndicatorColor = ColorError;   StatusSymbol = TEXT("\u21ba"); }

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

void SPCGExWizardWidget::ScrollToBottom()
{
    if (!ChatScrollBox.IsValid()) return;
    TWeakPtr<SScrollBox> WeakScroll = ChatScrollBox;
    GEditor->GetTimerManager()->SetTimerForNextTick([WeakScroll]()
    {
        if (WeakScroll.IsValid()) WeakScroll.Pin()->ScrollToEnd();
    });
}

void SPCGExWizardWidget::AddAIMessage(const FString& Text, TSharedPtr<FJsonObject> Graph, bool bShowActions)
{
    FPCGExChatMessage Msg;
    Msg.bFromUser     = false;
    Msg.Text          = Text;
    Msg.AttachedGraph = Graph;
    Msg.bShowActions  = bShowActions;
    Session.Messages.Add(Msg);
    RebuildChatUI();
}

void SPCGExWizardWidget::AddUserMessage(const FString& Text)
{
    FPCGExChatMessage Msg;
    Msg.bFromUser = true;
    Msg.Text      = Text;
    Session.Messages.Add(Msg);
    RebuildChatUI();
}

void SPCGExWizardWidget::AddTypingIndicator()
{
    if (bTypingIndicatorVisible) return;
    bTypingIndicatorVisible = true;
    FPCGExChatMessage Msg;
    Msg.bFromUser    = false;
    Msg.Text         = TEXT("AI is thinking...");
    Msg.bShowActions = false;
    Session.Messages.Add(Msg);
    RebuildChatUI();
}

void SPCGExWizardWidget::RemoveTypingIndicator()
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

FText SPCGExWizardWidget::GetStepProgressText() const
{
    if (Session.Steps.IsEmpty()) return FText::GetEmpty();
    return FText::FromString(FString::Printf(TEXT("Step %d / %d"),
        Session.CurrentStep + 1, Session.Steps.Num()));
}

EVisibility SPCGExWizardWidget::GetActionBarVisibility() const
{
    if (!Session.HasCurrentStep()) return EVisibility::Collapsed;
    const FPCGExWizardStep& Step = Session.Steps[Session.CurrentStep];
    return (Step.Status == EPCGExWizardStepStatus::InProgress && Step.Graph.IsValid())
        ? EVisibility::Visible : EVisibility::Collapsed;
}

EVisibility SPCGExWizardWidget::GetServerPromptVisibility() const
{
    return (Module && !Module->IsServerRunning()) ? EVisibility::Visible : EVisibility::Collapsed;
}

EVisibility SPCGExWizardWidget::GetSettingsPanelVisibility() const
{
    return bSettingsVisible ? EVisibility::Visible : EVisibility::Collapsed;
}

bool SPCGExWizardWidget::CanSendMessage() const
{
    return !Session.bWaitingForAI;
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

void SPCGExWizardWidget::Tick(const FGeometry& AllottedGeometry, double InCurrentTime, float InDeltaTime)
{
    SCompoundWidget::Tick(AllottedGeometry, InCurrentTime, InDeltaTime);
}

// ---------------------------------------------------------------------------
// Wizard navigation
// ---------------------------------------------------------------------------

FReply SPCGExWizardWidget::OnWizardNext()
{
    WizardPage = FMath::Min(WizardPage + 1, 2);
    RebuildContent();
    return FReply::Handled();
}

FReply SPCGExWizardWidget::OnWizardBack()
{
    WizardPage = FMath::Max(WizardPage - 1, 0);
    RebuildContent();
    return FReply::Handled();
}

FReply SPCGExWizardWidget::OnWizardFinish()
{
    FPCGExBridgeSettings& S = FPCGExBridgeSettings::Get();
    S.bHasSeenWizard = true;
    S.OperationMode  = ChosenMode;
    S.Save();

    ShowScreen(ChosenMode == EPCGExOperationMode::Integrated
        ? EPCGExScreen::MCPStatus
        : EPCGExScreen::ChatUI);
    return FReply::Handled();
}

FReply SPCGExWizardWidget::OnSelectIntegrated()
{
    ChosenMode = EPCGExOperationMode::Integrated;
    if (CurrentScreen == EPCGExScreen::Wizard)
    {
        RebuildContent();
    }
    else
    {
        FPCGExBridgeSettings& S = FPCGExBridgeSettings::Get();
        S.OperationMode = ChosenMode;
        S.Save();
        ShowScreen(EPCGExScreen::MCPStatus);
    }
    return FReply::Handled();
}

FReply SPCGExWizardWidget::OnSelectApiKey()
{
    ChosenMode = EPCGExOperationMode::ApiKey;
    if (CurrentScreen == EPCGExScreen::Wizard)
    {
        RebuildContent();
    }
    else
    {
        FPCGExBridgeSettings& S = FPCGExBridgeSettings::Get();
        S.OperationMode = ChosenMode;
        S.Save();
        ShowScreen(EPCGExScreen::ChatUI);
    }
    return FReply::Handled();
}

// ---------------------------------------------------------------------------
// Action handlers (chat)
// ---------------------------------------------------------------------------

FReply SPCGExWizardWidget::OnSendMessage()
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

FReply SPCGExWizardWidget::OnApproveStep()
{
    if (!Session.HasCurrentStep()) return FReply::Handled();
    Session.GetCurrentStep().Status = EPCGExWizardStepStatus::Approved;
    RebuildSidebar();
    AdvanceToNextStep();
    return FReply::Handled();
}

FReply SPCGExWizardWidget::OnRedoStep()
{
    if (!Session.HasCurrentStep()) return FReply::Handled();
    Session.GetCurrentStep().Status = EPCGExWizardStepStatus::Redoing;
    Session.GetCurrentStep().Graph.Reset();
    RebuildSidebar();
    AddAIMessage(FString::Printf(TEXT("Let's redo \"%s\". What would you like to change?"),
        *Session.GetCurrentStep().Name));
    return FReply::Handled();
}

FReply SPCGExWizardWidget::OnPreviewGraph()
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

FReply SPCGExWizardWidget::OnCreateInUE()
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
    TWeakPtr<SPCGExWizardWidget> WeakSelf = SharedThis(this);
    Module->SendTcpCommand(TEXT("create_graph"), Params,
        [WeakSelf, AssetName, StepIndex](bool bOk, const TSharedPtr<FJsonObject>& Response)
    {
        TSharedPtr<SPCGExWizardWidget> Self = WeakSelf.Pin();
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

FReply SPCGExWizardWidget::OnTestIt()
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

    TWeakPtr<SPCGExWizardWidget> WeakSelf = SharedThis(this);
    Module->SendTcpCommand(TEXT("execute_graph"), Params,
        [WeakSelf](bool bOk, const TSharedPtr<FJsonObject>& Response)
    {
        TSharedPtr<SPCGExWizardWidget> Self = WeakSelf.Pin();
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

FReply SPCGExWizardWidget::OnStartServer()
{
    if (Module) Module->StartMCPServer();
    return FReply::Handled();
}

FReply SPCGExWizardWidget::OnToggleSettings()
{
    bSettingsVisible = !bSettingsVisible;
    return FReply::Handled();
}

FReply SPCGExWizardWidget::OnSaveSettings()
{
    FPCGExBridgeSettings& S = FPCGExBridgeSettings::Get();
    if (ApiKeyBox.IsValid())     FPCGExBridgeSettings::SetSharedApiKey(ApiKeyBox->GetText().ToString().TrimStartAndEnd());
    if (BaseUrlBox.IsValid())    S.BaseURL    = BaseUrlBox->GetText().ToString().TrimStartAndEnd();
    if (ModelBox.IsValid())      S.Model      = ModelBox->GetText().ToString().TrimStartAndEnd();
    if (OutputPathBox.IsValid()) S.OutputPath = OutputPathBox->GetText().ToString().TrimStartAndEnd();

    if (S.BaseURL.IsEmpty())    S.BaseURL    = TEXT("https://api.anthropic.com/v1/messages");
    if (S.Model.IsEmpty())      S.Model      = TEXT("claude-opus-4-6-20251101");
    if (S.OutputPath.IsEmpty()) S.OutputPath = TEXT("/Game/PCGExBridge/Generated");

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

void SPCGExWizardWidget::SendToMCP(const FString& UserMessage)
{
    const FPCGExBridgeSettings& S = FPCGExBridgeSettings::Get();
    if (!S.HasApiKey())
    {
        AddAIMessage(TEXT("No API key set. Open \u2699 Setup and enter your key."));
        return;
    }

    Session.bWaitingForAI = true;
    AddTypingIndicator();

    FOnClaudeResponse Callback;
    Callback.BindSP(this, &SPCGExWizardWidget::OnClaudeResponse);
    FPCGExClaudeClient::SendMessage(GetPCGExWizardSystemPrompt(), UserMessage,
        FPCGExBridgeSettings::GetSharedApiKey(), S.Model, Callback);
}

void SPCGExWizardWidget::OnClaudeResponse(bool bSuccess, const FString& ResponseText)
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
            Session.GetCurrentStep().Status = EPCGExWizardStepStatus::InProgress;
            RebuildSidebar();
        }
        AddAIMessage(ReplyText, Graph, true);
    }
    else
    {
        AddAIMessage(ReplyText);
    }
}

void SPCGExWizardWidget::OnMCPResponse(bool bSuccess, const FString& ResponseText, TSharedPtr<FJsonObject> Graph)
{
    UE_LOG(LogPCGExWizard, Log, TEXT("OnMCPResponse: %s"), *ResponseText);
}

void SPCGExWizardWidget::InitializeSession(const FString& Goal)
{
    Session.Goal      = Goal;
    Session.SessionId = FGuid::NewGuid().ToString();
    RebuildSidebar();
    AddAIMessage(TEXT("Planning your project steps..."));
    SendToMCP(FString::Printf(TEXT("[INIT] Goal: %s"), *Goal));
}

void SPCGExWizardWidget::AdvanceToNextStep()
{
    int32 Next = Session.CurrentStep + 1;
    if (Session.Steps.IsValidIndex(Next))
    {
        Session.CurrentStep         = Next;
        Session.Steps[Next].Status  = EPCGExWizardStepStatus::InProgress;
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

void SPCGExWizardWidget::RedoCurrentStep()
{
    OnRedoStep();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

FReply SPCGExWizardWidget::OnCopyText(FString Text)
{
    FPlatformApplicationMisc::ClipboardCopy(*Text);
    return FReply::Handled();
}

FString SPCGExWizardWidget::ResolveMCPServerPath() const
{
    TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("Hayba_PcgEx_MCP"));
    if (Plugin.IsValid())
    {
        FString Base = Plugin->GetBaseDir();
        return FPaths::ConvertRelativePathToFull(Base / TEXT("ThirdParty/mcp_server/dist/index.js"));
    }
    return TEXT("<plugin-dir>/ThirdParty/mcp_server/dist/index.js");
}

#undef LOCTEXT_NAMESPACE
