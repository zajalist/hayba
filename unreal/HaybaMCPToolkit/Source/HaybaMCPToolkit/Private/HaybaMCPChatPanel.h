// Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPChatPanel.h
#pragma once

#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/Input/SMultiLineEditableTextBox.h"
#include "HaybaMCPWizardState.h"
#include "HaybaMCPSettings.h"
#include "HaybaMCPModelDiscovery.h"
#include "HaybaMCPWorldInspectSummary.h"

class FHaybaMCPModule;
class SScrollBox;
class SBox;
class SVerticalBox;
class SHorizontalBox;
class SButton;
class SComboButton;
class SEditableTextBox;
class SMultiLineEditableText;

/** Replace a changed activity projection without dropping focus from its action. */
namespace HaybaChatFocus
{
    void ReplaceActivityContent(const TSharedRef<SBox>& Slot, const TSharedRef<SWidget>& Content);
}

/** Display grammar only. Parsed prose can never create an approval or tool action. */
namespace HaybaChatText
{
    enum class EBlock : uint8 { Paragraph, Heading, ListItem, Code, Link };
    struct FBlock
    {
        EBlock Kind = EBlock::Paragraph;
        FString Text;
        FString Label;
        FString Target;
    };
    TArray<FBlock> Parse(const FString& Text);
    bool IsSafeWebLink(const FString& Target);
    bool IsSafeAssetReference(const FString& Target);
}

/** Native selectable text; unchanged blocks survive streaming and activity refreshes. */
class SHaybaChatMessageBody : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SHaybaChatMessageBody) : _PlainText(false) {}
        SLATE_ARGUMENT(bool, PlainText)
    SLATE_END_ARGS()
    void Construct(const FArguments& Args);
    void SetMessageText(const FString& Text);
    virtual void Tick(const FGeometry& Geometry, double Time, float Delta) override;
private:
    struct FRenderedBlock
    {
        HaybaChatText::FBlock Block;
        TSharedPtr<SMultiLineEditableText> Text;
        TSharedPtr<SWidget> Widget;
    };
    FRenderedBlock BuildBlock(const HaybaChatText::FBlock& Block);
    TSharedPtr<SVerticalBox> Stack;
    TArray<FRenderedBlock> Blocks;
    FString PendingText;
    FString DisplayedText;
    double LastRenderedAt = 0.0;
    bool bPlainText = false;
    bool bPendingUpdate = false;
    bool bWaitingForSelection = false;
};

// Streaming agent client + its SSE payload structs (Task 7).
class FHaybaMCPAgentClient;
struct FHaybaChatToolCall;
struct FHaybaChatToolResult;
struct FHaybaChatPlanRequest;
struct FHaybaChatDone;
struct FHaybaChatError;
class FJsonObject;

/**
 * Single-purpose chat surface. Conversation, input, and contextual task feedback.
 *
 * Settings, step progress, and onboarding live in their dedicated panels.
 */
class SHaybaMCPChatPanel : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SHaybaMCPChatPanel) {} SLATE_END_ARGS()

    void Construct(const FArguments& InArgs, FHaybaMCPModule* InModule);
    /** Stage a guided request without sending or replacing a user's draft. */
    void DraftPrompt(const FString& Prompt);

    /** Controls hosted by the main panel's single task header. */
    TSharedRef<SWidget> BuildTaskSwitcher();
    FReply OnNewConversation();
    FReply OnInspectWorld();

    // Unsubscribe delegates + cancel any in-flight stream so a late callback
    // cannot touch freed Slate widgets.
    virtual ~SHaybaMCPChatPanel() override;
    virtual void Tick(const FGeometry& Geometry, double Time, float Delta) override;

    // ── Drag-and-drop into the chat input ────────────────────────────────────
    // Accept Content Browser assets (FAssetDragDropOp) and external files
    // (FExternalDragOperation); on drop, append their paths to InputBox.
    virtual FReply OnDragOver(const FGeometry& MyGeometry, const FDragDropEvent& DragDropEvent) override;
    virtual FReply OnDrop(const FGeometry& MyGeometry, const FDragDropEvent& DragDropEvent) override;

