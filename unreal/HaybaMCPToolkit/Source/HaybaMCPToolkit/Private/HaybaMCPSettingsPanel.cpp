#include "HaybaMCPSettingsPanel.h"
#include "HaybaMCPMainPanel.h"
#include "HaybaMCPSettings.h"
#include "HaybaMCPDeveloperSettings.h"
#include "HaybaMCPStyle.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SScrollBox.h"
#include "Widgets/Layout/SSeparator.h"
#include "Widgets/SOverlay.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Images/SImage.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SCheckBox.h"
#include "Widgets/Input/SEditableTextBox.h"
#include "Widgets/Input/SComboBox.h"
#include "Widgets/Input/SComboButton.h"
#include "Framework/Application/SlateApplication.h"
#include "Styling/AppStyle.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "Json.h"
#include "HAL/PlatformProcess.h"
#include "HAL/PlatformTime.h"

namespace
{
    // DPAPI vault id for the Hayba Pro refresh token (never shown, never logged).
    const TCHAR* const BrainVaultId = TEXT("hayba-brain");

    FText ProviderLabel(const TSharedPtr<FString>& Id)
    {
        const FHaybaProviderInfo* Info = Id.IsValid() ? FHaybaMCPSettings::FindProvider(*Id) : nullptr;
        return FText::FromString(Info ? FString(Info->Label) : (Id.IsValid() ? *Id : FString()));
    }

    FText BrainLlmModeLabel(const TSharedPtr<FString>& Mode)
    {
        return (Mode.IsValid() && *Mode == TEXT("byok"))
            ? NSLOCTEXT("Hayba", "S.Pro.Llm.Byok", "Your provider key")
            : NSLOCTEXT("Hayba", "S.Pro.Llm.Subscription", "Hayba models");
    }

    FText LeaseModeLabel(EHaybaMCPLeaseEnforcement Mode)
    {
        switch (Mode)
        {
        case EHaybaMCPLeaseEnforcement::Off: return NSLOCTEXT("Hayba", "S.Lease.Off", "Ignore conflicts");
        case EHaybaMCPLeaseEnforcement::Advisory: return NSLOCTEXT("Hayba", "S.Lease.Advisory", "Warn about conflicts");
        case EHaybaMCPLeaseEnforcement::Enforced: return NSLOCTEXT("Hayba", "S.Lease.Enforced", "Block conflicts for edits and reads");
        case EHaybaMCPLeaseEnforcement::EnforcedForWrites:
        default: return NSLOCTEXT("Hayba", "S.Lease.Writes", "Block conflicting edits");
        }
    }

    FText LeaseModeDetail(EHaybaMCPLeaseEnforcement Mode)
    {
        switch (Mode)
        {
        case EHaybaMCPLeaseEnforcement::Off:
            return NSLOCTEXT("Hayba", "S.Lease.Off.Detail", "Edits and reads continue without conflict checks.");
        case EHaybaMCPLeaseEnforcement::Advisory:
            return NSLOCTEXT("Hayba", "S.Lease.Advisory.Detail", "Edits and reads continue; conflicts show warnings.");
        case EHaybaMCPLeaseEnforcement::Enforced:
            return NSLOCTEXT("Hayba", "S.Lease.Enforced.Detail", "Block conflicting edits and reads after a lease expires.");
        case EHaybaMCPLeaseEnforcement::EnforcedForWrites:
        default:
            return NSLOCTEXT("Hayba", "S.Lease.Writes.Detail", "Block conflicting edits; allow reads.");
        }
    }

    FString BrainJsonToString(const TSharedRef<FJsonObject>& Root)
    {
        FString Out;
        TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Out);
        FJsonSerializer::Serialize(Root, Writer);
        return Out;
    }

    /** POST a JSON body to a loopback sidecar /brain/* route. Host comes from SidecarURL as-is. */
    TSharedRef<IHttpRequest, ESPMode::ThreadSafe> MakeBrainPost(const FString& Route, const TSharedRef<FJsonObject>& Body)
    {
        TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
        Request->SetURL(FHaybaMCPSettings::Get().SidecarURL / Route);
        Request->SetVerb(TEXT("POST"));
        Request->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
        Request->SetContentAsString(BrainJsonToString(Body));
        return Request;
    }
}

SHaybaMCPSettingsPanel::~SHaybaMCPSettingsPanel()
{
    if (ModelDiscoveryClient.IsValid()) ModelDiscoveryClient->Cancel();
    StopBrainSignInPoll();
}

