#include "HaybaMCPStyle.h"
#include "Styling/SlateStyleRegistry.h"
#include "Styling/SlateStyleMacros.h"
#include "Interfaces/IPluginManager.h"
#include "Misc/Paths.h"

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

    Style->Set("Hayba.Logo",     new IMAGE_BRUSH_SVG(TEXT("HaybaLogo"),     FVector2D(160.f, 160.f)));
    Style->Set("Hayba.Wordmark", new IMAGE_BRUSH_SVG(TEXT("HaybaWordmark"), FVector2D(280.f, 60.f)));

    return Style;
}

#undef RootToContentDir
