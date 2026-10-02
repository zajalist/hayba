// Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPSceneMapWebPanel.cpp
#include "HaybaMCPSceneMapWebPanel.h"

#include "SWebBrowser.h"
#include "IWebBrowserWindow.h"
#include "GenericPlatform/GenericPlatformHttp.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Text/STextBlock.h"
#include "Styling/AppStyle.h"
#include "Interfaces/IPluginManager.h"
#include "Misc/Paths.h"
#include "Misc/FileHelper.h"
#include "Editor.h"
#include "GameFramework/Actor.h"
#include "Components/StaticMeshComponent.h"
#include "Components/SkeletalMeshComponent.h"
#include "Engine/Level.h"
#include "Engine/World.h"
#include "HAL/PlatformTime.h"
#include "LandscapeComponent.h"
#include "Async/Async.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

void SHaybaMCPSceneMapWebPanel::Construct(const FArguments& InArgs)
{
    const FString Url = ResolveHtmlUrl();
    TWeakPtr<SHaybaMCPSceneMapWebPanel> WeakPanel = SharedThis(this);

    // Build the SWebBrowser, defer page-loaded callback until DOM is ready.
    SAssignNew(Browser, SWebBrowser)
        .InitialURL(Url)
        .ShowControls(false)
        .ShowAddressBar(false)
        .SupportsTransparency(false)
        .OnBeforeNavigation_Lambda([WeakPanel, Url](const FString& TargetUrl, const FWebNavigationRequest& Request)
        {
            static const FString Prefix = TEXT("hayba-scene-map://select/");
            static const FString RefreshPrefix = TEXT("hayba-scene-map://refresh/");
            // The panel has one local document. No actor-derived content may
            // navigate its main frame to a network or another local page.
            if (TargetUrl.StartsWith(RefreshPrefix))
            {
                if (!Request.bIsMainFrame) return true;
                int32 Generation = 0;
                const FString GenerationText = TargetUrl.Mid(RefreshPrefix.Len());
                if (!GenerationText.IsNumeric() || !LexTryParseString(Generation, *GenerationText) || Generation <= 0) return true;
                AsyncTask(ENamedThreads::GameThread, [WeakPanel, Generation]()
                {
                    if (TSharedPtr<SHaybaMCPSceneMapWebPanel> Panel = WeakPanel.Pin())
                    {
                        if (Generation == Panel->ScanGeneration) Panel->Refresh();
                    }
                });
                return true;
            }
            if (!TargetUrl.StartsWith(Prefix))
            {
                return !TargetUrl.Equals(Url, ESearchCase::IgnoreCase) &&
                    !FGenericPlatformHttp::UrlDecode(TargetUrl).Equals(Url, ESearchCase::IgnoreCase);
            }
            // Always cancel our command URL. Reject malformed or subframe
            // requests, and perform editor selection on the game thread.
            if (!Request.bIsMainFrame) return true;
            FString GenerationText, IndexText;
            const FString Argument = TargetUrl.Mid(Prefix.Len());
            if (!Argument.Split(TEXT("/"), &GenerationText, &IndexText)) return true;
            int32 Generation = 0, ActorIndex = INDEX_NONE;
            if (!GenerationText.IsNumeric() || !IndexText.IsNumeric() ||
                !LexTryParseString(Generation, *GenerationText) ||
                !LexTryParseString(ActorIndex, *IndexText) ||
                Generation <= 0 || ActorIndex < 0) return true;
            AsyncTask(ENamedThreads::GameThread, [WeakPanel, Generation, ActorIndex]()
            {
                if (TSharedPtr<SHaybaMCPSceneMapWebPanel> Panel = WeakPanel.Pin())
                {
                    Panel->SelectLoadedActor(Generation, ActorIndex);
                }
            });
            return true;
        })
        .OnLoadCompleted_Lambda([this]() { OnPageLoaded(); });

    ChildSlot
    [
        SNew(SVerticalBox)
        + SVerticalBox::Slot().FillHeight(1.f)
        [ Browser.ToSharedRef() ]
    ];

    // The first slice runs on Tick after the local page is ready.
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
    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    ScannedWorld = World;
    Geometry = HaybaWorldGeometry::FSnapshot();
    Geometry.OriginCm = World ? FVector(World->OriginLocation) : FVector::ZeroVector;
    PendingGeometry = HaybaWorldGeometry::FSnapshot();
    PendingPointCursor = TotalPoints = ScannedActorSlots = TotalActorSlots = 0;
    LevelCursor = ActorCursor = 0;
    LoadedLevels.Reset(); LevelActorCounts.Reset(); DeferredActors.Reset(); DeferredAttempts.Reset(); ScanGaps.Reset();
    bScanDone = !World;
    bScanPartial = false;
    if (World)
    {
        for (ULevel* Level : World->GetLevels())
        {
            if (!IsValid(Level)) continue;
            LoadedLevels.Add(Level);
            const int32 Count = Level->Actors.Num();
            LevelActorCounts.Add(Count);
            TotalActorSlots += Count;
        }
    }
    ++ScanGeneration;
    if (bPageLoaded) PushGeometryToPage();
}

