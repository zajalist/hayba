// Plugins/Hayba_PcgEx_MCP/Source/Hayba_PcgEx_MCP/Private/PCGExWizardWidget.h
#pragma once

#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/Input/SMultiLineEditableTextBox.h"
#include "PCGExWizardState.h"
#include "PCGExBridgeSettings.h"

class FPCGExBridgeModule;
class SScrollBox;
class SEditableTextBox;
class SBox;
class SVerticalBox;

enum class EPCGExScreen : uint8
{
	Wizard,
	ModeSelect,
	MCPStatus,
	ChatUI,
};

class SPCGExWizardWidget : public SCompoundWidget
{
public:
	SLATE_BEGIN_ARGS(SPCGExWizardWidget) {}
	SLATE_END_ARGS()

	void Construct(const FArguments& InArgs, FPCGExBridgeModule* InModule);
	virtual void Tick(const FGeometry& AllottedGeometry, double InCurrentTime, float InDeltaTime) override;

private:
	FPCGExBridgeModule* Module = nullptr;

	// ---- Screen routing ----
	EPCGExScreen CurrentScreen = EPCGExScreen::Wizard;
	int32 WizardPage = 0;
	EPCGExOperationMode ChosenMode = EPCGExOperationMode::Integrated;
	TSharedPtr<SBox> ScreenSwitcher;

	void ShowScreen(EPCGExScreen Screen);
	void RebuildContent();

	// ---- Screen builders ----
	TSharedRef<SWidget> BuildWizardScreen();
	TSharedRef<SWidget> BuildModeSelectScreen();
	TSharedRef<SWidget> BuildMCPStatusScreen();
	TSharedRef<SWidget> BuildChatScreen();

	// ---- Wizard pages ----
	TSharedRef<SWidget> BuildWizardPage0_Welcome();
	TSharedRef<SWidget> BuildWizardPage1_ModeChoice();
	TSharedRef<SWidget> BuildWizardPage2a_Integrated();
	TSharedRef<SWidget> BuildWizardPage2b_ApiKey();
	TSharedRef<SWidget> BuildModeCard(const FText& Title, const FText& Desc, EPCGExOperationMode Mode);

	// ---- Shared header ----
	TSharedRef<SWidget> BuildHeader(const FText& Title);

	// ---- MCP Status ----
	TSharedPtr<SScrollBox> ActivityLog;
	void AddActivity(const FString& Text);

	// ---- Chat UI ----
	FPCGExWizardSession Session;
	TSharedPtr<SScrollBox> ChatScrollBox;
	TSharedPtr<SMultiLineEditableTextBox> InputBox;
	TSharedPtr<SEditableTextBox> ApiKeyBox;
	TSharedPtr<SEditableTextBox> BaseUrlBox;
	TSharedPtr<SEditableTextBox> ModelBox;
	TSharedPtr<SEditableTextBox> OutputPathBox;
	bool bSettingsVisible = false;
	bool bTypingIndicatorVisible = false;

	TSharedRef<SWidget> BuildSettingsPanel();
	TSharedRef<SWidget> BuildChatArea();
	TSharedRef<SWidget> BuildInputArea();
	TSharedRef<SWidget> BuildMessageWidget(const FPCGExChatMessage& Message);
	TSharedRef<SWidget> BuildStepsSidebar();
	TSharedRef<SWidget> BuildStepActionButtons(int32 StepIndex);
	TSharedRef<SWidget> BuildActionBar();

	FReply OnSendMessage();
	FReply OnApproveStep();
	FReply OnRedoStep();
	FReply OnPreviewGraph();
	FReply OnCreateInUE();
	FReply OnTestIt();
	FReply OnStartServer();
	FReply OnToggleSettings();
	FReply OnSaveSettings();

	FText GetStepProgressText() const;
	EVisibility GetActionBarVisibility() const;
	EVisibility GetServerPromptVisibility() const;
	EVisibility GetSettingsPanelVisibility() const;
	bool CanSendMessage() const;

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
	void InitializeSession(const FString& Goal);
	void AdvanceToNextStep();
	void RedoCurrentStep();

	TSharedPtr<SVerticalBox> StepListBox;

	// ---- Wizard nav ----
	FReply OnWizardNext();
	FReply OnWizardBack();
	FReply OnWizardFinish();
	FReply OnSetupButton() { ShowScreen(EPCGExScreen::ModeSelect); return FReply::Handled(); }
	FReply OnSelectIntegrated();
	FReply OnSelectApiKey();
	FReply OnCopyText(FString Text);
	FString ResolveMCPServerPath() const;
};
