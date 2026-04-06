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
#include "Widgets/Layout/SUniformGridPanel.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SEditableTextBox.h"
#include "Widgets/Input/SMultiLineEditableTextBox.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Images/SImage.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Notifications/SProgressBar.h"
#include "Framework/Application/SlateApplication.h"
#include "Styling/SlateBrush.h"
#include "Styling/SlateStyle.h"
#include "Logging/LogMacros.h"
#include "Misc/Guid.h"
#include "Misc/Paths.h"
#include "Json.h"
#include "JsonUtilities.h"
#include "Editor.h"
#include "Interfaces/IPluginManager.h"

DEFINE_LOG_CATEGORY_STATIC(LogPCGExWizard, Log, All);

// ── Hayba brand palette ──────────────────────────────────────────
static const FLinearColor ColorBG      (0.075f, 0.075f, 0.075f, 1.0f); // #131313
static const FLinearColor ColorSurface (0.110f, 0.110f, 0.110f, 1.0f); // #1c1c1c
static const FLinearColor ColorPanel   (0.145f, 0.145f, 0.145f, 1.0f); // #252525
static const FLinearColor ColorCard    (0.190f, 0.190f, 0.190f, 1.0f); // #303030
static const FLinearColor ColorBorder  (0.230f, 0.230f, 0.230f, 1.0f); // #3b3b3b
static const FLinearColor ColorAccent  (0.914f, 0.404f, 0.212f, 1.0f); // #E96736 — Hayba orange
static const FLinearColor ColorAccentDim(0.55f, 0.24f, 0.13f, 1.0f);   // darker orange for buttons
static const FLinearColor ColorSuccess (0.298f, 0.686f, 0.314f, 1.0f); // #4CAF50
static const FLinearColor ColorError   (0.878f, 0.267f, 0.267f, 1.0f); // #E04444
static const FLinearColor ColorText    (0.900f, 0.900f, 0.900f, 1.0f);
static const FLinearColor ColorSubtext (0.580f, 0.580f, 0.580f, 1.0f);
static const FLinearColor ColorMuted   (0.380f, 0.380f, 0.380f, 1.0f);
static const FLinearColor ColorUserBubble(0.180f, 0.220f, 0.300f, 1.0f);
static const FLinearColor ColorAIBubble  (0.155f, 0.155f, 0.155f, 1.0f);

static FSlateFontInfo BoldFont(int32 Size)   { return FCoreStyle::GetDefaultFontStyle("Bold",    Size); }
static FSlateFontInfo RegFont (int32 Size)   { return FCoreStyle::GetDefaultFontStyle("Regular", Size); }

// ── Construct ────────────────────────────────────────────────────