void SHaybaMCPSettingsPanel::Construct(const FArguments& InArgs)
{
    MainPanel = InArgs._MainPanel;
    auto& S = FHaybaMCPSettings::Get();
    ModelDiscoveryClient = MakeShared<FHaybaMCPModelDiscoveryClient>();

    // OnTextChanged fires on every keystroke — that's the right granularity for
    // "the user has touched the form, surface a Save button".
    auto OnDirty = [this](const FText&){ MarkDirty(); };

    SAssignNew(CapTokenBox,    SEditableTextBox)
        .Style(&FHaybaMCPStyle::Get().GetWidgetStyle<FEditableTextBoxStyle>("Hayba.Input.Settings"))
        .Text(FText::FromString(S.CapabilityToken)).IsPassword(true)
        .OnTextChanged_Lambda(OnDirty);
    SAssignNew(SidecarUrlBox,  SEditableTextBox)
        .Style(&FHaybaMCPStyle::Get().GetWidgetStyle<FEditableTextBoxStyle>("Hayba.Input.Settings"))
        .Text(FText::FromString(S.SidecarURL))
        .OnTextChanged_Lambda(OnDirty);
    SAssignNew(LlmModelBox,    SEditableTextBox)
        .Style(&FHaybaMCPStyle::Get().GetWidgetStyle<FEditableTextBoxStyle>("Hayba.Input.Settings"))
        .Text(FText::FromString(S.Model))
        .HintText(NSLOCTEXT("Hayba", "S.Model.ExactIdHint", "Exact model ID"))
        .OnTextChanged_Lambda([this](const FText&){ if (!bApplyingProviderDefaults) bModelEdited = true; MarkDirty(); });
    SAssignNew(LlmBaseUrlBox,  SEditableTextBox)
        .Style(&FHaybaMCPStyle::Get().GetWidgetStyle<FEditableTextBoxStyle>("Hayba.Input.Settings"))
        .Text(FText::FromString(S.BaseURL))
        .OnTextChanged_Lambda([this](const FText&){ if (!bApplyingProviderDefaults) bUrlEdited = true; MarkDirty(); });
    // Key box starts EMPTY — we never populate it with the stored secret. The
    // last-4 status label (RefreshKeyStatus) is the only readback. Typing here
    // marks the key as edited so OnSave writes the new value through the vault.
    SAssignNew(LlmApiKeyBox,   SEditableTextBox)
        .Style(&FHaybaMCPStyle::Get().GetWidgetStyle<FEditableTextBoxStyle>("Hayba.Input.Settings"))
        .IsPassword(true)
        .HintText(NSLOCTEXT("Hayba", "S.Backend.KeyHint", "enter to replace stored key"))
        .OnTextChanged_Lambda([this](const FText&)
        {
            bKeyEdited = true;
            bKeyDiscardedOnProviderChange = false;
            MarkDirty();
            RefreshKeyStatus();
        });

    // Provider dropdown — options mirror the catalog (providers.ts).
    ProviderOptions.Reset();
    for (const FHaybaProviderInfo& P : FHaybaMCPSettings::GetProviderCatalog())
    {
        TSharedPtr<FString> Opt = MakeShared<FString>(FString(P.Id));
        ProviderOptions.Add(Opt);
        if (S.SelectedProviderId.Equals(P.Id, ESearchCase::IgnoreCase))
            SelectedProvider = Opt;
    }
    if (!SelectedProvider.IsValid() && ProviderOptions.Num() > 0)
        SelectedProvider = ProviderOptions[0];

    SAssignNew(ProviderCombo, SComboButton)
        .ButtonStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FButtonStyle>("Hayba.Button.Switcher"))
        .HasDownArrow(false)
        .ContentPadding(FMargin(10.f, 6.f))
        .OnGetMenuContent(this, &SHaybaMCPSettingsPanel::BuildProviderMenu)
        .ButtonContent()
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().FillWidth(1.f)
            [ SNew(STextBlock).Text_Lambda([this]() { return ProviderLabel(SelectedProvider); }) ]
            + SHorizontalBox::Slot().AutoWidth().Padding(10.f, 0.f, 0.f, 0.f)
            [ SNew(SImage).Image(FHaybaMCPStyle::GetBrush("Hayba.Icon.Chevron.Down"))
                .ColorAndOpacity(FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Text.Secondary"))) ]
        ];

    SAssignNew(ModelCombo, SComboButton)
        .ButtonStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FButtonStyle>("Hayba.Button.Switcher"))
        .HasDownArrow(false)
        .ContentPadding(FMargin(10.f, 6.f))
        .ToolTipText_Lambda([this]() { return LlmModelBox.IsValid() ? LlmModelBox->GetText() : FText::GetEmpty(); })
        .OnGetMenuContent(this, &SHaybaMCPSettingsPanel::BuildModelMenu)
        .ButtonContent()
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center)
            [ SNew(STextBlock)
                .TextStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FTextBlockStyle>("Hayba.Text.Body"))
                .OverflowPolicy(ETextOverflowPolicy::Ellipsis)
                .Text_Lambda([this]()
                {
                    return LlmModelBox.IsValid() && !LlmModelBox->GetText().IsEmpty()
                        ? LlmModelBox->GetText()
                        : NSLOCTEXT("Hayba", "S.Model.Choose", "Choose a model");
                }) ]
            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(10.f, 0.f, 0.f, 0.f)
            [ SNew(SImage).Image(FHaybaMCPStyle::GetBrush("Hayba.Icon.Chevron.Down"))
                .ColorAndOpacity(FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Text.Secondary"))) ]
        ];

    SAssignNew(KeyStatusText, STextBlock)
        .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("SmallText"))
        .AutoWrapText(true);
    SAssignNew(RateLimitBox,   SEditableTextBox)
        .Style(&FHaybaMCPStyle::Get().GetWidgetStyle<FEditableTextBoxStyle>("Hayba.Input.Settings"))
        .Text(FText::AsNumber(S.RateLimitPerMinute))
        .OnTextChanged_Lambda(OnDirty);
    SAssignNew(CacheTtlBox,    SEditableTextBox)
        .Style(&FHaybaMCPStyle::Get().GetWidgetStyle<FEditableTextBoxStyle>("Hayba.Input.Settings"))
        .Text(FText::AsNumber(S.ToolCacheTTLSeconds))
        .OnTextChanged_Lambda(OnDirty);

    AdvisoryVerbosityOptions = {
        MakeShared<EHaybaMCPAdvisoryVerbosity>(EHaybaMCPAdvisoryVerbosity::ErrorsOnly),
        MakeShared<EHaybaMCPAdvisoryVerbosity>(EHaybaMCPAdvisoryVerbosity::ErrorsAndWarnings),
        MakeShared<EHaybaMCPAdvisoryVerbosity>(EHaybaMCPAdvisoryVerbosity::ErrorsWarningsAndTips),
    };
    for (const TSharedPtr<EHaybaMCPAdvisoryVerbosity>& Option : AdvisoryVerbosityOptions)
    {
        if (Option.IsValid() && *Option == S.AdvisoryVerbosity)
        {
            SelectedAdvisoryVerbosity = Option;
            break;
        }
    }
    if (!SelectedAdvisoryVerbosity.IsValid())
    {
        SelectedAdvisoryVerbosity = AdvisoryVerbosityOptions[1];
    }
    SAssignNew(AdvisoryVerbosityCombo, SComboButton)
        .ButtonStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FButtonStyle>("Hayba.Button.Switcher"))
        .HasDownArrow(false)
        .ContentPadding(FMargin(10.f, 6.f))
        .OnGetMenuContent(this, &SHaybaMCPSettingsPanel::BuildAdvisoryVerbosityMenu)
        .ButtonContent()
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().FillWidth(1.f)
            [
                SNew(STextBlock).Text_Lambda([this]()
                {
                    return SelectedAdvisoryVerbosity.IsValid()
                        ? AdvisoryVerbosityLabel(*SelectedAdvisoryVerbosity) : FText::GetEmpty();
                })
            ]
            + SHorizontalBox::Slot().AutoWidth().Padding(10.f, 0.f, 0.f, 0.f)
            [ SNew(SImage).Image(FHaybaMCPStyle::GetBrush("Hayba.Icon.Chevron.Down"))
                .ColorAndOpacity(FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Text.Secondary"))) ]
        ];

    // Hayba Pro model source: "subscription" (Hayba-provided) or "byok".
    BrainLlmModeOptions = { MakeShared<FString>(TEXT("subscription")), MakeShared<FString>(TEXT("byok")) };
    SelectedBrainLlmMode = S.BrainLlmMode == TEXT("byok") ? BrainLlmModeOptions[1] : BrainLlmModeOptions[0];
    SAssignNew(BrainLlmModeCombo, SComboButton)
        .ButtonStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FButtonStyle>("Hayba.Button.Switcher"))
        .HasDownArrow(false)
        .ContentPadding(FMargin(10.f, 6.f))
        .OnGetMenuContent(this, &SHaybaMCPSettingsPanel::BuildBrainLlmModeMenu)
        .ButtonContent()
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().FillWidth(1.f)
            [ SNew(STextBlock).Text_Lambda([this]() { return BrainLlmModeLabel(SelectedBrainLlmMode); }) ]
            + SHorizontalBox::Slot().AutoWidth().Padding(10.f, 0.f, 0.f, 0.f)
            [ SNew(SImage).Image(FHaybaMCPStyle::GetBrush("Hayba.Icon.Chevron.Down"))
                .ColorAndOpacity(FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Text.Secondary"))) ]
        ];
    SAssignNew(LeaseEnforcementCombo, SComboButton)
        .ButtonStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FButtonStyle>("Hayba.Button.Switcher"))
        .HasDownArrow(false)
        .ContentPadding(FMargin(10.f, 6.f))
        .OnGetMenuContent(this, &SHaybaMCPSettingsPanel::BuildLeaseEnforcementMenu)
        .ButtonContent()
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().FillWidth(1.f)
            [
                SNew(STextBlock).Text_Lambda([]()
                {
                    const UHaybaMCPDeveloperSettings* Dev = GetDefault<UHaybaMCPDeveloperSettings>();
                    return LeaseModeLabel(Dev ? Dev->LeaseEnforcement : EHaybaMCPLeaseEnforcement::EnforcedForWrites);
                })
            ]
            + SHorizontalBox::Slot().AutoWidth().Padding(10.f, 0.f, 0.f, 0.f)
            [ SNew(SImage).Image(FHaybaMCPStyle::GetBrush("Hayba.Icon.Chevron.Down"))
                .ColorAndOpacity(FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Text.Secondary"))) ]
        ];
    SAssignNew(BrainStatusText, STextBlock)
        .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("SmallText"))
        .AutoWrapText(true);

    ChildSlot
    [
        SNew(SBorder)
        .BorderImage(FHaybaMCPStyle::GetBrush("Hayba.Brush.Dock"))
        .Padding(FMargin(0))
        [
            SNew(SOverlay)
            + SOverlay::Slot()
            [
                SNew(SScrollBox)
                + SScrollBox::Slot().HAlign(HAlign_Center).Padding(FMargin(12.f, 10.f, 12.f, 70.f))
                [
                    // SBox's max desired width only caps a child's natural width;
                    // it does not expand the narrow form in a wide dock.
                    SNew(SBox).WidthOverride_Lambda([this]()
                    {
                        const float DockWidth = GetCachedGeometry().GetLocalSize().X;
                        return FOptionalSize(DockWidth > 0.f
                            ? FMath::Min(600.f, FMath::Max(0.f, DockWidth - 36.f))
                            : 600.f);
                    })
                    [ SNew(SVerticalBox)
                    + SVerticalBox::Slot().AutoHeight().Padding(0.f, 0.f, 0.f, 8.f)
                    [
                        BuildSection(
                            NSLOCTEXT("Hayba", "Settings.Sec.LLM", "Chat model"),
                            NSLOCTEXT("Hayba", "Settings.Sec.LLM.TT",
                                "Provider, model, and key for Hayba's built-in chat. External MCP hosts use their own model settings."),
                            SNew(SVerticalBox)
                            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 2.f)
                            [ BuildLabeledRow(
                                NSLOCTEXT("Hayba", "S.Backend.Provider", "Provider"),
                                NSLOCTEXT("Hayba", "S.Backend.Provider.TT",
                                    "Pick your LLM provider. Selecting one fills the Base URL and "
                                    "default Model unless you have edited those fields. Local providers "
                                    "(Ollama, LM Studio) and Mock need no API key."),
                                ProviderCombo.ToSharedRef()) ]
                            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 2.f)
                            [ BuildLabeledRow(
                                NSLOCTEXT("Hayba", "S.Backend.Key",  "API Key"),
                                NSLOCTEXT("Hayba", "S.Backend.Key.TT",
                                    "Stored encrypted at rest via Windows DPAPI (per-user, per-machine); "
                                    "never written to disk in plaintext and never shown here in full. "
                                    "Leave blank to keep the existing key; type to replace it."),
                                LlmApiKeyBox.ToSharedRef()) ]
                            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 2.f)
                            [ BuildLabeledRow(
                                FText::GetEmpty(),
                                FText::GetEmpty(),
                                KeyStatusText.ToSharedRef()) ]
                            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 2.f)
                            [
                                SNew(STextBlock)
                                .AutoWrapText(true)
                                .Text_Lambda([this]()
                                {
                                    return FText::Format(
                                        NSLOCTEXT("Hayba", "S.Key.ProviderChanged",
                                            "Unsaved key entry for {0} was cleared. Its stored key was not changed."),
                                        FText::FromString(DiscardedKeyProviderLabel));
                                })
                                .ColorAndOpacity(FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Status.Warn")))
                                .Visibility_Lambda([this]()
                                {
                                    return bKeyDiscardedOnProviderChange ? EVisibility::Visible : EVisibility::Collapsed;
                                })
                            ]
                            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 2.f)
                            [
                                SNew(SVerticalBox)
                                + SVerticalBox::Slot().AutoHeight()
                                [ BuildLabeledRow(
                                    NSLOCTEXT("Hayba", "S.Backend.Model", "Model"),
                                    NSLOCTEXT("Hayba", "S.Backend.Model.TT", "Select an available model or enter an exact model ID."),
                                    ModelCombo.ToSharedRef()) ]
                                + SVerticalBox::Slot().AutoHeight().Padding(0.f, 0.f, 0.f, 8.f)
                                [ SNew(SBox)
                                    .Visibility_Lambda([this]() { return bManualModelEntry ? EVisibility::Visible : EVisibility::Collapsed; })
                                    [ LlmModelBox.ToSharedRef() ] ]
                            ]
                        , false)
                    ]

                    + SVerticalBox::Slot().AutoHeight().Padding(0.f, 0.f, 0.f, 8.f)
                    [
                        BuildSection(
                            NSLOCTEXT("Hayba", "Settings.Sec.PlanMode", "Editor safety"),
                            NSLOCTEXT("Hayba", "Settings.Sec.PlanMode.TT",
                                "Require a reviewed plan for external MCP clients before they change the project. "
                                "Review incoming proposals in Agent. Built-in chat keeps its own action approvals "
                                "and Explore / Draft / Production modes."),
                            SNew(SVerticalBox)
                            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 2.f)
                            [ BuildLabeledRow(
                                NSLOCTEXT("Hayba", "S.Lease.Label", "When agents edit the same item"),
                                NSLOCTEXT("Hayba", "S.Lease.TT",
                                    "Lease enforcement controls what happens when agents work on the same resource. "
                                    "Enforced for writes is the default: conflicting writes are blocked, while reads continue. "
                                    "Changes take effect immediately and are saved to Project Settings."),
                                LeaseEnforcementCombo.ToSharedRef()) ]
                            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 2.f, 0.f, 6.f)
                            [
                                SNew(STextBlock)
                                .TextStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FTextBlockStyle>("Hayba.Text.Caption"))
                                .AutoWrapText(true)
                                .Text_Lambda([]()
                                {
                                    const UHaybaMCPDeveloperSettings* Dev = GetDefault<UHaybaMCPDeveloperSettings>();
                                    return LeaseModeDetail(Dev ? Dev->LeaseEnforcement
                                        : EHaybaMCPLeaseEnforcement::EnforcedForWrites);
                                })
                            ]
                            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 2.f)
                            [ BuildToggle(
                                NSLOCTEXT("Hayba", "S.Plan", "Require a plan for changes from other apps"),
                                NSLOCTEXT("Hayba", "S.Plan.TT",
                                    "Applies to the native command gate used by external MCP hosts. "
                                    "Turning this off allows their write commands without this plan review. "
                                    "Built-in chat approvals remain enabled. Default: on."),
                                [](){ return FHaybaMCPSettings::Get().bPlanModeEnabled; },
                                [](bool b){ FHaybaMCPSettings::Get().bPlanModeEnabled = b; }) ]
                        , false)
                    ]

                    + SVerticalBox::Slot().AutoHeight().Padding(0.f, 3.f, 0.f, 8.f)
                    [
                        SNew(SButton)
                        .ButtonStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FButtonStyle>("Hayba.Button.Task"))
                        .ContentPadding(FMargin(0.f, 9.f))
                        .OnClicked_Lambda([this]()
                        {
                            bAdvancedExpanded = !bAdvancedExpanded;
                            Invalidate(EInvalidateWidgetReason::Layout);
                            return FReply::Handled();
                        })
                        [
                            SNew(SHorizontalBox)
                            + SHorizontalBox::Slot().FillWidth(1.f)
                            [ SNew(STextBlock)
                                .TextStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FTextBlockStyle>("Hayba.Text.Heading"))
                                .Text(NSLOCTEXT("Hayba", "Settings.Advanced", "Advanced")) ]
                            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(8.f, 0.f, 2.f, 0.f)
                            [ SNew(SImage)
                                .Image_Lambda([this]() { return FHaybaMCPStyle::GetBrush(
                                    bAdvancedExpanded ? "Hayba.Icon.Chevron.Up" : "Hayba.Icon.Chevron.Down"); })
                                .ColorAndOpacity(FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Text.Secondary"))) ]
                        ]
                    ]

                    + SVerticalBox::Slot().AutoHeight().Padding(0.f, 0.f, 0.f, 12.f)
                    [
                        SNew(SBox).Visibility_Lambda([this]() { return bAdvancedExpanded ? EVisibility::Visible : EVisibility::Collapsed; })
                        [ SNew(SButton)
                            .ButtonStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FButtonStyle>("Hayba.Button.Switcher"))
                            .Text(NSLOCTEXT("Hayba", "Settings.ToolPermissions", "Tool permissions"))
                            .ContentPadding(FMargin(12.f, 8.f))
                            .OnClicked_Lambda([this]()
                            {
                                if (MainPanel) MainPanel->ShowSection(EHaybaSection::MCP);
                                return FReply::Handled();
                            }) ]
                    ]

                    + SVerticalBox::Slot().AutoHeight().Padding(0.f, 0.f, 0.f, 8.f)
                    [
                        SNew(SBox).Visibility_Lambda([this]() { return bAdvancedExpanded ? EVisibility::Visible : EVisibility::Collapsed; })
                        [ BuildSection(
                            NSLOCTEXT("Hayba", "Settings.Sec.Connection", "Advanced connection"),
                            NSLOCTEXT("Hayba", "Settings.Sec.Connection.TT",
                                "How the MCP server authenticates incoming tool calls and what gets logged."),
                            SNew(SVerticalBox)
                            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 2.f)
                            [ BuildLabeledRow(
                                NSLOCTEXT("Hayba", "S.Backend.Url", "Custom endpoint"),
                                NSLOCTEXT("Hayba", "S.Backend.Url.TT", "Edit only when your provider uses a custom API endpoint."),
                                LlmBaseUrlBox.ToSharedRef()) ]
                            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 2.f)
                            [ BuildLabeledRow(
                                NSLOCTEXT("Hayba", "S.CapToken", "Capability Token"),
                                NSLOCTEXT("Hayba", "S.CapToken.TT",
                                    "Optional shared secret required on every TCP command.\n"
                                    "When set, every incoming command must include matching `auth` — useful when running the editor on a multi-user box or exposing the MCP port beyond localhost.\n\n"
                                    "Leave blank for local-only development.\n\n"
                                    "Default: empty."),
                                CapTokenBox.ToSharedRef()) ]
                            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 2.f)
                            [ BuildToggle(
                                NSLOCTEXT("Hayba", "S.Journal", "Enable execution journal (Saved/hayba-execution.log)"),
                                NSLOCTEXT("Hayba", "S.Journal.TT",
                                    "Append-only log of every tool call: timestamp, command, hashed params, duration, ok/error, and message.\n\n"
                                    "Useful for post-mortem on what the agent did, and for compliance audits. Hashes are SHA-256 so no PII leaks in.\n\n"
                                    "Default: on."),
                                [](){ return FHaybaMCPSettings::Get().bEnableExecutionJournal; },
                                [](bool b){ FHaybaMCPSettings::Get().bEnableExecutionJournal = b; }) ]
                            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 2.f)
                            [ BuildToggle(
                                NSLOCTEXT("Hayba", "S.CodeMode", "Progressive tool discovery"),
                                NSLOCTEXT("Hayba", "S.CodeMode.TT",
                                    "Advertise a small set of discovery tools to external agents. The full catalog remains available on demand. Default: on."),
                                [](){ return FHaybaMCPSettings::Get().bCodeModeEnabled; },
                                [](bool b){ FHaybaMCPSettings::Get().bCodeModeEnabled = b; }) ]
                        ) ]
                    ]

                    + SVerticalBox::Slot().AutoHeight().Padding(0.f, 0.f, 0.f, 8.f)
                    [
                        SNew(SBox).Visibility_Lambda([this]() { return bAdvancedExpanded ? EVisibility::Visible : EVisibility::Collapsed; })
                        [ BuildSection(
                            NSLOCTEXT("Hayba", "Settings.Sec.Pro", "Hayba Pro"),
                            NSLOCTEXT("Hayba", "Settings.Sec.Pro.TT",
                                "Route chats through the hosted Hayba Pro agent instead of the local Community loop.\n\n"
                                "Tools still run here in your editor, behind your own approvals. If Hayba Pro is unavailable, "
                                "a chat can switch to Community with one click."),
                            SNew(SVerticalBox)
                            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 2.f)
                            [ BuildToggle(
                                NSLOCTEXT("Hayba", "S.Pro.Use", "Use Hayba Pro (hosted)"),
                                NSLOCTEXT("Hayba", "S.Pro.Use.TT",
                                    "When on, new chat turns use Hayba Pro. When off, chat uses the local Community loop. Default: off."),
                                [](){ return FHaybaMCPSettings::Get().bUseHaybaPro; },
                                [](bool b){ FHaybaMCPSettings::Get().bUseHaybaPro = b; }) ]
                            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 2.f)
                            [ BuildLabeledRow(
                                NSLOCTEXT("Hayba", "S.Pro.Llm", "Models"),
                                NSLOCTEXT("Hayba", "S.Pro.Llm.TT",
                                    "Subscription uses Hayba-provided models. BYOK uses the provider key configured above."),
                                BrainLlmModeCombo.ToSharedRef()) ]
                            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 2.f)
                            [
                                SNew(STextBlock)
                                .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("SmallText"))
                                .AutoWrapText(true)
                                .ColorAndOpacity(FSlateColor(FLinearColor(0.65f, 0.65f, 0.7f)))
                                .Text(NSLOCTEXT("Hayba", "S.Pro.ByokNote",
                                    "BYOK: your key is sent to Hayba Pro for this session only, held in memory, never stored or logged."))
                            ]
                            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 6.f, 0.f, 2.f)
                            [ BrainStatusText.ToSharedRef() ]
                            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 4.f, 0.f, 2.f)
                            [
                                SNew(SHorizontalBox)
                                + SHorizontalBox::Slot().AutoWidth()
                                [
                                    SNew(SButton)
                                    .Text(NSLOCTEXT("Hayba", "S.Pro.SignIn", "Sign in to Hayba Pro"))
                                    .ContentPadding(FMargin(12.f, 4.f))
                                    .IsEnabled_Lambda([this](){ return !bBrainSignInStarting && !BrainPollTicker.IsValid(); })
                                    .OnClicked(this, &SHaybaMCPSettingsPanel::OnBrainSignIn)
                                ]
                                + SHorizontalBox::Slot().AutoWidth().Padding(8.f, 0.f, 0.f, 0.f)
                                [
                                    SNew(SButton)
                                    .Text(NSLOCTEXT("Hayba", "S.Pro.SignOut", "Sign out"))
                                    .ContentPadding(FMargin(12.f, 4.f))
                                    .IsEnabled_Lambda([](){ return FHaybaMCPSettings::HasProviderKey(BrainVaultId); })
                                    .OnClicked(this, &SHaybaMCPSettingsPanel::OnBrainSignOut)
                                ]
                            ]
                        ) ]
                    ]

                    + SVerticalBox::Slot().AutoHeight().Padding(0.f, 0.f, 0.f, 8.f)
                    [
                        SNew(SBox).Visibility_Lambda([this]() { return bAdvancedExpanded ? EVisibility::Visible : EVisibility::Collapsed; })
                        [ BuildSection(
                            NSLOCTEXT("Hayba", "Settings.Sec.Guidance", "AI Response Guidance"),
                            NSLOCTEXT("Hayba", "Settings.Sec.Guidance.TT",
                                "Choose how much optional guidance Hayba adds to tool replies. Errors and safety-required recovery instructions can never be hidden."),
                            SNew(SVerticalBox)
                            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 2.f)
                            [ BuildLabeledRow(
                                NSLOCTEXT("Hayba", "S.Guidance.Level", "Response detail"),
                                NSLOCTEXT("Hayba", "S.Guidance.Level.TT",
                                    "Errors only — suppress optional warnings and AI tips.\n\n"
                                    "Errors and warnings — include risk, partial-success, and verification warnings, but no coaching tips.\n\n"
                                    "Errors, warnings, and AI tips — include concise next-step guidance.\n\n"
                                    "Errors, session-health failures, and mandatory recovery instructions are always returned."),
                                AdvisoryVerbosityCombo.ToSharedRef()) ]
                        ) ]
                    ]

                    + SVerticalBox::Slot().AutoHeight().Padding(0.f, 0.f, 0.f, 8.f)
                    [
                        SNew(SBox).Visibility_Lambda([this]() { return bAdvancedExpanded ? EVisibility::Visible : EVisibility::Collapsed; })
                        [ BuildSection(
                            NSLOCTEXT("Hayba", "Settings.Sec.Visual", "Visual Sidecar"),
                            NSLOCTEXT("Hayba", "Settings.Sec.Visual.TT",
                                "External Python service (FastAPI + CLIP / SpatialCLIP / OWL-ViT) that the toolkit calls for image embeddings and grounding.\n\n"
                                "Used by deep-check scene validation, moodboard tools, and CLIP-compare. Optional — if the sidecar isn't running, those tools fall back to text-only heuristics."),
                            SNew(SVerticalBox)
                            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 2.f)
                            [ BuildLabeledRow(
                                NSLOCTEXT("Hayba", "S.SidecarUrl", "Sidecar URL"),
                                FText::GetEmpty(),
                                SidecarUrlBox.ToSharedRef()) ]
                            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 2.f)
                            [ BuildToggle(
                                NSLOCTEXT("Hayba", "S.SpatialCLIP",   "Enable SpatialCLIP embeddings"),
                                NSLOCTEXT("Hayba", "S.SpatialCLIP.TT",
                                    "Tile-aware CLIP variant that captures *where* objects are in the frame, not just *what*. Heavier than plain CLIP.\n\n"
                                    "Use for: layout similarity scoring, finding scenes with matching composition.\n\n"
                                    "Requires the sidecar to be started with HAYBA_ENABLE_SPATIAL_CLIP=1."),
                                [](){ return FHaybaMCPSettings::Get().bEnableSpatialCLIP; },
                                [](bool b){ FHaybaMCPSettings::Get().bEnableSpatialCLIP = b; }) ]
                            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 2.f)
                            [ BuildToggle(
                                NSLOCTEXT("Hayba", "S.OWLViT",        "Enable OWL-ViT object grounding"),
                                NSLOCTEXT("Hayba", "S.OWLViT.TT",
                                    "Open-vocabulary detector — given a text query, returns bounding boxes for matching objects in the viewport capture.\n\n"
                                    "Use for: \"find every chair the AI placed\", structural sanity checks, deep_check on scene_validate_physics.\n\n"
                                    "Requires the sidecar to be started with HAYBA_ENABLE_OWL_VIT=1."),
                                [](){ return FHaybaMCPSettings::Get().bEnableOWLViT; },
                                [](bool b){ FHaybaMCPSettings::Get().bEnableOWLViT = b; }) ]
                            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 2.f)
                            [ BuildToggle(
                                NSLOCTEXT("Hayba", "S.Continuous",    "Continuous viewport capture"),
                                NSLOCTEXT("Hayba", "S.Continuous.TT",
                                    "Streams a viewport screenshot to the sidecar every few seconds, even when no tool is actively asking. Lets the agent answer \"what does the scene look like right now?\" without waiting on a capture round-trip.\n\n"
                                    "Cost: ~1-3 MB/s upload to localhost, modest GPU load on the sidecar.\n\n"
                                    "Default: off."),
                                [](){ return FHaybaMCPSettings::Get().bEnableContinuousCapture; },
                                [](bool b){ FHaybaMCPSettings::Get().bEnableContinuousCapture = b; }) ]
                        ) ]
                    ]

                    + SVerticalBox::Slot().AutoHeight().Padding(0.f, 0.f, 0.f, 8.f)
                    [
                        SNew(SBox).Visibility_Lambda([this]() { return bAdvancedExpanded ? EVisibility::Visible : EVisibility::Collapsed; })
                        [ BuildSection(
                            NSLOCTEXT("Hayba", "Settings.Sec.Perf", "Performance"),
                            NSLOCTEXT("Hayba", "Settings.Sec.Perf.TT",
                                "Throughput and caching knobs for the MCP server. Defaults are tuned for solo iterative use; bump these on multi-agent swarm setups."),
                            SNew(SVerticalBox)
                            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 2.f)
                            [ BuildLabeledRow(
                                NSLOCTEXT("Hayba", "S.RateLimit",   "Rate limit (req/min)"),
                                NSLOCTEXT("Hayba", "S.RateLimit.TT",
                                    "Max tool calls per minute before the server starts returning rate-limit errors. Sliding window, per agent.\n\n"
                                    "Protects against runaway loops that would otherwise blow up your API bill or DOS the editor.\n\n"
                                    "Default: 60. Raise to 120-180 for tight feedback loops; lower to 20 if you only want supervised use."),
                                RateLimitBox.ToSharedRef()) ]
                            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 2.f)
                            [ BuildLabeledRow(
                                NSLOCTEXT("Hayba", "S.CacheTTL",    "Tool cache TTL (seconds)"),
                                NSLOCTEXT("Hayba", "S.CacheTTL.TT",
                                    "How long the LRU read-cache keeps results for idempotent tools (actor_list, scene_export, search_node_catalog, etc).\n\n"
                                    "Write tools (spawn / delete / set_property) invalidate the cache automatically.\n\n"
                                    "Default: 2.0s. Increase to 10-30s if your scene is static; set to 0 to disable caching."),
                                CacheTtlBox.ToSharedRef()) ]
                        ) ]
                    ]

                    // ── Danger zone — Redo Setup lives at the very bottom on its own. ─────────
                    + SVerticalBox::Slot().AutoHeight().Padding(0.f, 24.f, 0.f, 0.f)
                    [
                        SNew(SBox).Visibility_Lambda([this]() { return bAdvancedExpanded ? EVisibility::Visible : EVisibility::Collapsed; })
                        [ BuildSection(
                            NSLOCTEXT("Hayba", "Settings.Sec.Redo", "Onboarding"),
                            NSLOCTEXT("Hayba", "Settings.Sec.Redo.TT",
                                "Re-runs the first-time setup wizard. Your saved settings above are kept; this just re-shows the screens that configure the MCP server location."),
                            SNew(SVerticalBox)
                            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 4.f, 0.f, 12.f)
                            [
                                SNew(STextBlock)
                                .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("NormalText"))
                                .AutoWrapText(true)
                                .Text(NSLOCTEXT("Hayba", "Settings.RedoHint",
                                    "Run the first-time setup wizard again. Your settings above are kept; this just re-shows the onboarding screens."))
                            ]
                            + SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Left)
                            [
                                SNew(SButton)
                                .Text(NSLOCTEXT("Hayba", "Settings.RedoSetup", "Redo Setup"))
                                .ContentPadding(FMargin(18.f, 8.f))
                                .OnClicked(this, &SHaybaMCPSettingsPanel::OnRedoSetup)
                            ]
                        ) ]
                    ]
                    ]
                ]
            ]
            + SOverlay::Slot().HAlign(HAlign_Right).VAlign(VAlign_Bottom).Padding(FMargin(12.f))
            [
                SNew(SBorder)
                .BorderImage(FHaybaMCPStyle::GetBrush("Hayba.Brush.Popup"))
                .Visibility_Lambda([this]() { return bIsDirty ? EVisibility::Visible : EVisibility::Collapsed; })
                .Padding(FMargin(10.f, 6.f))
                [
                    SNew(SHorizontalBox)
                    + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(2.f, 0.f, 12.f, 0.f)
                    [ SNew(STextBlock)
                        .TextStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FTextBlockStyle>("Hayba.Text.Caption"))
                        .Text(NSLOCTEXT("Hayba", "Settings.Hint.Dirty", "Unsaved changes")) ]
                    + SHorizontalBox::Slot().AutoWidth()
                    [ SNew(SButton)
                        .ButtonStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FButtonStyle>("Hayba.Button.Switcher"))
                        .Text(NSLOCTEXT("Hayba", "Settings.Save", "Save"))
                        .ContentPadding(FMargin(16.f, 6.f))
                        .OnClicked(this, &SHaybaMCPSettingsPanel::OnSave) ]
                ]
            ]
        ]
    ];

    // Initialize the key box enabled/hint state + status label for the provider
    // restored from settings. Do NOT overwrite the user's saved Base URL / Model
    // on first paint — only the dropdown interaction does that.
    ApplyProviderDefaults(
        SelectedProvider.IsValid() ? FHaybaMCPSettings::FindProvider(*SelectedProvider) : nullptr,
        /*bOverwriteUrlModel=*/false);
    RefreshKeyStatus();
    RefreshBrainStatus();
}

