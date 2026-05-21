// Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPCogMapBuilder.cpp
#include "HaybaMCPCogMapBuilder.h"

#include "Engine/World.h"
#include "Engine/Light.h"
#include "Engine/SkyLight.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/Brush.h"
#include "EngineUtils.h"
#include "GameFramework/Actor.h"
#include "Components/ActorComponent.h"
#include "HaybaTagIndex.h"
#include "Landscape.h"
#include "LandscapeStreamingProxy.h"

namespace
{
    // Same noise filter as the Validation/Scene-Map panels — skip world
    // plumbing actors that don't carry meaning for the cognitive map.
    bool SkipActorForMap(AActor* A)
    {
        if (!A) return true;
        if (A->IsA<ALandscape>())               return false;   // landscape itself: keep
        if (A->IsA<ALandscapeStreamingProxy>()) return true;
        if (A->IsA<ABrush>())                   return true;
        const FString ClassName = A->GetClass()->GetName();
        if (ClassName == TEXT("WorldSettings"))             return true;
        if (ClassName == TEXT("WorldDataLayers"))           return true;
        if (ClassName == TEXT("WorldPartitionMiniMap"))     return true;
        if (ClassName == TEXT("MassVisualizer"))            return true;
        if (ClassName == TEXT("DefaultPhysicsVolume"))      return true;
        if (ClassName == TEXT("GameplayDebuggerPlayerManager")) return true;
        if (ClassName.StartsWith(TEXT("Chaos")))            return true;
        if (ClassName.StartsWith(TEXT("WorldPartitionHLOD"))) return true;
        if (ClassName.StartsWith(TEXT("HLOD")))             return true;
        return false;
    }

    // Spec §3.2: cluster label derived from dominant class names using a
    // name→semantic mapping table. Tested first-match-wins so order matters.
    struct FSemanticRule
    {
        const TCHAR* Substr;
        const TCHAR* Label;
        EHaybaNodeSemantic Semantic;
    };
    const FSemanticRule kRules[] = {
        { TEXT("Tree"),       TEXT("forest"),   EHaybaNodeSemantic::Foliage  },
        { TEXT("Foliage"),    TEXT("forest"),   EHaybaNodeSemantic::Foliage  },
        { TEXT("Grass"),      TEXT("meadow"),   EHaybaNodeSemantic::Foliage  },
        { TEXT("Bush"),       TEXT("brush"),    EHaybaNodeSemantic::Foliage  },
        { TEXT("Building"),   TEXT("urban"),    EHaybaNodeSemantic::Building },
        { TEXT("Wall"),       TEXT("urban"),    EHaybaNodeSemantic::Building },
        { TEXT("Floor"),      TEXT("urban"),    EHaybaNodeSemantic::Building },
        { TEXT("House"),      TEXT("urban"),    EHaybaNodeSemantic::Building },
        { TEXT("Light"),      TEXT("lighting"), EHaybaNodeSemantic::Light    },
        { TEXT("Lamp"),       TEXT("lighting"), EHaybaNodeSemantic::Light    },
        { TEXT("Character"),  TEXT("characters"), EHaybaNodeSemantic::Character },
        { TEXT("Pawn"),       TEXT("characters"), EHaybaNodeSemantic::Character },
        { TEXT("Trigger"),    TEXT("triggers"), EHaybaNodeSemantic::Trigger  },
        { TEXT("Volume"),     TEXT("triggers"), EHaybaNodeSemantic::Trigger  },
        { TEXT("Rock"),       TEXT("geology"),  EHaybaNodeSemantic::Other    },
        { TEXT("Cliff"),      TEXT("geology"),  EHaybaNodeSemantic::Other    },
        { TEXT("Boulder"),    TEXT("geology"),  EHaybaNodeSemantic::Other    },
        { TEXT("Landscape"),  TEXT("terrain"),  EHaybaNodeSemantic::Other    },
        { TEXT("Water"),      TEXT("water"),    EHaybaNodeSemantic::Other    },
        { TEXT("River"),      TEXT("water"),    EHaybaNodeSemantic::Other    },
        { TEXT("Ocean"),      TEXT("water"),    EHaybaNodeSemantic::Other    },
    };

    void ClassifyDominant(const TArray<FString>& Classes, FString& OutLabel, EHaybaNodeSemantic& OutSem)
    {
        // Apply the rule table to the top class first; fall back to a sanitized
        // class name when no rule matches.
        for (const FString& C : Classes)
        {
            for (const FSemanticRule& Rule : kRules)
            {
                if (C.Contains(Rule.Substr, ESearchCase::IgnoreCase))
                {
                    OutLabel = Rule.Label;
                    OutSem   = Rule.Semantic;
                    return;
                }
            }
        }
        // Fallback: turn the dominant class name into a readable label.
        if (Classes.Num() > 0)
        {
            FString L = Classes[0];
            L.RemoveFromStart(TEXT("BP_"));
            L.RemoveFromEnd(TEXT("_C"));
            L.RemoveFromStart(TEXT("SM_"));
            OutLabel = L.ToLower();
        }
        else
        {
            OutLabel = TEXT("mixed");
        }
        OutSem = EHaybaNodeSemantic::Other;
    }

    // Compute the dominant class list for a set of actors.
    TArray<FString> DominantClasses(const TArray<AActor*>& Actors, int32 Limit)
    {
        TMap<FString, int32> Counts;
        for (AActor* A : Actors)
        {
            if (!A) continue;
            Counts.FindOrAdd(A->GetClass()->GetName())++;
        }
        TArray<TPair<FString, int32>> Sorted;
        for (const auto& KV : Counts) Sorted.Add(KV);
        Sorted.Sort([](const TPair<FString,int32>& A, const TPair<FString,int32>& B){ return A.Value > B.Value; });
        TArray<FString> Out;
        Out.Reserve(Limit);
        for (int32 i = 0; i < FMath::Min(Limit, Sorted.Num()); ++i) Out.Add(Sorted[i].Key);
        return Out;
    }

