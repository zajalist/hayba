#pragma once
#include "CoreMinimal.h"
#include "HaybaMCPAdvisoryTypes.h"
#include "Widgets/SCompoundWidget.h"
#include "Input/Reply.h"
#include "Containers/Ticker.h"

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
    // Stops a pending Hayba Pro sign-in poll so the ticker cannot outlive the panel.
    virtual ~SHaybaMCPSettingsPanel() override;

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

    // Optional response-guidance level. Strongly typed so adding a future
    // level cannot silently map to the wrong display label.
    TArray<TSharedPtr<EHaybaMCPAdvisoryVerbosity>> AdvisoryVerbosityOptions;
    TSharedPtr<EHaybaMCPAdvisoryVerbosity> SelectedAdvisoryVerbosity;
    TSharedPtr<SComboBox<TSharedPtr<EHaybaMCPAdvisoryVerbosity>>> AdvisoryVerbosityCombo;

    void OnProviderChanged(TSharedPtr<FString> NewId, ESelectInfo::Type);
    void ApplyProviderDefaults(const FHaybaProviderInfo* Info, bool bOverwriteUrlModel);
    void RefreshKeyStatus();
    void OnAdvisoryVerbosityChanged(TSharedPtr<EHaybaMCPAdvisoryVerbosity> NewValue, ESelectInfo::Type);
    static FText AdvisoryVerbosityLabel(EHaybaMCPAdvisoryVerbosity Value);

    // ── Hayba Pro (hosted brain) ────────────────────────────────────────────
    // Sign-in is a device-code flow proxied by the chat sidecar's /brain/* routes.
    // The refresh token goes straight into the DPAPI vault under "hayba-brain".
    TArray<TSharedPtr<FString>>                BrainLlmModeOptions;  // "subscription" / "byok"
    TSharedPtr<FString>                        SelectedBrainLlmMode;
    TSharedPtr<SComboBox<TSharedPtr<FString>>> BrainLlmModeCombo;
    TSharedPtr<STextBlock>                     BrainStatusText;      // "Signed in as ..." / sign-in progress
    FTSTicker::FDelegateHandle                 BrainPollTicker;
    FString                                    BrainDeviceCode;
    double                                     BrainSignInDeadline = 0.0; // FPlatformTime::Seconds()
    bool                                       bBrainSignInStarting = false;
    bool                                       bBrainPollInFlight = false;

    void   RefreshBrainStatus();
    FReply OnBrainSignIn();
    FReply OnBrainSignOut();
    bool   TickBrainSignInPoll(float DeltaTime);
    void   StopBrainSignInPoll();

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