TSharedRef<SWidget> SHaybaMCPSettingsPanel::BuildProviderMenu()
{
    TSharedRef<SVerticalBox> Items = SNew(SVerticalBox);
    for (const TSharedPtr<FString>& Option : ProviderOptions)
    {
        const FHaybaProviderInfo* Info = Option.IsValid() ? FHaybaMCPSettings::FindProvider(*Option) : nullptr;
        Items->AddSlot().AutoHeight()
        [
            FHaybaMCPStyle::PopupRow(ProviderLabel(Option), FOnClicked::CreateLambda([this, Option]()
            {
                if (ProviderCombo.IsValid()) ProviderCombo->SetIsOpen(false);
                OnProviderChanged(Option, ESelectInfo::OnMouseClick);
                return FReply::Handled();
            }), SelectedProvider == Option,
                Info && Info->bNeedsKey
                    ? NSLOCTEXT("Hayba", "S.Provider.NeedsKey", "API key required")
                    : NSLOCTEXT("Hayba", "S.Provider.Keyless", "No API key needed"))
        ];
    }
    return FHaybaMCPStyle::PopupSurface(Items, 240.f);
}

TSharedRef<SWidget> SHaybaMCPSettingsPanel::BuildModelMenu()
{
    ModelSearch.Empty();
    ModelPendingConfirmationId.Empty();
    SAssignNew(ModelMenuItems, SVerticalBox);
    DiscoveredModels.Reset();
    bModelDiscoveryLoading = false;
    ModelDiscoveryMessage = bIsDirty
        ? TEXT("Save your changes to browse this provider's models.")
        : TEXT("Checking available models...");
    RefreshModelMenuItems();

    if (!bIsDirty && ModelDiscoveryClient.IsValid())
    {
        bModelDiscoveryLoading = true;
        TWeakPtr<SHaybaMCPSettingsPanel> WeakSelf = StaticCastSharedRef<SHaybaMCPSettingsPanel>(AsShared());
        ModelDiscoveryClient->DiscoverSavedSettings(/*bRefresh=*/true,
            [WeakSelf](FHaybaMCPModelDiscoveryResult Result)
            {
                TSharedPtr<SHaybaMCPSettingsPanel> Self = WeakSelf.Pin();
                if (!Self.IsValid()) return;
                Self->bModelDiscoveryLoading = false;
                Self->DiscoveredModels = MoveTemp(Result);
                Self->RefreshModelMenuItems();
            });
    }

    return FHaybaMCPStyle::PopupSurface(
        SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight().Padding(4.f, 4.f, 4.f, 8.f)
        [
            SNew(SEditableTextBox)
            .Style(&FHaybaMCPStyle::Get().GetWidgetStyle<FEditableTextBoxStyle>("Hayba.Input.Settings"))
            .HintText(NSLOCTEXT("Hayba", "S.Model.Search", "Search models"))
            .OnTextChanged_Lambda([this](const FText& Text)
            {
                ModelSearch = Text.ToString();
                RefreshModelMenuItems();
            })
        ]
        + SVerticalBox::Slot().AutoHeight()
        [
            SNew(SBox).MaxDesiredHeight(330.f)
            [ SNew(SScrollBox)
                + SScrollBox::Slot()
                [ ModelMenuItems.ToSharedRef() ] ]
        ]
        + SVerticalBox::Slot().AutoHeight().Padding(0.f, 6.f, 0.f, 0.f)
        [
            FHaybaMCPStyle::PopupRow(
                NSLOCTEXT("Hayba", "S.Model.EnterExactId", "Enter exact model ID"),
                FOnClicked::CreateLambda([this]()
                {
                    if (ModelCombo.IsValid()) ModelCombo->SetIsOpen(false);
                    bManualModelEntry = true;
                    Invalidate(EInvalidateWidgetReason::Layout);
                    if (LlmModelBox.IsValid())
                        FSlateApplication::Get().SetKeyboardFocus(LlmModelBox.ToSharedRef(), EFocusCause::SetDirectly);
                    return FReply::Handled();
                }), bManualModelEntry)
        ], 300.f);
}