void SPCGExWizardWidget::Construct(const FArguments& InArgs, FPCGExBridgeModule* InModule)
{
    Module = InModule;

    // Load logo from plugin Resources
    FString LogoPath = FPaths::Combine(
        IPluginManager::Get().FindPlugin(TEXT("Hayba_PcgEx_MCP"))->GetBaseDir(),
        TEXT("Resources"), TEXT("HaybaLogo_32.png"));
    if (FPaths::FileExists(LogoPath))
    {
        LogoBrush = MakeShared<FSlateDynamicImageBrush>(
            FName(*LogoPath), FVector2D(24, 32));
    }

    ChildSlot
    [
        SNew(SBorder)
        .BorderBackgroundColor(ColorBG)
        .BorderImage(FCoreStyle::Get().GetBrush("WhiteBrush"))
        .Padding(0)
        [
            SNew(SVerticalBox)

            // ── Header ──
            + SVerticalBox::Slot()
            .AutoHeight()
            [
                BuildHeader()
            ]

            // ── Settings panel (collapsible) ──
            + SVerticalBox::Slot()
            .AutoHeight()
            [
                SNew(SBox)
                .Visibility(this, &SPCGExWizardWidget::GetSettingsPanelVisibility)
                [
                    BuildSettingsPanel()
                ]
            ]

            // ── Two-column main area ──
            + SVerticalBox::Slot()
            .FillHeight(1.0f)
            [
                SNew(SHorizontalBox)

                // Left: chat
                + SHorizontalBox::Slot()
                .FillWidth(0.65f)
                [
                    SNew(SBorder)
                    .BorderBackgroundColor(ColorSurface)
                    .BorderImage(FCoreStyle::Get().GetBrush("WhiteBrush"))
                    .Padding(0)
                    [
                        SNew(SVerticalBox)

                        + SVerticalBox::Slot()
                        .FillHeight(1.0f)
                        [
                            BuildChatArea()
                        ]

                        + SVerticalBox::Slot()
                        .AutoHeight()
                        .Padding(8, 4)
                        [
                            BuildActionBar()
                        ]

                        + SVerticalBox::Slot()
                        .AutoHeight()
                        .Padding(8, 4, 8, 8)
                        [
                            BuildInputArea()
                        ]
                    ]
                ]

                // Divider
                + SHorizontalBox::Slot()
                .AutoWidth()
                [
                    SNew(SSeparator)
                    .Orientation(Orient_Vertical)
                    .SeparatorImage(FCoreStyle::Get().GetBrush("WhiteBrush"))
                    .ColorAndOpacity(ColorBorder)
                ]

                // Right: steps + status
                + SHorizontalBox::Slot()
                .FillWidth(0.35f)
                [
                    BuildStepsSidebar()
                ]
            ]
        ]
    ];

    const FPCGExBridgeSettings& S = FPCGExBridgeSettings::Get();
    if (!S.HasApiKey())
        AddAIMessage(TEXT("Welcome to Hayba PCGEx MCP!\n\nOpen \u2699 Settings and enter your API key to get started.\n\nWorks with Anthropic Claude, OpenAI, or any compatible endpoint."));
    else
        AddAIMessage(TEXT("Welcome back!\n\nDescribe what you want to generate:\n\u2022 \"A mini city with organic roads\"\n\u2022 \"A dungeon with connected rooms\"\n\u2022 \"A forest path network\""));
}

// ── Header ───────────────────────────────────────────────────────

