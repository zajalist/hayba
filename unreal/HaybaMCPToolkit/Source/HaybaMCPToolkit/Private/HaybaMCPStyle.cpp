#include "HaybaMCPStyle.h"
#include "Styling/SlateStyleRegistry.h"
#include "Styling/SlateStyleMacros.h"
#include "Styling/SlateTypes.h"
#include "Brushes/SlateImageBrush.h"
#include "Interfaces/IPluginManager.h"
#include "Misc/Paths.h"
#include "Fonts/SlateFontInfo.h"
#include "Styling/AppStyle.h"

TSharedPtr<FSlateStyleSet> FHaybaMCPStyle::StyleInstance = nullptr;

void FHaybaMCPStyle::Initialize()
{
    if (!StyleInstance.IsValid())
    {
        StyleInstance = Create();
        FSlateStyleRegistry::RegisterSlateStyle(*StyleInstance);
    }
}

void FHaybaMCPStyle::Shutdown()
{
    if (StyleInstance.IsValid())
    {
        FSlateStyleRegistry::UnRegisterSlateStyle(*StyleInstance);
        ensure(StyleInstance.IsUnique());
        StyleInstance.Reset();
    }
}

const ISlateStyle& FHaybaMCPStyle::Get()
{
    return *StyleInstance;
}

FName FHaybaMCPStyle::GetStyleSetName()
{
    static const FName Name(TEXT("HaybaMCPStyle"));
    return Name;
}

const FSlateBrush* FHaybaMCPStyle::GetBrush(const FName& BrushName)
{
    return StyleInstance.IsValid() ? StyleInstance->GetBrush(BrushName) : nullptr;
}

FLinearColor FHaybaMCPStyle::Colour(const FName& Token)
{
    // Magenta rather than a plausible default: on cool dark chrome a missing
    // token returning black or white looks like a deliberate choice and can
    // ship unnoticed. If you are seeing magenta, the token name is wrong.
    static const FLinearColor Missing(1.f, 0.f, 1.f, 1.f);
    return StyleInstance.IsValid()
        ? StyleInstance->GetColor(Token, nullptr, Missing)
        : Missing;
}

float FHaybaMCPStyle::Metric(const FName& Token)
{
    return StyleInstance.IsValid() ? StyleInstance->GetFloat(Token, nullptr, 0.f) : 0.f;
}

#define RootToContentDir StyleInstance->RootToContentDir

