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

/**
 * Single-purpose chat surface for API-key mode users. Integrated-mode users
 * never see this tab. Conversation, input, footer status — that's it.
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

private:
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
    FDelegateHandle ToolCallSubscription;
    int32           InProgressMessageIndex = INDEX_NONE;
    TArray<FString> InProgressTrace;

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
    FReply OnFooterModeClick();

    // ── Send helpers (existing wiring) ────────────────────────────────────
    void InitializeSession(const FString& Goal);
    void SendToMCP(const FString& UserMessage);
    void OnClaudeResponse(bool bSuccess, const FString& ResponseText);

    // ── Empty-state prompt helpers ────────────────────────────────────────
    FReply OnPromptCardClicked(FString Prompt);

    // ── Scroll chip ───────────────────────────────────────────────────────
    EVisibility GetNewMessagesChipVisibility() const;
};