void SHaybaMCPSceneMapWebPanel::OnPageLoaded()
{
    bPageLoaded = true;
    PushGeometryToPage();
}

void SHaybaMCPSceneMapWebPanel::FitView()  { Run(TEXT("window.haybaFit && window.haybaFit();")); }
void SHaybaMCPSceneMapWebPanel::ResetView(){ Run(TEXT("window.haybaReset && window.haybaReset();")); }

void SHaybaMCPSceneMapWebPanel::PushGeometryToPage()
{
    Run(FString::Printf(TEXT("window.haybaLoadGeometry(%s);"), *GeometryToJson()));
    if (bScanDone) FinishScan();
}

void SHaybaMCPSceneMapWebPanel::Tick(const FGeometry& AllottedGeometry,
    const double InCurrentTime, const float InDeltaTime)
{
    SCompoundWidget::Tick(AllottedGeometry, InCurrentTime, InDeltaTime);
    if (!bPageLoaded || bScanDone) return;
    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    if (!IsValid(World) || ScannedWorld.Get() != World)
    {
        bScanPartial = true; ScanGaps.AddUnique(TEXT("editor_world_changed"));
        FinishScan(); return;
    }
    if (PendingPointCursor < PendingGeometry.Splats.Num())
    {
        SendPendingPointChunk();
        return;
    }
    PendingGeometry = HaybaWorldGeometry::FSnapshot();
    PendingPointCursor = 0;
    constexpr int32 TotalPointLimit = 131072;
    constexpr int32 BatchActorLimit = 8;
    constexpr int32 SlotVisitLimit = 128;
    if (TotalPoints >= TotalPointLimit)
    {
        bScanPartial = true; ScanGaps.AddUnique(TEXT("total_point_cap"));
        FinishScan(); return;
    }
    TArray<TWeakObjectPtr<AActor>> Batch;
    Batch.Reserve(BatchActorLimit);
    while (!DeferredActors.IsEmpty() && Batch.Num() < BatchActorLimit)
        Batch.Add(DeferredActors.Pop(EAllowShrinking::No));
    int32 SlotsThisTick = 0;
    const double ScanStart = FPlatformTime::Seconds();
    while (Batch.Num() < BatchActorLimit && SlotsThisTick < SlotVisitLimit && LevelCursor < LoadedLevels.Num()
        && FPlatformTime::Seconds() - ScanStart < 0.004)
    {
        ULevel* Level = LoadedLevels[LevelCursor].Get();
        const int32 OriginalCount = LevelActorCounts[LevelCursor];
        if (!IsValid(Level))
        {
            bScanPartial = true; ScanGaps.AddUnique(TEXT("loaded_level_unavailable"));
            ++LevelCursor; ActorCursor = 0; continue;
        }
        if (Level->Actors.Num() != OriginalCount)
        {
            bScanPartial = true; ScanGaps.AddUnique(TEXT("loaded_level_changed"));
        }
        if (ActorCursor >= OriginalCount)
        {
            ++LevelCursor; ActorCursor = 0; continue;
        }
        const int32 Slot = ActorCursor++;
        ++SlotsThisTick; ++ScannedActorSlots;
        if (!Level->Actors.IsValidIndex(Slot)) continue;
        AActor* Actor = Level->Actors[Slot];
        if (!IsValid(Actor) || Actor->GetWorld() != World || Actor->IsEditorOnly()) continue;
        int32 Inspected = 0;
        bool bRelevant = false;
        for (UActorComponent* Component : Actor->GetComponents())
        {
            if (++Inspected > 64)
            {
                bScanPartial = true; ScanGaps.AddUnique(TEXT("eligibility_component_cap"));
                break;
            }
            if (!IsValid(Component) || !Component->IsRegistered()) continue;
            if (Component->IsA<UStaticMeshComponent>() || Component->IsA<USkeletalMeshComponent>() ||
                Component->IsA<ULandscapeComponent>()) { bRelevant = true; break; }
        }
        if (bRelevant) Batch.Add(Actor);
    }
    if (Batch.IsEmpty())
    {
        if (LevelCursor >= LoadedLevels.Num() && DeferredActors.IsEmpty()) FinishScan();
        return;
    }
    // Allocate the fixed point budget across the loaded actor slots. Sparse
    // metadata actors leave headroom; small scenes receive much denser surfaces.
    const int32 PointsPerActor = FMath::Clamp(TotalPointLimit / FMath::Max(1, TotalActorSlots), 24, 512);
    const int32 PagePointLimit = FMath::Min3(4096, TotalPointLimit - TotalPoints,
        PointsPerActor * Batch.Num());
    PendingGeometry = HaybaWorldGeometry::BuildBatch(World, Batch, PagePointLimit, 0.020);
    for (const TWeakObjectPtr<AActor>& Input : Batch)
    {
        AActor* Actor = Input.Get();
        if (!IsValid(Actor) || Actor->GetWorld() != World) continue;
        const bool bProcessed = PendingGeometry.Actors.ContainsByPredicate(
            [Actor](const HaybaWorldGeometry::FActor& Entry) { return Entry.LoadedActor.Get() == Actor; });
        if (!bProcessed)
        {
            int32& Attempts = DeferredAttempts.FindOrAdd(Actor->GetPathName());
            if (++Attempts < 2) DeferredActors.Add(Actor);
            else { bScanPartial = true; ScanGaps.AddUnique(TEXT("actor_process_time_budget")); }
        }
    }
    for (const FString& Gap : PendingGeometry.StopReasons)
    {
        // A per-page point cap is planned density reduction, not lost actors.
        if (Gap != TEXT("splat_cap")) { bScanPartial = true; ScanGaps.AddUnique(Gap); }
    }
    const int32 ActorBase = Geometry.Actors.Num();
    Geometry.Actors.Append(PendingGeometry.Actors);
    TSharedRef<FJsonObject> Metadata = HaybaWorldGeometry::ToMetadataJson(PendingGeometry);
    Metadata->SetNumberField(TEXT("actorBase"), ActorBase);
    FString Json;
    const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Json);
    FJsonSerializer::Serialize(Metadata, Writer);
    Run(FString::Printf(TEXT("window.haybaAppendGeometry(%d,%s);"), ScanGeneration, *Json));
    TotalPoints += PendingGeometry.Splats.Num();
    if (PendingGeometry.Splats.IsEmpty() && LevelCursor >= LoadedLevels.Num() && DeferredActors.IsEmpty())
        FinishScan();
}

