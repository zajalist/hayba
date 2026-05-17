// Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPChatPanel.cpp
//
// Single-purpose chat panel — see HaybaMCPChatPanel.h for the design contract.
// All Wizard / ModeSelect / MCPStatus / inline-Settings / Steps-sidebar code
// was removed; those concerns live in dedicated panels. This file should stay
// focused on conversation, input, footer status, and per-message affordances.
//
#include "HaybaMCPChatPanel.h"
#include "HaybaMCPModule.h"
#include "HaybaMCPMainPanel.h"
#include "HaybaMCPClaudeClient.h"
#include "HaybaMCPSettings.h"
#include "HaybaMCPWizardPrompt.h"

#include "Widgets/Layout/SBox.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SSeparator.h"
#include "Widgets/Layout/SScrollBox.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SComboButton.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Images/SImage.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/SOverlay.h"

#include "Framework/Application/SlateApplication.h"
#include "Framework/MultiBox/MultiBoxBuilder.h"
#include "Framework/Notifications/NotificationManager.h"
#include "Widgets/Notifications/SNotificationList.h"

#include "HAL/PlatformApplicationMisc.h"
#include "Json.h"
#include "JsonUtilities.h"
#include "Editor.h"
#include "Styling/AppStyle.h"

#define LOCTEXT_NAMESPACE "HaybaMCPToolkit"

namespace
{
    const FLinearColor ColorSuccess(0.40f, 0.95f, 0.55f);
    const FLinearColor ColorError  (1.00f, 0.40f, 0.40f);
    const FLinearColor ColorMuted  (0.55f, 0.57f, 0.65f);
    const FLinearColor ColorRoleAI (0.78f, 0.80f, 0.88f);

    void Toast(const FText& Msg)
    {
        FNotificationInfo Info(Msg);
        Info.ExpireDuration = 2.0f;
        FSlateNotificationManager::Get().AddNotification(Info);
    }

    void OpenSettings(SHaybaMCPMainPanel* Main)
    {
        if (Main) Main->ShowPanel(EHaybaPanel::Settings);
        else      Toast(LOCTEXT("Footer.OpenSettings", "Open the Settings tab from the sidebar."));
    }
}

// ── Construct ──────────────────────────────────────────────────────────────

void SHaybaMCPChatPanel::Construct(const FArguments& InArgs, FHaybaMCPModule* InModule)
{
    Module = InModule;
    MainPanel = InArgs._MainPanel;

    ChildSlot
    [
        SNew(SVerticalBox)
        // Toolbar — new conversation + recent dropdown (Q18-a).
        + SVerticalBox::Slot().AutoHeight().Padding(4.f, 4.f, 4.f, 0.f)
        [ BuildToolbar() ]

        // Chat scroll. SOverlay so we can float a "↓ N new" chip on top.
        + SVerticalBox::Slot().FillHeight(1.f)
        [
            SNew(SOverlay)
            + SOverlay::Slot() [ BuildChatArea() ]
            + SOverlay::Slot()
            .HAlign(HAlign_Right).VAlign(VAlign_Bottom)
            .Padding(FMargin(0.f, 0.f, 14.f, 14.f))
            [
                SNew(SButton)
                .ButtonStyle(FAppStyle::Get(), "PrimaryButton")
                .ContentPadding(FMargin(10.f, 4.f))
                .Visibility(this, &SHaybaMCPChatPanel::GetNewMessagesChipVisibility)
                .OnClicked_Lambda([this]()
                {
                    UnseenWhileScrolledUp = 0;
                    if (ChatScrollBox.IsValid()) ChatScrollBox->ScrollToEnd();
                    return FReply::Handled();
                })
                [
                    SNew(STextBlock).Text_Lambda([this]()
                    {
                        return FText::FromString(FString::Printf(TEXT("↓ %d new"), UnseenWhileScrolledUp));
                    })
                ]
            ]
        ]

        // Footer (clickable status segments) and input.
        + SVerticalBox::Slot().AutoHeight().Padding(8.f, 6.f, 8.f, 0.f)
        [ BuildFooter() ]
        + SVerticalBox::Slot().AutoHeight().Padding(8.f, 4.f, 8.f, 8.f)
        [ BuildInput() ]
    ];

    RebuildChat();
}

// ── Toolbar (top-right new + recent) ──────────────────────────────────────

