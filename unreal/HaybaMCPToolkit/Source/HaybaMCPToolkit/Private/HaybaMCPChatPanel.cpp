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
#include "HaybaMCPAgentClient.h"
#include "HaybaMCPPlanPanel.h"
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
#include "DragAndDrop/AssetDragDropOp.h"
#include "Input/DragAndDrop.h"          // FExternalDragOperation (SlateCore)
#include "AssetRegistry/AssetData.h"
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
        if (Main) Main->ShowSection(EHaybaSection::Settings);
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

SHaybaMCPChatPanel::~SHaybaMCPChatPanel()
{
    // Drop the legacy module tool-call subscription.
    if (Module && ToolCallSubscription.IsValid())
    {
        Module->OnToolCallRecorded.Remove(ToolCallSubscription);
        ToolCallSubscription.Reset();
    }
    // Drop the plan-approval subscription.
    if (Module && PlanApprovedSubscription.IsValid())
    {
        Module->OnPlanApproved.Remove(PlanApprovedSubscription);
        PlanApprovedSubscription.Reset();
    }
    if (Module && PlanRejectedSubscription.IsValid())
    {
        Module->OnPlanRejected.Remove(PlanRejectedSubscription);
        PlanRejectedSubscription.Reset();
    }
    // Tear down the streaming client: clear our delegate bindings so a late HTTP
    // tick can't fan out into this destroyed panel, then cancel the stream. The
    // client itself captures a weak ptr, so the ordering is belt-and-braces.
    if (AgentClient.IsValid())
    {
        AgentClient->OnTextDelta.RemoveAll(this);
        AgentClient->OnToolCall.RemoveAll(this);
        AgentClient->OnToolResult.RemoveAll(this);
        AgentClient->OnPlanRequest.RemoveAll(this);
        AgentClient->OnDone.RemoveAll(this);
        AgentClient->OnError.RemoveAll(this);
        AgentClient->Cancel();
        AgentClient.Reset();
    }
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
        // Spacer + plugin watermark already shown by MainPanel — nothing here.
        + SHorizontalBox::Slot().FillWidth(1.f) [ SNew(SBox) ];
}

FReply SHaybaMCPChatPanel::OnFooterConnectionClick() { OpenSettings(MainPanel); return FReply::Handled(); }
FReply SHaybaMCPChatPanel::OnFooterModelClick()      { OpenSettings(MainPanel); return FReply::Handled(); }

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
                    .Text_Lambda([this]()
                    {
                        // Reflect the parked-at-the-gate state so the disabled
                        // input reads as intentional, not broken.
                        if (bAwaitingPlanApproval)
                            return LOCTEXT("InputHintAwaitApproval",
                                "Action needs approval — Approve or Reject it in the Plan tab to continue.");
                        return LOCTEXT("InputHint",
                            "Describe what you want to generate…  (⏎ to send · ⇧⏎ for newline)");
                    })
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

// ── Drag-and-drop into the input (assets + external files) ────────────────

bool SHaybaMCPChatPanel::AppendToInput(const FString& Addition)
{
    if (!InputBox.IsValid() || Addition.IsEmpty()) return false;

    FString Existing = InputBox->GetText().ToString();
    // Space-separate from prior content; if the box already ends in whitespace
    // (or is empty) don't inject a redundant leading space.
    if (!Existing.IsEmpty() && !FChar::IsWhitespace(Existing[Existing.Len() - 1]))
    {
        Existing += TEXT(" ");
    }
    Existing += Addition;

    InputBox->SetText(FText::FromString(Existing));
    if (FSlateApplication::IsInitialized())
    {
        FSlateApplication::Get().SetKeyboardFocus(InputBox);
    }
    return true;
}

FReply SHaybaMCPChatPanel::OnDragOver(const FGeometry& /*MyGeometry*/, const FDragDropEvent& DragDropEvent)
{
    // Show the droppable cursor for payloads we know how to consume.
    if (DragDropEvent.GetOperationAs<FAssetDragDropOp>().IsValid() ||
        DragDropEvent.GetOperationAs<FExternalDragOperation>().IsValid())
    {
        return FReply::Handled();
    }
    return FReply::Unhandled();
}