TSharedRef<SWidget> SPCGExWizardWidget::BuildHeader()
{
    TSharedRef<SHorizontalBox> Bar = SNew(SHorizontalBox);

    // Logo
    if (LogoBrush.IsValid())
    {
        Bar->AddSlot()
        .AutoWidth()
        .VAlign(VAlign_Center)
        .Padding(12, 0, 8, 0)
        [
            SNew(SImage)
            .Image(LogoBrush.Get())
        ];
    }

    // Title
    Bar->AddSlot()
    .FillWidth(1.0f)
    .VAlign(VAlign_Center)
    .Padding(0, 0, 8, 0)
    [
        SNew(SVerticalBox)
        + SVerticalBox::Slot()
        .AutoHeight()
        [
            SNew(STextBlock)
            .Text(FText::FromString(TEXT("PCGEx MCP")))
            .Font(BoldFont(12))
            .ColorAndOpacity(ColorText)
        ]
        + SVerticalBox::Slot()
        .AutoHeight()
        [
            SNew(STextBlock)
            .Text(FText::FromString(TEXT("by Hayba")))
            .Font(RegFont(8))
            .ColorAndOpacity(ColorAccent)
        ]
    ];

    // Server status dot + label
    Bar->AddSlot()
    .AutoWidth()
    .VAlign(VAlign_Center)
    .Padding(0, 0, 6, 0)
    [
        SNew(SHorizontalBox)
        + SHorizontalBox::Slot()
        .AutoWidth()
        .VAlign(VAlign_Center)
        .Padding(0, 0, 4, 0)
        [
            SNew(SBox)
            .WidthOverride(7).HeightOverride(7)
            [
                SNew(SBorder)
                .BorderImage(FCoreStyle::Get().GetBrush("WhiteBrush"))
                .BorderBackgroundColor_Lambda([this]() -> FSlateColor
                {
                    return Module && Module->IsServerRunning() ? ColorSuccess : ColorMuted;
                })
            ]
        ]
        + SHorizontalBox::Slot()
        .AutoWidth()
        .VAlign(VAlign_Center)
        [
            SNew(STextBlock)
            .Text_Lambda([this]() -> FText
            {
                return FText::FromString(Module && Module->IsServerRunning() ? TEXT("Bridge") : TEXT("Offline"));
            })
            .Font(RegFont(8))
            .ColorAndOpacity(ColorMuted)
        ]
    ];

    // Start server button (only when offline)
    Bar->AddSlot()
    .AutoWidth()
    .VAlign(VAlign_Center)
    .Padding(0, 0, 4, 0)
    [
        SNew(SBox)
        .Visibility(this, &SPCGExWizardWidget::GetServerPromptVisibility)
        [
            SNew(SButton)
            .Text(FText::FromString(TEXT("\u25B6")))
            .ToolTipText(FText::FromString(TEXT("Start Bridge Server")))
            .OnClicked(this, &SPCGExWizardWidget::OnStartServer)
            .ButtonColorAndOpacity(ColorAccentDim)
        ]
    ];

    // Settings button
    Bar->AddSlot()
    .AutoWidth()
    .VAlign(VAlign_Center)
    .Padding(0, 0, 8, 0)
    [
        SNew(SButton)
        .Text(FText::FromString(TEXT("\u2699")))
        .ToolTipText(FText::FromString(TEXT("Settings")))
        .OnClicked(this, &SPCGExWizardWidget::OnToggleSettings)
        .ButtonColorAndOpacity(FLinearColor::Transparent)
        .ForegroundColor(ColorSubtext)
    ];

    return SNew(SBorder)
        .BorderImage(FCoreStyle::Get().GetBrush("WhiteBrush"))
        .BorderBackgroundColor(ColorPanel)
        .Padding(0, 6)
        [ Bar ];
}

// ── Settings panel ───────────────────────────────────────────────

TSharedRef<SWidget> SPCGExWizardWidget::BuildSettingsPanel()
{
    const FPCGExBridgeSettings& S = FPCGExBridgeSettings::Get();

    auto MakeField = [&](const FString& Label, TSharedPtr<SEditableTextBox>& OutBox,
                         const FString& Value, const FString& Hint, bool bPassword = false) -> TSharedRef<SWidget>
    {
        return SNew(SVerticalBox)
            + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 3)
            [
                SNew(STextBlock)
                .Text(FText::FromString(Label))
                .Font(BoldFont(8))
                .ColorAndOpacity(ColorSubtext)
            ]
            + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 8)
            [
                SAssignNew(OutBox, SEditableTextBox)
                .Text(FText::FromString(Value))
                .HintText(FText::FromString(Hint))
                .IsPassword(bPassword)
            ];
    };

    return SNew(SBorder)
        .BorderImage(FCoreStyle::Get().GetBrush("WhiteBrush"))
        .BorderBackgroundColor(ColorPanel)
        .Padding(12, 10)
        [
            SNew(SVerticalBox)

            + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 10)
            [
                SNew(STextBlock)
                .Text(FText::FromString(TEXT("Settings")))
                .Font(BoldFont(10))
                .ColorAndOpacity(ColorText)
            ]

            // Two-column: API Key + Base URL
            + SVerticalBox::Slot().AutoHeight()
            [
                SNew(SHorizontalBox)

                + SHorizontalBox::Slot().FillWidth(1.0f).Padding(0, 0, 8, 0)
                [
                    MakeField(TEXT("API Key"), ApiKeyBox, S.ApiKey, TEXT("sk-ant-...  or  sk-..."), true)
                ]

                + SHorizontalBox::Slot().FillWidth(1.0f)
                [
                    MakeField(TEXT("Endpoint URL"), BaseUrlBox, S.BaseURL, TEXT("https://api.anthropic.com/v1/messages"))
                ]
            ]

            // Two-column: Model + Output Path
            + SVerticalBox::Slot().AutoHeight()
            [
                SNew(SHorizontalBox)

                + SHorizontalBox::Slot().FillWidth(1.0f).Padding(0, 0, 8, 0)
                [
                    MakeField(TEXT("Model"), ModelBox, S.Model, TEXT("claude-opus-4-6-20251101"))
                ]

                + SHorizontalBox::Slot().FillWidth(1.0f)
                [
                    MakeField(TEXT("Output Path"), OutputPathBox, S.OutputPath, TEXT("/Game/PCGExBridge/Generated"))
                ]
            ]

            + SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Right)
            [
                SNew(SButton)
                .Text(FText::FromString(TEXT("Save")))
                .OnClicked(this, &SPCGExWizardWidget::OnSaveSettings)
                .ButtonColorAndOpacity(ColorAccent)
                .ForegroundColor(FLinearColor::White)
            ]
        ];
}

