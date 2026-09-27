#include "HaybaMCPSettingsPanel.h"
#include "HaybaMCPMainPanel.h"
#include "HaybaMCPSettings.h"
#include "HaybaMCPStyle.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SScrollBox.h"
#include "Widgets/Layout/SSeparator.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SCheckBox.h"
#include "Widgets/Input/SEditableTextBox.h"
#include "Widgets/Input/SComboBox.h"
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
    StopBrainSignInPoll();
}

void SHaybaMCPSettingsPanel::Construct(const FArguments& InArgs)
{
    MainPanel = InArgs._MainPanel;
    auto& S = FHaybaMCPSettings::Get();

    // OnTextChanged fires on every keystroke — that's the right granularity for
    // "the user has touched the form, surface a Save button".
    auto OnDirty = [this](const FText&){ MarkDirty(); };

    SAssignNew(CapTokenBox,    SEditableTextBox)
        .Text(FText::FromString(S.CapabilityToken)).IsPassword(true)
        .OnTextChanged_Lambda(OnDirty);
    SAssignNew(SidecarUrlBox,  SEditableTextBox)
        .Text(FText::FromString(S.SidecarURL))
        .OnTextChanged_Lambda(OnDirty);
    SAssignNew(LlmModelBox,    SEditableTextBox)
        .Text(FText::FromString(S.Model))
        .OnTextChanged_Lambda(OnDirty);
    SAssignNew(LlmBaseUrlBox,  SEditableTextBox)
        .Text(FText::FromString(S.BaseURL))
        .OnTextChanged_Lambda(OnDirty);
    // Key box starts EMPTY — we never populate it with the stored secret. The
    // last-4 status label (RefreshKeyStatus) is the only readback. Typing here
    // marks the key as edited so OnSave writes the new value through the vault.
    SAssignNew(LlmApiKeyBox,   SEditableTextBox)
        .IsPassword(true)
        .HintText(NSLOCTEXT("Hayba", "S.Backend.KeyHint", "enter to replace stored key"))
        .OnTextChanged_Lambda([this](const FText&){ bKeyEdited = true; MarkDirty(); });

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

    auto MakeProviderLabel = [](TSharedPtr<FString> Id) -> FText
    {
        const FHaybaProviderInfo* Info = Id.IsValid() ? FHaybaMCPSettings::FindProvider(*Id) : nullptr;
        return FText::FromString(Info ? FString(Info->Label) : (Id.IsValid() ? *Id : FString()));
    };

    SAssignNew(ProviderCombo, SComboBox<TSharedPtr<FString>>)
        .OptionsSource(&ProviderOptions)
        .InitiallySelectedItem(SelectedProvider)
        .OnGenerateWidget_Lambda([MakeProviderLabel](TSharedPtr<FString> Id)
        {
            return SNew(STextBlock).Text(MakeProviderLabel(Id));
        })
        .OnSelectionChanged(this, &SHaybaMCPSettingsPanel::OnProviderChanged)
        [
            SNew(STextBlock)
            .Text_Lambda([this, MakeProviderLabel]()
            {
                return MakeProviderLabel(SelectedProvider);
            })
        ];

    SAssignNew(KeyStatusText, STextBlock)
        .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("SmallText"));
    SAssignNew(RateLimitBox,   SEditableTextBox)
        .Text(FText::AsNumber(S.RateLimitPerMinute))
        .OnTextChanged_Lambda(OnDirty);
    SAssignNew(CacheTtlBox,    SEditableTextBox)
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
    SAssignNew(AdvisoryVerbosityCombo, SComboBox<TSharedPtr<EHaybaMCPAdvisoryVerbosity>>)
        .OptionsSource(&AdvisoryVerbosityOptions)
        .InitiallySelectedItem(SelectedAdvisoryVerbosity)
        .OnGenerateWidget_Lambda([](TSharedPtr<EHaybaMCPAdvisoryVerbosity> Value)
        {
            return SNew(STextBlock).Text(Value.IsValid()
                ? AdvisoryVerbosityLabel(*Value)
                : FText::GetEmpty());
        })
        .OnSelectionChanged(this, &SHaybaMCPSettingsPanel::OnAdvisoryVerbosityChanged)
        [
            SNew(STextBlock)
            .Text_Lambda([this]()
            {
                return SelectedAdvisoryVerbosity.IsValid()
                    ? AdvisoryVerbosityLabel(*SelectedAdvisoryVerbosity)
                    : FText::GetEmpty();
            })
        ];

    // Hayba Pro model source: "subscription" (Hayba-provided) or "byok".
    BrainLlmModeOptions = { MakeShared<FString>(TEXT("subscription")), MakeShared<FString>(TEXT("byok")) };
    SelectedBrainLlmMode = S.BrainLlmMode == TEXT("byok") ? BrainLlmModeOptions[1] : BrainLlmModeOptions[0];
    auto MakeBrainLlmModeLabel = [](TSharedPtr<FString> Mode) -> FText
    {
        return (Mode.IsValid() && *Mode == TEXT("byok"))
            ? NSLOCTEXT("Hayba", "S.Pro.Llm.Byok", "Your provider key (BYOK)")
            : NSLOCTEXT("Hayba", "S.Pro.Llm.Subscription", "Hayba models (subscription)");
    };
    SAssignNew(BrainLlmModeCombo, SComboBox<TSharedPtr<FString>>)
        .OptionsSource(&BrainLlmModeOptions)
        .InitiallySelectedItem(SelectedBrainLlmMode)
        .OnGenerateWidget_Lambda([MakeBrainLlmModeLabel](TSharedPtr<FString> Mode)
        {
            return SNew(STextBlock).Text(MakeBrainLlmModeLabel(Mode));
        })
        .OnSelectionChanged_Lambda([this](TSharedPtr<FString> NewMode, ESelectInfo::Type)
        {
            if (!NewMode.IsValid()) return;
            SelectedBrainLlmMode = NewMode;
            FHaybaMCPSettings::Get().BrainLlmMode = *NewMode;
            MarkDirty();
        })
        [
            SNew(STextBlock)
            .Text_Lambda([this, MakeBrainLlmModeLabel]()
            {
                return MakeBrainLlmModeLabel(SelectedBrainLlmMode);
            })
        ];
    SAssignNew(BrainStatusText, STextBlock)
        .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("SmallText"))
        .AutoWrapText(true);

    ChildSlot
    [
        SNew(SBorder)
        .BorderImage(FAppStyle::Get().GetBrush("Brushes.Recessed"))
        .Padding(FMargin(0))
        [
            SNew(SVerticalBox)
            // Action bar — only the Save button. Redo Setup now lives at the bottom of the form.
            + SVerticalBox::Slot().AutoHeight()
            [
                SNew(SBorder)
                .BorderImage(FAppStyle::Get().GetBrush("Brushes.Header"))
                .Padding(FMargin(12.f, 8.f))
                [
                    SNew(SHorizontalBox)
                    + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center)
                    [
                        SNew(STextBlock)
                        .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("SmallText"))
                        // Status text reacts to dirty state too — clearer feedback loop.
                        .Text_Lambda([this]()
                        {
                            return bIsDirty
                                ? NSLOCTEXT("Hayba", "Settings.Hint.Dirty", "You have unsaved changes.")
                                : NSLOCTEXT("Hayba", "Settings.Hint.Clean", "Edit any field to enable Save.");
                        })
                        .ColorAndOpacity_Lambda([this]()
                        {
                            return bIsDirty
                                ? FSlateColor(FLinearColor(1.0f, 0.78f, 0.30f))   // amber
                                : FSlateColor(FLinearColor(0.65f, 0.65f, 0.7f));  // muted
                        })
                    ]
                    + SHorizontalBox::Slot().AutoWidth()
                    [
                        SNew(SButton)
                        .ButtonStyle(FAppStyle::Get(), "PrimaryButton")
                        .Text(NSLOCTEXT("Hayba", "Settings.Save", "Save"))
                        .ContentPadding(FMargin(18.f, 6.f))
                        .IsEnabled_Lambda([this](){ return bIsDirty; })
                        .OnClicked(this, &SHaybaMCPSettingsPanel::OnSave)
                    ]
                ]
            ]
            + SVerticalBox::Slot().FillHeight(1.f)
            [
                SNew(SScrollBox)
                + SScrollBox::Slot().Padding(FMargin(12.f, 10.f))
                [
                    SNew(SVerticalBox)
                    + SVerticalBox::Slot().AutoHeight().Padding(0.f, 0.f, 0.f, 8.f)
                    [
                        BuildSection(
                            NSLOCTEXT("Hayba", "Settings.Sec.Connection", "Connection & Security"),
                            NSLOCTEXT("Hayba", "Settings.Sec.Connection.TT",
                                "How the MCP server authenticates incoming tool calls and what gets logged."),
                            SNew(SVerticalBox)
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
                        )
                    ]

                    + SVerticalBox::Slot().AutoHeight().Padding(0.f, 0.f, 0.f, 8.f)
                    [
                        BuildSection(
                            NSLOCTEXT("Hayba", "Settings.Sec.PlanMode", "External MCP safety"),
                            NSLOCTEXT("Hayba", "Settings.Sec.PlanMode.TT",
                                "Require a reviewed plan for external MCP clients before they change the project. "
                                "Review incoming proposals in Agent. Built-in chat keeps its own action approvals "
                                "and Explore / Draft / Production modes."),
                            SNew(SVerticalBox)
                            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 2.f)
                            [ BuildToggle(
                                NSLOCTEXT("Hayba", "S.Plan", "Require a plan before external MCP changes"),
                                NSLOCTEXT("Hayba", "S.Plan.TT",
                                    "Applies to the native command gate used by external MCP hosts. "
                                    "Turning this off allows their write commands without this plan review. "
                                    "Built-in chat approvals remain enabled. Default: on."),
                                [](){ return FHaybaMCPSettings::Get().bPlanModeEnabled; },
                                [](bool b){ FHaybaMCPSettings::Get().bPlanModeEnabled = b; }) ]
                        )
                    ]

                    + SVerticalBox::Slot().AutoHeight().Padding(0.f, 0.f, 0.f, 8.f)
                    [
                        BuildSection(
                            NSLOCTEXT("Hayba", "Settings.Sec.LLM", "AI / LLM Backend"),
                            NSLOCTEXT("Hayba", "Settings.Sec.LLM.TT",
                                "Configures the AI used by the Chat tab.\n\n"
                                "External MCP hosts (Claude Desktop / Code / Cursor) ignore these fields — the host application drives the model choice there."),
                            SNew(SVerticalBox)
                            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 2.f)
                            [ BuildLabeledRow(
                                NSLOCTEXT("Hayba", "S.Backend.Provider", "Provider"),
                                NSLOCTEXT("Hayba", "S.Backend.Provider.TT",
                                    "Pick your LLM provider. Selecting one auto-fills the Base URL, "
                                    "default Model, and key hint below. Local providers "
                                    "(Ollama, LM Studio) and Mock need no API key."),
                                ProviderCombo.ToSharedRef()) ]
                            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 2.f)
                            [ BuildLabeledRow(
                                NSLOCTEXT("Hayba", "S.Backend.Url",  "Base URL"),
                                FText::GetEmpty(),
                                LlmBaseUrlBox.ToSharedRef()) ]
                            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 2.f)
                            [ BuildLabeledRow(
                                NSLOCTEXT("Hayba", "S.Backend.Model","Model"),
                                FText::GetEmpty(),
                                LlmModelBox.ToSharedRef()) ]
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
                            [ BuildToggle(
                                NSLOCTEXT("Hayba", "S.CodeMode", "Code Mode (meta-tools)"),
                                NSLOCTEXT("Hayba", "S.CodeMode.TT",
                                    "When on, the MCP server advertises only 3 meta-tools to the agent:\n"
                                    "  • list_tool_categories — domain overview\n"
                                    "  • get_tool_signature — schema for a specific tool\n"
                                    "  • python_run — escape hatch via UE Python\n\n"
                                    "The full 100+ tool catalog stays loaded server-side; the agent discovers them on demand. This reduces the initial tool-list payload by ~92%, freeing up the context window for actual reasoning.\n\n"
                                    "Default: on. Turn off only if your agent host has trouble with progressive tool discovery."),
                                [](){ return FHaybaMCPSettings::Get().bCodeModeEnabled; },
                                [](bool b){ FHaybaMCPSettings::Get().bCodeModeEnabled = b; }) ]
                        )
                    ]

                    + SVerticalBox::Slot().AutoHeight().Padding(0.f, 0.f, 0.f, 8.f)
                    [
                        BuildSection(
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
                        )
                    ]

                    + SVerticalBox::Slot().AutoHeight().Padding(0.f, 0.f, 0.f, 8.f)
                    [
                        BuildSection(
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
                        )
                    ]

                    + SVerticalBox::Slot().AutoHeight().Padding(0.f, 0.f, 0.f, 8.f)
                    [
                        BuildSection(
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
                        )
                    ]

                    + SVerticalBox::Slot().AutoHeight().Padding(0.f, 0.f, 0.f, 8.f)
                    [
                        BuildSection(
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
                        )
                    ]

                    + SVerticalBox::Slot().AutoHeight().Padding(0.f, 0.f, 0.f, 8.f)
                    [
                        BuildSection(
                            NSLOCTEXT("Hayba", "Settings.Sec.SceneMap", "Scene Map renderer"),
                            NSLOCTEXT("Hayba", "Settings.Sec.SceneMap.TT",
                                "Choose how the Scene Map (cognitive map) tab renders cells.\n\n"
                                "  • Auto — pick Web on modern GPUs.\n"
                                "  • Web — CEF + D3.js. Smooth animations, fancier tooltips.\n"
                                "  • Native — Slate-only. Lighter on low-end GPUs."),
                            SNew(SVerticalBox)
                            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 2.f)
                            [
                                BuildToggle(
                                    NSLOCTEXT("Hayba", "S.Map.Web",   "Use Web (CEF + D3.js) renderer"),
                                    NSLOCTEXT("Hayba", "S.Map.Web.TT",
                                        "Toggle ON for the rich Web renderer, OFF for the lightweight Native Slate renderer."),
                                    [](){ return FHaybaMCPSettings::Get().SceneMapRenderer != FHaybaMCPSettings::ESceneMapRenderer::Native; },
                                    [](bool b){
                                        FHaybaMCPSettings::Get().SceneMapRenderer = b
                                            ? FHaybaMCPSettings::ESceneMapRenderer::Web
                                            : FHaybaMCPSettings::ESceneMapRenderer::Native;
                                    })
                            ]
                        )
                    ]

                    + SVerticalBox::Slot().AutoHeight().Padding(0.f, 0.f, 0.f, 8.f)
                    [
                        BuildSection(
                            NSLOCTEXT("Hayba", "Settings.Sec.Python", "Python"),
                            NSLOCTEXT("Hayba", "Settings.Sec.Python.TT",
                                "python_run is an Unreal-only embedded scripting principal.\n\n"
                                "Tier 1: bounded Unreal editor scripting.\n"
                                "Tier 2: Unreal mutations guarded by the normal MCP policy.\n"
                                "Tier 3: host filesystem, subprocess, and network access is always refused."),
                            SNew(STextBlock)
                                .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("NormalText"))
                                .AutoWrapText(true)
                                .Text(NSLOCTEXT("Hayba", "S.PythonBoundary",
                                    "Host access from embedded python_run is permanently disabled. "
                                    "The legacy allow_unsafe request field and old saved setting are accepted for compatibility but are ineffective. "
                                    "Use a typed brokered MCP tool (#412/#415) for supported host operations. "
                                    "This boundary reduces exposure; it does not claim arbitrary in-process Python safety (#392/#414)."))
                        )
                    ]

                    // ── Danger zone — Redo Setup lives at the very bottom on its own. ─────────
                    + SVerticalBox::Slot().AutoHeight().Padding(0.f, 24.f, 0.f, 0.f)
                    [
                        BuildSection(
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
                        )
                    ]
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