private:
    // Append `Addition` to InputBox, space-separating from any existing text,
    // then focus the input. Returns true if anything was appended.
    bool AppendToInput(const FString& Addition);

    FHaybaMCPModule* Module = nullptr;

    // ── Session ────────────────────────────────────────────────────────────
    // Lives in the widget for now; will migrate to the module so it survives
    // tab navigation, and to disk for API-key mode (decision Q8-b).
    FHaybaMCPWizardSession Session;

    // ── Widget refs ────────────────────────────────────────────────────────
    TSharedPtr<SScrollBox>                  ChatScrollBox;
    TSharedPtr<SMultiLineEditableTextBox>   InputBox;
    TSharedPtr<SVerticalBox>                ChatContainer;
    TSharedPtr<SComboButton>                TaskSwitcherButton;
    TSharedPtr<SComboButton>                WorkModeButton;
    TSharedPtr<SComboButton>                ModelButton;
    TSharedPtr<SComboButton>                EffortButton;
    TSharedPtr<SVerticalBox>                ModelMenuItems;
    TSharedPtr<SVerticalBox>                ExternalPlanStepsBox;
    TSharedPtr<SButton>                     ExternalDetailsButton;
    FString                                 DisplayedExternalPlanId;
    bool                                    bExternalDetailsExpanded = false;
    bool                                    bExternalChangeNeedsDetails = false;
    TSharedPtr<FHaybaMCPModelDiscoveryClient> ModelDiscoveryClient;
    TOptional<FHaybaMCPModelDiscoveryResult> DiscoveredModels;
    FString                                 ModelSearch;
    FString                                 ModelMenuMessage;
    FString                                 PendingUnverifiedModelId;
    FString                                 ReasoningEffort;
    FString                                 TaskModelId;
    FString                                 TaskModelProviderId;
    FString                                 RestoredProviderId;
    FString                                 RestoredLoop;
    bool                                    bModelDiscoveryLoading = false;
    struct FMessageWidgets
    {
        TSharedPtr<SWidget> Row;
        TSharedPtr<SHaybaChatMessageBody> Body;
        TSharedPtr<SBox> Activity;
        FString ActivityId;
        uint64 ActivitySerial = MAX_uint64;
    };
    TArray<FMessageWidgets> MessageWidgets;
    TMap<FString, uint64> ActivitySerialById;
    bool                                    bIsStreaming = false;
    bool                                    bInspectInFlight = false;
    FHaybaInspectRequestGeneration         InspectGeneration;
    int32                                   UnseenWhileScrolledUp = 0;

    int32           InProgressMessageIndex = INDEX_NONE;
    FString         InProgressAssistantText;// streamed assistant deltas
    FString         WorkMode = TEXT("explore");
    TSet<FString>    ExpandedActivityIds;
    struct FRecentSession
    {
        FString Id;
        FString Title;
        FString UpdatedAt;
    };
    TArray<FRecentSession> RecentSessions;
    FString RecentSessionsStatus;
    FString PendingSessionId;
    bool bLoadingSession = false;

    // ── Streaming agent client (Task 7/8) ────────────────────────────────────
    // Held via MakeShared (NEVER stack — AsShared asserts). One client per panel
    // = one server session; reused across turns so the transcript continues.
    TSharedPtr<FHaybaMCPAgentClient> AgentClient;
    bool            bAwaitingPlanApproval = false;
    FString         PendingActivityId;

    // ── Hayba Pro loop selection / unavailable fallback ─────────────────────
    // Last prompt handed to the agent (set in StartAgentTurn). The Community
    // fallback does NOT re-send it — it re-streams prompt-less over the saved
    // transcript — so this is kept for reference only.
    FString         LastPrompt;
    FString         RetryPromptText;
    int32           RetryMessageIndex = INDEX_NONE;
    bool            bTurnErrorShown = false;
    // Row (Session.Messages index) that carries the inline Community-fallback
    // button; INDEX_NONE when no fallback is offered.
    int32           CommunityFallbackMessageIndex = INDEX_NONE;
    /** True when the next turn routes through Hayba Pro (setting on, not forced to Community). */
    bool            IsProLoopActive() const;
    FReply          OnUseCommunityForThisChat();

    void            EnsureAgentClient();
    void            StartAgentTurn(const FString& Prompt);
    void            BeginInProgressBubble();
    void            RefreshInProgressBubble();
    void            FinalizeInProgressBubble(const FString& FallbackText);

    // Agent-client delegate handlers (all fire on the game thread).
    void            HandleTextDelta(const FString& Text);
    void            HandleActivityEvent(const FJsonObject& Event);
    void            HandleStreamDone(const FHaybaChatDone& Done);
    void            HandleStreamError(const FHaybaChatError& Error);
    void            HandlePlanApproved();
    void            HandlePlanRejected();
    void            ApproveActivity(const FString& ActivityId);
    void            RejectActivity(const FString& ActivityId);
    bool            IsNativeApprovalForCurrentActivity(const FString& ProposalId) const;
    void            InvalidateCurrentChatNativeApproval();
    FString         ActiveNativeProposalId;
    FString         ActiveNativeOperationDigest;

    // ── Layout ─────────────────────────────────────────────────────────────
    TSharedRef<SWidget> BuildChatArea();
    void RebuildExternalProposal();
    TSharedRef<SWidget> BuildInput();
    TSharedRef<SWidget> BuildWorkModeMenu();
    TSharedRef<SWidget> BuildModelMenu();
    TSharedRef<SWidget> BuildEffortMenu();
    void RefreshModelMenuItems();
    FReply OnSetModel(const FString& ModelId);
    FReply OnSetEffort(const FString& Effort);
    void OnManualModelCommitted(const FText& Text, ETextCommit::Type CommitType);
    FString EffectiveModelId() const;
    FString EffectiveReasoningEffort() const;
    const FHaybaMCPDiscoveredModel* SelectedDiscoveredModel() const;
    bool IsSubscriptionModel() const;
    bool HasEffortChoices() const;
    TSharedRef<SWidget> BuildEmptyState();
    TSharedRef<SWidget> BuildMessageRow(const FHaybaMCPChatMessage& Message, int32 MessageIndex);
    TSharedRef<SWidget> BuildActivityCard(const FString& ActivityId);
    FReply OnSetWorkMode(FString NewMode);

    // ── Message management ────────────────────────────────────────────────
    void AddUserMessage(const FString& Text);
    void AddAIMessage(const FString& Text, TSharedPtr<FJsonObject> Graph = nullptr);
    void AddInspectResult(const FHaybaWorldInspectSummary& Summary);
    void AddSystemError(const FString& Reason, const FString& RetryPrompt);
    FReply RestoreRetryPrompt();
    void RebuildChat();
    void ScrollToBottomIfPinned();
    bool IsScrolledNearBottom() const;

    // ── Send/stop ─────────────────────────────────────────────────────────
    FReply OnSendOrStop();
    FReply OnSendCurrentInput();
    void   StopGeneration();
    bool   CanSend() const;

    // ── Conversation controls ─────────────────────────────────────────────
    TSharedRef<SWidget> BuildRecentSessionsMenu();
    void RefreshRecentSessions();
    void OpenSavedSession(const FString& SessionId);

    // ── Per-row affordances ───────────────────────────────────────────────
    FReply OnCopyMessage(int32 MessageIndex);
    TSharedPtr<SWidget> BuildMessageContextMenu(int32 MessageIndex);

    // ── Empty-state prompt helpers ────────────────────────────────────────

    // ── Scroll chip ───────────────────────────────────────────────────────
    EVisibility GetNewMessagesChipVisibility() const;
};