TSharedRef<SWidget> SHaybaMCPChatPanel::BuildToolbar()
{
    return SNew(SHorizontalBox)
        + SHorizontalBox::Slot().FillWidth(1.f) [ SNew(SBox) ]
        + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
        [
            SNew(SButton)
            .ButtonStyle(FAppStyle::Get(), "SimpleButton")
            .ToolTipText(LOCTEXT("NewConvTT", "Start a new conversation"))
            .ContentPadding(FMargin(4.f))
            .OnClicked(this, &SHaybaMCPChatPanel::OnNewConversation)
            [ SNew(SImage).Image(FAppStyle::GetBrush("Icons.Plus")) ]
        ]
        + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(4.f, 0.f, 0.f, 0.f)
        [
            SNew(SComboButton)
            .ButtonStyle(FAppStyle::Get(), "SimpleButton")
            .ContentPadding(FMargin(6.f, 2.f))
            .ToolTipText(LOCTEXT("RecentTT", "Recent conversations"))
            .ButtonContent()
            [
                // Conversation title. Auto-generated from first user message;
                // falls back to "New conversation" when nothing has been sent.
                SNew(STextBlock).Text_Lambda([this]()
                {
                    if (Session.Goal.IsEmpty())
                        return LOCTEXT("ConvUntitled", "New conversation");
                    return FText::FromString(Session.Goal.Len() > 40
                        ? Session.Goal.Left(40) + TEXT("…")
                        : Session.Goal);
                })
            ]
            .OnGetMenuContent(this, &SHaybaMCPChatPanel::BuildRecentSessionsMenu)
        ];
}

TSharedRef<SWidget> SHaybaMCPChatPanel::BuildRecentSessionsMenu()
{
    // Recent sessions list is gated on the disk-persistence work (Q8-b),
    // which lives in the module. Until that lands, surface a clear placeholder
    // so users understand the affordance exists.
    FMenuBuilder Menu(true, nullptr);
    Menu.AddMenuEntry(
        LOCTEXT("RecentEmpty", "Recent conversations — coming soon"),
        LOCTEXT("RecentEmptyTT", "Session persistence (Q8-b) lands in a follow-up commit."),
        FSlateIcon(),
        FUIAction(FExecuteAction(), FCanExecuteAction::CreateLambda([](){ return false; })));
    return Menu.MakeWidget();
}

// ── Chat scroll ───────────────────────────────────────────────────────────

TSharedRef<SWidget> SHaybaMCPChatPanel::BuildChatArea()
{
    SAssignNew(ChatScrollBox, SScrollBox)
        .Orientation(Orient_Vertical)
        .OnUserScrolled_Lambda([this](float /*Offset*/)
        {
            // User actively scrolling — reset the "↓ N new" chip if they
            // scrolled back to the bottom themselves.
            if (IsScrolledNearBottom()) UnseenWhileScrolledUp = 0;
        });
    return SNew(SBorder)
        .BorderImage(FAppStyle::GetBrush("Brushes.Recessed"))
        .Padding(FMargin(8.f, 6.f))
        [
            SNew(SVerticalBox)
            + SVerticalBox::Slot().FillHeight(1.f)
            [ ChatScrollBox.ToSharedRef() ]
        ];
}

// ── Footer (three clickable status segments) ──────────────────────────────

TSharedRef<SWidget> SHaybaMCPChatPanel::BuildFooter()
{
    auto Sep = []()
    {
        return SNew(STextBlock)
            .Text(FText::FromString(TEXT(" · ")))
            .ColorAndOpacity(FSlateColor(ColorMuted));
    };

    return SNew(SHorizontalBox)
        // Connection segment — green/red dot, label routes to Settings.
        + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
        [
            SNew(SButton)
            .ButtonStyle(FAppStyle::Get(), "SimpleButton")
            .ContentPadding(FMargin(0.f))
            .OnClicked(this, &SHaybaMCPChatPanel::OnFooterConnectionClick)
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(0.f, 0.f, 4.f, 0.f)
                [
                    SNew(STextBlock)
                    .Text(FText::FromString(TEXT("●")))
                    .ColorAndOpacity_Lambda([this]() -> FSlateColor
                    {
                        const bool bConnected = Module && Module->IsServerRunning();
                        return FSlateColor(bConnected ? ColorSuccess : ColorError);
                    })
                ]
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
                [
                    SNew(STextBlock)
                    .Text_Lambda([this]()
                    {
                        const bool bConnected = Module && Module->IsServerRunning();
                        return bConnected ? LOCTEXT("FootConn", "Connected")
                                          : LOCTEXT("FootDisc", "Disconnected");
                    })
                    .ColorAndOpacity(FSlateColor(ColorMuted))
                ]
            ]
        ]
        + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center) [ Sep() ]

        // Model segment.
        + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
        [
            SNew(SButton)
            .ButtonStyle(FAppStyle::Get(), "SimpleButton")
            .ContentPadding(FMargin(0.f))
            .OnClicked(this, &SHaybaMCPChatPanel::OnFooterModelClick)
            [
                SNew(STextBlock)
                .Text_Lambda([]()
                {
                    const FString& M = FHaybaMCPSettings::Get().Model;
                    return FText::FromString(M.IsEmpty() ? TEXT("model?") : M);
                })
                .ColorAndOpacity(FSlateColor(ColorMuted))
            ]
        ]
        + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center) [ Sep() ]

        // Mode segment (was the inline header in the old layout).
        + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
        [
            SNew(SButton)
            .ButtonStyle(FAppStyle::Get(), "SimpleButton")
            .ContentPadding(FMargin(0.f))
            .OnClicked(this, &SHaybaMCPChatPanel::OnFooterModeClick)
            [
                SNew(STextBlock)
                .Text_Lambda([]()
                {
                    return FHaybaMCPSettings::Get().OperationMode == EHaybaMCPOperationMode::Integrated
                        ? LOCTEXT("FootModeI", "Integrated Mode")
                        : LOCTEXT("FootModeA", "API Key Mode");
                })
                .ColorAndOpacity(FSlateColor(ColorMuted))
            ]
        ]

        // Spacer + plugin watermark already shown by MainPanel — nothing here.
        + SHorizontalBox::Slot().FillWidth(1.f) [ SNew(SBox) ];
}