void SHaybaMCPSettingsPanel::RefreshModelMenuItems()
{
    if (!ModelMenuItems.IsValid()) return;
    ModelMenuItems->ClearChildren();
    auto AddNote = [this](const FText& Note)
    {
        ModelMenuItems->AddSlot().AutoHeight().Padding(8.f, 4.f, 8.f, 8.f)
        [ SNew(STextBlock)
            .TextStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FTextBlockStyle>("Hayba.Text.Caption"))
            .AutoWrapText(true).Text(Note) ];
    };

    if (bIsDirty || bModelDiscoveryLoading || !DiscoveredModels.IsSet())
    {
        AddNote(FText::FromString(ModelDiscoveryMessage));
        return;
    }

    const FHaybaMCPModelDiscoveryResult& Result = DiscoveredModels.GetValue();
    if (!Result.Error.IsEmpty())
    {
        AddNote(FText::FromString(Result.Error));
        return;
    }
    if (Result.Status == EHaybaMCPModelDiscoveryStatus::NoKey)
    {
        AddNote(NSLOCTEXT("Hayba", "S.Model.NoKey", "Add an API key and save to list available models."));
        return;
    }
    if (Result.Status == EHaybaMCPModelDiscoveryStatus::Manual)
    {
        AddNote(NSLOCTEXT("Hayba", "S.Model.Manual", "Enter the exact model ID for this endpoint."));
        return;
    }
    if (Result.bStale || Result.Status == EHaybaMCPModelDiscoveryStatus::Unavailable)
        AddNote(NSLOCTEXT("Hayba", "S.Model.Stale", "Current availability could not be verified. This list may be stale."));
    else if (Result.bPartial)
        AddNote(NSLOCTEXT("Hayba", "S.Model.Partial", "Only part of this provider's model list was verified."));

    int32 Shown = 0;
    int32 Matches = 0;
    for (const FHaybaMCPDiscoveredModel& Model : Result.Models)
    {
        if (!ModelSearch.IsEmpty() && !Model.Id.Contains(ModelSearch, ESearchCase::IgnoreCase) &&
            !Model.Name.Contains(ModelSearch, ESearchCase::IgnoreCase)) continue;
        ++Matches;
        if (Shown++ >= 40) continue;
        const bool bImpossible = Model.ChatCapability == EHaybaMCPModelChatCapability::No ||
            Model.ToolUse == EHaybaMCPModelToolUse::No;
        const bool bVerified = Model.ChatCapability == EHaybaMCPModelChatCapability::Yes &&
            (Model.ToolUse == EHaybaMCPModelToolUse::Yes ||
             Model.ToolUse == EHaybaMCPModelToolUse::Trained);
        FText Detail = Model.Name == Model.Id ? FText::GetEmpty() : FText::FromString(Model.Name);
        if (bImpossible) Detail = NSLOCTEXT("Hayba", "S.Model.NoTools", "Not suitable for Hayba chat tools");
        else if (!bVerified)
            Detail = ModelPendingConfirmationId == Model.Id
                ? NSLOCTEXT("Hayba", "S.Model.Confirm", "Tool support unverified. Select again to use this model.")
                : NSLOCTEXT("Hayba", "S.Model.UnknownTools", "Tool support unverified. Confirmation required.");
        ModelMenuItems->AddSlot().AutoHeight()
        [
            FHaybaMCPStyle::PopupRow(FText::FromString(Model.Id), FOnClicked::CreateLambda([this, Id = Model.Id, bVerified]()
            {
                if (!bVerified && ModelPendingConfirmationId != Id)
                {
                    ModelPendingConfirmationId = Id;
                    RefreshModelMenuItems();
                    return FReply::Handled();
                }
                if (ModelCombo.IsValid()) ModelCombo->SetIsOpen(false);
                bManualModelEntry = false;
                Invalidate(EInvalidateWidgetReason::Layout);
                if (LlmModelBox.IsValid()) LlmModelBox->SetText(FText::FromString(Id));
                return FReply::Handled();
            }), LlmModelBox.IsValid() && LlmModelBox->GetText().ToString() == Model.Id,
                Detail, !bImpossible)
        ];
    }
    if (Matches == 0)
        AddNote(NSLOCTEXT("Hayba", "S.Model.NoMatches", "No matching models. You can enter an exact ID manually."));
    else if (Matches > 40)
        AddNote(NSLOCTEXT("Hayba", "S.Model.More", "More models match. Narrow your search to find one."));
}