TSharedRef<SWidget> SHaybaMCPSettingsPanel::BuildSection(const FText& Heading, const FText& Tooltip, const TSharedRef<SWidget>& Body)
{
    return SNew(SBorder)
        .BorderImage(FAppStyle::Get().GetBrush("Brushes.Panel"))
        .ToolTipText(Tooltip)
        .Padding(FMargin(10.f, 8.f))
        [
            SNew(SVerticalBox)
            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 0.f, 0.f, 8.f)
            [
                SNew(STextBlock)
                .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("DetailsView.CategoryTextStyle"))
                .Text(Heading)
                .ToolTipText(Tooltip)
            ]
            + SVerticalBox::Slot().AutoHeight()
            [ SNew(SSeparator).Thickness(1.f) ]
            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 8.f, 0.f, 0.f)
            [ Body ]
        ];
}

TSharedRef<SWidget> SHaybaMCPSettingsPanel::BuildLabeledRow(const FText& Label, const FText& Tooltip, const TSharedRef<SWidget>& Right)
{
    // No visible help badge — tooltip is the only affordance and triggers on
    // the standard Slate hover delay. The label, the input, and the row
    // wrapper all carry the tooltip so hovering anywhere reveals it.
    return SNew(SBox).ToolTipText(Tooltip)
    [
        SNew(SHorizontalBox)
        + SHorizontalBox::Slot().FillWidth(0.42f).VAlign(VAlign_Center)
        [
            SNew(STextBlock)
            .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("NormalText"))
            .Text(Label)
            .ToolTipText(Tooltip)
        ]
        + SHorizontalBox::Slot().FillWidth(0.58f).VAlign(VAlign_Center) [ Right ]
    ];
}