FReply SHaybaMCPChatPanel::OnFooterConnectionClick() { OpenSettings(MainPanel); return FReply::Handled(); }
FReply SHaybaMCPChatPanel::OnFooterModelClick()      { OpenSettings(MainPanel); return FReply::Handled(); }
FReply SHaybaMCPChatPanel::OnFooterModeClick()       { OpenSettings(MainPanel); return FReply::Handled(); }

// ── Input area (inline send / stop, Q7-a) ─────────────────────────────────

TSharedRef<SWidget> SHaybaMCPChatPanel::BuildInput()
{
    return SNew(SBorder)
        .BorderImage(FAppStyle::GetBrush("Brushes.Panel"))
        .Padding(FMargin(6.f))
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center)
            [
                // Overlay the real input with a middle-ellipsis hint label so
                // narrow panels show "Describe what you...for newline)" rather
                // than wrapping the hint to 3 lines.
                SNew(SOverlay)
                + SOverlay::Slot()
                [
                    SAssignNew(InputBox, SMultiLineEditableTextBox)
                    // No HintText — the overlay below takes that role so we
                    // can apply OverflowPolicy::MiddleEllipsis.
                    .AutoWrapText(true)
                    .IsEnabled_Lambda([this](){ return CanSend(); })
                    .OnKeyDownHandler_Lambda([this](const FGeometry&, const FKeyEvent& Key) -> FReply
                    {
                        if (Key.GetKey() == EKeys::Enter && !Key.IsShiftDown())
                        {
                            OnSendCurrentInput();
                            return FReply::Handled();
                        }
                        return FReply::Unhandled();
                    })
                ]
                + SOverlay::Slot()
                .VAlign(VAlign_Center).Padding(FMargin(4.f, 0.f))
                [
                    SNew(STextBlock)
                    .Text(LOCTEXT("InputHint",
                        "Describe what you want to generate…  (⏎ to send · ⇧⏎ for newline)"))
                    .ColorAndOpacity(FSlateColor(FLinearColor(0.50f, 0.52f, 0.60f)))
                    .OverflowPolicy(ETextOverflowPolicy::MiddleEllipsis)
                    .Visibility_Lambda([this]()
                    {
                        // Only visible while the input is empty AND unfocused
                        // (matches stock HintText behaviour). bIsHovered
                        // intentionally ignored so it doesn't flicker on hover.
                        if (!InputBox.IsValid()) return EVisibility::Visible;
                        const bool bEmpty = InputBox->GetText().IsEmpty();
                        return bEmpty ? EVisibility::HitTestInvisible : EVisibility::Collapsed;
                    })
                ]
            ]
            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Bottom).Padding(6.f, 0.f, 0.f, 0.f)
            [
                SNew(SButton)
                .ButtonStyle(FAppStyle::Get(), "PrimaryButton")
                .ContentPadding(FMargin(10.f, 6.f))
                .OnClicked(this, &SHaybaMCPChatPanel::OnSendOrStop)
                .ToolTipText_Lambda([this]()
                {
                    return bIsStreaming ? LOCTEXT("StopTT", "Stop generation")
                                        : LOCTEXT("SendTT", "Send message (⏎)");
                })
                [
                    SNew(STextBlock).Text_Lambda([this]()
                    {
                        return bIsStreaming ? FText::FromString(TEXT("■"))
                                            : FText::FromString(TEXT("Send ▶"));
                    })
                ]
            ]
        ];
}

// ── Empty state (Q11) ─────────────────────────────────────────────────────