// ── Steps sidebar ────────────────────────────────────────────────

TSharedRef<SWidget> SPCGExWizardWidget::BuildStepsSidebar()
{
    return SNew(SBorder)
        .BorderImage(FCoreStyle::Get().GetBrush("WhiteBrush"))
        .BorderBackgroundColor(ColorPanel)
        .Padding(0)
        [
            SNew(SVerticalBox)

            // Sidebar header
            + SVerticalBox::Slot()
            .AutoHeight()
            .Padding(10, 8, 10, 6)
            [
                SNew(STextBlock)
                .Text(FText::FromString(TEXT("STEPS")))
                .Font(BoldFont(8))
                .ColorAndOpacity(ColorMuted)
            ]

            + SVerticalBox::Slot()
            .AutoHeight()
            .Padding(10, 0, 10, 8)
            [
                SNew(SProgressBar)
                .Percent_Lambda([this]() -> TOptional<float>
                {
                    if (Session.Steps.IsEmpty()) return 0.0f;
                    return (float)(Session.CurrentStep + 1) / (float)Session.Steps.Num();
                })
                .FillColorAndOpacity(ColorAccent)
            ]

            // Step list (rebuilt dynamically)
            + SVerticalBox::Slot()
            .FillHeight(1.0f)
            [
                SNew(SScrollBox)
                + SScrollBox::Slot()
                [
                    SAssignNew(StepListBox, SVerticalBox)
                ]
            ]

            // Separator
            + SVerticalBox::Slot()
            .AutoHeight()
            [
                SNew(SSeparator)
                .SeparatorImage(FCoreStyle::Get().GetBrush("WhiteBrush"))
                .ColorAndOpacity(ColorBorder)
            ]

            // Connection status card
            + SVerticalBox::Slot()
            .AutoHeight()
            .Padding(10, 8)
            [
                SNew(SVerticalBox)

                + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 4)
                [
                    SNew(STextBlock)
                    .Text(FText::FromString(TEXT("BRIDGE")))
                    .Font(BoldFont(8))
                    .ColorAndOpacity(ColorMuted)
                ]

                + SVerticalBox::Slot().AutoHeight()
                [
                    SNew(STextBlock)
                    .Text_Lambda([this]() -> FText
                    {
                        if (!Module) return FText::FromString(TEXT("No module"));
                        return FText::FromString(Module->IsServerRunning()
                            ? FString::Printf(TEXT("TCP :%d  MCP :%d"), 52342, 52341)
                            : TEXT("Not running"));
                    })
                    .Font(RegFont(8))
                    .ColorAndOpacity_Lambda([this]() -> FSlateColor
                    {
                        return Module && Module->IsServerRunning() ? ColorSuccess : ColorError;
                    })
                ]
            ]

            // AI status card
            + SVerticalBox::Slot()
            .AutoHeight()
            .Padding(10, 0, 10, 10)
            [
                SNew(SVerticalBox)

                + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 4)
                [
                    SNew(STextBlock)
                    .Text(FText::FromString(TEXT("AI")))
                    .Font(BoldFont(8))
                    .ColorAndOpacity(ColorMuted)
                ]

                + SVerticalBox::Slot().AutoHeight()
                [
                    SNew(STextBlock)
                    .Text_Lambda([this]() -> FText
                    {
                        const FPCGExBridgeSettings& S = FPCGExBridgeSettings::Get();
                        if (!S.HasApiKey()) return FText::FromString(TEXT("No key set"));
                        FString Display = S.BaseURL;
                        Display.RemoveFromStart(TEXT("https://"));
                        Display.RemoveFromStart(TEXT("http://"));
                        int32 Slash = INDEX_NONE;
                        if (Display.FindChar('/', Slash)) Display = Display.Left(Slash);
                        return FText::FromString(Display);
                    })
                    .Font(RegFont(8))
                    .ColorAndOpacity_Lambda([this]() -> FSlateColor
                    {
                        return FPCGExBridgeSettings::Get().HasApiKey() ? ColorSuccess : ColorError;
                    })
                    .AutoWrapText(true)
                ]
            ]
        ];
}

