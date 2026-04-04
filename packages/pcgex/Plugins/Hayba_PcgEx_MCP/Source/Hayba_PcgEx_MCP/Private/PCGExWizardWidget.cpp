// Plugins/PCGExBridge/Source/PCGExBridge/Private/PCGExWizardWidget.cpp
#include "PCGExWizardWidget.h"
#include "PCGExBridgeModule.h"
#include "PCGExClaudeClient.h"
#include "PCGExBridgeSettings.h"
#include "PCGExWizardPrompt.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SSeparator.h"
#include "Widgets/Layout/SScrollBox.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SEditableTextBox.h"
#include "Widgets/Input/SMultiLineEditableTextBox.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Notifications/SProgressBar.h"
#include "Framework/Application/SlateApplication.h"
#include "Logging/LogMacros.h"
#include "Misc/Guid.h"
#include "Json.h"
#include "JsonUtilities.h"
#include "Editor.h"

DEFINE_LOG_CATEGORY_STATIC(LogPCGExWizard, Log, All);

// UE5 dark theme colors
static const FLinearColor ColorBG(0.118f, 0.118f, 0.118f, 1.0f);          // #1e1e1e
static const FLinearColor ColorPanel(0.169f, 0.169f, 0.169f, 1.0f);       // #2b2b2b
static const FLinearColor ColorCard(0.235f, 0.235f, 0.235f, 1.0f);        // #3c3c3c
static const FLinearColor ColorAccent(0.0f, 0.439f, 0.878f, 1.0f);        // #0070e0
static const FLinearColor ColorSuccess(0.416f, 0.749f, 0.416f, 1.0f);     // #6abf6a
static const FLinearColor ColorError(0.878f, 0.333f, 0.333f, 1.0f);       // #e05555
static const FLinearColor ColorText(0.85f, 0.85f, 0.85f, 1.0f);
static const FLinearColor ColorMuted(0.5f, 0.5f, 0.5f, 1.0f);
static const FLinearColor ColorUserBubble(0.16f, 0.28f, 0.48f, 1.0f);     // User message bg
static const FLinearColor ColorAIBubble(0.22f, 0.22f, 0.22f, 1.0f);       // AI message bg

void SPCGExWizardWidget::Construct(const FArguments& InArgs, FPCGExBridgeModule* InModule)
{
    Module = InModule;

    ChildSlot
    [
        SNew(SBorder)
        .BorderBackgroundColor(ColorBG)
        .Padding(0)
        [
            SNew(SVerticalBox)

            // Top bar: title + server status + gear
            + SVerticalBox::Slot()
            .AutoHeight()
            [
                BuildTopBar()
            ]

            // Settings panel (collapsible)
            + SVerticalBox::Slot()
            .AutoHeight()
            [
                SNew(SBox)
                .Visibility(this, &SPCGExWizardWidget::GetSettingsPanelVisibility)
                [
                    BuildSettingsPanel()
                ]
            ]

            // Server not running prompt
            + SVerticalBox::Slot()
            .AutoHeight()
            [
                SNew(SBox)
                .Visibility(this, &SPCGExWizardWidget::GetServerPromptVisibility)
                .Padding(8)
                [
                    SNew(SButton)
                    .Text(FText::FromString(TEXT("▶  Start PCGEx Bridge to begin")))
                    .OnClicked(this, &SPCGExWizardWidget::OnStartServer)
                ]
            ]

            // Step progress bar
            + SVerticalBox::Slot()
            .AutoHeight()
            .Padding(8, 4)
            [
                BuildStepProgress()
            ]

            // Chat area (fills remaining space)
            + SVerticalBox::Slot()
            .FillHeight(1.0f)
            [
                BuildChatArea()
            ]

            // Separator
            + SVerticalBox::Slot()
            .AutoHeight()
            [
                SNew(SSeparator)
                .Thickness(1.0f)
                .SeparatorImage(FCoreStyle::Get().GetBrush("GenericWhiteBox"))
                .ColorAndOpacity(ColorCard)
            ]

            // Action bar (Approve / Redo)
            + SVerticalBox::Slot()
            .AutoHeight()
            .Padding(8, 4)
            [
                BuildActionBar()
            ]

            // Input area
            + SVerticalBox::Slot()
            .AutoHeight()
            .Padding(8, 4, 8, 8)
            [
                BuildInputArea()
            ]
        ]
    ];

    // Start with a greeting based on whether API key is set
    const FPCGExBridgeSettings& S = FPCGExBridgeSettings::Get();
    if (!S.HasApiKey())
        AddAIMessage(TEXT("Welcome to PCGEx Wizard!\n\nTo get started, click \u2699 Settings and enter your Anthropic API key.\n\nOnce set, describe what you want to build and I'll generate a PCG graph for it."));
    else
        AddAIMessage(TEXT("Welcome back! Describe what you want to generate.\n\nExamples:\n\u2022 \"A mini city with organic roads and parcels\"\n\u2022 \"A dungeon with connected rooms\"\n\u2022 \"A forest path network\""));
}

