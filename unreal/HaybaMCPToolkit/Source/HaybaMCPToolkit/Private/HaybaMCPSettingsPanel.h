#pragma once
#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"
#include "Input/Reply.h"

class SEditableTextBox;
class STextBlock;
class SHaybaMCPMainPanel;
struct FHaybaProviderInfo;
template <typename T> class SComboBox;

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

    // ── BYOK provider dropdown ──────────────────────────────────────────────
    // Options are pointers into the static catalog (FHaybaMCPSettings::GetProviderCatalog()).
    TArray<TSharedPtr<FString>>              ProviderOptions;   // provider ids, for the combo
    TSharedPtr<FString>                      SelectedProvider;  // current combo selection
    TSharedPtr<SComboBox<TSharedPtr<FString>>> ProviderCombo;
    TSharedPtr<STextBlock>                   KeyStatusText;     // "Stored: ••••1234" / keyless badge
    // Whether the user typed a new key this session (only then do we write the vault).
    bool bKeyEdited = false;

    void OnProviderChanged(TSharedPtr<FString> NewId, ESelectInfo::Type);
    void ApplyProviderDefaults(const FHaybaProviderInfo* Info, bool bOverwriteUrlModel);
    void RefreshKeyStatus();

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