// ── Chat area ────────────────────────────────────────────────────

TSharedRef<SWidget> SPCGExWizardWidget::BuildChatArea()
{
    return SAssignNew(ChatScrollBox, SScrollBox)
        .Orientation(Orient_Vertical);
}

// ── Input area ───────────────────────────────────────────────────

TSharedRef<SWidget> SPCGExWizardWidget::BuildInputArea()
{
    return SNew(SVerticalBox)

        + SVerticalBox::Slot()
        .AutoHeight()
        .Padding(0, 0, 0, 4)
        [
            SAssignNew(InputBox, SMultiLineEditableTextBox)
            .HintText(FText::FromString(TEXT("Describe what you want to generate...")))
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

        + SVerticalBox::Slot()
        .AutoHeight()
        .HAlign(HAlign_Right)
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot()
            .AutoWidth()
            .Padding(0, 0, 4, 0)
            [
                SNew(STextBlock)
                .Text(FText::FromString(TEXT("Shift+Enter for newline")))
                .Font(RegFont(7))
                .ColorAndOpacity(ColorMuted)
                .Visibility_Lambda([this]() {
                    return InputBox.IsValid() && !InputBox->GetText().IsEmpty()
                        ? EVisibility::Visible : EVisibility::Collapsed;
                })
            ]
            + SHorizontalBox::Slot()
            .AutoWidth()
            [
                SNew(SButton)
                .Text(FText::FromString(TEXT("Send \u23CE")))
                .OnClicked(this, &SPCGExWizardWidget::OnSendMessage)
                .IsEnabled_Lambda([this]() { return CanSendMessage(); })
                .ButtonColorAndOpacity_Lambda([this]() -> FLinearColor
                {
                    return CanSendMessage() ? ColorAccent : ColorCard;
                })
                .ForegroundColor(FLinearColor::White)
            ]
        ];
}

// ── Action bar ───────────────────────────────────────────────────

TSharedRef<SWidget> SPCGExWizardWidget::BuildActionBar()
{
    return SNew(SBox)
        .Visibility(this, &SPCGExWizardWidget::GetActionBarVisibility)
        [
            SNew(SBorder)
            .BorderImage(FCoreStyle::Get().GetBrush("WhiteBrush"))
            .BorderBackgroundColor(ColorCard)
            .Padding(8, 6)
            [
                SNew(SHorizontalBox)

                + SHorizontalBox::Slot()
                .FillWidth(1.0f)
                .Padding(0, 0, 6, 0)
                [
                    SNew(SButton)
                    .Text(FText::FromString(TEXT("\u2713  Approve & Continue")))
                    .OnClicked(this, &SPCGExWizardWidget::OnApproveStep)
                    .ButtonColorAndOpacity(ColorSuccess)
                    .ForegroundColor(FLinearColor::White)
                ]

                + SHorizontalBox::Slot()
                .AutoWidth()
                .Padding(0, 0, 6, 0)
                [
                    SNew(SButton)
                    .Text(FText::FromString(TEXT("\u25B6  Test")))
                    .OnClicked(this, &SPCGExWizardWidget::OnTestIt)
                    .ButtonColorAndOpacity(ColorAccentDim)
                    .ForegroundColor(FLinearColor::White)
                ]

                + SHorizontalBox::Slot()
                .AutoWidth()
                [
                    SNew(SButton)
                    .Text(FText::FromString(TEXT("\u21ba  Redo")))
                    .OnClicked(this, &SPCGExWizardWidget::OnRedoStep)
                    .ButtonColorAndOpacity(ColorCard)
                    .ForegroundColor(ColorSubtext)
                ]
            ]
        ];
}

