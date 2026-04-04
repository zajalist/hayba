#pragma once
#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"

class FHaybaGaeaModule;
class SScrollBox;
class SMultiLineEditableTextBox;
class SEditableTextBox;

class SHaybaGaeaPanel : public SCompoundWidget
{
public:
	SLATE_BEGIN_ARGS(SHaybaGaeaPanel) {}
	SLATE_END_ARGS()

	void Construct(const FArguments& InArgs, FHaybaGaeaModule* InModule);

private:
	FHaybaGaeaModule* Module = nullptr;
	bool bGenerating = false;

	TSharedPtr<SScrollBox> LogBox;
	TSharedPtr<SMultiLineEditableTextBox> PromptBox;
	TSharedPtr<SEditableTextBox> OutputFolderBox;

	TSharedRef<SWidget> BuildTopBar();
	TSharedRef<SWidget> BuildSettingsRow();
	TSharedRef<SWidget> BuildPromptArea();
	TSharedRef<SWidget> BuildLog();

	FReply OnGenerate();
	void AddLog(const FString& Text, bool bError = false);
	bool CanGenerate() const;
};