TSharedRef<SWidget> SPCGExWizardWidget::BuildTopBar()
{
    return SNew(SBorder)
        .BorderBackgroundColor(ColorPanel)
        .Padding(8, 6)
        [
            SNew(SHorizontalBox)

            + SHorizontalBox::Slot()
            .FillWidth(1.0f)
            .VAlign(VAlign_Center)
            [
                SNew(STextBlock)
                .Text(FText::FromString(TEXT("Hayba PCGEx MCP")))
                .Font(FCoreStyle::GetDefaultFontStyle("Bold", 11))
                .ColorAndOpacity(ColorText)
            ]

            + SHorizontalBox::Slot()
            .AutoWidth()
            .VAlign(VAlign_Center)
            [
                SNew(SBox)
                .WidthOverride(8)
                .HeightOverride(8)
                [
                    SNew(SBorder)
                    .BorderBackgroundColor_Lambda([this]() -> FSlateColor
                    {
                        return Module && Module->IsServerRunning() ? ColorSuccess : ColorError;
                    })
                ]
            ]

            + SHorizontalBox::Slot()
            .AutoWidth()
            .Padding(4, 0, 0, 0)
            .VAlign(VAlign_Center)
            [
                SNew(STextBlock)
                .Text_Lambda([this]() -> FText
                {
                    return FText::FromString(Module && Module->IsServerRunning() ? TEXT("Connected") : TEXT("Disconnected"));
                })
                .Font(FCoreStyle::GetDefaultFontStyle("Regular", 8))
                .ColorAndOpacity(ColorMuted)
            ]

            + SHorizontalBox::Slot()
            .AutoWidth()
            .Padding(8, 0, 0, 0)
            .VAlign(VAlign_Center)
            [
                SNew(SButton)
                .Text(FText::FromString(TEXT("\u2699")))
                .ToolTipText(FText::FromString(TEXT("Settings")))
                .OnClicked(this, &SPCGExWizardWidget::OnToggleSettings)
                .ButtonColorAndOpacity(FLinearColor::Transparent)
            ]
        ];
}

TSharedRef<SWidget> SPCGExWizardWidget::BuildSettingsPanel()
{
    const FPCGExBridgeSettings& S = FPCGExBridgeSettings::Get();

    return SNew(SBorder)
        .BorderBackgroundColor(ColorPanel)
        .Padding(12, 10)
        [
            SNew(SVerticalBox)

            + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 8)
            [
                SNew(SVerticalBox)
                + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 3)
                [
                    SNew(STextBlock)
                    .Text(FText::FromString(TEXT("Anthropic API Key")))
                    .Font(FCoreStyle::GetDefaultFontStyle("Bold", 8))
                    .ColorAndOpacity(ColorMuted)
                ]
                + SVerticalBox::Slot().AutoHeight()
                [
                    SAssignNew(ApiKeyBox, SEditableTextBox)
                    .Text(FText::FromString(S.ApiKey))
                    .HintText(FText::FromString(TEXT("sk-ant-...")))
                    .IsPassword(true)
                ]
            ]

            + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 10)
            [
                SNew(SVerticalBox)
                + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 3)
                [
                    SNew(STextBlock)
                    .Text(FText::FromString(TEXT("Output Content Path")))
                    .Font(FCoreStyle::GetDefaultFontStyle("Bold", 8))
                    .ColorAndOpacity(ColorMuted)
                ]
                + SVerticalBox::Slot().AutoHeight()
                [
                    SAssignNew(OutputPathBox, SEditableTextBox)
                    .Text(FText::FromString(S.OutputPath))
                    .HintText(FText::FromString(TEXT("/Game/PCGExBridge/Generated")))
                ]
            ]

            + SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Right)
            [
                SNew(SButton)
                .Text(FText::FromString(TEXT("Save Settings")))
                .OnClicked(this, &SPCGExWizardWidget::OnSaveSettings)
                .ButtonColorAndOpacity(ColorAccent)
            ]
        ];
}