TSharedRef<FSlateStyleSet> FHaybaMCPStyle::Create()
{
    TSharedRef<FSlateStyleSet> Style = MakeShareable(new FSlateStyleSet(GetStyleSetName()));

    const TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("HaybaMCPToolkit"));
    if (Plugin.IsValid())
    {
        Style->SetContentRoot(Plugin->GetBaseDir() / TEXT("Resources"));
    }
    else
    {
        Style->SetContentRoot(FPaths::ProjectPluginsDir() / TEXT("HaybaMCPToolkit/Resources"));
    }

    StyleInstance = Style;

    // The HaybaLogo SVG is 166x201 — preserve that aspect everywhere.
    Style->Set("Hayba.Logo.Small",   new IMAGE_BRUSH_SVG(TEXT("HaybaLogo"), FVector2D(40.f,  48.f)));
    Style->Set("Hayba.Logo.Medium",  new IMAGE_BRUSH_SVG(TEXT("HaybaLogo"), FVector2D(83.f,  100.f)));
    Style->Set("Hayba.Logo.Large",   new IMAGE_BRUSH_SVG(TEXT("HaybaLogo"), FVector2D(166.f, 201.f)));
    Style->Set("Hayba.Logo",         new IMAGE_BRUSH_SVG(TEXT("HaybaLogo"), FVector2D(166.f, 201.f)));
    Style->Set("Hayba.Icon.Toolkit", new IMAGE_BRUSH_SVG(TEXT("HaybaLogo"), FVector2D(40.f, 48.f)));

    // ── Design tokens ────────────────────────────────────────────────────────
    // Cool neutral chrome so the panel sits inside Unreal's own; ochre carries
    // meaning and nothing else. See HaybaMCPStyle.h for the ochre rule.
    {
        // Named Tok, not Colour: a local named Colour would hide the static
        // FHaybaMCPStyle::Colour inside this function, which compiles and reads
        // wrong.
        // Set as FLinearColor (read back with GetColor). Setting FSlateColor
        // instead would require GetSlateColor and silently miss here.
        auto Tok = [&Style](const TCHAR* Token, const FLinearColor& Value)
        {
            Style->Set(Token, Value);
        };

        // Surfaces
        Tok(TEXT("Hayba.Color.Surface.Panel"),  FLinearColor::FromSRGBColor(FColor(0x20, 0x25, 0x2B)));
        Tok(TEXT("Hayba.Color.Surface.Raised"), FLinearColor::FromSRGBColor(FColor(0x29, 0x2F, 0x36)));
        Tok(TEXT("Hayba.Color.Surface.Sunken"), FLinearColor::FromSRGBColor(FColor(0x17, 0x1B, 0x20)));

        // Lines
        Tok(TEXT("Hayba.Color.Border.Subtle"),  FLinearColor::FromSRGBColor(FColor(0x3A, 0x42, 0x4B)));
        Tok(TEXT("Hayba.Color.Border.Strong"),  FLinearColor::FromSRGBColor(FColor(0x51, 0x5B, 0x66)));

        // Text
        Tok(TEXT("Hayba.Color.Text.Primary"),   FLinearColor::FromSRGBColor(FColor(0xE5, 0xE9, 0xED)));
        Tok(TEXT("Hayba.Color.Text.Secondary"), FLinearColor::FromSRGBColor(FColor(0xAA, 0xB3, 0xBD)));
        Tok(TEXT("Hayba.Color.Text.Muted"),     FLinearColor::FromSRGBColor(FColor(0x77, 0x82, 0x8E)));

        // Semantic accent. #C47A28 is a legibility-tuned relative of the logo's
        // #B56A1D -- lifted so a thin stroke holds against dark chrome. The
        // logo itself keeps its own colour and is not retinted.
        Tok(TEXT("Hayba.Color.Accent.Ochre"),   FLinearColor::FromSRGBColor(FColor(0xC4, 0x7A, 0x28)));
        Tok(TEXT("Hayba.Color.Accent.Hover"),   FLinearColor::FromSRGBColor(FColor(0xD8, 0x8A, 0x30)));
        Tok(TEXT("Hayba.Color.Accent.Pressed"), FLinearColor::FromSRGBColor(FColor(0xA9, 0x65, 0x20)));

        // Status. Restrained on purpose: ochre already carries "needs you", so
        // pass and fail must not shout over it.
        Tok(TEXT("Hayba.Color.Status.Pass"),    FLinearColor::FromSRGBColor(FColor(0x7E, 0xA5, 0x8A)));
        Tok(TEXT("Hayba.Color.Status.Fail"),    FLinearColor::FromSRGBColor(FColor(0xC4, 0x6E, 0x68)));

        // Metrics — so spacing stops being magic numbers at each call site.
        Style->Set(TEXT("Hayba.Metric.Radius.Chip"),  6.f);
        Style->Set(TEXT("Hayba.Metric.Radius.Card"),  8.f);
        Style->Set(TEXT("Hayba.Metric.Radius.Panel"), 10.f);
        Style->Set(TEXT("Hayba.Metric.Pad.XS"),       4.f);
        Style->Set(TEXT("Hayba.Metric.Pad.S"),        8.f);
        Style->Set(TEXT("Hayba.Metric.Pad.M"),       12.f);
        Style->Set(TEXT("Hayba.Metric.Pad.L"),       18.f);
        Style->Set(TEXT("Hayba.Metric.Pad.XL"),      28.f);
        Style->Set(TEXT("Hayba.Metric.Icon.Inline"), 16.f);
        Style->Set(TEXT("Hayba.Metric.Icon.Sidebar"),28.f);
        // The active row's left edge. State is carried by the row, never by a
        // badge composited onto an icon.
        Style->Set(TEXT("Hayba.Metric.ActiveEdge"),   3.f);
    }

    // ── Icons ────────────────────────────────────────────────────────────────
    // PNG, not SVG, and registered at the exact sizes Slate draws so it never
    // rescales at draw time. These are filled two-tone silhouettes whose whole
    // legibility argument is crisp edges; a Slate downscale is a bilinear blur.
    // Rasters are generated by tools/build-icons.mjs from the signed masters --
    // do not hand-edit anything under Resources/Icons.
    {
        const FVector2D Sidebar(28.f, 28.f);
        const FVector2D Inline16(16.f, 16.f);

        // IMAGE_BRUSH, not a direct FSlateImageBrush: this file #defines
        // RootToContentDir as StyleInstance->RootToContentDir, so spelling that
        // identifier ourselves would expand to StyleInstance->StyleInstance->...
        auto Icon = [&Style, &Sidebar, &Inline16](const TCHAR* Token, const TCHAR* File)
        {
            // "<Token>"   -> 28px, the sidebar size
            // "<Token>.S" -> 16px, inline and row-end marks
            const FString Big   = FString(TEXT("Icons/")) + File + TEXT("@28");
            const FString Small = FString(TEXT("Icons/")) + File + TEXT("@16");
            Style->Set(Token,                                new IMAGE_BRUSH(*Big,   Sidebar));
            Style->Set(*(FString(Token) + TEXT(".S")),        new IMAGE_BRUSH(*Small, Inline16));
        };

        // The five nouns plus the gear.
        Icon(TEXT("Hayba.Icon.World"),    TEXT("world"));
        Icon(TEXT("Hayba.Icon.Library"),  TEXT("library"));
        Icon(TEXT("Hayba.Icon.Rules"),    TEXT("rules"));
        Icon(TEXT("Hayba.Icon.Activity"), TEXT("activity"));
        Icon(TEXT("Hayba.Icon.Chat"),     TEXT("chat"));
        Icon(TEXT("Hayba.Icon.Settings"), TEXT("settings"));

        // Semantic marks.
        Icon(TEXT("Hayba.Icon.Profile"),      TEXT("profile"));
        Icon(TEXT("Hayba.Icon.Recipe"),       TEXT("recipe"));
        Icon(TEXT("Hayba.Icon.RulePass"),     TEXT("rule-pass"));
        Icon(TEXT("Hayba.Icon.RuleViolated"), TEXT("rule-violated"));
        Icon(TEXT("Hayba.Icon.PlanPending"),  TEXT("plan-pending"));
        Icon(TEXT("Hayba.Icon.Diff"),         TEXT("diff"));
        Icon(TEXT("Hayba.Icon.Undo"),         TEXT("undo"));

        // Actions.
        Icon(TEXT("Hayba.Icon.Run"),     TEXT("run"));
        Icon(TEXT("Hayba.Icon.Approve"), TEXT("approve"));
        Icon(TEXT("Hayba.Icon.Reject"),  TEXT("reject"));
        Icon(TEXT("Hayba.Icon.Save"),    TEXT("save"));
        Icon(TEXT("Hayba.Icon.Search"),  TEXT("search"));
        Icon(TEXT("Hayba.Icon.Refresh"), TEXT("refresh"));
        Icon(TEXT("Hayba.Icon.Add"),     TEXT("add"));
        Icon(TEXT("Hayba.Icon.Remove"),  TEXT("remove"));
        Icon(TEXT("Hayba.Icon.Close"),   TEXT("close"));
        Icon(TEXT("Hayba.Icon.Expand"),  TEXT("expand"));
        Icon(TEXT("Hayba.Icon.Capture"), TEXT("capture"));
        Icon(TEXT("Hayba.Icon.Connect"), TEXT("connect"));

        // Unreal domains.
        Icon(TEXT("Hayba.Icon.Terrain"),   TEXT("terrain"));
        Icon(TEXT("Hayba.Icon.Foliage"),   TEXT("foliage"));
        Icon(TEXT("Hayba.Icon.PCGGraph"),  TEXT("pcg-graph"));
        Icon(TEXT("Hayba.Icon.Material"),  TEXT("material"));
        Icon(TEXT("Hayba.Icon.Blueprint"), TEXT("blueprint"));
        Icon(TEXT("Hayba.Icon.Python"),    TEXT("python"));
        Icon(TEXT("Hayba.Icon.Build"),     TEXT("build"));
        Icon(TEXT("Hayba.Icon.Viewport"),  TEXT("camera-viewport"));

        // State marks. Inline beside text, or in the row-end slot -- never
        // composited onto another icon. 16px is their only size.
        auto StateMark = [&Style, &Inline16](const TCHAR* Token, const TCHAR* File)
        {
            const FString Path = FString(TEXT("Icons/")) + File + TEXT("@16");
            Style->Set(Token, new IMAGE_BRUSH(*Path, Inline16));
        };
        StateMark(TEXT("Hayba.State.Attention"), TEXT("state-attention"));
        StateMark(TEXT("Hayba.State.Pending"),   TEXT("state-pending"));
        StateMark(TEXT("Hayba.State.Unsaved"),   TEXT("state-unsaved"));

        // The tabs this pass does not rename still need brushes, and leaving
        // them on the old SVGs would put seven outline icons beside four filled
        // ones in the same sidebar -- worse than either set alone. So the old
        // tokens are re-pointed at the signed rasters whose meaning already
        // matches the tab. No tab is renamed, moved, or removed here; that is
        // P3b. This is the same "look only" scope, applied to the whole strip
        // instead of the part that happened to share a name.
        Icon(TEXT("Hayba.Icon.ToolStream"), TEXT("activity"));     // live trace of tool calls
        Icon(TEXT("Hayba.Icon.SceneMap"),   TEXT("world"));        // the scene's cognitive map
        Icon(TEXT("Hayba.Icon.Plan"),       TEXT("plan-pending")); // steps awaiting approval
        Icon(TEXT("Hayba.Icon.Validation"), TEXT("rules"));        // what must be true
        Icon(TEXT("Hayba.Icon.Memory"),     TEXT("blueprint"));    // Lessons: the written why
        Icon(TEXT("Hayba.Icon.MCP"),        TEXT("connect"));      // which tools the agent sees
        Icon(TEXT("Hayba.Icon.Slivers"),    TEXT("recipe"));       // slivers are Recipes
        Icon(TEXT("Hayba.Icon.Setup"),      TEXT("run"));          // first-run wizard

        // Still SVG: a 72px hero image with no raster equivalent, and the logo
        // above, which is real vector art and must keep scaling cleanly.
        Style->Set("Hayba.MCP.Hero", new IMAGE_BRUSH_SVG(TEXT("MCPHero"), FVector2D(72.f, 72.f)));
    }

    // Typography. Sizes match the published ramp; colours come from the tokens
    // above rather than from per-style literals, so a palette change is one
    // edit instead of six that drift.
    {
        const FLinearColor Primary   = Style->GetColor("Hayba.Color.Text.Primary");
        const FLinearColor Secondary = Style->GetColor("Hayba.Color.Text.Secondary");
        const FLinearColor Muted     = Style->GetColor("Hayba.Color.Text.Muted");

        auto Text = [&Style](const TCHAR* Token, int32 Size, const FLinearColor& Tint)
        {
            FTextBlockStyle S = FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("NormalText");
            S.SetFontSize(Size).SetColorAndOpacity(Tint);
            Style->Set(Token, S);
        };

        Text(TEXT("Hayba.Text.Title"),    20, Primary);
        Text(TEXT("Hayba.Text.AppTitle"), 18, Primary);
        Text(TEXT("Hayba.Text.Heading"),  15, Secondary);
        Text(TEXT("Hayba.Text.Body"),     12, Secondary);
        Text(TEXT("Hayba.Text.TabLabel"), 11, Secondary);
        Text(TEXT("Hayba.Text.Caption"),  10, Muted);
    }

    return Style;
}

#undef RootToContentDir