// ── Message bubbles ──────────────────────────────────────────────

TSharedRef<SWidget> SPCGExWizardWidget::BuildMessageWidget(const FPCGExChatMessage& Message)
{
    return Message.bFromUser
        ? BuildUserMessageBubble(Message)
        : BuildAIMessageBubble(Message);
}

TSharedRef<SWidget> SPCGExWizardWidget::BuildAIMessageBubble(const FPCGExChatMessage& Message)
{
    TSharedRef<SVerticalBox> Content = SNew(SVerticalBox)

        + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 4)
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().AutoWidth().Padding(0, 0, 6, 0)
            [
                SNew(STextBlock)
                .Text(FText::FromString(TEXT("Hayba AI")))
                .Font(BoldFont(8))
                .ColorAndOpacity(ColorAccent)
            ]
            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Bottom)
            [
                SNew(STextBlock)
                .Text(FText::FromString(Message.Timestamp.ToString(TEXT("%H:%M"))))
                .Font(RegFont(7))
                .ColorAndOpacity(ColorMuted)
            ]
        ]

        + SVerticalBox::Slot().AutoHeight()
        [
            SNew(STextBlock)
            .Text(FText::FromString(Message.Text))
            .Font(RegFont(9))
            .ColorAndOpacity(ColorText)
            .AutoWrapText(true)
        ];

    if (Message.bShowActions && Message.AttachedGraph.IsValid())
    {
        Content->AddSlot()
        .AutoHeight()
        .Padding(0, 8, 0, 0)
        [
            SNew(SHorizontalBox)

            + SHorizontalBox::Slot().AutoWidth().Padding(0, 0, 4, 0)
            [
                SNew(SButton)
                .Text(FText::FromString(TEXT("Preview")))
                .OnClicked(this, &SPCGExWizardWidget::OnPreviewGraph)
                .ButtonColorAndOpacity(ColorCard)
                .ForegroundColor(ColorSubtext)
            ]

            + SHorizontalBox::Slot().AutoWidth().Padding(0, 0, 4, 0)
            [
                SNew(SButton)
                .Text(FText::FromString(TEXT("\u2B06  Create in UE")))
                .OnClicked(this, &SPCGExWizardWidget::OnCreateInUE)
                .ButtonColorAndOpacity(ColorAccent)
                .ForegroundColor(FLinearColor::White)
            ]
        ];
    }

    return SNew(SBox)
        .Padding(FMargin(8, 4, 40, 4))
        [
            SNew(SBorder)
            .BorderImage(FCoreStyle::Get().GetBrush("WhiteBrush"))
            .BorderBackgroundColor(ColorAIBubble)
            .Padding(10, 8)
            [ Content ]
        ];
}