TSharedRef<SWidget> SHaybaMCPChatPanel::BuildEmptyState()
{
    // Empty state lives at the bottom of the scroll: a flexible spacer above
    // pushes the cards down to where the input is, so the visual centre of
    // attention starts right where the user's cursor is going next.
    // TODO: returning user variant lists recent saved sessions instead of cards.
    return SNew(SVerticalBox)
        + SVerticalBox::Slot().FillHeight(1.f) [ SNew(SBox) ]
        + SVerticalBox::Slot().AutoHeight().Padding(20.f, 16.f, 20.f, 10.f)
        [
            SNew(STextBlock)
            .Text(LOCTEXT("EmptyTitle", "Start a conversation"))
            .ColorAndOpacity(FSlateColor(ColorMuted))
            .Justification(ETextJustify::Center)
        ]
        + SVerticalBox::Slot().AutoHeight().Padding(20.f, 0.f, 20.f, 20.f)
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().FillWidth(1.f).Padding(0.f, 0.f, 8.f, 0.f)
            [ BuildPromptCard(
                LOCTEXT("PCard1Title", "Mini city"),
                LOCTEXT("PCard1Hint",  "Organic roads, parcels, building footprints"),
                TEXT("Generate a mini city with organic roads and parcels."),
                TEXT("MC"),
                FLinearColor(0.30f, 0.55f, 0.85f)) ]
            + SHorizontalBox::Slot().FillWidth(1.f).Padding(4.f, 0.f, 4.f, 0.f)
            [ BuildPromptCard(
                LOCTEXT("PCard2Title", "Dungeon"),
                LOCTEXT("PCard2Hint",  "Connected rooms with corridor topology"),
                TEXT("Generate a dungeon with connected rooms."),
                TEXT("DG"),
                FLinearColor(0.65f, 0.30f, 0.55f)) ]
            + SHorizontalBox::Slot().FillWidth(1.f).Padding(8.f, 0.f, 0.f, 0.f)
            [ BuildPromptCard(
                LOCTEXT("PCard3Title", "Forest path"),
                LOCTEXT("PCard3Hint",  "Branching path network through dense foliage"),
                TEXT("Generate a forest path network with branching trails."),
                TEXT("FP"),
                FLinearColor(0.30f, 0.65f, 0.40f)) ]
        ];
}

TSharedRef<SWidget> SHaybaMCPChatPanel::BuildPromptCard(const FText& Title, const FText& Hint, const FString& Prompt,
                                                       const FString& Glyph, const FLinearColor& AccentColor)
{
    return SNew(SButton)
        .ButtonStyle(FAppStyle::Get(), "SimpleButton")
        .ContentPadding(FMargin(0.f))
        .OnClicked_Lambda([this, Prompt]() { return OnPromptCardClicked(Prompt); })
        [
            SNew(SBorder)
            .BorderImage(FAppStyle::GetBrush("Brushes.Panel"))
            .Padding(FMargin(0.f))
            [
                SNew(SVerticalBox)
                // Themed visual area — flat color rectangle with the glyph
                // centered, sized for visual weight. No external image asset
                // so this stays copyright-clean and ships in the plugin
                // without binary deps.
                + SVerticalBox::Slot().AutoHeight()
                [
                    SNew(SBorder)
                    .BorderImage(FAppStyle::Get().GetBrush("WhiteBrush"))
                    .BorderBackgroundColor(FSlateColor(AccentColor))
                    .Padding(FMargin(0.f, 24.f))
                    [
                        SNew(STextBlock)
                        .Text(FText::FromString(Glyph))
                        .Justification(ETextJustify::Center)
                        .ColorAndOpacity(FSlateColor(FLinearColor::White))
                        .Font(FCoreStyle::GetDefaultFontStyle("Bold", 36))
                    ]
                ]
                // Title + hint below the visual.
                + SVerticalBox::Slot().AutoHeight().Padding(FMargin(14.f, 12.f, 14.f, 14.f))
                [
                    SNew(SVerticalBox)
                    + SVerticalBox::Slot().AutoHeight().Padding(0.f, 0.f, 0.f, 4.f)
                    [
                        SNew(STextBlock)
                        .Text(Title)
                        .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("DetailsView.CategoryTextStyle"))
                    ]
                    + SVerticalBox::Slot().AutoHeight()
                    [
                        SNew(STextBlock)
                        .Text(Hint)
                        .ColorAndOpacity(FSlateColor(ColorMuted))
                        .AutoWrapText(true)
                    ]
                ]
            ]
        ];
}

FReply SHaybaMCPChatPanel::OnPromptCardClicked(FString Prompt)
{
    if (InputBox.IsValid()) InputBox->SetText(FText::FromString(Prompt));
    if (FSlateApplication::IsInitialized() && InputBox.IsValid())
    {
        FSlateApplication::Get().SetKeyboardFocus(InputBox);
    }
    return FReply::Handled();
}

// ── Message row (Q5-a flat + Q12-c copy on hover + right-click) ──────────