TSharedRef<SWidget> SPCGExWizardWidget::BuildStepProgress()
{
    return SNew(SHorizontalBox)

        + SHorizontalBox::Slot()
        .AutoWidth()
        .VAlign(VAlign_Center)
        .Padding(0, 0, 6, 0)
        [
            SNew(STextBlock)
            .Text(this, &SPCGExWizardWidget::GetStepProgressText)
            .Font(FCoreStyle::GetDefaultFontStyle("Regular", 8))
            .ColorAndOpacity(ColorMuted)
        ]

        + SHorizontalBox::Slot()
        .FillWidth(1.0f)
        .VAlign(VAlign_Center)
        [
            SNew(SProgressBar)
            .Percent_Lambda([this]() -> TOptional<float>
            {
                if (Session.Steps.IsEmpty()) return 0.0f;
                return (float)(Session.CurrentStep + 1) / (float)Session.Steps.Num();
            })
            .FillColorAndOpacity(ColorAccent)
        ];
}

TSharedRef<SWidget> SPCGExWizardWidget::BuildChatArea()
{
    return SAssignNew(ChatScrollBox, SScrollBox)
        .Orientation(Orient_Vertical);
}

TSharedRef<SWidget> SPCGExWizardWidget::BuildInputArea()
{
    return SNew(SHorizontalBox)

        + SHorizontalBox::Slot()
        .FillWidth(1.0f)
        .Padding(0, 0, 4, 0)
        [
            SAssignNew(InputBox, SMultiLineEditableTextBox)
            .HintText(FText::FromString(TEXT("Describe what you want to generate... (Enter to send, Shift+Enter for newline)")))
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
            .AutoWrapText(true)
        ]

        + SHorizontalBox::Slot()
        .AutoWidth()
        [
            SNew(SButton)
            .Text(FText::FromString(TEXT("Send")))
            .OnClicked(this, &SPCGExWizardWidget::OnSendMessage)
            .IsEnabled_Lambda([this]() { return CanSendMessage(); })
        ];
}

TSharedRef<SWidget> SPCGExWizardWidget::BuildActionBar()
{
    return SNew(SBox)
        .Visibility(this, &SPCGExWizardWidget::GetActionBarVisibility)
        [
            SNew(SHorizontalBox)

            + SHorizontalBox::Slot()
            .FillWidth(1.0f)
            .Padding(0, 0, 4, 0)
            [
                SNew(SButton)
                .Text(FText::FromString(TEXT("✓  Approve & Continue")))
                .OnClicked(this, &SPCGExWizardWidget::OnApproveStep)
                .ButtonColorAndOpacity(ColorSuccess)
            ]

            + SHorizontalBox::Slot()
            .AutoWidth()
            [
                SNew(SButton)
                .Text(FText::FromString(TEXT("↺  Redo Step")))
                .OnClicked(this, &SPCGExWizardWidget::OnRedoStep)
            ]
        ];
}

TSharedRef<SWidget> SPCGExWizardWidget::BuildMessageWidget(const FPCGExChatMessage& Message)
{
    return Message.bFromUser
        ? BuildUserMessageBubble(Message)
        : BuildAIMessageBubble(Message);
}