FReply SHaybaMCPChatPanel::OnDrop(const FGeometry& /*MyGeometry*/, const FDragDropEvent& DragDropEvent)
{
    TArray<FString> Refs;

    // 1) Content Browser assets — append each asset's object path
    //    (e.g. /Game/Path/Asset.Asset) so the reference is unambiguous.
    if (TSharedPtr<FAssetDragDropOp> AssetOp = DragDropEvent.GetOperationAs<FAssetDragDropOp>())
    {
        for (const FAssetData& Asset : AssetOp->GetAssets())
        {
            const FString ObjectPath = Asset.GetObjectPathString();
            if (!ObjectPath.IsEmpty()) Refs.Add(ObjectPath);
        }
    }
    // 2) External files dragged from the OS file explorer.
    else if (TSharedPtr<FExternalDragOperation> ExtOp = DragDropEvent.GetOperationAs<FExternalDragOperation>())
    {
        if (ExtOp->HasFiles())
        {
            for (const FString& File : ExtOp->GetFiles())
            {
                if (!File.IsEmpty()) Refs.Add(File);
            }
        }
    }

    if (Refs.Num() == 0) return FReply::Unhandled();

    const bool bAppended = AppendToInput(FString::Join(Refs, TEXT(" ")));
    if (bAppended)
    {
        Toast(FText::Format(
            LOCTEXT("DropAppended", "Added {0} reference(s) to the message."),
            FText::AsNumber(Refs.Num())));
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

    // First user message names the conversation (title dropdown / recents).
    if (Session.Goal.IsEmpty()) Session.Goal = Text;

    // Streaming agent path (Task 8). The legacy single-POST pipeline
    // (InitializeSession / SendToMCP / OnClaudeResponse) is retained below but
    // no longer wired — see the "Legacy send pipeline" section.
    StartAgentTurn(Text);

    return FReply::Handled();
}

void SHaybaMCPChatPanel::StopGeneration()
{
    // Cancel the in-flight stream: aborts the server-side loop, cancels the local
    // HTTP request, and fires OnDone{cancelled} which finalizes the bubble.
    if (AgentClient.IsValid()) AgentClient->Cancel();
    // Defensively disarm the plan gate too, in case Stop is pressed while parked
    // at the approval gate (Cancel() above already notifies the server).
    bAwaitingPlanApproval = false;
    // Belt-and-braces if there is no live client (shouldn't happen while
    // bIsStreaming): tag the partial reply and reset local flags.
    if (!AgentClient.IsValid())
    {
        bIsStreaming = false;
        Session.bWaitingForAI = false;
        FinalizeInProgressBubble(TEXT(""));
    }
}

bool SHaybaMCPChatPanel::CanSend() const
{
    // Blocked while the AI is streaming AND while a plan_request is parked at the
    // approval gate. On plan_request the server emits a `done` frame (so
    // bWaitingForAI is false), but sending a fresh prompt here would start a new
    // /chat/stream that server-side replaces session.messages — orphaning the
    // paused plan and losing transcript context. Stay disabled until the user
    // Approves (resume) or Rejects (cancel) the pending plan.
    return !Session.bWaitingForAI && !bAwaitingPlanApproval;
}

// ── New / recent ──────────────────────────────────────────────────────────

FReply SHaybaMCPChatPanel::OnNewConversation()
{
    // TODO: when persistence lands, save current Session to disk before reset.
    // Abort any in-flight stream and drop the client so the next send opens a
    // FRESH server session (new session_id, new transcript).
    if (AgentClient.IsValid())
    {
        AgentClient->OnTextDelta.RemoveAll(this);
        AgentClient->OnToolCall.RemoveAll(this);
        AgentClient->OnToolResult.RemoveAll(this);
        AgentClient->OnPlanRequest.RemoveAll(this);
        AgentClient->OnDone.RemoveAll(this);
        AgentClient->OnError.RemoveAll(this);
        AgentClient->Cancel();
        AgentClient.Reset();
    }
    bAwaitingPlanApproval = false;
    bIsStreaming = false;
    InProgressMessageIndex = INDEX_NONE;
    InProgressTrace.Reset();
    InProgressAssistantText.Reset();

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

// ── Streaming agent pipeline (Task 8) ─────────────────────────────────────

void SHaybaMCPChatPanel::EnsureAgentClient()
{
    if (AgentClient.IsValid()) return;

    // MUST be MakeShared — the client calls AsShared() internally and asserts if
    // it was ever stack/heap-allocated outside a shared ref.
    AgentClient = MakeShared<FHaybaMCPAgentClient>();

    // Subscribe once; the client persists for the panel's lifetime so a
    // multi-turn conversation reuses one server session. RemoveAll(this) in the
    // destructor drops these. Handlers all fire on the game thread.
    AgentClient->OnTextDelta.AddSP(this, &SHaybaMCPChatPanel::HandleTextDelta);
    AgentClient->OnToolCall.AddSP(this, &SHaybaMCPChatPanel::HandleToolCall);
    AgentClient->OnToolResult.AddSP(this, &SHaybaMCPChatPanel::HandleToolResult);
    AgentClient->OnPlanRequest.AddSP(this, &SHaybaMCPChatPanel::HandlePlanRequest);
    AgentClient->OnDone.AddSP(this, &SHaybaMCPChatPanel::HandleStreamDone);
    AgentClient->OnError.AddSP(this, &SHaybaMCPChatPanel::HandleStreamError);

    // Watch for Plan-tab approvals so a paused turn can resume. One-shot per
    // pending plan (guarded by bAwaitingPlanApproval in the handler).
    if (Module && !PlanApprovedSubscription.IsValid())
    {
        PlanApprovedSubscription = Module->OnPlanApproved.AddSP(
            this, &SHaybaMCPChatPanel::HandlePlanApproved);
    }

    // Watch for Plan-tab rejections so a paused turn is cancelled and this panel
    // disarms — otherwise it stays armed and a later, unrelated Approve resumes
    // the rejected turn. Also guarded by bAwaitingPlanApproval in the handler.
    if (Module && !PlanRejectedSubscription.IsValid())
    {
        PlanRejectedSubscription = Module->OnPlanRejected.AddSP(
            this, &SHaybaMCPChatPanel::HandlePlanRejected);
    }
}

void SHaybaMCPChatPanel::StartAgentTurn(const FString& Prompt)
{
    if (!FHaybaMCPSettings::Get().HasApiKey())
    {
        AddSystemError(TEXT("No API key configured — add one in Settings to chat"), TEXT(""));
        return;
    }

    EnsureAgentClient();

    Session.bWaitingForAI = true;
    bIsStreaming = true;
    BeginInProgressBubble();

    // Server owns the system prompt (see HaybaMCPWizardPrompt.h) — send only the
    // user turn. Provider/model/key are resolved by the client from the vault
    // and pushed to the sidecar via /chat/config on the first turn.
    AgentClient->SendPrompt(Prompt);
}

void SHaybaMCPChatPanel::BeginInProgressBubble()
{
    InProgressTrace.Reset();
    InProgressAssistantText.Reset();

    FHaybaMCPChatMessage Placeholder;
    Placeholder.bFromUser = false;
    Placeholder.Text      = TEXT("…");
    Session.Messages.Add(Placeholder);
    InProgressMessageIndex = Session.Messages.Num() - 1;

    RebuildChat();
    ScrollToBottomIfPinned();
}

void SHaybaMCPChatPanel::RefreshInProgressBubble()
{
    if (!Session.Messages.IsValidIndex(InProgressMessageIndex)) return;

    // Tool-step trace (if any) sits above the streaming answer so the user sees
    // what the agent is doing, then the prose it produces.
    FString Composed;
    if (InProgressTrace.Num() > 0)
    {
        Composed = FString::Join(InProgressTrace, TEXT("\n"));
    }
    if (!InProgressAssistantText.IsEmpty())
    {
        if (!Composed.IsEmpty()) Composed += TEXT("\n\n");
        Composed += InProgressAssistantText;
    }
    if (Composed.IsEmpty()) Composed = TEXT("…");

    Session.Messages[InProgressMessageIndex].Text = Composed;
    const bool bPinned = IsScrolledNearBottom();
    RebuildChat();
    if (bPinned) ScrollToBottomIfPinned();
}

void SHaybaMCPChatPanel::FinalizeInProgressBubble(const FString& FallbackText)
{
    if (!Session.Messages.IsValidIndex(InProgressMessageIndex))
    {
        InProgressMessageIndex = INDEX_NONE;
        return;
    }
    // If nothing streamed (e.g. immediate error), drop or substitute the
    // placeholder so we don't leave a lone "…" bubble.
    const bool bEmpty = InProgressTrace.Num() == 0 && InProgressAssistantText.IsEmpty();
    if (bEmpty)
    {
        if (FallbackText.IsEmpty())
        {
            Session.Messages.RemoveAt(InProgressMessageIndex);
        }
        else
        {
            Session.Messages[InProgressMessageIndex].Text = FallbackText;
        }
    }
    else
    {
        RefreshInProgressBubble();
        if (!FallbackText.IsEmpty() && Session.Messages.IsValidIndex(InProgressMessageIndex))
        {
            Session.Messages[InProgressMessageIndex].Text += FString::Printf(TEXT("\n\n%s"), *FallbackText);
        }
    }
    InProgressMessageIndex = INDEX_NONE;
    InProgressTrace.Reset();
    InProgressAssistantText.Reset();
    RebuildChat();
}

// ── Agent-client delegate handlers ────────────────────────────────────────

void SHaybaMCPChatPanel::HandleTextDelta(const FString& Text)
{
    if (InProgressMessageIndex == INDEX_NONE) BeginInProgressBubble();
    InProgressAssistantText += Text;
    RefreshInProgressBubble();
}

void SHaybaMCPChatPanel::HandleToolCall(const FHaybaChatToolCall& Call)
{
    if (InProgressMessageIndex == INDEX_NONE) BeginInProgressBubble();
    // Collapsible-step affordance: a compact one-liner per tool call. (Full
    // arg/result inspection lives in the Tool Stream panel.)
    InProgressTrace.Add(FString::Printf(TEXT("→ %s"),
        Call.Name.IsEmpty() ? TEXT("tool") : *Call.Name));
    RefreshInProgressBubble();
}

void SHaybaMCPChatPanel::HandleToolResult(const FHaybaChatToolResult& Result)
{
    if (InProgressMessageIndex == INDEX_NONE) BeginInProgressBubble();
    const TCHAR* Glyph = Result.bIsError ? TEXT("✕") : TEXT("✓");
    InProgressTrace.Add(FString::Printf(TEXT("  %s %s"),
        Glyph, Result.Name.IsEmpty() ? TEXT("tool") : *Result.Name));
    RefreshInProgressBubble();
}

void SHaybaMCPChatPanel::HandlePlanRequest(const FHaybaChatPlanRequest& Plan)
{
    // Surface the gated action in the Plan tab for EXPLICIT human approval.
    // NEVER auto-approve. The paused turn stays parked server-side until the
    // user clicks Approve (→ OnPlanApproved → HandlePlanApproved → resume).
    bAwaitingPlanApproval = true;

    if (InProgressMessageIndex != INDEX_NONE)
    {
        InProgressTrace.Add(FString::Printf(
            TEXT("⏸ Needs approval: %s — see the Plan tab."),
            Plan.Name.IsEmpty() ? TEXT("action") : *Plan.Name));
        RefreshInProgressBubble();
    }

    if (Module)
    {
        if (TSharedPtr<SHaybaMCPPlanPanel> PP = Module->PlanPanel.Pin())
        {
            FHaybaPlanStep Step;
            Step.Index       = 0;
            Step.Title       = Plan.Name.IsEmpty() ? TEXT("Proposed action") : Plan.Name;
            Step.Description = Plan.Hint.IsEmpty()
                ? FString::Printf(TEXT("Input: %s"), *Plan.InputJson)
                : Plan.Hint;
            Step.Tool        = Plan.Name;
            TArray<FHaybaPlanStep> Steps; Steps.Add(Step);
            PP->LoadPlan(Steps, /*AwaitSeconds*/ 120);
        }
    }

    // Route the user to the Plan tab so the Approve/Reject bar is in front of
    // them. This does not approve anything.
    if (MainPanel) MainPanel->ShowSection(EHaybaSection::Plan);

    Toast(LOCTEXT("PlanPause", "Action needs approval — review it in the Plan tab."));
}

void SHaybaMCPChatPanel::HandlePlanApproved()
{
    // Only act if WE are the panel waiting on a plan (avoids resuming on stray
    // approvals). One-shot: clear the flag before resuming.
    if (!bAwaitingPlanApproval) return;
    bAwaitingPlanApproval = false;

    if (!AgentClient.IsValid()) return;

    // Resume the paused turn into a fresh in-progress bubble.
    Session.bWaitingForAI = true;
    bIsStreaming = true;
    BeginInProgressBubble();
    AgentClient->ApproveAndResume();

    if (MainPanel) MainPanel->ShowSection(EHaybaSection::Chat);
}

void SHaybaMCPChatPanel::HandlePlanRejected()
{
    // Only act if WE are the panel waiting on a plan (avoids cancelling on stray
    // rejections from an unrelated Plan-tab action). Disarm before cancelling.
    if (!bAwaitingPlanApproval) return;
    bAwaitingPlanApproval = false;

    // Cancel the paused server-side turn so it can never be resumed, and mark the
    // in-progress bubble as aborted. Re-enables the input (CanSend clears once
    // bAwaitingPlanApproval + bWaitingForAI are both false).
    // NOTE: use AbortServerTurn(), not Cancel(): on plan reject the plan_request
    // SSE stream has already closed (bStreaming=false), so Cancel() would hit its
    // early-return and never POST /chat/cancel, leaving the turn parked server-side.
    if (AgentClient.IsValid()) AgentClient->AbortServerTurn();
    Session.bWaitingForAI = false;
    bIsStreaming = false;
    FinalizeInProgressBubble(TEXT("[rejected]"));

    Toast(LOCTEXT("PlanRejected", "Plan rejected — the paused action was cancelled."));
}

void SHaybaMCPChatPanel::HandleStreamDone(const FHaybaChatDone& Done)
{
    Session.bWaitingForAI = false;
    bIsStreaming = false;

    // Prefer streamed text; fall back to the server's assembled assistant_text
    // (e.g. on a clean end with no incremental deltas).
    if (InProgressAssistantText.IsEmpty() && !Done.AssistantText.IsEmpty())
    {
        InProgressAssistantText = Done.AssistantText;
    }
    const FString DoneTag = Done.bCancelled ? TEXT("[stopped]") : TEXT("");
    FinalizeInProgressBubble(DoneTag);
}

void SHaybaMCPChatPanel::HandleStreamError(const FHaybaChatError& Error)
{
    Session.bWaitingForAI = false;
    bIsStreaming = false;
    // Keep any partial content, then surface the error inline.
    FinalizeInProgressBubble(TEXT(""));
    AddSystemError(Error.Error.IsEmpty() ? TEXT("Chat error") : Error.Error, TEXT(""));
}

// ── Legacy send pipeline (UNUSED — retained for least-risk fallback) ──────
// The single-POST FHaybaMCPClaudeClient path below is no longer wired into the
// send button; StartAgentTurn() replaced it. Kept compilable so the fallback
// remains available and to avoid a wide deletion. See HaybaMCPWizardPrompt.h
// for the system-prompt ownership decision.

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