TSharedRef<SWidget> SHaybaMCPSettingsPanel::BuildAdvisoryVerbosityMenu()
{
    TSharedRef<SVerticalBox> Items = SNew(SVerticalBox);
    for (const TSharedPtr<EHaybaMCPAdvisoryVerbosity>& Option : AdvisoryVerbosityOptions)
    {
        if (!Option.IsValid()) continue;
        Items->AddSlot().AutoHeight()
        [
            FHaybaMCPStyle::PopupRow(AdvisoryVerbosityLabel(*Option), FOnClicked::CreateLambda([this, Option]()
            {
                if (AdvisoryVerbosityCombo.IsValid()) AdvisoryVerbosityCombo->SetIsOpen(false);
                OnAdvisoryVerbosityChanged(Option, ESelectInfo::OnMouseClick);
                return FReply::Handled();
            }), SelectedAdvisoryVerbosity == Option)
        ];
    }
    return FHaybaMCPStyle::PopupSurface(Items, 240.f);
}

TSharedRef<SWidget> SHaybaMCPSettingsPanel::BuildBrainLlmModeMenu()
{
    TSharedRef<SVerticalBox> Items = SNew(SVerticalBox);
    for (const TSharedPtr<FString>& Option : BrainLlmModeOptions)
    {
        if (!Option.IsValid()) continue;
        Items->AddSlot().AutoHeight()
        [
            FHaybaMCPStyle::PopupRow(BrainLlmModeLabel(Option), FOnClicked::CreateLambda([this, Option]()
            {
                if (BrainLlmModeCombo.IsValid()) BrainLlmModeCombo->SetIsOpen(false);
                if (SelectedBrainLlmMode != Option)
                {
                    SelectedBrainLlmMode = Option;
                    MarkDirty();
                }
                return FReply::Handled();
            }), SelectedBrainLlmMode == Option,
                *Option == TEXT("byok")
                    ? NSLOCTEXT("Hayba", "S.Pro.Llm.Byok.Detail", "Use your configured provider key.")
                    : NSLOCTEXT("Hayba", "S.Pro.Llm.Subscription.Detail", "Use Hayba-provided models."))
        ];
    }
    return FHaybaMCPStyle::PopupSurface(Items, 240.f);
}

