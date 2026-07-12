// Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPChatPanel.h
#pragma once

#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/Input/SMultiLineEditableTextBox.h"
#include "HaybaMCPWizardState.h"
#include "HaybaMCPSettings.h"

class FHaybaMCPModule;
class SHaybaMCPMainPanel;
class SScrollBox;
class SBox;
class SVerticalBox;
class SHorizontalBox;
class SButton;

// Streaming agent client + its SSE payload structs (Task 7).
class FHaybaMCPAgentClient;
struct FHaybaChatToolCall;
struct FHaybaChatToolResult;
struct FHaybaChatPlanRequest;
struct FHaybaChatDone;
struct FHaybaChatError;

/**
 * Single-purpose chat surface. Conversation, input, footer status — that's it.
 *
 * Settings, step progress, and onboarding live in their dedicated panels.
 */
class SHaybaMCPChatPanel : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SHaybaMCPChatPanel) {}
        SLATE_ARGUMENT(SHaybaMCPMainPanel*, MainPanel)
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs, FHaybaMCPModule* InModule);

    // Unsubscribe delegates + cancel any in-flight stream so a late callback
    // cannot touch freed Slate widgets.
    virtual ~SHaybaMCPChatPanel() override;

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
    SHaybaMCPMainPanel* MainPanel = nullptr;

    // ── Session ────────────────────────────────────────────────────────────
    // Lives in the widget for now; will migrate to the module so it survives
    // tab navigation, and to disk for API-key mode (decision Q8-b).
    FHaybaMCPWizardSession Session;

    // ── Widget refs ────────────────────────────────────────────────────────
    TSharedPtr<SScrollBox>                  ChatScrollBox;
    TSharedPtr<SMultiLineEditableTextBox>   InputBox;
    TSharedPtr<SVerticalBox>                ChatContainer;
    bool                                    bIsStreaming = false;
    int32                                   UnseenWhileScrolledUp = 0;

    // In-flight tool-call trace state.
    FDelegateHandle ToolCallSubscription;   // legacy path (module recorder)
    int32           InProgressMessageIndex = INDEX_NONE;
    TArray<FString> InProgressTrace;        // tool-step lines for the live bubble
    FString         InProgressAssistantText;// streamed assistant deltas

    // ── Streaming agent client (Task 7/8) ────────────────────────────────────
    // Held via MakeShared (NEVER stack — AsShared asserts). One client per panel
    // = one server session; reused across turns so the transcript continues.
    TSharedPtr<FHaybaMCPAgentClient> AgentClient;
    FDelegateHandle PlanApprovedSubscription;   // module OnPlanApproved
    FDelegateHandle PlanRejectedSubscription;   // module OnPlanRejected
    bool            bAwaitingPlanApproval = false;

    void            EnsureAgentClient();
    void            StartAgentTurn(const FString& Prompt);
    void            BeginInProgressBubble();
    void            RefreshInProgressBubble();
    void            FinalizeInProgressBubble(const FString& FallbackText);

    // Agent-client delegate handlers (all fire on the game thread).
    void            HandleTextDelta(const FString& Text);
    void            HandleToolCall(const FHaybaChatToolCall& Call);
    void            HandleToolResult(const FHaybaChatToolResult& Result);
    void            HandlePlanRequest(const FHaybaChatPlanRequest& Plan);
    void            HandleStreamDone(const FHaybaChatDone& Done);
    void            HandleStreamError(const FHaybaChatError& Error);
    void            HandlePlanApproved();
    void            HandlePlanRejected();

    // ── Layout ─────────────────────────────────────────────────────────────
    TSharedRef<SWidget> BuildToolbar();
    TSharedRef<SWidget> BuildChatArea();
    TSharedRef<SWidget> BuildFooter();
    TSharedRef<SWidget> BuildInput();
    TSharedRef<SWidget> BuildEmptyState();
    TSharedRef<SWidget> BuildPromptCard(const FText& Title, const FText& Hint, const FString& Prompt,
                                        const FString& Glyph, const FLinearColor& AccentColor);
    TSharedRef<SWidget> BuildMessageRow(const FHaybaMCPChatMessage& Message, int32 MessageIndex);

    // ── Message management ────────────────────────────────────────────────
    void AddUserMessage(const FString& Text);
    void AddAIMessage(const FString& Text, TSharedPtr<FJsonObject> Graph = nullptr);
    void AddSystemError(const FString& Reason, const FString& RetryPrompt);
    void RebuildChat();
    void ScrollToBottomIfPinned();
    bool IsScrolledNearBottom() const;

    // ── Send/stop ─────────────────────────────────────────────────────────
    FReply OnSendOrStop();
    FReply OnSendCurrentInput();
    void   StopGeneration();
    bool   CanSend() const;

    // ── Conversation controls ─────────────────────────────────────────────
    FReply OnNewConversation();
    TSharedRef<SWidget> BuildRecentSessionsMenu();

    // ── Per-row affordances ───────────────────────────────────────────────
    FReply OnCopyMessage(int32 MessageIndex);
    TSharedPtr<SWidget> BuildMessageContextMenu(int32 MessageIndex);

    // ── Message-attached step actions (Q6-a) ──────────────────────────────
    FReply OnApproveStepFromMessage();
    FReply OnRedoStepFromMessage();
    FReply OnPreviewGraphFromMessage(int32 MessageIndex);
    FReply OnCreateInUEFromMessage(int32 MessageIndex);
    FReply OnTestItFromMessage(int32 MessageIndex);

    // ── Footer click handlers (Q17-b) ─────────────────────────────────────
    FReply OnFooterConnectionClick();
    FReply OnFooterModelClick();

    // ── Send helpers (existing wiring) ────────────────────────────────────
    void InitializeSession(const FString& Goal);
    void SendToMCP(const FString& UserMessage);
    void OnClaudeResponse(bool bSuccess, const FString& ResponseText);

    // ── Empty-state prompt helpers ────────────────────────────────────────
    FReply OnPromptCardClicked(FString Prompt);

    // ── Scroll chip ───────────────────────────────────────────────────────
    EVisibility GetNewMessagesChipVisibility() const;
};