TSharedRef<SWidget> SPCGExWizardWidget::BuildUserMessageBubble(const FPCGExChatMessage& Message)
{
    return SNew(SBox)
        .Padding(FMargin(40, 4, 8, 4))
        .HAlign(HAlign_Right)
        [
            SNew(SBorder)
            .BorderImage(FCoreStyle::Get().GetBrush("WhiteBrush"))
            .BorderBackgroundColor(ColorUserBubble)
            .Padding(10, 8)
            [
                SNew(SVerticalBox)

                + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 4).HAlign(HAlign_Right)
                [
                    SNew(STextBlock)
                    .Text(FText::FromString(Message.Timestamp.ToString(TEXT("%H:%M"))))
                    .Font(RegFont(7))
                    .ColorAndOpacity(ColorMuted)
                ]

                + SVerticalBox::Slot().AutoHeight()
                [
                    SNew(STextBlock)
                    .Text(FText::FromString(Message.Text))
                    .Font(RegFont(9))
                    .ColorAndOpacity(ColorText)
                    .AutoWrapText(true)
                ]
            ]
        ];
}

TSharedRef<SWidget> SPCGExWizardWidget::BuildStepActionButtons(int32 StepIndex)
{
    return SNew(SHorizontalBox)

        + SHorizontalBox::Slot().AutoWidth().Padding(0, 0, 4, 0)
        [
            SNew(SButton)
            .Text(FText::FromString(TEXT("\u2713")))
            .OnClicked(this, &SPCGExWizardWidget::OnApproveStep)
            .ButtonColorAndOpacity(ColorSuccess)
            .ForegroundColor(FLinearColor::White)
        ]

        + SHorizontalBox::Slot().AutoWidth()
        [
            SNew(SButton)
            .Text(FText::FromString(TEXT("\u21ba")))
            .OnClicked(this, &SPCGExWizardWidget::OnRedoStep)
            .ButtonColorAndOpacity(ColorCard)
            .ForegroundColor(ColorSubtext)
        ];
}

// ── Chat management ──────────────────────────────────────────────

void SPCGExWizardWidget::RebuildChatUI()
{
    if (!ChatScrollBox.IsValid()) return;
    ChatScrollBox->ClearChildren();
    for (const FPCGExChatMessage& Msg : Session.Messages)
    {
        ChatScrollBox->AddSlot()[ BuildMessageWidget(Msg) ];
    }
    ScrollToBottom();
}