TSharedRef<SWidget> SHaybaMCPSettingsPanel::BuildLeaseEnforcementMenu()
{
    TSharedRef<SVerticalBox> Items = SNew(SVerticalBox);
    const UHaybaMCPDeveloperSettings* Dev = GetDefault<UHaybaMCPDeveloperSettings>();
    const EHaybaMCPLeaseEnforcement Selected = Dev
        ? Dev->LeaseEnforcement : EHaybaMCPLeaseEnforcement::EnforcedForWrites;
    for (const EHaybaMCPLeaseEnforcement Mode : {
        EHaybaMCPLeaseEnforcement::EnforcedForWrites,
        EHaybaMCPLeaseEnforcement::Enforced,
        EHaybaMCPLeaseEnforcement::Advisory,
        EHaybaMCPLeaseEnforcement::Off })
    {
        Items->AddSlot().AutoHeight()
        [
            FHaybaMCPStyle::PopupRow(LeaseModeLabel(Mode), FOnClicked::CreateLambda([this, Mode]()
            {
                if (LeaseEnforcementCombo.IsValid()) LeaseEnforcementCombo->SetIsOpen(false);
                UHaybaMCPDeveloperSettings* MutableDev = GetMutableDefault<UHaybaMCPDeveloperSettings>();
                if (MutableDev && MutableDev->LeaseEnforcement != Mode)
                {
                    MutableDev->LeaseEnforcement = Mode;
                    MutableDev->SaveConfig();
                }
                return FReply::Handled();
            }), Mode == Selected, LeaseModeDetail(Mode))
        ];
    }
    return FHaybaMCPStyle::PopupSurface(Items, 260.f);
}

TSharedRef<SWidget> SHaybaMCPSettingsPanel::BuildSection(const FText& Heading, const FText& Tooltip,
                                                          const TSharedRef<SWidget>& Body, bool bCollapsible)
{
    if (!bCollapsible)
    {
        return SNew(SVerticalBox)
            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 9.f, 0.f, 12.f)
            [
                SNew(STextBlock)
                .TextStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FTextBlockStyle>("Hayba.Text.Heading"))
                .Text(Heading)
                .ToolTipText(Tooltip)
            ]
            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 3.f, 0.f, 12.f)
            [ Body ]
            + SVerticalBox::Slot().AutoHeight()
            [
                SNew(SSeparator)
                .Thickness(1.f)
                .ColorAndOpacity(FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Border.Subtle")))
            ];
    }

    TSharedRef<bool> bExpanded = MakeShared<bool>(false);
    return SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight()
        [
            SNew(SButton)
            .ButtonStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FButtonStyle>("Hayba.Button.Task"))
            .ContentPadding(FMargin(0.f, 9.f))
            .ToolTipText(Tooltip)
            .OnClicked_Lambda([this, bExpanded]()
            {
                *bExpanded = !*bExpanded;
                Invalidate(EInvalidateWidgetReason::Layout);
                return FReply::Handled();
            })
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center)
                [
                    SNew(STextBlock)
                    .TextStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FTextBlockStyle>("Hayba.Text.Heading"))
                    .Text(Heading)
                ]
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(8.f, 0.f, 2.f, 0.f)
                [
                    SNew(SImage)
                    .Image_Lambda([bExpanded]() { return FHaybaMCPStyle::GetBrush(
                        *bExpanded ? "Hayba.Icon.Chevron.Up" : "Hayba.Icon.Chevron.Down"); })
                    .ColorAndOpacity(FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Text.Secondary")))
                ]
            ]
        ]
        + SVerticalBox::Slot().AutoHeight().Padding(0.f, 3.f, 0.f, 12.f)
        [ SNew(SBox).Visibility_Lambda([bExpanded]() { return *bExpanded ? EVisibility::Visible : EVisibility::Collapsed; }) [ Body ] ]
        + SVerticalBox::Slot().AutoHeight()
        [
            SNew(SSeparator)
            .Thickness(1.f)
            .ColorAndOpacity(FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Border.Subtle")))
        ];
}

TSharedRef<SWidget> SHaybaMCPSettingsPanel::BuildLabeledRow(const FText& Label, const FText& Tooltip, const TSharedRef<SWidget>& Right)
{
    // Put the field below its label so narrow editor docks retain the whole
    // control instead of squeezing it beside a long setting name.
    return SNew(SBox).ToolTipText(Tooltip)
    [
        SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight()
        [
            SNew(STextBlock)
            .TextStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FTextBlockStyle>("Hayba.Text.TabLabel"))
            .Text(Label)
            .AutoWrapText(true)
            .Visibility(Label.IsEmpty() ? EVisibility::Collapsed : EVisibility::Visible)
            .ToolTipText(Tooltip)
        ]
        + SVerticalBox::Slot().AutoHeight().Padding(0.f, Label.IsEmpty() ? 0.f : 6.f, 0.f, 8.f)
        [ Right ]
    ];
}

TSharedRef<SWidget> SHaybaMCPSettingsPanel::BuildToggle(const FText& Label, const FText& Tooltip,
                                                       TFunction<bool()> Get, TFunction<void(bool)> Set)
{
    TWeakPtr<SHaybaMCPSettingsPanel> WeakSelf = StaticCastSharedRef<SHaybaMCPSettingsPanel>(AsShared());
    TSharedRef<FPendingToggle> Pending = MakeShared<FPendingToggle>(Get(), MoveTemp(Set));
    PendingToggles.Add(Pending);
    return SNew(SBox).ToolTipText(Tooltip)
    [
        SNew(SHorizontalBox)
        + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
        [
            SNew(SCheckBox)
            .ToolTipText(Tooltip)
            .IsChecked_Lambda([Pending](){ return Pending->Value ? ECheckBoxState::Checked : ECheckBoxState::Unchecked; })
            .OnCheckStateChanged_Lambda([Pending, WeakSelf](ECheckBoxState s)
            {
                Pending->Value = (s == ECheckBoxState::Checked);
                if (TSharedPtr<SHaybaMCPSettingsPanel> Self = WeakSelf.Pin()) Self->MarkDirty();
            })
        ]
        + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center).Padding(10.f, 0.f, 0.f, 0.f)
        [
            SNew(STextBlock)
            .TextStyle(&FHaybaMCPStyle::Get().GetWidgetStyle<FTextBlockStyle>("Hayba.Text.Body"))
            .AutoWrapText(true)
            .Text(Label)
            .ToolTipText(Tooltip)
        ]
    ];
}