TSharedRef<SWidget> SPCGExWizardWidget::BuildAIMessageBubble(const FPCGExChatMessage& Message)
{
    TSharedRef<SVerticalBox> Bubble = SNew(SVerticalBox)

        + SVerticalBox::Slot()
        .AutoHeight()
        .Padding(2, 1)
        [
            SNew(STextBlock)
            .Text(FText::FromString(TEXT("PCGEx AI")))
            .Font(FCoreStyle::GetDefaultFontStyle("Bold", 8))
            .ColorAndOpacity(ColorAccent)
        ]

        + SVerticalBox::Slot()
        .AutoHeight()
        .Padding(2, 0, 0, 4)
        [
            SNew(STextBlock)
            .Text(FText::FromString(Message.Timestamp.ToString(TEXT("%H:%M"))))
            .Font(FCoreStyle::GetDefaultFontStyle("Regular", 7))
            .ColorAndOpacity(FLinearColor(0.3f, 0.3f, 0.3f, 1.0f))
        ]

        + SVerticalBox::Slot()
        .AutoHeight()
        [
            SNew(STextBlock)
            .Text(FText::FromString(Message.Text))
            .Font(FCoreStyle::GetDefaultFontStyle("Regular", 9))
            .ColorAndOpacity(ColorText)
            .AutoWrapText(true)
        ];

    // Add action buttons if this message has a graph attached
    if (Message.bShowActions && Message.AttachedGraph.IsValid())
    {
        Bubble->AddSlot()
        .AutoHeight()
        .Padding(0, 6, 0, 0)
        [
            SNew(SHorizontalBox)

            + SHorizontalBox::Slot()
            .AutoWidth()
            .Padding(0, 0, 4, 0)
            [
                SNew(SButton)
                .Text(FText::FromString(TEXT("👁  Preview")))
                .OnClicked(this, &SPCGExWizardWidget::OnPreviewGraph)
            ]

            + SHorizontalBox::Slot()
            .AutoWidth()
            .Padding(0, 0, 4, 0)
            [
                SNew(SButton)
                .Text(FText::FromString(TEXT("⬆  Create in UE")))
                .OnClicked(this, &SPCGExWizardWidget::OnCreateInUE)
            ]

            + SHorizontalBox::Slot()
            .AutoWidth()
            [
                SNew(SButton)
                .Text(FText::FromString(TEXT("▶  Test It")))
                .OnClicked(this, &SPCGExWizardWidget::OnTestIt)
            ]
        ];
    }

    return SNew(SBox)
        .Padding(FMargin(0, 4, 60, 4))
        [
            SNew(SBorder)
            .BorderBackgroundColor(ColorAIBubble)
            .Padding(10, 8)
            [
                Bubble
            ]
        ];
}

TSharedRef<SWidget> SPCGExWizardWidget::BuildUserMessageBubble(const FPCGExChatMessage& Message)
{
    return SNew(SBox)
        .Padding(FMargin(60, 4, 0, 4))
        .HAlign(HAlign_Right)
        [
            SNew(SBorder)
            .BorderBackgroundColor(ColorUserBubble)
            .Padding(10, 8)
            [
                SNew(SVerticalBox)

                + SVerticalBox::Slot()
                .AutoHeight()
                .Padding(2, 0, 0, 4)
                [
                    SNew(STextBlock)
                    .Text(FText::FromString(Message.Timestamp.ToString(TEXT("%H:%M"))))
                    .Font(FCoreStyle::GetDefaultFontStyle("Regular", 7))
                    .ColorAndOpacity(FLinearColor(0.3f, 0.3f, 0.3f, 1.0f))
                ]

                + SVerticalBox::Slot()
                .AutoHeight()
                [
                    SNew(STextBlock)
                    .Text(FText::FromString(Message.Text))
                    .Font(FCoreStyle::GetDefaultFontStyle("Regular", 9))
                    .ColorAndOpacity(ColorText)
                    .AutoWrapText(true)
                ]
            ]
        ];
}

TSharedRef<SWidget> SPCGExWizardWidget::BuildStepActionButtons(int32 StepIndex)
{
    return SNew(SHorizontalBox)

        + SHorizontalBox::Slot()
        .AutoWidth()
        .Padding(0, 0, 4, 0)
        [
            SNew(SButton)
            .Text(FText::FromString(TEXT("✓  Approve")))
            .OnClicked(this, &SPCGExWizardWidget::OnApproveStep)
        ]

        + SHorizontalBox::Slot()
        .AutoWidth()
        [
            SNew(SButton)
            .Text(FText::FromString(TEXT("↺  Redo")))
            .OnClicked(this, &SPCGExWizardWidget::OnRedoStep)
        ];
}

// ── Chat management ──────────────────────────────────────────────

void SPCGExWizardWidget::RebuildChatUI()
{
    if (!ChatScrollBox.IsValid()) return;

    ChatScrollBox->ClearChildren();

    for (const FPCGExChatMessage& Msg : Session.Messages)
    {
        ChatScrollBox->AddSlot()
        [
            BuildMessageWidget(Msg)
        ];
    }

    ScrollToBottom();
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
    Msg.bFromUser = false;
    Msg.Text = Text;
    Msg.AttachedGraph = Graph;
    Msg.bShowActions = bShowActions;
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
    Msg.bFromUser = false;
    Msg.Text = TEXT("PCGEx AI is thinking...");
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
        && Session.Messages.Last().Text == TEXT("PCGEx AI is thinking..."))
    {
        Session.Messages.RemoveAt(Session.Messages.Num() - 1);
    }
    RebuildChatUI();
}

// ── State queries ────────────────────────────────────────────────