void SPCGExWizardWidget::RebuildSidebar()
{
    if (!StepListBox.IsValid()) return;
    StepListBox->ClearChildren();

    if (Session.Steps.IsEmpty())
    {
        StepListBox->AddSlot()
        .AutoHeight()
        .Padding(10, 6)
        [
            SNew(STextBlock)
            .Text(FText::FromString(TEXT("Steps will appear\nonce you describe\nyour goal.")))
            .Font(RegFont(8))
            .ColorAndOpacity(ColorMuted)
            .AutoWrapText(true)
        ];
        return;
    }

    for (int32 i = 0; i < Session.Steps.Num(); ++i)
    {
        const FPCGExWizardStep& Step = Session.Steps[i];
        const bool bIsCurrent = (i == Session.CurrentStep);

        FLinearColor IndicatorColor = ColorMuted;
        FString StatusSymbol = TEXT("\u25CB"); // hollow circle = pending
        if (Step.Status == EPCGExWizardStepStatus::Approved)
        {
            IndicatorColor = ColorSuccess;
            StatusSymbol = TEXT("\u2713");
        }
        else if (Step.Status == EPCGExWizardStepStatus::InProgress)
        {
            IndicatorColor = ColorAccent;
            StatusSymbol = TEXT("\u25CF"); // filled circle = active
        }
        else if (Step.Status == EPCGExWizardStepStatus::Redoing)
        {
            IndicatorColor = ColorError;
            StatusSymbol = TEXT("\u21ba");
        }

        StepListBox->AddSlot()
        .AutoHeight()
        [
            SNew(SBorder)
            .BorderImage(FCoreStyle::Get().GetBrush("WhiteBrush"))
            .BorderBackgroundColor(bIsCurrent ? ColorCard : FLinearColor::Transparent)
            .Padding(10, 6)
            [
                SNew(SHorizontalBox)

                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(0, 0, 6, 0)
                [
                    SNew(STextBlock)
                    .Text(FText::FromString(StatusSymbol))
                    .Font(BoldFont(9))
                    .ColorAndOpacity(IndicatorColor)
                ]

                + SHorizontalBox::Slot().FillWidth(1.0f).VAlign(VAlign_Center)
                [
                    SNew(SVerticalBox)
                    + SVerticalBox::Slot().AutoHeight()
                    [
                        SNew(STextBlock)
                        .Text(FText::FromString(FString::Printf(TEXT("%d. %s"), i + 1, *Step.Name)))
                        .Font(bIsCurrent ? BoldFont(9) : RegFont(9))
                        .ColorAndOpacity(bIsCurrent ? ColorText : ColorSubtext)
                        .AutoWrapText(true)
                    ]
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
    Msg.bFromUser  = false;
    Msg.Text       = Text;
    Msg.AttachedGraph = Graph;
    Msg.bShowActions  = bShowActions;
    Session.Messages.Add(Msg);
    RebuildChatUI();
}

void SPCGExWizardWidget::AddUserMessage(const FString& Text)
{
    FPCGExChatMessage Msg;
    Msg.bFromUser = true;
    Msg.Text = Text;
    Session.Messages.Add(Msg);
    RebuildChatUI();
}

void SPCGExWizardWidget::AddTypingIndicator()
{
    if (bTypingIndicatorVisible) return;
    bTypingIndicatorVisible = true;
    FPCGExChatMessage Msg;
    Msg.bFromUser    = false;
    Msg.Text         = TEXT("Hayba AI is thinking...");
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
        && Session.Messages.Last().Text == TEXT("Hayba AI is thinking..."))
    {
        Session.Messages.RemoveAt(Session.Messages.Num() - 1);
    }
    RebuildChatUI();
}

// ── State queries ────────────────────────────────────────────────

FText SPCGExWizardWidget::GetStepProgressText() const
{
    if (Session.Steps.IsEmpty()) return FText::FromString(TEXT(""));
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

// ── Tick ─────────────────────────────────────────────────────────

void SPCGExWizardWidget::Tick(const FGeometry& AllottedGeometry, double InCurrentTime, float InDeltaTime)
{
    SCompoundWidget::Tick(AllottedGeometry, InCurrentTime, InDeltaTime);
}

// ── Action handlers ─────────────────────────────────────────────

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
        else if (!bCreated)
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
        [WeakSelf, AssetPath](bool bOk, const TSharedPtr<FJsonObject>& Response)
    {
        TSharedPtr<SPCGExWizardWidget> Self = WeakSelf.Pin();
        if (!Self.IsValid()) return;

        if (!bOk || !Response.IsValid())
        {
            Self->AddAIMessage(TEXT("Failed to execute graph."));
            return;
        }

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
    if (ApiKeyBox.IsValid())    S.ApiKey     = ApiKeyBox->GetText().ToString().TrimStartAndEnd();
    if (BaseUrlBox.IsValid())   S.BaseURL    = BaseUrlBox->GetText().ToString().TrimStartAndEnd();
    if (ModelBox.IsValid())     S.Model      = ModelBox->GetText().ToString().TrimStartAndEnd();
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

// ── Step flow ────────────────────────────────────────────────────

void SPCGExWizardWidget::SendToMCP(const FString& UserMessage)
{
    const FPCGExBridgeSettings& S = FPCGExBridgeSettings::Get();
    if (!S.HasApiKey())
    {
        AddAIMessage(TEXT("No API key set. Open \u2699 Settings and enter your key."));
        return;
    }

    Session.bWaitingForAI = true;
    AddTypingIndicator();

    FOnClaudeResponse Callback;
    Callback.BindSP(this, &SPCGExWizardWidget::OnClaudeResponse);
    FPCGExClaudeClient::SendMessage(GetPCGExWizardSystemPrompt(), UserMessage, S.ApiKey, S.Model, Callback);
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
        Session.CurrentStep = Next;
        Session.Steps[Next].Status = EPCGExWizardStepStatus::InProgress;
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