    // Aggregate up to Limit tags across the cell's actors, sorted by frequency
    // then alphabetically for stability. Prefers UE Actor->Tags; falls back to
    // the retriever snapshot indexed by the actor's primary asset path.
    TArray<FString> AggregateTagsForCell(const TArray<AActor*>& Actors, int32 Limit)
    {
        TMap<FString, int32> Counts;

        auto Bump = [&Counts](const FString& Tag)
        {
            if (!Tag.IsEmpty()) Counts.FindOrAdd(Tag)++;
        };

        const FHaybaTagIndex& Index = FHaybaTagIndex::Get();

        for (AActor* A : Actors)
        {
            if (!A) continue;
            bool bHadUETag = false;
            for (const FName& T : A->Tags) { Bump(T.ToString()); bHadUETag = true; }
            if (bHadUETag) continue;

            // Fallback: resolve the actor's source-asset path via its root component's UObject, if any.
            FString AssetPath;
            if (UObject* SrcAsset = A->GetClass()) AssetPath = SrcAsset->GetPathName();
            if (!AssetPath.IsEmpty())
            {
                for (const FString& T : Index.Lookup(AssetPath)) Bump(T);
            }
        }

        TArray<TPair<FString, int32>> Sorted;
        for (const auto& KV : Counts) Sorted.Add(KV);
        Sorted.Sort([](const TPair<FString,int32>& A, const TPair<FString,int32>& B)
        {
            if (A.Value != B.Value) return A.Value > B.Value;
            return A.Key < B.Key;
        });

        TArray<FString> Out;
        Out.Reserve(Limit);
        for (int32 i = 0; i < FMath::Min(Limit, Sorted.Num()); ++i) Out.Add(Sorted[i].Key);
        return Out;
    }

    // Uniform 2D grid fallback. Divides the bounding XY of all actors into a
    // GridSize × GridSize lattice and keeps non-empty bins as cells.
    TArray<FHaybaCogMapCell> BuildUniformGrid(const TArray<AActor*>& Actors, int32 GridSize)
    {
        if (Actors.IsEmpty()) return {};

        // Bounding box in projected coords (X, Y) / 100 to match the panel.
        FBox2D Bounds(ForceInit);
        for (AActor* A : Actors)
        {
            const FVector L = A->GetActorLocation();
            Bounds += FVector2D(L.X * 0.01f, L.Y * 0.01f);
        }
        // Expand slightly so edge actors don't fall outside.
        Bounds = Bounds.ExpandBy(1.f);

        const FVector2D Size = Bounds.GetSize();
        const FVector2D CellSize(
            FMath::Max(Size.X / GridSize, 1.f),
            FMath::Max(Size.Y / GridSize, 1.f));

        TArray<TArray<AActor*>> Bins;
        Bins.SetNum(GridSize * GridSize);

        for (AActor* A : Actors)
        {
            const FVector L = A->GetActorLocation();
            const FVector2D P(L.X * 0.01f, L.Y * 0.01f);
            const int32 GX = FMath::Clamp((int32)((P.X - Bounds.Min.X) / CellSize.X), 0, GridSize - 1);
            const int32 GY = FMath::Clamp((int32)((P.Y - Bounds.Min.Y) / CellSize.Y), 0, GridSize - 1);
            Bins[GY * GridSize + GX].Add(A);
        }

        TArray<FHaybaCogMapCell> Cells;
        for (int32 GY = 0; GY < GridSize; ++GY)
        for (int32 GX = 0; GX < GridSize; ++GX)
        {
            const TArray<AActor*>& Bin = Bins[GY * GridSize + GX];
            if (Bin.IsEmpty()) continue;

            FHaybaCogMapCell Cell;
            Cell.Bounds = FBox2D(
                FVector2D(Bounds.Min.X + GX * CellSize.X,     Bounds.Min.Y + GY * CellSize.Y),
                FVector2D(Bounds.Min.X + (GX+1) * CellSize.X, Bounds.Min.Y + (GY+1) * CellSize.Y));
            Cell.ActorCount = Bin.Num();
            Cell.DominantClasses = DominantClasses(Bin, /*Limit=*/5);
            Cell.Tags = AggregateTagsForCell(Bin, /*Limit=*/5);
            ClassifyDominant(Cell.DominantClasses, Cell.Label, Cell.Semantic);
            for (AActor* A : Bin) Cell.ActorLabels.Add(A->GetActorLabel());
            Cells.Add(MoveTemp(Cell));
        }
        return Cells;
    }
}

namespace HaybaCogMap
{
    TArray<FHaybaCogMapCell> BuildForWorld(UWorld* World)
    {
        if (!World) return {};

        TArray<AActor*> Actors;
        for (TActorIterator<AActor> It(World); It; ++It)
        {
            if (!SkipActorForMap(*It)) Actors.Add(*It);
        }
        if (Actors.IsEmpty()) return {};

        // TODO Phase 4: detect World Partition (UWorldPartition* WP = World->GetWorldPartition())
        // and emit one cell per loaded WP cell. For now we always use the uniform
        // grid fallback, which behaves correctly for non-WP and WP-disabled worlds.
        const int32 GridSize = FMath::Clamp((int32)FMath::Sqrt((float)Actors.Num()), 3, 8);
        return BuildUniformGrid(Actors, GridSize);
    }
}