FText SPCGExWizardWidget::GetStepProgressText() const
{
    if (Session.Steps.IsEmpty())
    {
        return FText::FromString(TEXT("No steps yet"));
    }
    return FText::FromString(FString::Printf(
        TEXT("Step %d / %d — %s"),
        Session.CurrentStep + 1,
        Session.Steps.Num(),
        *Session.Steps[Session.CurrentStep].Name
    ));
}

EVisibility SPCGExWizardWidget::GetActionBarVisibility() const
{
    if (Session.Steps.IsEmpty()) return EVisibility::Collapsed;
    if (!Session.HasCurrentStep()) return EVisibility::Collapsed;
    const FPCGExWizardStep& Step = Session.Steps[Session.CurrentStep];
    return (Step.Status == EPCGExWizardStepStatus::InProgress && Step.Graph.IsValid())
        ? EVisibility::Visible
        : EVisibility::Collapsed;
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

    // If this is the first message, initialize a session
    if (Session.Goal.IsEmpty())
    {
        InitializeSession(Text);
    }
    else
    {
        SendToMCP(Text);
    }

    return FReply::Handled();
}

FReply SPCGExWizardWidget::OnApproveStep()
{
    if (!Session.HasCurrentStep()) return FReply::Handled();

    Session.GetCurrentStep().Status = EPCGExWizardStepStatus::Approved;
    AdvanceToNextStep();
    return FReply::Handled();
}

FReply SPCGExWizardWidget::OnRedoStep()
{
    if (!Session.HasCurrentStep()) return FReply::Handled();

    Session.GetCurrentStep().Status = EPCGExWizardStepStatus::Redoing;
    Session.GetCurrentStep().Graph.Reset();

    AddAIMessage(FString::Printf(
        TEXT("Let's redo **%s**. What would you like to change?"),
        *Session.GetCurrentStep().Name
    ));

    return FReply::Handled();
}