void SHaybaMCPSceneMapWebPanel::SendPendingPointChunk()
{
    // One ordinary eight-actor page now fits in one bounded browser message.
    // This avoids a second hidden-window Slate tick per page.
    constexpr int32 ChunkSize = 1024;
    const int32 Start = PendingPointCursor;
    const int32 End = FMath::Min(Start + ChunkSize, PendingGeometry.Splats.Num());
    if (Start < End)
    {
        TArray<TSharedPtr<FJsonValue>> Values;
        Values.Reserve(End - Start);
        for (int32 Index = Start; Index < End; ++Index)
            Values.Add(HaybaWorldGeometry::SplatToJson(PendingGeometry.Splats[Index]));
        FString Json;
        const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Json);
        FJsonSerializer::Serialize(Values, Writer);
        Run(FString::Printf(TEXT("window.haybaAppendSplats(%d,%s);"), ScanGeneration, *Json));
    }
    PendingPointCursor = End;
    if (PendingPointCursor >= PendingGeometry.Splats.Num() &&
        LevelCursor >= LoadedLevels.Num() && DeferredActors.IsEmpty()) FinishScan();
}

void SHaybaMCPSceneMapWebPanel::FinishScan()
{
    if (bScanDone && !bPageLoaded) return;
    bScanDone = true;
    TSharedRef<FJsonObject> Completion = MakeShared<FJsonObject>();
    Completion->SetBoolField(TEXT("partial"), bScanPartial);
    Completion->SetNumberField(TEXT("scannedActorSlots"), ScannedActorSlots);
    Completion->SetNumberField(TEXT("totalActorSlots"), TotalActorSlots);
    Completion->SetNumberField(TEXT("totalPointLimit"), 131072);
    TArray<TSharedPtr<FJsonValue>> Gaps;
    for (const FString& Gap : ScanGaps) Gaps.Add(MakeShared<FJsonValueString>(Gap));
    Completion->SetArrayField(TEXT("gaps"), Gaps);
    FString Json;
    const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Json);
    FJsonSerializer::Serialize(Completion, Writer);
    Run(FString::Printf(TEXT("window.haybaGeometryDone(%d,%s);"), ScanGeneration, *Json));
}

