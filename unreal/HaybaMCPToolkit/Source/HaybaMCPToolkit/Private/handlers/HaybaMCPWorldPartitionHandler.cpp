#include "HaybaMCPWorldPartitionHandler.h"
#include "Json.h"
#include "Editor.h"
#include "EngineUtils.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "WorldPartition/WorldPartition.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPWP, Log, All);

namespace
{
    static UWorld* EditorWorld()
    {
        return GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    }

    static FString CellId(int32 X, int32 Y)
    {
        return FString::Printf(TEXT("%d_%d"), X, Y);
    }
}

TArray<FString> FHaybaMCPWorldPartitionHandler::GetCommands() const
{
    return {
        TEXT("wp_get_cells"),
        TEXT("wp_load_cell"),
        TEXT("wp_get_streaming_state"),
    };
}

FHaybaHandlerResult FHaybaMCPWorldPartitionHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& P)
{
    if (Cmd == TEXT("wp_get_cells"))            return WpGetCells(P);
    if (Cmd == TEXT("wp_load_cell"))            return WpLoadCell(P);
    if (Cmd == TEXT("wp_get_streaming_state"))  return WpGetStreamingState(P);
    return FHaybaHandlerResult::Err(FString::Printf(TEXT("WPHandler: unknown command %s"), *Cmd));
}