TSharedRef<SWidget> SHaybaMCPSettingsPanel::BuildToggle(const FText& Label, const FText& Tooltip,
                                                       TFunction<bool()> Get, TFunction<void(bool)> Set)
{
    TWeakPtr<SHaybaMCPSettingsPanel> WeakSelf = StaticCastSharedRef<SHaybaMCPSettingsPanel>(AsShared());
    return SNew(SBox).ToolTipText(Tooltip)
    [
        SNew(SHorizontalBox)
        + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
        [
            SNew(SCheckBox)
            .ToolTipText(Tooltip)
            .IsChecked_Lambda([Get](){ return Get() ? ECheckBoxState::Checked : ECheckBoxState::Unchecked; })
            .OnCheckStateChanged_Lambda([Set, WeakSelf](ECheckBoxState s)
            {
                Set(s == ECheckBoxState::Checked);
                if (TSharedPtr<SHaybaMCPSettingsPanel> Self = WeakSelf.Pin()) Self->MarkDirty();
            })
        ]
        + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center).Padding(10.f, 0.f, 0.f, 0.f)
        [
            SNew(STextBlock)
            .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("NormalText"))
            .AutoWrapText(true)
            .Text(Label)
            .ToolTipText(Tooltip)
        ]
    ];
}

void SHaybaMCPSettingsPanel::MarkDirty()
{
    if (!bIsDirty)
    {
        bIsDirty = true;
        Invalidate(EInvalidateWidgetReason::Paint);
    }
}

