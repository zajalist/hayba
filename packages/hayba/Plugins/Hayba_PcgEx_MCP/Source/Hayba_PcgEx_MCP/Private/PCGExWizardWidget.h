// Plugins/Hayba_PcgEx_MCP/Source/Hayba_PcgEx_MCP/Private/PCGExWizardWidget.h
#pragma once

#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/Input/SMultiLineEditableTextBox.h"
#include "Styling/SlateBrush.h"
#include "PCGExWizardState.h"

class FPCGExBridgeModule;
class SScrollBox;
class SEditableTextBox;

class SPCGExWizardWidget : public SCompoundWidget
{
public:
	SLATE_BEGIN_ARGS(SPCGExWizardWidget) {}
	SLATE_END_ARGS()

	void Construct(const FArguments& InArgs, FPCGExBridgeModule* InModule);
	virtual void Tick(const FGeometry& AllottedGeometry, double InCurrentTime, float InDeltaTime) override;

private:
	FPCGExBridgeModule* Module = nullptr;
	FPCGExWizardSession Session;

	// Logo brush (loaded from Resources/HaybaLogo_32.png)
	TSharedPtr<FSlateDynamicImageBrush> LogoBrush;

	// Chat
	TSharedPtr<SScrollBox> ChatScrollBox;
	TSharedPtr<SMultiLineEditableTextBox> InputBox;

	// Settings panel fields
	TSharedPtr<SEditableTextBox> ApiKeyBox;
	TSharedPtr<SEditableTextBox> BaseUrlBox;
	TSharedPtr<SEditableTextBox> ModelBox;
	TSharedPtr<SEditableTextBox> OutputPathBox;
	bool bSettingsVisible = false;

	// Typing indicator
	bool bTypingIndicatorVisible = false;

	// UI builders
	TSharedRef<SWidget> BuildHeader();
	TSharedRef<SWidget> BuildSettingsPanel();
	TSharedRef<SWidget> BuildStepsSidebar();
	TSharedRef<SWidget> BuildChatArea();
	TSharedRef<SWidget> BuildInputArea();
	TSharedRef<SWidget> BuildActionBar();
	TSharedRef<SWidget> BuildMessageWidget(const FPCGExChatMessage& Message);
	TSharedRef<SWidget> BuildAIMessageBubble(const FPCGExChatMessage& Message);
	TSharedRef<SWidget> BuildUserMessageBubble(const FPCGExChatMessage& Message);
	TSharedRef<SWidget> BuildStepActionButtons(int32 StepIndex);

	// Actions
	FReply OnSendMessage();
	FReply OnApproveStep();
	FReply OnRedoStep();
	FReply OnPreviewGraph();
	FReply OnCreateInUE();
	FReply OnTestIt();
	FReply OnStartServer();
	FReply OnToggleSettings();
	FReply OnSaveSettings();

	// State queries
	FText GetStepProgressText() const;
	EVisibility GetActionBarVisibility() const;
	EVisibility GetServerPromptVisibility() const;
	EVisibility GetSettingsPanelVisibility() const;
	bool CanSendMessage() const;

	// Chat management
	void AddAIMessage(const FString& Text, TSharedPtr<FJsonObject> Graph = nullptr, bool bShowActions = false);
	void AddUserMessage(const FString& Text);
	void ScrollToBottom();
	void SendToMCP(const FString& UserMessage);
	void OnClaudeResponse(bool bSuccess, const FString& ResponseText);
	void OnMCPResponse(bool bSuccess, const FString& ResponseText, TSharedPtr<FJsonObject> Graph);
	void AddTypingIndicator();
	void RemoveTypingIndicator();
	void RebuildChatUI();
	void RebuildSidebar();

	// Step flow
	void InitializeSession(const FString& Goal);
	void AdvanceToNextStep();
	void RedoCurrentStep();

	// Sidebar ref for live updates
	TSharedPtr<SVerticalBox> StepListBox;
};