void SHaybaMCPSettingsPanel::MarkDirty()
{
    if (ModelDiscoveryClient.IsValid()) ModelDiscoveryClient->Cancel();
    DiscoveredModels.Reset();
    ModelPendingConfirmationId.Empty();
    bModelDiscoveryLoading = false;
    ModelDiscoveryMessage = TEXT("Save your changes to browse this provider's models.");
    RefreshModelMenuItems();
    if (!bIsDirty)
    {
        bIsDirty = true;
        Invalidate(EInvalidateWidgetReason::Layout);
    }
}

FReply SHaybaMCPSettingsPanel::OnSave()
{
    auto& S = FHaybaMCPSettings::Get();

    for (const TSharedRef<FPendingToggle>& Pending : PendingToggles)
    {
        if (Pending->Value != Pending->SavedValue)
        {
            Pending->Apply(Pending->Value);
            Pending->SavedValue = Pending->Value;
        }
    }

    if (CapTokenBox.IsValid())   S.CapabilityToken = CapTokenBox->GetText().ToString();
    if (SidecarUrlBox.IsValid()) S.SidecarURL      = SidecarUrlBox->GetText().ToString();
    if (LlmModelBox.IsValid())   S.Model           = LlmModelBox->GetText().ToString();
    if (LlmBaseUrlBox.IsValid()) S.BaseURL         = LlmBaseUrlBox->GetText().ToString();

    // Persist the selected provider before writing the key so the vault stores
    // it under the right id.
    if (SelectedProvider.IsValid()) S.SelectedProviderId = *SelectedProvider;
    if (SelectedAdvisoryVerbosity.IsValid()) S.AdvisoryVerbosity = *SelectedAdvisoryVerbosity;
    if (SelectedBrainLlmMode.IsValid()) S.BrainLlmMode = *SelectedBrainLlmMode;

    // Only touch the vault when the user actually typed a new key this session.
    // An empty-but-untouched box must NOT wipe the stored key.
    if (bKeyEdited && LlmApiKeyBox.IsValid())
    {
        const FString Typed = LlmApiKeyBox->GetText().ToString();
        FHaybaMCPSettings::SetProviderKey(S.SelectedProviderId, Typed); // empty -> clears
        // Do not keep the plaintext around: clear the input and the scratch field.
        S.ApiKey.Empty();
        LlmApiKeyBox->SetText(FText::GetEmpty());
        bKeyEdited = false;
    }
    if (RateLimitBox.IsValid())
    {
        const FString R = RateLimitBox->GetText().ToString();
        if (R.IsNumeric()) S.RateLimitPerMinute = FCString::Atoi(*R);
    }
    if (CacheTtlBox.IsValid())
    {
        const FString T = CacheTtlBox->GetText().ToString();
        if (T.IsNumeric()) S.ToolCacheTTLSeconds = FCString::Atof(*T);
    }
    S.Save();
    bUrlEdited = false;
    bModelEdited = false;
    RefreshKeyStatus();
    bIsDirty = false;
    bKeyDiscardedOnProviderChange = false;
    DiscardedKeyProviderLabel.Empty();
    DiscoveredModels.Reset();
    ModelDiscoveryMessage = TEXT("Checking available models...");
    Invalidate(EInvalidateWidgetReason::Layout);
    return FReply::Handled();
}

void SHaybaMCPSettingsPanel::OnProviderChanged(TSharedPtr<FString> NewId, ESelectInfo::Type)
{
    if (!NewId.IsValid()) return;
    if (SelectedProvider == NewId) return;
    // A pending secret belongs to the provider that was selected when it was
    // entered. Never write it under a different provider after a dropdown
    // change, including an empty entry intended to clear the original key.
    if (bKeyEdited && LlmApiKeyBox.IsValid())
    {
        const FHaybaProviderInfo* PreviousInfo = SelectedProvider.IsValid()
            ? FHaybaMCPSettings::FindProvider(*SelectedProvider) : nullptr;
        DiscardedKeyProviderLabel = PreviousInfo
            ? FString(PreviousInfo->Label)
            : (SelectedProvider.IsValid() ? *SelectedProvider : FString(TEXT("the previous provider")));
        LlmApiKeyBox->SetText(FText::GetEmpty());
        bKeyEdited = false;
        bKeyDiscardedOnProviderChange = true;
    }
    SelectedProvider = NewId;
    const FHaybaProviderInfo* Info = FHaybaMCPSettings::FindProvider(*NewId);
    // Keep custom edits visible. Only untouched fields follow provider defaults.
    ApplyProviderDefaults(Info, /*bOverwriteUrlModel=*/true);
    RefreshKeyStatus();
    MarkDirty();
}

void SHaybaMCPSettingsPanel::ApplyProviderDefaults(const FHaybaProviderInfo* Info, bool bOverwriteUrlModel)
{
    if (!Info) return;
    if (bOverwriteUrlModel)
    {
        bApplyingProviderDefaults = true;
        if (LlmBaseUrlBox.IsValid() && !bUrlEdited) LlmBaseUrlBox->SetText(FText::FromString(FString(Info->BaseURLDefault)));
        if (LlmModelBox.IsValid() && !bModelEdited) LlmModelBox->SetText(FText::FromString(FString(Info->DefaultModel)));
        bApplyingProviderDefaults = false;
    }
    if (LlmApiKeyBox.IsValid())
    {
        // Keyless providers: disable the key box; keyed providers: use the hint.
        LlmApiKeyBox->SetEnabled(Info->bNeedsKey);
        LlmApiKeyBox->SetHintText(Info->bNeedsKey
            ? FText::FromString(FString(Info->KeyHint))
            : NSLOCTEXT("Hayba", "S.Backend.KeylessHint", "no key required"));
    }
}