FReply SHaybaMCPSettingsPanel::OnSave()
{
    auto& S = FHaybaMCPSettings::Get();

    if (CapTokenBox.IsValid())   S.CapabilityToken = CapTokenBox->GetText().ToString();
    if (SidecarUrlBox.IsValid()) S.SidecarURL      = SidecarUrlBox->GetText().ToString();
    if (LlmModelBox.IsValid())   S.Model           = LlmModelBox->GetText().ToString();
    if (LlmBaseUrlBox.IsValid()) S.BaseURL         = LlmBaseUrlBox->GetText().ToString();

    // Persist the selected provider before writing the key so the vault stores
    // it under the right id.
    if (SelectedProvider.IsValid()) S.SelectedProviderId = *SelectedProvider;

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
    RefreshKeyStatus();
    bIsDirty = false;
    Invalidate(EInvalidateWidgetReason::Paint);
    return FReply::Handled();
}

void SHaybaMCPSettingsPanel::OnProviderChanged(TSharedPtr<FString> NewId, ESelectInfo::Type)
{
    if (!NewId.IsValid()) return;
    SelectedProvider = NewId;
    const FHaybaProviderInfo* Info = FHaybaMCPSettings::FindProvider(*NewId);
    // Overwrite the Base URL / Model fields with this provider's defaults so the
    // panel always shows a coherent config for the picked provider.
    ApplyProviderDefaults(Info, /*bOverwriteUrlModel=*/true);
    RefreshKeyStatus();
    MarkDirty();
}

