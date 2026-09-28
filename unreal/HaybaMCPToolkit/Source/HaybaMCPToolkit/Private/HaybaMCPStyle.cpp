#include "HaybaMCPStyle.h"
#include "Styling/SlateStyleRegistry.h"
#include "Styling/SlateStyleMacros.h"
#include "Styling/SlateTypes.h"
#include "Interfaces/IPluginManager.h"
#include "Misc/Paths.h"
#include "Fonts/SlateFontInfo.h"
#include "Styling/AppStyle.h"
#include "Brushes/SlateRoundedBoxBrush.h"

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

    // Product navigation shares one 24 px outline grid. White SVG strokes are
    // multiplied by Slate's foreground tint, so state lives in the widget.
    const FVector2D IconSize(24.f, 24.f);
    Style->Set("Hayba.Icon.Agent",    new IMAGE_BRUSH_SVG(TEXT("IconAgent"), IconSize));
    Style->Set("Hayba.Icon.World",    new IMAGE_BRUSH_SVG(TEXT("IconWorld"), IconSize));
    Style->Set("Hayba.Icon.Library",  new IMAGE_BRUSH_SVG(TEXT("IconLibrary"), IconSize));
    Style->Set("Hayba.Icon.Settings", new IMAGE_BRUSH_SVG(TEXT("IconSettings"), IconSize));
    Style->Set("Hayba.Color.Active", FSlateColor(FLinearColor(0.769f, 0.478f, 0.157f)));
    Style->Set("Hayba.Color.Pending", FSlateColor(FLinearColor(0.769f, 0.478f, 0.157f)));
    Style->Set("Hayba.Color.Unsaved", FSlateColor(FLinearColor(0.769f, 0.478f, 0.157f)));
    Style->Set("Hayba.Color.Violation", FSlateColor(FLinearColor(0.769f, 0.478f, 0.157f)));

    // Compatibility brushes for panels that are being retired.
    Style->Set("Hayba.Icon.Chat",       new IMAGE_BRUSH_SVG(TEXT("IconChat"),        IconSize));
    Style->Set("Hayba.Icon.ToolStream", new IMAGE_BRUSH_SVG(TEXT("IconToolStream"),  IconSize));
    Style->Set("Hayba.Icon.SceneMap",   new IMAGE_BRUSH_SVG(TEXT("IconSceneMap"),    IconSize));
    Style->Set("Hayba.Icon.Plan",       new IMAGE_BRUSH_SVG(TEXT("IconPlan"),        IconSize));
    Style->Set("Hayba.Icon.Diff",       new IMAGE_BRUSH_SVG(TEXT("IconDiff"),        IconSize));
    Style->Set("Hayba.Icon.Validation", new IMAGE_BRUSH_SVG(TEXT("IconValidation"),  IconSize));
    Style->Set("Hayba.Icon.Memory",     new IMAGE_BRUSH_SVG(TEXT("IconMemory"),      IconSize));
    Style->Set("Hayba.Icon.Setup",      new IMAGE_BRUSH_SVG(TEXT("IconSetup"),       IconSize));
    Style->Set("Hayba.Icon.MCP",        new IMAGE_BRUSH_SVG(TEXT("IconMCP"),         IconSize));
    Style->Set("Hayba.Icon.Slivers",    new IMAGE_BRUSH_SVG(TEXT("IconSlivers"),     IconSize));
    Style->Set("Hayba.MCP.Hero",        new IMAGE_BRUSH_SVG(TEXT("MCPHero"),         FVector2D(72.f, 72.f)));

    FButtonStyle Nav = FAppStyle::Get().GetWidgetStyle<FButtonStyle>("SimpleButton");
    Nav.SetNormal(FSlateRoundedBoxBrush(FLinearColor::White, 6.f));
    Nav.SetHovered(FSlateRoundedBoxBrush(FLinearColor(0.24f, 0.21f, 0.17f), 6.f));
    Nav.SetPressed(FSlateRoundedBoxBrush(FLinearColor(0.31f, 0.23f, 0.14f), 6.f));
    Style->Set("Hayba.Button.Nav", Nav);
    Style->Set("Hayba.Composer", new FSlateRoundedBoxBrush(FLinearColor(0.055f, 0.052f, 0.047f), 8.f,
        FLinearColor(0.19f, 0.17f, 0.14f), 1.f));

    // Typography — bigger, more breathing room
    {
        FTextBlockStyle AppTitle = FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("NormalText");
        AppTitle.SetFontSize(18).SetColorAndOpacity(FLinearColor(0.95f, 0.97f, 1.0f));
        Style->Set("Hayba.Text.AppTitle", AppTitle);

        FTextBlockStyle Title = FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("NormalText");
        Title.SetFontSize(20).SetColorAndOpacity(FLinearColor(0.95f, 0.97f, 1.0f));
        Style->Set("Hayba.Text.Title", Title);

        FTextBlockStyle Heading = FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("NormalText");
        Heading.SetFontSize(15).SetColorAndOpacity(FLinearColor(0.85f, 0.88f, 0.95f));
        Style->Set("Hayba.Text.Heading", Heading);

        FTextBlockStyle Body = FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("NormalText");
        Body.SetFontSize(12).SetColorAndOpacity(FLinearColor(0.78f, 0.82f, 0.90f));
        Style->Set("Hayba.Text.Body", Body);

        FTextBlockStyle Caption = FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("NormalText");
        Caption.SetFontSize(10).SetColorAndOpacity(FLinearColor(0.6f, 0.65f, 0.75f));
        Style->Set("Hayba.Text.Caption", Caption);

        FTextBlockStyle TabLabel = FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("NormalText");
        TabLabel.SetFontSize(11).SetColorAndOpacity(FLinearColor(0.85f, 0.88f, 0.95f));
        Style->Set("Hayba.Text.TabLabel", TabLabel);
    }

    return Style;
}

#undef RootToContentDir
