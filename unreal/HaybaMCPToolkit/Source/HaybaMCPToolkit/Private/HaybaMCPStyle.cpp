#include "HaybaMCPStyle.h"
#include "Styling/SlateStyleRegistry.h"
#include "Styling/SlateStyleMacros.h"
#include "Styling/SlateTypes.h"
#include "Brushes/SlateImageBrush.h"
#include "Brushes/SlateColorBrush.h"
#include "Brushes/SlateRoundedBoxBrush.h"
#include "Interfaces/IPluginManager.h"
#include "Misc/Paths.h"
#include "Fonts/SlateFontInfo.h"
#include "Styling/AppStyle.h"
#include "Styling/CoreStyle.h"

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

FSlateFontInfo FHaybaMCPStyle::Font(int32 Size, bool bSemibold)
{
    if (!StyleInstance.IsValid()) return FCoreStyle::GetDefaultFontStyle(bSemibold ? "Bold" : "Regular", Size);
    return FSlateFontInfo(StyleInstance->RootToContentDir(
        bSemibold ? TEXT("Fonts/noto-sans-latin-600-normal.ttf")
                  : TEXT("Fonts/noto-sans-latin-400-normal.ttf")), Size);
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

    // One restrained icon family across the task header and optional views.
    // Sources are Phosphor regular SVGs; see Icons/LICENSE.phosphor.
    Style->Set("Hayba.Icon.Nav.Chat",     new IMAGE_BRUSH_SVG(TEXT("Icons/chat"),     FVector2D(20.f, 20.f)));
    Style->Set("Hayba.Icon.Nav.Activity", new IMAGE_BRUSH_SVG(TEXT("Icons/activity"), FVector2D(20.f, 20.f)));
    Style->Set("Hayba.Icon.Nav.Rules",    new IMAGE_BRUSH_SVG(TEXT("Icons/rules"),    FVector2D(20.f, 20.f)));
    Style->Set("Hayba.Icon.Nav.World",    new IMAGE_BRUSH_SVG(TEXT("Icons/world"),    FVector2D(20.f, 20.f)));
    Style->Set("Hayba.Icon.Nav.Library",  new IMAGE_BRUSH_SVG(TEXT("Icons/library"),  FVector2D(20.f, 20.f)));
    Style->Set("Hayba.Icon.Nav.Settings", new IMAGE_BRUSH_SVG(TEXT("Icons/settings"), FVector2D(20.f, 20.f)));
    Style->Set("Hayba.Icon.Nav.More",     new IMAGE_BRUSH_SVG(TEXT("Icons/more"),     FVector2D(20.f, 20.f)));
    Style->Set("Hayba.Icon.Send",         new IMAGE_BRUSH_SVG(TEXT("Icons/send"),         FVector2D(16.f, 16.f)));
    Style->Set("Hayba.Icon.Stop",         new IMAGE_BRUSH_SVG(TEXT("Icons/stop"),         FVector2D(16.f, 16.f)));
    Style->Set("Hayba.Icon.Inspect",      new IMAGE_BRUSH_SVG(TEXT("Icons/inspect"),      FVector2D(18.f, 18.f)));
    Style->Set("Hayba.Icon.New",          new IMAGE_BRUSH_SVG(TEXT("Icons/new"),          FVector2D(18.f, 18.f)));
    Style->Set("Hayba.Icon.Copy",         new IMAGE_BRUSH_SVG(TEXT("Icons/copy"),         FVector2D(16.f, 16.f)));

    // ── Design tokens ────────────────────────────────────────────────────────
    // Warm neutral charcoal is shared with cognitive-map/index.html. Ochre
    // carries interaction meaning and the logo remains unretinted.
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
        Tok(TEXT("Hayba.Color.Surface.Panel"),  FLinearColor::FromSRGBColor(FColor(0x21, 0x1F, 0x1D)));
        Tok(TEXT("Hayba.Color.Surface.Raised"), FLinearColor::FromSRGBColor(FColor(0x2B, 0x28, 0x25)));
        Tok(TEXT("Hayba.Color.Surface.Sunken"), FLinearColor::FromSRGBColor(FColor(0x19, 0x18, 0x16)));
        Tok(TEXT("Hayba.Color.Surface.Canvas"), FLinearColor::FromSRGBColor(FColor(0x21, 0x1F, 0x1D)));
        Tok(TEXT("Hayba.Color.Surface.Hover"),  FLinearColor::FromSRGBColor(FColor(0x38, 0x33, 0x2E)));

        // Lines
        Tok(TEXT("Hayba.Color.Border.Subtle"),  FLinearColor::FromSRGBColor(FColor(0x4A, 0x44, 0x3D)));
        Tok(TEXT("Hayba.Color.Border.Strong"),  FLinearColor::FromSRGBColor(FColor(0x68, 0x5E, 0x53)));

        // Text
        Tok(TEXT("Hayba.Color.Text.Primary"),   FLinearColor::FromSRGBColor(FColor(0xF1, 0xED, 0xE6)));
        Tok(TEXT("Hayba.Color.Text.Secondary"), FLinearColor::FromSRGBColor(FColor(0xC9, 0xBF, 0xB2)));
        Tok(TEXT("Hayba.Color.Text.Muted"),     FLinearColor::FromSRGBColor(FColor(0xA9, 0x9D, 0x90)));

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
        // Severity is its own axis: how much a finding matters, as opposed to
        // Cat.* which says what it is about.
        //
        // These carry the Validation panel's ORIGINAL literals unchanged
        // (1.0,0.85,0.2 amber and 0.55,0.7,1.0 blue), so adding them moved the
        // colours into the token system without altering a single pixel. An
        // earlier revision retuned them to sit beside Pass and Fail, which was
        // a real improvement and also a visible change nobody had approved --
        // and palette curation is not a call to make on someone's behalf.
        //
        // Retuning is now a two-line edit here, with nothing else to change:
        //     Warn -> FColor(0xC9, 0xA2, 0x5E)   (muted amber)
        //     Info -> FColor(0x7E, 0x9C, 0xC4)   (muted blue)
        Tok(TEXT("Hayba.Color.Status.Warn"),    FLinearColor(1.0f, 0.85f, 0.2f));
        Tok(TEXT("Hayba.Color.Status.Info"),    FLinearColor(0.55f, 0.7f, 1.0f));

        // Categorical palette — for telling *kinds* apart, not for status.
        //
        // The Tool Stream already had ten of these inline, and two of them were
        // a problem: Performance sat 1.5 degrees from the semantic ochre and
        // Scene 9.6, so two ordinary categories were visually indistinguishable
        // from "needs your attention". Actor and Plan were 7.6 degrees apart
        // from each other, which is not a distinction anyone can make.
        //
        // These hues are all at least 25 degrees clear of the ochre and at
        // least 30 apart from each other, at a shared saturation and value so
        // no one category shouts louder than the rest. Value is pulled down
        // from the originals' 1.0, which glares on this chrome.
        //
        // Error is deliberately absent: an error is a status, not a category,
        // and belongs to Status.Fail so the two can never drift apart.
        Tok(TEXT("Hayba.Color.Cat.Performance"), FLinearColor::FromSRGBColor(FColor(0xCA, 0xDB, 0x72)));
        Tok(TEXT("Hayba.Color.Cat.Script"),      FLinearColor::FromSRGBColor(FColor(0x95, 0xDB, 0x72)));
        Tok(TEXT("Hayba.Color.Cat.Scene"),       FLinearColor::FromSRGBColor(FColor(0x72, 0xDB, 0x9E)));
        Tok(TEXT("Hayba.Color.Cat.Actor"),       FLinearColor::FromSRGBColor(FColor(0x72, 0xCA, 0xDB)));
        Tok(TEXT("Hayba.Color.Cat.Plan"),        FLinearColor::FromSRGBColor(FColor(0x72, 0x8C, 0xDB)));
        Tok(TEXT("Hayba.Color.Cat.Memory"),      FLinearColor::FromSRGBColor(FColor(0x99, 0x72, 0xDB)));
        Tok(TEXT("Hayba.Color.Cat.Asset"),       FLinearColor::FromSRGBColor(FColor(0xCD, 0x72, 0xDB)));
        Tok(TEXT("Hayba.Color.Cat.Image"),       FLinearColor::FromSRGBColor(FColor(0xDB, 0x72, 0xAF)));
        Tok(TEXT("Hayba.Color.Cat.Neutral"),     FLinearColor::FromSRGBColor(FColor(0xB0, 0xB6, 0xC0)));

        // Scene-map node semantics. These lived as literals in
        // HaybaMCPSceneMapPanel.cpp, outside the visual system: nothing could
        // check them, reuse them, or notice them drifting. Registered here at
        // their EXISTING values -- this moves them into the system without
        // changing a pixel.
        Tok(TEXT("Hayba.Color.Semantic.Foliage"),   FLinearColor(0.30f, 0.70f, 0.40f));
        Tok(TEXT("Hayba.Color.Semantic.Building"),  FLinearColor(0.55f, 0.60f, 0.75f));
        Tok(TEXT("Hayba.Color.Semantic.Light"),     FLinearColor(1.00f, 0.85f, 0.35f));
        Tok(TEXT("Hayba.Color.Semantic.Trigger"),   FLinearColor(0.35f, 0.75f, 1.00f));
        Tok(TEXT("Hayba.Color.Semantic.Character"), FLinearColor(1.00f, 0.45f, 0.45f));
        Tok(TEXT("Hayba.Color.Semantic.Blueprint"), FLinearColor(0.70f, 0.50f, 1.00f));
        Tok(TEXT("Hayba.Color.Semantic.Unknown"),   FLinearColor(0.70f, 0.72f, 0.78f));

        // Metrics — so spacing stops being magic numbers at each call site.
        Style->Set(TEXT("Hayba.Metric.Radius.Chip"),  8.f);
        Style->Set(TEXT("Hayba.Metric.Radius.Card"), 10.f);
        Style->Set(TEXT("Hayba.Metric.Radius.Panel"), 12.f);
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

    // Native dock surfaces and control states share the same three radii.
    // The large rounded areas are structural (canvas and composer), while
    // controls use the smaller radius and remain recognizably Unreal Slate.
    {
        const FLinearColor Panel = Style->GetColor("Hayba.Color.Surface.Panel");
        const FLinearColor Canvas = Style->GetColor("Hayba.Color.Surface.Canvas");
        const FLinearColor Raised = Style->GetColor("Hayba.Color.Surface.Raised");
        const FLinearColor Sunken = Style->GetColor("Hayba.Color.Surface.Sunken");
        const FLinearColor Hover = Style->GetColor("Hayba.Color.Surface.Hover");
        const FLinearColor Border = Style->GetColor("Hayba.Color.Border.Subtle");
        const FLinearColor StrongBorder = Style->GetColor("Hayba.Color.Border.Strong");
        const float ControlRadius = Style->GetFloat("Hayba.Metric.Radius.Chip");
        const float CardRadius = Style->GetFloat("Hayba.Metric.Radius.Card");
        const float PanelRadius = Style->GetFloat("Hayba.Metric.Radius.Panel");

        Style->Set("Hayba.Brush.Dock", new FSlateColorBrush(Panel));
        Style->Set("Hayba.Brush.Canvas", new FSlateColorBrush(Canvas));
        Style->Set("Hayba.Brush.Settings.Section", new FSlateRoundedBoxBrush(Raised, CardRadius, Border, 1.f));
        Style->Set("Hayba.Brush.Composer", new FSlateRoundedBoxBrush(Raised, PanelRadius, Border, 1.f));
        Style->Set("Hayba.Brush.Proposal", new FSlateRoundedBoxBrush(Raised, CardRadius, Style->GetColor("Hayba.Color.Accent.Ochre"), 1.f));
        Style->Set("Hayba.Brush.EmptyMark", new FSlateRoundedBoxBrush(Raised, CardRadius, Border, 1.f));
        Style->Set("Hayba.Brush.Nav.Active", new FSlateRoundedBoxBrush(Raised, ControlRadius));
        Style->Set("Hayba.Brush.Nav.Inactive", new FSlateRoundedBoxBrush(FLinearColor::Transparent, ControlRadius));

        const FSlateRoundedBoxBrush Clear(FLinearColor::Transparent, ControlRadius);
        const FSlateRoundedBoxBrush HoverBrush(Hover, ControlRadius);
        const FSlateRoundedBoxBrush PressedBrush(Sunken, ControlRadius);
        const FSlateRoundedBoxBrush RaisedBrush(Raised, ControlRadius, Border, 1.f);
        const FSlateRoundedBoxBrush RaisedHover(Hover, ControlRadius, StrongBorder, 1.f);

        FButtonStyle IconButton = FAppStyle::Get().GetWidgetStyle<FButtonStyle>("SimpleButton");
        IconButton.SetNormal(Clear).SetHovered(HoverBrush).SetPressed(PressedBrush)
            .SetDisabled(Clear).SetNormalPadding(FMargin(0.f)).SetPressedPadding(FMargin(0.f));
        Style->Set("Hayba.Button.Icon", IconButton);

        FButtonStyle TaskButton = IconButton;
        TaskButton.SetHovered(FSlateRoundedBoxBrush(Hover, ControlRadius))
            .SetPressed(FSlateRoundedBoxBrush(Raised, ControlRadius));
        Style->Set("Hayba.Button.Task", TaskButton);

        FButtonStyle SwitcherButton = IconButton;
        SwitcherButton.SetNormal(RaisedBrush).SetHovered(RaisedHover).SetPressed(PressedBrush)
            .SetDisabled(RaisedBrush);
        Style->Set("Hayba.Button.Switcher", SwitcherButton);

        FButtonStyle SendButton = IconButton;
        SendButton.SetNormal(RaisedHover).SetHovered(FSlateRoundedBoxBrush(Hover, ControlRadius, Style->GetColor("Hayba.Color.Text.Muted"), 1.f))
            .SetPressed(PressedBrush).SetDisabled(RaisedBrush);
        Style->Set("Hayba.Button.Send", SendButton);

        FEditableTextBoxStyle ComposerText = FAppStyle::Get().GetWidgetStyle<FEditableTextBoxStyle>("NormalEditableTextBox");
        const FSlateColorBrush TransparentInput(FLinearColor::Transparent);
        ComposerText.SetBackgroundImageNormal(TransparentInput)
            .SetBackgroundImageHovered(TransparentInput)
            .SetBackgroundImageFocused(TransparentInput)
            .SetBackgroundImageReadOnly(TransparentInput)
            .SetForegroundColor(Style->GetColor("Hayba.Color.Text.Primary"))
            .SetFocusedForegroundColor(Style->GetColor("Hayba.Color.Text.Primary"));
        Style->Set("Hayba.Input.Composer", ComposerText);
    }

    // Typography. Sizes match the published ramp; colours come from the tokens
    // above rather than from per-style literals, so a palette change is one
    // edit instead of six that drift.
    {
        const FLinearColor Primary   = Style->GetColor("Hayba.Color.Text.Primary");
        const FLinearColor Secondary = Style->GetColor("Hayba.Color.Text.Secondary");
        const FLinearColor Muted     = Style->GetColor("Hayba.Color.Text.Muted");

        auto Text = [&Style](const TCHAR* Token, int32 Size, const FLinearColor& Tint, bool bSemibold = false)
        {
            FTextBlockStyle S = FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("NormalText");
            S.SetFont(FHaybaMCPStyle::Font(Size, bSemibold)).SetColorAndOpacity(Tint);
            Style->Set(Token, S);
        };

        Text(TEXT("Hayba.Text.Title"),    20, Primary, true);
        Text(TEXT("Hayba.Text.AppTitle"), 16, Primary, true);
        Text(TEXT("Hayba.Text.Heading"),  15, Primary, true);
        Text(TEXT("Hayba.Text.Body"),     13, Primary);
        Text(TEXT("Hayba.Text.TabLabel"), 12, Secondary, true);
        Text(TEXT("Hayba.Text.Caption"),  11, Muted);
    }

    return Style;
}

#undef RootToContentDir