void SHaybaMCPSettingsPanel::ApplyProviderDefaults(const FHaybaProviderInfo* Info, bool bOverwriteUrlModel)
{
    if (!Info) return;
    if (bOverwriteUrlModel)
    {
        if (LlmBaseUrlBox.IsValid()) LlmBaseUrlBox->SetText(FText::FromString(FString(Info->BaseURLDefault)));
        if (LlmModelBox.IsValid())   LlmModelBox->SetText(FText::FromString(FString(Info->DefaultModel)));
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
        KeyStatusText->SetText(NSLOCTEXT("Hayba", "S.Key.Keyless",
            "Keyless provider — no API key needed."));
        KeyStatusText->SetColorAndOpacity(FSlateColor(FLinearColor(0.45f, 0.8f, 0.5f))); // green
        return;
    }

    // NEVER display the full key — last-4 only.
    const FString Last4 = FHaybaMCPSettings::GetProviderKeyLast4(Id);
    if (Last4.IsEmpty())
    {
        KeyStatusText->SetText(NSLOCTEXT("Hayba", "S.Key.None", "No key stored for this provider."));
        KeyStatusText->SetColorAndOpacity(FSlateColor(FLinearColor(0.85f, 0.55f, 0.35f))); // amber
    }
    else
    {
        KeyStatusText->SetText(FText::FromString(FString::Printf(TEXT("Stored (DPAPI): ••••%s"), *Last4)));
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
    FHaybaMCPSettings::Get().AdvisoryVerbosity = *NewValue;
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
