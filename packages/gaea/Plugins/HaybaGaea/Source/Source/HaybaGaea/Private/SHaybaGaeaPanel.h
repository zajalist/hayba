#pragma once
#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"
#include "HaybaGaeaSettings.h"

class FHaybaGaeaModule;
class SScrollBox;
class SMultiLineEditableTextBox;
class SEditableTextBox;
class SWidgetSwitcher;

// Which top-level screen the panel is showing
enum class EHaybaScreen : uint8
{
	Wizard,        // First-launch paged wizard
	ModeSelect,    // Per-launch mode selection
	MCPStatus,     // Mode A — connection status + activity log
	ApiKeyPrompt,  // Mode B — terrain prompt + API key
};

class SHaybaGaeaPanel : public SCompoundWidget
{
public:
	SLATE_BEGIN_ARGS(SHaybaGaeaPanel) {}
	SLATE_END_ARGS()

	void Construct(const FArguments& InArgs, FHaybaGaeaModule* InModule);

private:
	FHaybaGaeaModule* Module = nullptr;

	// ---- Screen routing ----
	EHaybaScreen CurrentScreen = EHaybaScreen::Wizard;
	int32 WizardPage = 0; // 0=Welcome 1=ModeSelect 2=Setup
	EHaybaOperationMode ChosenMode = EHaybaOperationMode::Integrated;
	TSharedPtr<SWidgetSwitcher> ScreenSwitcher;

	void ShowScreen(EHaybaScreen Screen);
	void RebuildContent();

	// ---- Top-level screen builders ----
	TSharedRef<SWidget> BuildWizardScreen();
	TSharedRef<SWidget> BuildModeSelectScreen();
	TSharedRef<SWidget> BuildMCPStatusScreen();
	TSharedRef<SWidget> BuildApiKeyPromptScreen();

	// ---- Wizard pages ----
	TSharedRef<SWidget> BuildWizardPage0_Welcome();
	TSharedRef<SWidget> BuildWizardPage1_ModeChoice();
	TSharedRef<SWidget> BuildWizardPage2a_Integrated();
	TSharedRef<SWidget> BuildWizardPage2b_ApiKey();
	TSharedRef<SWidget> BuildModeCard(const FText& Title, const FText& Desc, EHaybaOperationMode Mode);
	TSharedRef<SWidget> BuildSetupButton(const FText& Label, FReply (SHaybaGaeaPanel::*Handler)());

	// ---- Shared header ----
	TSharedRef<SWidget> BuildHeader(const FText& Title);

	// ---- MCP Status screen state ----
	TSharedPtr<SScrollBox> ActivityLog;
	void AddActivity(const FString& Text);

	// ---- API Key / Prompt screen state ----
	bool bGenerating = false;
	TSharedPtr<SScrollBox> LogBox;
	TSharedPtr<SMultiLineEditableTextBox> PromptBox;
	TSharedPtr<SEditableTextBox> OutputFolderBox;
	TSharedPtr<SEditableTextBox> ApiKeyBox;

	FReply OnGenerate();
	void AddLog(const FString& Text, bool bError = false);
	bool CanGenerate() const;

	// ---- Wizard navigation ----
	FReply OnWizardNext();
	FReply OnWizardBack();
	FReply OnWizardFinish();
	FReply OnSetupButton() { ShowScreen(EHaybaScreen::ModeSelect); return FReply::Handled(); }
	FReply OnSelectIntegrated();
	FReply OnSelectApiKey();

	// ---- Copy helpers ----
	FReply OnCopyText(FString Text);
	FString ResolveMCPServerPath() const;
};
