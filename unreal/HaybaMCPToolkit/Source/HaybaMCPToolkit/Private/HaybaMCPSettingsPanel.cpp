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
#include "Styling/AppStyle.h"

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
    SAssignNew(LlmApiKeyBox,   SEditableTextBox)
        .Text(FText::FromString(FHaybaMCPSettings::GetSharedApiKey())).IsPassword(true)
        .OnTextChanged_Lambda(OnDirty);
    SAssignNew(RateLimitBox,   SEditableTextBox)
        .Text(FText::AsNumber(S.RateLimitPerMinute))
        .OnTextChanged_Lambda(OnDirty);
    SAssignNew(CacheTtlBox,    SEditableTextBox)
        .Text(FText::AsNumber(S.ToolCacheTTLSeconds))
        .OnTextChanged_Lambda(OnDirty);

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
                                "How the MCP server authenticates incoming tool calls and what gets logged.\n\nApplies to both Integrated and API Key modes."),
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
                            NSLOCTEXT("Hayba", "Settings.Sec.PlanMode", "Plan Mode (AI safety)"),
                            NSLOCTEXT("Hayba", "Settings.Sec.PlanMode.TT",
                                "Plan Mode is a safety gate. When on, destructive commands "
                                "(spawn / delete / modify actors, write assets, run unsafe Python) "
                                "return `plan_mode_required` until the agent has called "
                                "`hayba_propose_plan` with a step-by-step proposal that you can "
                                "review in the Plan tab."),
                            SNew(SVerticalBox)
                            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 2.f)
                            [ BuildToggle(
                                NSLOCTEXT("Hayba", "S.Plan", "Plan Mode enabled — destructive ops require a plan first"),
                                NSLOCTEXT("Hayba", "S.Plan.TT",
                                    "Strongly recommended.\n\n"
                                    "Turning this off lets the agent mutate your level / assets / disk without proposing a plan first. Reserve for trusted prompts and small experiments.\n\n"
                                    "Default: on. Auto-prompts you to re-enable after 7 days off OR 50 destructive calls."),
                                [](){ return FHaybaMCPSettings::Get().bPlanModeEnabled; },
                                [](bool b){ FHaybaMCPSettings::Get().bPlanModeEnabled = b; }) ]
                        )
                    ]

                    + SVerticalBox::Slot().AutoHeight().Padding(0.f, 0.f, 0.f, 8.f)
                    [
                        BuildSection(
                            NSLOCTEXT("Hayba", "Settings.Sec.LLM", "AI / LLM Backend"),
                            NSLOCTEXT("Hayba", "Settings.Sec.LLM.TT",
                                "Configures the AI used by the Chat tab in API Key mode.\n\n"
                                "Integrated mode (Claude Desktop / Code / Cursor) ignores these fields — the host application drives the model choice there."),
                            SNew(SVerticalBox)
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
                                FText::GetEmpty(),
                                LlmApiKeyBox.ToSharedRef()) ]
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
                                "Controls what the agent's Python escape hatch (python_run) is allowed to do.\n\n"
                                "Tier 1: pure UE editor scripting (unreal.* APIs). Always allowed.\n"
                                "Tier 2: same as Tier 1 + read-only filesystem under the project. Always allowed.\n"
                                "Tier 3: arbitrary code, full filesystem, subprocess, socket. Opt-in below."),
                            BuildToggle(
                                NSLOCTEXT("Hayba", "S.UnsafePython",
                                    "Allow Tier 3 Python (filesystem, subprocess, socket) — DANGEROUS"),
                                NSLOCTEXT("Hayba", "S.UnsafePython.TT",
                                    "DANGER: turning this on lets the agent shell out, write anywhere on disk, open sockets, and import arbitrary modules.\n\n"
                                    "Equivalent to giving the agent full code execution on your machine. Reserve for trusted local workflows where the alternative is even worse (e.g., scripting external tooling).\n\n"
                                    "Default: off. Tier 3 calls return a permission error when this is off."),
                                [](){ return FHaybaMCPSettings::Get().bAllowUnsafePython; },
                                [](bool b){ FHaybaMCPSettings::Get().bAllowUnsafePython = b; })
                        )
                    ]

                    // ── Danger zone — Redo Setup lives at the very bottom on its own. ─────────
                    + SVerticalBox::Slot().AutoHeight().Padding(0.f, 24.f, 0.f, 0.f)
                    [
                        BuildSection(
                            NSLOCTEXT("Hayba", "Settings.Sec.Redo", "Onboarding"),
                            NSLOCTEXT("Hayba", "Settings.Sec.Redo.TT",
                                "Re-runs the first-time setup wizard. Your saved settings above are kept; this just re-shows the screens that pick Integrated vs API Key mode and configure the MCP server location."),
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
    if (LlmApiKeyBox.IsValid())
    {
        S.ApiKey = LlmApiKeyBox->GetText().ToString();
        FHaybaMCPSettings::SetSharedApiKey(S.ApiKey);
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
    bIsDirty = false;
    Invalidate(EInvalidateWidgetReason::Paint);
    return FReply::Handled();
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