TSharedRef<SWidget> SHaybaMCPChatPanel::BuildMessageRow(const FHaybaMCPChatMessage& Msg, int32 MessageIndex)
{
    const FText RoleLabel = Msg.bFromUser ? LOCTEXT("RoleYou", "You")
                                          : LOCTEXT("RoleAI",  "AI");
    const FLinearColor RoleColor = Msg.bFromUser ? ColorMuted : ColorRoleAI;

    TSharedRef<SVerticalBox> Stack = SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight()
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().AutoWidth().Padding(0.f, 0.f, 8.f, 0.f)
            [
                SNew(STextBlock)
                .Text(RoleLabel)
                .ColorAndOpacity(FSlateColor(ColorMuted))
            ]
            + SHorizontalBox::Slot().FillWidth(1.f)
            [
                SNew(STextBlock)
                .Text(FText::FromString(Msg.Text))
                .ColorAndOpacity(FSlateColor(RoleColor))
                .AutoWrapText(true)
            ]
            // Hover copy icon (Q12-c).
            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Top).Padding(6.f, 0.f, 0.f, 0.f)
            [
                SNew(SButton)
                .ButtonStyle(FAppStyle::Get(), "SimpleButton")
                .ToolTipText(LOCTEXT("CopyMsgTT", "Copy message"))
                .ContentPadding(FMargin(2.f))
                .OnClicked_Lambda([this, MessageIndex]() { return OnCopyMessage(MessageIndex); })
                [ SNew(SImage).Image(FAppStyle::GetBrush("Icons.Duplicate")) ]
            ]
        ];

    // Message-attached step actions (Q6-a) — only on AI messages with a graph.
    if (!Msg.bFromUser && Msg.bShowActions && Msg.AttachedGraph.IsValid())
    {
        Stack->AddSlot().AutoHeight().Padding(28.f, 6.f, 0.f, 0.f)
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().AutoWidth().Padding(0.f, 0.f, 4.f, 0.f)
            [
                SNew(SButton)
                .ButtonStyle(FAppStyle::Get(), "PrimaryButton")
                .Text(LOCTEXT("ApproveBtn", "✓ Approve"))
                .ContentPadding(FMargin(8.f, 3.f))
                .OnClicked(this, &SHaybaMCPChatPanel::OnApproveStepFromMessage)
            ]
            + SHorizontalBox::Slot().AutoWidth().Padding(0.f, 0.f, 4.f, 0.f)
            [
                SNew(SButton)
                .Text(LOCTEXT("PreviewBtn", "Preview"))
                .ContentPadding(FMargin(8.f, 3.f))
                .OnClicked_Lambda([this, MessageIndex]() { return OnPreviewGraphFromMessage(MessageIndex); })
            ]
            + SHorizontalBox::Slot().AutoWidth().Padding(0.f, 0.f, 4.f, 0.f)
            [
                SNew(SButton)
                .Text(LOCTEXT("CreateBtn", "↑ Create"))
                .ContentPadding(FMargin(8.f, 3.f))
                .OnClicked_Lambda([this, MessageIndex]() { return OnCreateInUEFromMessage(MessageIndex); })
            ]
            + SHorizontalBox::Slot().AutoWidth().Padding(0.f, 0.f, 4.f, 0.f)
            [
                SNew(SButton)
                .Text(LOCTEXT("TestBtn", "▶ Test"))
                .ContentPadding(FMargin(8.f, 3.f))
                .OnClicked_Lambda([this, MessageIndex]() { return OnTestItFromMessage(MessageIndex); })
            ]
            + SHorizontalBox::Slot().AutoWidth()
            [
                SNew(SButton)
                .Text(LOCTEXT("RedoBtnSmall", "↺ Redo"))
                .ContentPadding(FMargin(8.f, 3.f))
                .OnClicked(this, &SHaybaMCPChatPanel::OnRedoStepFromMessage)
            ]
        ];
    }

    return SNew(SBorder)
        .BorderImage(FAppStyle::GetBrush("NoBrush"))
        .Padding(FMargin(8.f, 4.f))
        [ Stack ];
}

// ── Message management ────────────────────────────────────────────────────

void SHaybaMCPChatPanel::AddUserMessage(const FString& Text)
{
    FHaybaMCPChatMessage Msg;
    Msg.bFromUser = true;
    Msg.Text      = Text;
    Session.Messages.Add(Msg);
    RebuildChat();
}

void SHaybaMCPChatPanel::AddAIMessage(const FString& Text, TSharedPtr<FJsonObject> Graph)
{
    FHaybaMCPChatMessage Msg;
    Msg.bFromUser     = false;
    Msg.Text          = Text;
    Msg.AttachedGraph = Graph;
    Msg.bShowActions  = Graph.IsValid();
    Session.Messages.Add(Msg);

    // Sticky-if-at-bottom (Q13-b).
    const bool bPinned = IsScrolledNearBottom();
    if (!bPinned) ++UnseenWhileScrolledUp;
    RebuildChat();
    if (bPinned) ScrollToBottomIfPinned();
}

void SHaybaMCPChatPanel::AddSystemError(const FString& Reason, const FString& RetryPrompt)
{
    FHaybaMCPChatMessage Msg;
    Msg.bFromUser    = false;
    Msg.Text         = FString::Printf(TEXT("⚠ %s"), *Reason);
    Msg.bShowActions = false;
    Session.Messages.Add(Msg);
    RebuildChat();
    // Retry button surfacing happens by re-rendering with a `[Retry]` chip
    // attached when the next prompt is the same. Minimum-viable for now:
    // user can re-send via the copy-as-prompt right-click menu.
    Toast(FText::FromString(FString::Printf(TEXT("Send failed: %s — use right-click → Copy as prompt to retry"), *Reason)));
    (void)RetryPrompt;
}