void SHaybaMCPSettingsPanel::RefreshKeyStatus()
{
    if (!KeyStatusText.IsValid()) return;
    const FString Id = SelectedProvider.IsValid() ? *SelectedProvider : FString();
    const FHaybaProviderInfo* Info = FHaybaMCPSettings::FindProvider(Id);

    if (Info && !Info->bNeedsKey)
    {
        KeyStatusText->SetText(NSLOCTEXT("Hayba", "S.Key.Keyless", "No API key needed."));
        KeyStatusText->SetColorAndOpacity(FSlateColor(FLinearColor(0.45f, 0.8f, 0.5f))); // green
        return;
    }

    // NEVER display the full key — last-4 only.
    const FString Last4 = FHaybaMCPSettings::GetProviderKeyLast4(Id);
    if (bKeyEdited && LlmApiKeyBox.IsValid())
    {
        const bool bHasPendingKey = !LlmApiKeyBox->GetText().IsEmpty();
        KeyStatusText->SetText(bHasPendingKey
            ? (Last4.IsEmpty()
                ? NSLOCTEXT("Hayba", "S.Key.PendingNew", "Key entered. Save to use it.")
                : NSLOCTEXT("Hayba", "S.Key.PendingReplace", "New key entered. Save to replace the stored key."))
            : (Last4.IsEmpty()
                ? NSLOCTEXT("Hayba", "S.Key.None", "No key saved")
                : NSLOCTEXT("Hayba", "S.Key.PendingClear", "Key cleared here. Save to remove the stored key.")));
        KeyStatusText->SetColorAndOpacity(FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Status.Warn")));
        return;
    }
    if (Last4.IsEmpty())
    {
        KeyStatusText->SetText(NSLOCTEXT("Hayba", "S.Key.None", "No key saved"));
        KeyStatusText->SetColorAndOpacity(FSlateColor(FLinearColor(0.85f, 0.55f, 0.35f))); // amber
    }
    else
    {
        KeyStatusText->SetText(FText::FromString(FString::Printf(TEXT("Key saved: ••••%s"), *Last4)));
        KeyStatusText->SetColorAndOpacity(FSlateColor(FLinearColor(0.65f, 0.65f, 0.7f))); // muted
    }
}

FText SHaybaMCPSettingsPanel::AdvisoryVerbosityLabel(EHaybaMCPAdvisoryVerbosity Value)
{
    switch (Value)
    {
    case EHaybaMCPAdvisoryVerbosity::ErrorsOnly:
        return NSLOCTEXT("Hayba", "S.Guidance.ErrorsOnly", "Errors only");
    case EHaybaMCPAdvisoryVerbosity::ErrorsAndWarnings:
        return NSLOCTEXT("Hayba", "S.Guidance.ErrorsWarnings", "Errors and warnings");
    case EHaybaMCPAdvisoryVerbosity::ErrorsWarningsAndTips:
    default:
        return NSLOCTEXT("Hayba", "S.Guidance.ErrorsWarningsTips", "Errors, warnings, and AI tips");
    }
}

void SHaybaMCPSettingsPanel::OnAdvisoryVerbosityChanged(
    TSharedPtr<EHaybaMCPAdvisoryVerbosity> NewValue,
    ESelectInfo::Type)
{
    if (!NewValue.IsValid()) return;
    SelectedAdvisoryVerbosity = NewValue;
    MarkDirty();
}

FReply SHaybaMCPSettingsPanel::OnRedoSetup()
{
    auto& S = FHaybaMCPSettings::Get();
    S.bHasSeenOnboarding = false;
    S.Save();
    if (MainPanel)
    {
        MainPanel->ShowOnboardingFromSplash();
    }
    return FReply::Handled();
}

// ── Hayba Pro sign-in (device code, proxied by the sidecar's /brain/* routes) ──

void SHaybaMCPSettingsPanel::RefreshBrainStatus()
{
    if (!BrainStatusText.IsValid()) return;
    const FString& Email = FHaybaMCPSettings::Get().BrainAccountEmail;
    if (FHaybaMCPSettings::HasProviderKey(BrainVaultId))
    {
        BrainStatusText->SetText(Email.IsEmpty()
            ? NSLOCTEXT("Hayba", "S.Pro.SignedIn", "Signed in")
            : FText::Format(NSLOCTEXT("Hayba", "S.Pro.SignedInAs", "Signed in as {0}"), FText::FromString(Email)));
    }
    else
    {
        BrainStatusText->SetText(NSLOCTEXT("Hayba", "S.Pro.NotSignedIn", "Not signed in"));
    }
}

FReply SHaybaMCPSettingsPanel::OnBrainSignIn()
{
    if (bBrainSignInStarting || BrainPollTicker.IsValid()) return FReply::Handled();
    bBrainSignInStarting = true;
    if (BrainStatusText.IsValid())
        BrainStatusText->SetText(NSLOCTEXT("Hayba", "S.Pro.Starting", "Starting sign-in…"));

    TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request =
        MakeBrainPost(TEXT("brain/signin/start"), MakeShared<FJsonObject>());
    TWeakPtr<SHaybaMCPSettingsPanel> WeakSelf = SharedThis(this);
    Request->OnProcessRequestComplete().BindLambda(
        [WeakSelf](FHttpRequestPtr /*Req*/, FHttpResponsePtr Response, bool bConnected)
        {
            TSharedPtr<SHaybaMCPSettingsPanel> Self = WeakSelf.Pin();
            if (!Self.IsValid()) return;
            Self->bBrainSignInStarting = false;
            if (!Self->BrainStatusText.IsValid()) return;

            if (!bConnected || !Response.IsValid())
            {
                Self->BrainStatusText->SetText(NSLOCTEXT("Hayba", "S.Pro.NoSidecar",
                    "Could not reach the Hayba sidecar. Is it running?"));
                return;
            }
            const int32 Code = Response->GetResponseCode();
            if (Code == 503)
            {
                Self->BrainStatusText->SetText(NSLOCTEXT("Hayba", "S.Pro.NotConfigured",
                    "Hayba Pro is not configured on this machine."));
                return;
            }
            if (Code != 200)
            {
                Self->BrainStatusText->SetText(FText::Format(
                    NSLOCTEXT("Hayba", "S.Pro.StartFailed", "Hayba Pro sign-in failed (HTTP {0})."),
                    FText::AsNumber(Code)));
                return;
            }

            TSharedPtr<FJsonObject> Root;
            FString VerificationUrl, UserCode, DeviceCode;
            if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Response->GetContentAsString()), Root) ||
                !Root.IsValid() ||
                !Root->TryGetStringField(TEXT("verification_url"), VerificationUrl) ||
                !Root->TryGetStringField(TEXT("device_code"), DeviceCode) ||
                DeviceCode.IsEmpty() ||
                // Only ever hand a web page to the OS shell, never another scheme.
                !(VerificationUrl.StartsWith(TEXT("https://")) || VerificationUrl.StartsWith(TEXT("http://"))))
            {
                Self->BrainStatusText->SetText(NSLOCTEXT("Hayba", "S.Pro.BadStart",
                    "Hayba Pro sent an unexpected sign-in response."));
                return;
            }
            Root->TryGetStringField(TEXT("user_code"), UserCode);
            double Interval = 5.0;
            double ExpiresIn = 600.0;
            Root->TryGetNumberField(TEXT("interval"), Interval);
            Root->TryGetNumberField(TEXT("expires_in"), ExpiresIn);
            Interval = FMath::Clamp(Interval, 1.0, 60.0);

            Self->BrainDeviceCode = DeviceCode;
            Self->BrainSignInDeadline = FPlatformTime::Seconds() + FMath::Max(ExpiresIn, Interval);

            FPlatformProcess::LaunchURL(*VerificationUrl, nullptr, nullptr);
            Self->BrainStatusText->SetText(UserCode.IsEmpty()
                ? NSLOCTEXT("Hayba", "S.Pro.CompleteInBrowser", "Complete sign-in in your browser")
                : FText::Format(
                    NSLOCTEXT("Hayba", "S.Pro.ConfirmCode", "Confirm code {0} in your browser"),
                    FText::FromString(UserCode)));

            Self->BrainPollTicker = FTSTicker::GetCoreTicker().AddTicker(
                FTickerDelegate::CreateSP(Self.ToSharedRef(), &SHaybaMCPSettingsPanel::TickBrainSignInPoll),
                static_cast<float>(Interval));
        });
    Request->ProcessRequest();
    return FReply::Handled();
}

bool SHaybaMCPSettingsPanel::TickBrainSignInPoll(float /*DeltaTime*/)
{
    if (BrainDeviceCode.IsEmpty())
    {
        BrainPollTicker.Reset();
        return false;
    }
    if (FPlatformTime::Seconds() > BrainSignInDeadline)
    {
        BrainDeviceCode.Empty();
        BrainPollTicker.Reset();
        if (BrainStatusText.IsValid())
            BrainStatusText->SetText(NSLOCTEXT("Hayba", "S.Pro.Expired", "Code expired — try again"));
        return false;
    }
    if (bBrainPollInFlight) return true;
    bBrainPollInFlight = true;

    TSharedRef<FJsonObject> Body = MakeShared<FJsonObject>();
    Body->SetStringField(TEXT("device_code"), BrainDeviceCode);
    TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = MakeBrainPost(TEXT("brain/signin/poll"), Body);
    TWeakPtr<SHaybaMCPSettingsPanel> WeakSelf = SharedThis(this);
    Request->OnProcessRequestComplete().BindLambda(
        [WeakSelf](FHttpRequestPtr /*Req*/, FHttpResponsePtr Response, bool bConnected)
        {
            TSharedPtr<SHaybaMCPSettingsPanel> Self = WeakSelf.Pin();
            if (!Self.IsValid()) return;
            Self->bBrainPollInFlight = false;
            // Sign-in was stopped (sign out / expiry) while this poll was in flight.
            if (!Self->BrainPollTicker.IsValid()) return;
            // Transient failures keep polling until the code expires.
            if (!bConnected || !Response.IsValid() || Response->GetResponseCode() != 200) return;

            TSharedPtr<FJsonObject> Root;
            if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Response->GetContentAsString()), Root) ||
                !Root.IsValid()) return;
            FString Status;
            Root->TryGetStringField(TEXT("status"), Status);

            if (Status == TEXT("approved"))
            {
                FString RefreshToken, Email;
                Root->TryGetStringField(TEXT("refresh_token"), RefreshToken);
                Root->TryGetStringField(TEXT("email"), Email);
                if (RefreshToken.IsEmpty()) return;
                // NB: never log the token — it goes straight into the DPAPI vault.
                FHaybaMCPSettings::SetProviderKey(BrainVaultId, RefreshToken);
                FHaybaMCPSettings& S = FHaybaMCPSettings::Get();
                S.BrainAccountEmail = Email;
                S.Save();
                Self->StopBrainSignInPoll();
                Self->RefreshBrainStatus();
            }
            else if (Status == TEXT("expired"))
            {
                Self->StopBrainSignInPoll();
                if (Self->BrainStatusText.IsValid())
                    Self->BrainStatusText->SetText(NSLOCTEXT("Hayba", "S.Pro.Expired", "Code expired — try again"));
            }
            // "pending": keep polling.
        });
    Request->ProcessRequest();
    return true;
}

void SHaybaMCPSettingsPanel::StopBrainSignInPoll()
{
    if (BrainPollTicker.IsValid())
    {
        FTSTicker::GetCoreTicker().RemoveTicker(BrainPollTicker);
        BrainPollTicker.Reset();
    }
    BrainDeviceCode.Empty();
}

FReply SHaybaMCPSettingsPanel::OnBrainSignOut()
{
    StopBrainSignInPoll();
    // Fire-and-forget: drop the sidecar's in-memory token too.
    MakeBrainPost(TEXT("brain/signout"), MakeShared<FJsonObject>())->ProcessRequest();
    FHaybaMCPSettings::SetProviderKey(BrainVaultId, TEXT(""));
    FHaybaMCPSettings& S = FHaybaMCPSettings::Get();
    S.BrainAccountEmail.Empty();
    S.Save();
    RefreshBrainStatus();
    return FReply::Handled();
}
