#pragma once
#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"
#include "Input/Reply.h"

class SEditableTextBox;
class SHaybaMCPMainPanel;

class SHaybaMCPSettingsPanel : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SHaybaMCPSettingsPanel) {}
        SLATE_ARGUMENT(SHaybaMCPMainPanel*, MainPanel)
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs);

private:
    SHaybaMCPMainPanel* MainPanel = nullptr;

    // Inputs we keep references to so we can read user edits.
    TSharedPtr<SEditableTextBox> CapTokenBox;
    TSharedPtr<SEditableTextBox> SidecarUrlBox;
    TSharedPtr<SEditableTextBox> LlmModelBox;
    TSharedPtr<SEditableTextBox> LlmBaseUrlBox;
    TSharedPtr<SEditableTextBox> LlmApiKeyBox;
    TSharedPtr<SEditableTextBox> RateLimitBox;
    TSharedPtr<SEditableTextBox> CacheTtlBox;

    // Dirty tracking — Save button only enables when something has changed.
    bool bIsDirty = false;
    void MarkDirty();

    TSharedRef<class SWidget> BuildSection(const FText& Heading, const FText& Tooltip, const TSharedRef<SWidget>& Body);
    TSharedRef<class SWidget> BuildLabeledRow(const FText& Label, const FText& Tooltip, const TSharedRef<SWidget>& Right);
    TSharedRef<class SWidget> BuildToggle(const FText& Label, const FText& Tooltip,
                                          TFunction<bool()> Get, TFunction<void(bool)> Set);

    FReply OnSave();
    FReply OnRedoSetup();
};