void SHaybaMCPChatPanel::RebuildChat()
{
    if (!ChatScrollBox.IsValid()) return;
    ChatScrollBox->ClearChildren();

    if (Session.Messages.IsEmpty())
    {
        ChatScrollBox->AddSlot() [ BuildEmptyState() ];
        return;
    }

    for (int32 i = 0; i < Session.Messages.Num(); ++i)
    {
        ChatScrollBox->AddSlot() [ BuildMessageRow(Session.Messages[i], i) ];
    }
}

void SHaybaMCPChatPanel::ScrollToBottomIfPinned()
{
    if (!ChatScrollBox.IsValid()) return;
    TWeakPtr<SScrollBox> Weak = ChatScrollBox;
    if (GEditor)
    {
        GEditor->GetTimerManager()->SetTimerForNextTick([Weak]()
        {
            if (TSharedPtr<SScrollBox> S = Weak.Pin()) S->ScrollToEnd();
        });
    }
}

bool SHaybaMCPChatPanel::IsScrolledNearBottom() const
{
    if (!ChatScrollBox.IsValid()) return true;
    return ChatScrollBox->GetScrollOffsetOfEnd() <= 0.5f;
}

EVisibility SHaybaMCPChatPanel::GetNewMessagesChipVisibility() const
{
    return UnseenWhileScrolledUp > 0 ? EVisibility::Visible : EVisibility::Collapsed;
}

// ── Send / stop ───────────────────────────────────────────────────────────

FReply SHaybaMCPChatPanel::OnSendOrStop()
{
    if (bIsStreaming) { StopGeneration(); return FReply::Handled(); }
    return OnSendCurrentInput();
}

FReply SHaybaMCPChatPanel::OnSendCurrentInput()
{
    if (!InputBox.IsValid()) return FReply::Handled();
    FString Text = InputBox->GetText().ToString().TrimStartAndEnd();
    if (Text.IsEmpty()) return FReply::Handled();

    InputBox->SetText(FText::GetEmpty());
    AddUserMessage(Text);
    // User intent: always scroll to bottom on their own send.
    UnseenWhileScrolledUp = 0;
    ScrollToBottomIfPinned();

    if (Session.Goal.IsEmpty()) InitializeSession(Text);
    else SendToMCP(Text);

    return FReply::Handled();
}

void SHaybaMCPChatPanel::StopGeneration()
{
    // Q16-a: cancel HTTP only. The underlying client doesn't yet expose an
    // abort handle, so the minimum viable is to ignore the next response and
    // tag the partial reply.
    // TODO: wire FHaybaMCPClaudeClient::Cancel() once implemented.
    bIsStreaming = false;
    Session.bWaitingForAI = false;
    if (Module && ToolCallSubscription.IsValid())
    {
        Module->OnToolCallRecorded.Remove(ToolCallSubscription);
        ToolCallSubscription.Reset();
    }
    if (Session.Messages.IsValidIndex(InProgressMessageIndex))
    {
        Session.Messages[InProgressMessageIndex].Text += TEXT("\n\n[stopped]");
        InProgressMessageIndex = INDEX_NONE;
    }
    RebuildChat();
}

bool SHaybaMCPChatPanel::CanSend() const
{
    return !Session.bWaitingForAI;
}

// ── New / recent ──────────────────────────────────────────────────────────

FReply SHaybaMCPChatPanel::OnNewConversation()
{
    // TODO: when persistence lands, save current Session to disk before reset.
    Session = FHaybaMCPWizardSession{};
    UnseenWhileScrolledUp = 0;
    RebuildChat();
    return FReply::Handled();
}

// ── Copy / right-click ────────────────────────────────────────────────────

FReply SHaybaMCPChatPanel::OnCopyMessage(int32 MessageIndex)
{
    if (!Session.Messages.IsValidIndex(MessageIndex)) return FReply::Handled();
    FPlatformApplicationMisc::ClipboardCopy(*Session.Messages[MessageIndex].Text);
    Toast(LOCTEXT("Copied", "Copied message to clipboard"));
    return FReply::Handled();
}

TSharedPtr<SWidget> SHaybaMCPChatPanel::BuildMessageContextMenu(int32 MessageIndex)
{
    FMenuBuilder Menu(true, nullptr);
    Menu.AddMenuEntry(
        LOCTEXT("CopyMsg", "Copy message"),
        FText::GetEmpty(), FSlateIcon(),
        FUIAction(FExecuteAction::CreateLambda([this, MessageIndex]()
        {
            OnCopyMessage(MessageIndex);
        })));
    // TODO: "Copy as JSON" (extract first {...} block), "Copy as prompt"
    // (only for user rows; re-fills the input), "Redo from here".
    return Menu.MakeWidget();
}

