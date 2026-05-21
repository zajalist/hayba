// Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPSceneMapWebPanel.cpp
#include "HaybaMCPSceneMapWebPanel.h"
#include "HaybaMCPCogMapBuilder.h"

#include "SWebBrowser.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Text/STextBlock.h"
#include "Styling/AppStyle.h"
#include "Interfaces/IPluginManager.h"
#include "Misc/Paths.h"
#include "Misc/FileHelper.h"
#include "Editor.h"

void SHaybaMCPSceneMapWebPanel::Construct(const FArguments& InArgs)
{
    const FString Url = ResolveHtmlUrl();

    // Build the SWebBrowser, defer page-loaded callback until DOM is ready.
    SAssignNew(Browser, SWebBrowser)
        .InitialURL(Url)
        .ShowControls(false)
        .ShowAddressBar(false)
        .SupportsTransparency(false)
        .OnLoadCompleted_Lambda([this]() { OnPageLoaded(); });

    ChildSlot
    [
        SNew(SVerticalBox)
        + SVerticalBox::Slot().FillHeight(1.f)
        [ Browser.ToSharedRef() ]
    ];

    // Build the initial cells now so once the page reports loaded we can
    // push them straight in.
    Refresh();
}

FString SHaybaMCPSceneMapWebPanel::ResolveHtmlUrl() const
{
    TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("HaybaMCPToolkit"));
    if (!Plugin.IsValid()) return TEXT("about:blank");
    const FString Path = FPaths::ConvertRelativePathToFull(
        Plugin->GetBaseDir() / TEXT("Resources/cognitive-map/index.html"));
    return FString::Printf(TEXT("file:///%s"), *Path.Replace(TEXT("\\"), TEXT("/")));
}

void SHaybaMCPSceneMapWebPanel::Refresh()
{
    if (!GEditor) { Cells.Reset(); return; }
    UWorld* World = GEditor->GetEditorWorldContext().World();
    Cells = HaybaCogMap::BuildForWorld(World);
    if (bPageLoaded) PushCellsToPage();
}

void SHaybaMCPSceneMapWebPanel::OnPageLoaded()
{
    bPageLoaded = true;
    PushCellsToPage();
}

void SHaybaMCPSceneMapWebPanel::FitView()  { Run(TEXT("window.haybaFit && window.haybaFit();")); }
void SHaybaMCPSceneMapWebPanel::ResetView(){ Run(TEXT("window.haybaReset && window.haybaReset();")); }

void SHaybaMCPSceneMapWebPanel::PushCellsToPage()
{
    const FString Json = CellsToJson();
    // ExecuteJavascript is the safest bridge: a single function call with a
    // JSON-string payload. Avoids the BindObject API which varies across UE
    // versions.
    FString Escaped = Json.Replace(TEXT("\\"), TEXT("\\\\")).Replace(TEXT("\""), TEXT("\\\""));
    const FString Js = FString::Printf(TEXT("window.haybaLoadCells(\"%s\");"), *Escaped);
    Run(Js);
}

void SHaybaMCPSceneMapWebPanel::Run(const FString& Js)
{
    if (Browser.IsValid()) Browser->ExecuteJavascript(Js);
}

FString SHaybaMCPSceneMapWebPanel::CellsToJson() const
{
    // Hand-rolled JSON keeps this self-contained and avoids round-tripping
    // through FJsonSerializer for a fixed-shape payload.
    auto EscStr = [](const FString& S) -> FString
    {
        FString Out; Out.Reserve(S.Len() + 4);
        for (TCHAR C : S)
        {
            switch (C)
            {
                case TEXT('"'):  Out += TEXT("\\\""); break;
                case TEXT('\\'): Out += TEXT("\\\\"); break;
                case TEXT('\n'): Out += TEXT("\\n");  break;
                case TEXT('\r'): Out += TEXT("\\r");  break;
                case TEXT('\t'): Out += TEXT("\\t");  break;
                default: Out.AppendChar(C);
            }
        }
        return Out;
    };

    FString J = TEXT("{\"cells\":[");
    for (int32 i = 0; i < Cells.Num(); ++i)
    {
        const FHaybaCogMapCell& C = Cells[i];
        if (i) J += TEXT(",");
        J += FString::Printf(TEXT("{\"label\":\"%s\",\"count\":%d,\"bounds\":{\"min\":[%.3f,%.3f],\"max\":[%.3f,%.3f]},\"dominant\":["),
            *EscStr(C.Label), C.ActorCount,
            C.Bounds.Min.X, C.Bounds.Min.Y, C.Bounds.Max.X, C.Bounds.Max.Y);
        for (int32 d = 0; d < C.DominantClasses.Num(); ++d)
        {
            if (d) J += TEXT(",");
            J += TEXT("\"") + EscStr(C.DominantClasses[d]) + TEXT("\"");
        }
        J += TEXT("],\"tags\":[");
        for (int32 t = 0; t < C.Tags.Num(); ++t)
        {
            if (t) J += TEXT(",");
            J += TEXT("\"") + EscStr(C.Tags[t]) + TEXT("\"");
        }
        J += TEXT("]}");
    }
    J += TEXT("]}");
    return J;
}