FReply SPCGExWizardWidget::OnPreviewGraph()
{
    if (!Session.HasCurrentStep()) return FReply::Handled();

    TSharedPtr<FJsonObject> Graph = Session.GetCurrentStep().Graph;
    if (!Graph.IsValid()) return FReply::Handled();

    // Serialize graph for display
    FString GraphStr;
    TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&GraphStr);
    FJsonSerializer::Serialize(Graph.ToSharedRef(), Writer);

    // Count nodes and edges
    const TArray<TSharedPtr<FJsonValue>>* Nodes;
    const TArray<TSharedPtr<FJsonValue>>* Edges;
    int32 NodeCount = Graph->TryGetArrayField(TEXT("nodes"), Nodes) ? Nodes->Num() : 0;
    int32 EdgeCount = Graph->TryGetArrayField(TEXT("edges"), Edges) ? Edges->Num() : 0;

    AddAIMessage(FString::Printf(
        TEXT("Graph topology for **%s**:\n• %d nodes\n• %d edges\n\nUse 'Create in UE' to materialize it."),
        *Session.GetCurrentStep().Name,
        NodeCount,
        EdgeCount
    ));

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
    Params->SetStringField(TEXT("name"), AssetName);
    Params->SetStringField(TEXT("graph"), GraphStr);

    AddAIMessage(FString::Printf(TEXT("Creating '%s' in UE..."), *AssetName));

    int32 StepIndex = Session.CurrentStep;
    TWeakPtr<SPCGExWizardWidget> WeakSelf = SharedThis(this);
    Module->SendTcpCommand(TEXT("create_graph"), Params, [WeakSelf, AssetName, StepIndex](bool bOk, const TSharedPtr<FJsonObject>& Response)
    {
        TSharedPtr<SPCGExWizardWidget> Self = WeakSelf.Pin();
        if (!Self.IsValid()) return;

        if (!bOk || !Response.IsValid())
        {
            Self->AddAIMessage(TEXT("Failed to create graph. Check the Output Log for details."));
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
                TEXT("Created successfully!\n\nAsset: %s\n\nClick **Test It** to see it in the viewport, or **Approve & Continue** to move on."),
                *AssetPath
            ));
        }
        else if (!bCreated)
        {
            Self->AddAIMessage(TEXT("Creation failed due to validation errors. I'll fix them and try again."));
            Self->SendToMCP(FString::Printf(TEXT("[FIX_ERRORS] Asset creation failed for step %d"), StepIndex));
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
    Module->SendTcpCommand(TEXT("execute_graph"), Params, [WeakSelf, AssetPath](bool bOk, const TSharedPtr<FJsonObject>& Response)
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
        {
            Count = (int32)Response->GetNumberField(TEXT("componentsExecuted"));
        }

        if (Count > 0)
        {
            Self->AddAIMessage(FString::Printf(TEXT("Graph executed on %d PCG component(s). Check the viewport!"), Count));
        }
        else
        {
            FString Note;
            Response->TryGetStringField(TEXT("note"), Note);
            Self->AddAIMessage(FString::Printf(
                TEXT("No PCG components found using this graph.\n\n%s"),
                *Note
            ));
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
    if (ApiKeyBox.IsValid())     S.ApiKey     = ApiKeyBox->GetText().ToString().TrimStartAndEnd();
    if (OutputPathBox.IsValid()) S.OutputPath = OutputPathBox->GetText().ToString().TrimStartAndEnd();
    S.Save();
    bSettingsVisible = false;

    if (S.HasApiKey())
        AddAIMessage(TEXT("Settings saved! API key is set. You can start generating graphs."));
    else
        AddAIMessage(TEXT("Settings saved. Note: no API key is set \u2014 add one to use the AI."));

    return FReply::Handled();
}

// ── Step flow handlers ──────────────────────────────────────────

void SPCGExWizardWidget::SendToMCP(const FString& UserMessage)
{
    const FPCGExBridgeSettings& Settings = FPCGExBridgeSettings::Get();

    if (!Settings.HasApiKey())
    {
        AddAIMessage(TEXT("No API key set. Click \u2699 Settings and enter your Anthropic API key."));
        return;
    }

    Session.bWaitingForAI = true;
    AddTypingIndicator();

    FOnClaudeResponse Callback;
    Callback.BindSP(this, &SPCGExWizardWidget::OnClaudeResponse);

    FPCGExClaudeClient::SendMessage(
        GetPCGExWizardSystemPrompt(),
        UserMessage,
        Settings.ApiKey,
        Settings.Model,
        Callback
    );
}

void SPCGExWizardWidget::OnClaudeResponse(bool bSuccess, const FString& ResponseText)
{
    RemoveTypingIndicator();
    Session.bWaitingForAI = false;

    if (!bSuccess)
    {
        AddAIMessage(ResponseText);
        return;
    }

    // Parse JSON: { "reply": "...", "graph": {...} | null }
    TSharedPtr<FJsonObject> Root;
    TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(ResponseText);

    FString ReplyText = ResponseText;
    TSharedPtr<FJsonObject> Graph;

    if (FJsonSerializer::Deserialize(Reader, Root) && Root.IsValid())
    {
        Root->TryGetStringField(TEXT("reply"), ReplyText);
        const TSharedPtr<FJsonObject>* GraphObj;
        if (Root->TryGetObjectField(TEXT("graph"), GraphObj) && GraphObj->IsValid())
        {
            Graph = *GraphObj;
        }
    }

    if (Graph.IsValid())
    {
        if (Session.HasCurrentStep())
        {
            Session.GetCurrentStep().Graph = Graph;
            Session.GetCurrentStep().Status = EPCGExWizardStepStatus::InProgress;
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
    // Legacy callback — response handling is now done inline in SendToMCP lambdas
    UE_LOG(LogPCGExWizard, Log, TEXT("OnMCPResponse: %s"), *ResponseText);
}

void SPCGExWizardWidget::InitializeSession(const FString& Goal)
{
    Session.Goal = Goal;
    Session.SessionId = FGuid::NewGuid().ToString();

    AddAIMessage(TEXT("Let me plan the steps for your project..."));

    SendToMCP(FString::Printf(TEXT("[INIT] Goal: %s"), *Goal));
}

void SPCGExWizardWidget::AdvanceToNextStep()
{
    int32 NextStep = Session.CurrentStep + 1;
    if (Session.Steps.IsValidIndex(NextStep))
    {
        Session.CurrentStep = NextStep;
        Session.Steps[NextStep].Status = EPCGExWizardStepStatus::InProgress;

        AddAIMessage(FString::Printf(
            TEXT("Step %d approved! Moving to **%s**.\n\nHow would you like to approach this step?"),
            Session.CurrentStep,
            *Session.Steps[NextStep].Name
        ));
    }
    else
    {
        // All steps done — combine into final graph
        AddAIMessage(TEXT("All steps approved! I'll now combine everything into a final graph. One moment..."));
        SendToMCP(TEXT("[FINALIZE]"));
    }
}

void SPCGExWizardWidget::RedoCurrentStep()
{
    // Delegated to OnRedoStep — kept for interface compatibility
    OnRedoStep();
}