// ── Step actions per message (Q6-a) ───────────────────────────────────────

FReply SHaybaMCPChatPanel::OnApproveStepFromMessage()
{
    if (!Session.HasCurrentStep()) return FReply::Handled();
    Session.GetCurrentStep().Status = EHaybaMCPWizardStepStatus::Approved;

    int32 Next = Session.CurrentStep + 1;
    if (Session.Steps.IsValidIndex(Next))
    {
        Session.CurrentStep = Next;
        Session.Steps[Next].Status = EHaybaMCPWizardStepStatus::InProgress;
        AddAIMessage(FString::Printf(TEXT("Moving to step %d: \"%s\". How would you like to approach this?"),
            Next + 1, *Session.Steps[Next].Name));
    }
    else
    {
        AddAIMessage(TEXT("All steps approved. Finalizing graph…"));
        SendToMCP(TEXT("[FINALIZE]"));
    }
    return FReply::Handled();
}

FReply SHaybaMCPChatPanel::OnRedoStepFromMessage()
{
    if (!Session.HasCurrentStep()) return FReply::Handled();
    Session.GetCurrentStep().Status = EHaybaMCPWizardStepStatus::Redoing;
    Session.GetCurrentStep().Graph.Reset();
    AddAIMessage(FString::Printf(TEXT("Let's redo \"%s\". What would you like to change?"),
        *Session.GetCurrentStep().Name));
    return FReply::Handled();
}

FReply SHaybaMCPChatPanel::OnPreviewGraphFromMessage(int32 MessageIndex)
{
    if (!Session.Messages.IsValidIndex(MessageIndex)) return FReply::Handled();
    TSharedPtr<FJsonObject> Graph = Session.Messages[MessageIndex].AttachedGraph;
    if (!Graph.IsValid()) return FReply::Handled();

    const TArray<TSharedPtr<FJsonValue>>* Nodes = nullptr;
    const TArray<TSharedPtr<FJsonValue>>* Edges = nullptr;
    const int32 NodeCount = Graph->TryGetArrayField(TEXT("nodes"), Nodes) ? Nodes->Num() : 0;
    const int32 EdgeCount = Graph->TryGetArrayField(TEXT("edges"), Edges) ? Edges->Num() : 0;

    // TODO (Q15-b): instead of describing in text, route to the Plan tab
    // and load the graph there. Needs a public method on SHaybaMCPPlanPanel.
    AddAIMessage(FString::Printf(
        TEXT("Graph preview: %d nodes, %d edges. (Plan tab routing — coming.)"),
        NodeCount, EdgeCount));
    return FReply::Handled();
}

FReply SHaybaMCPChatPanel::OnCreateInUEFromMessage(int32 MessageIndex)
{
    if (!Session.Messages.IsValidIndex(MessageIndex) || !Module) return FReply::Handled();
    TSharedPtr<FJsonObject> Graph = Session.Messages[MessageIndex].AttachedGraph;
    if (!Graph.IsValid()) return FReply::Handled();

    FString GraphStr;
    TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&GraphStr);
    FJsonSerializer::Serialize(Graph.ToSharedRef(), Writer);

    FString AssetName = FString::Printf(TEXT("Chat_%s"),
        *FDateTime::Now().ToString(TEXT("%H%M%S")));

    TSharedRef<FJsonObject> Params = MakeShared<FJsonObject>();
    Params->SetStringField(TEXT("name"),  AssetName);
    Params->SetStringField(TEXT("graph"), GraphStr);

    AddAIMessage(FString::Printf(TEXT("Creating \"%s\"…"), *AssetName));

    TWeakPtr<SHaybaMCPChatPanel> WeakSelf = SharedThis(this);
    Module->SendTcpCommand(TEXT("create_graph"), Params,
        [WeakSelf, AssetName](bool bOk, const TSharedPtr<FJsonObject>& Response)
        {
            TSharedPtr<SHaybaMCPChatPanel> Self = WeakSelf.Pin();
            if (!Self.IsValid()) return;
            if (!bOk || !Response.IsValid())
            {
                Self->AddSystemError(TEXT("Failed to create graph"), TEXT(""));
                return;
            }
            FString AssetPath;
            Response->TryGetStringField(TEXT("assetPath"), AssetPath);
            Self->AddAIMessage(FString::Printf(TEXT("Created: %s"), *AssetPath));
        });
    return FReply::Handled();
}