FHaybaHandlerResult FHaybaMCPWorldPartitionHandler::WpGetCells(const TSharedPtr<FJsonObject>& P)
{
    UWorld* World = EditorWorld();
    if (!World) return FHaybaHandlerResult::Err(TEXT("wp_get_cells: no editor world"));

    UWorldPartition* WP = World->GetWorldPartition();
    if (!WP) return FHaybaHandlerResult::Err(TEXT("wp_get_cells: world partition not enabled"));

    constexpr double CellSize = 51200.0;

    struct FCellAgg
    {
        FBox Bounds = FBox(ForceInit);
        int32 ActorCount = 0;
        TMap<FString, int32> ClassCounts;
    };

    TMap<FString, FCellAgg> Cells;
    for (TActorIterator<AActor> It(World); It; ++It)
    {
        AActor* A = *It;
        if (!A) continue;
        FVector Loc = A->GetActorLocation();
        int32 CX = FMath::FloorToInt32(Loc.X / CellSize);
        int32 CY = FMath::FloorToInt32(Loc.Y / CellSize);
        FString Id = CellId(CX, CY);
        FCellAgg& Agg = Cells.FindOrAdd(Id);
        Agg.ActorCount++;
        Agg.Bounds += Loc;
        FString CN = A->GetClass() ? A->GetClass()->GetName() : TEXT("Unknown");
        Agg.ClassCounts.FindOrAdd(CN)++;
    }

    TArray<TSharedPtr<FJsonValue>> CellArr;
    int32 Emitted = 0;
    for (const auto& Pair : Cells)
    {
        if (Emitted >= 100) break;
        const FCellAgg& Agg = Pair.Value;

        TSharedPtr<FJsonObject> BoundsObj = MakeShared<FJsonObject>();
        TSharedPtr<FJsonObject> MinObj = MakeShared<FJsonObject>();
        MinObj->SetNumberField(TEXT("x"), Agg.Bounds.Min.X);
        MinObj->SetNumberField(TEXT("y"), Agg.Bounds.Min.Y);
        MinObj->SetNumberField(TEXT("z"), Agg.Bounds.Min.Z);
        TSharedPtr<FJsonObject> MaxObj = MakeShared<FJsonObject>();
        MaxObj->SetNumberField(TEXT("x"), Agg.Bounds.Max.X);
        MaxObj->SetNumberField(TEXT("y"), Agg.Bounds.Max.Y);
        MaxObj->SetNumberField(TEXT("z"), Agg.Bounds.Max.Z);
        BoundsObj->SetObjectField(TEXT("min"), MinObj);
        BoundsObj->SetObjectField(TEXT("max"), MaxObj);

        // Top 5 classes
        TArray<TPair<FString, int32>> Sorted;
        for (const auto& C : Agg.ClassCounts) Sorted.Add({C.Key, C.Value});
        Sorted.Sort([](const TPair<FString,int32>& A, const TPair<FString,int32>& B){ return A.Value > B.Value; });

        TArray<TSharedPtr<FJsonValue>> TopArr;
        const int32 Limit = FMath::Min(Sorted.Num(), 5);
        for (int32 i = 0; i < Limit; ++i)
        {
            TSharedPtr<FJsonObject> CC = MakeShared<FJsonObject>();
            CC->SetStringField(TEXT("name"), Sorted[i].Key);
            CC->SetNumberField(TEXT("count"), Sorted[i].Value);
            TopArr.Add(MakeShared<FJsonValueObject>(CC));
        }

        TSharedPtr<FJsonObject> Cell = MakeShared<FJsonObject>();
        Cell->SetStringField(TEXT("cell_id"), Pair.Key);
        Cell->SetObjectField(TEXT("bounds"), BoundsObj);
        Cell->SetNumberField(TEXT("actor_count"), Agg.ActorCount);
        Cell->SetArrayField(TEXT("top_classes"), TopArr);
        CellArr.Add(MakeShared<FJsonValueObject>(Cell));
        ++Emitted;
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetArrayField(TEXT("cells"), CellArr);
    Out->SetNumberField(TEXT("total"), Cells.Num());
    // These are NOT the World Partition's runtime cells. They are actor
    // locations binned onto a fixed grid by this handler — a useful spatial
    // summary, and a different thing entirely, since the real grid size and
    // cell bounds come from the partition config. A caller had no way to know
    // which of the two it was holding.
    Out->SetStringField(TEXT("cell_source"), TEXT("computed_grid"));
    Out->SetNumberField(TEXT("grid_size_cm"), CellSize);
    Out->SetStringField(TEXT("cell_source_note"),
        TEXT("Cells are computed by binning actor locations onto a fixed grid in this handler, "
             "NOT read from the World Partition runtime hash — cell ids and bounds will not match "
             "the partition's own cells."));
    if (Cells.Num() > Emitted)
    {
        // The 100-cell cap was silent: `total` disagreed with the array length
        // and nothing said why.
        Out->SetNumberField(TEXT("returned"), Emitted);
        Out->SetBoolField(TEXT("truncated"), true);
    }
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPWorldPartitionHandler::WpLoadCell(const TSharedPtr<FJsonObject>& P)
{
    // Same family as the source_count fix above: this returned Ok with
    // loaded:false for every call it has ever received. An unconditional no-op
    // reporting success is worse than an unimplemented command — a caller loops
    // over cells, gets ok every time, and concludes the world is loaded. It
    // never loads anything, so it now says so.
    return FHaybaHandlerResult::Err(TEXT(
        "wp_load_cell: not implemented — World Partition cell loading is interactive-only in the editor. "
        "There is no programmatic path here yet; load the region in the editor, or use wp_get_cells to see "
        "what exists without loading it."));
}

FHaybaHandlerResult FHaybaMCPWorldPartitionHandler::WpGetStreamingState(const TSharedPtr<FJsonObject>& P)
{
    UWorld* World = EditorWorld();
    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    if (!World)
    {
        Out->SetBoolField(TEXT("enabled"), false);
        return FHaybaHandlerResult::Ok(Out);
    }
    UWorldPartition* WP = World->GetWorldPartition();
    Out->SetBoolField(TEXT("enabled"), WP != nullptr);
    // `source_count` used to be reported here as a hard-coded 0. A field named
    // for a measurement, always answering zero, is worse than no field: it reads
    // as "measured, and there are none". Streaming sources are not enumerated
    // here, so the reply says that instead of inventing a number.
    Out->SetStringField(TEXT("streaming_sources"), TEXT("not_enumerated"));
    return FHaybaHandlerResult::Ok(Out);
}