void SHaybaMCPSceneMapWebPanel::Run(const FString& Js)
{
    if (Browser.IsValid()) Browser->ExecuteJavascript(Js);
}

void SHaybaMCPSceneMapWebPanel::SelectLoadedActor(int32 Generation, int32 ActorIndex)
{
    if (Generation != ScanGeneration || !GEditor) return;
    UWorld* World = GEditor->GetEditorWorldContext().World();
    if (!World || World != ScannedWorld.Get()) return;
    if (!Geometry.Actors.IsValidIndex(ActorIndex)) return;
    const HaybaWorldGeometry::FActor& Entry = Geometry.Actors[ActorIndex];
    AActor* Actor = Entry.LoadedActor.Get();
    if (IsValid(Actor) && Actor->GetWorld() == World && Actor->GetPathName() == Entry.Path)
    {
        GEditor->SelectNone(false, true);
        GEditor->SelectActor(Actor, true, /*bNotify=*/false, /*bSelectEvenIfHidden=*/true);
        GEditor->NoteSelectionChange();
    }
}

FString SHaybaMCPSceneMapWebPanel::GeometryToJson() const
{
    // The in-editor preview and read-only MCP world snapshot share one
    // provenance-preserving metadata contract. The page adds only its live
    // generation and editor-selection capability.
    TSharedRef<FJsonObject> Root = HaybaWorldGeometry::ToMetadataJson(Geometry);
    Root->SetNumberField(TEXT("generation"), ScanGeneration);
    Root->SetBoolField(TEXT("nativeSelection"), true);
    FString Json;
    const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Json);
    FJsonSerializer::Serialize(Root, Writer);
    return Json;
}