FReply SHaybaMCPChatPanel::OnTestItFromMessage(int32 /*MessageIndex*/)
{
    if (!Module) return FReply::Handled();
    // Test = re-execute the latest created asset. We don't track asset path
    // per-message yet; that lives on the step. Keep using current step.
    if (!Session.HasCurrentStep()) { AddAIMessage(TEXT("Nothing to test yet — Create the graph first.")); return FReply::Handled(); }
    const FString& AssetPath = Session.GetCurrentStep().AssetPath;
    if (AssetPath.IsEmpty()) { AddAIMessage(TEXT("Create the graph in UE first, then test it.")); return FReply::Handled(); }

    TSharedRef<FJsonObject> Params = MakeShared<FJsonObject>();
    Params->SetStringField(TEXT("assetPath"), AssetPath);
    TWeakPtr<SHaybaMCPChatPanel> WeakSelf = SharedThis(this);
    Module->SendTcpCommand(TEXT("execute_graph"), Params,
        [WeakSelf](bool bOk, const TSharedPtr<FJsonObject>& Response)
        {
            TSharedPtr<SHaybaMCPChatPanel> Self = WeakSelf.Pin();
            if (!Self.IsValid()) return;
            if (!bOk) { Self->AddSystemError(TEXT("Failed to execute graph"), TEXT("")); return; }
            int32 Count = 0;
            if (Response.IsValid() && Response->HasField(TEXT("componentsExecuted")))
                Count = (int32)Response->GetNumberField(TEXT("componentsExecuted"));
            Self->AddAIMessage(FString::Printf(TEXT("Executed on %d PCG component(s)."), Count));
        });
    return FReply::Handled();
}

// ── Existing send pipeline ────────────────────────────────────────────────

void SHaybaMCPChatPanel::InitializeSession(const FString& Goal)
{
    Session.Goal      = Goal;
    Session.SessionId = FGuid::NewGuid().ToString();
    AddAIMessage(TEXT("Planning your project steps…"));
    SendToMCP(FString::Printf(TEXT("[INIT] Goal: %s"), *Goal));
}

void SHaybaMCPChatPanel::SendToMCP(const FString& UserMessage)
{
    const FHaybaMCPSettings& S = FHaybaMCPSettings::Get();
    if (!S.HasApiKey())
    {
        AddSystemError(TEXT("No API key set — open Settings"), TEXT(""));
        return;
    }

    Session.bWaitingForAI = true;
    bIsStreaming = true;

    // Q9-c: subscribe to the module's tool-call recorder while the call is in
    // flight. Each call streams a trace line into a placeholder AI message
    // so the user sees what the AI is actually doing.
    InProgressTrace.Reset();
    {
        FHaybaMCPChatMessage Placeholder;
        Placeholder.bFromUser = false;
        Placeholder.Text      = TEXT("…");
        Session.Messages.Add(Placeholder);
        InProgressMessageIndex = Session.Messages.Num() - 1;
        RebuildChat();
        ScrollToBottomIfPinned();
    }
    if (Module)
    {
        TWeakPtr<SHaybaMCPChatPanel> WeakSelf = SharedThis(this);
        ToolCallSubscription = Module->OnToolCallRecorded.AddLambda(
            [WeakSelf](const FHaybaToolCallRecord& Rec)
            {
                TSharedPtr<SHaybaMCPChatPanel> Self = WeakSelf.Pin();
                if (!Self.IsValid()) return;
                if (Self->InProgressMessageIndex == INDEX_NONE) return;
                Self->InProgressTrace.Add(FString::Printf(TEXT("• %s"), *Rec.ToolName));
                if (Self->Session.Messages.IsValidIndex(Self->InProgressMessageIndex))
                {
                    Self->Session.Messages[Self->InProgressMessageIndex].Text =
                        FString::Join(Self->InProgressTrace, TEXT("\n"));
                    Self->RebuildChat();
                    if (Self->IsScrolledNearBottom()) Self->ScrollToBottomIfPinned();
                }
            });
    }

    FOnClaudeResponse Callback;
    Callback.BindSP(this, &SHaybaMCPChatPanel::OnClaudeResponse);
    FHaybaMCPClaudeClient::SendMessage(GetHaybaMCPWizardSystemPrompt(), UserMessage,
        FHaybaMCPSettings::GetSharedApiKey(), S.Model, Callback);
}

void SHaybaMCPChatPanel::OnClaudeResponse(bool bSuccess, const FString& ResponseText)
{
    Session.bWaitingForAI = false;
    bIsStreaming = false;

    // Tear down the in-flight subscription and consume the placeholder.
    if (Module && ToolCallSubscription.IsValid())
    {
        Module->OnToolCallRecorded.Remove(ToolCallSubscription);
        ToolCallSubscription.Reset();
    }
    if (Session.Messages.IsValidIndex(InProgressMessageIndex))
    {
        Session.Messages.RemoveAt(InProgressMessageIndex);
        InProgressMessageIndex = INDEX_NONE;
    }
    InProgressTrace.Reset();

    if (!bSuccess) { AddSystemError(ResponseText, TEXT("")); return; }

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
    if (Graph.IsValid() && Session.HasCurrentStep())
    {
        Session.GetCurrentStep().Graph  = Graph;
        Session.GetCurrentStep().Status = EHaybaMCPWizardStepStatus::InProgress;
    }
    AddAIMessage(ReplyText, Graph);
}

#undef LOCTEXT_NAMESPACE
