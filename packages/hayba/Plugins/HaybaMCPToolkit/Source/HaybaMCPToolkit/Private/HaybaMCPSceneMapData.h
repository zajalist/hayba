#pragma once
#include "CoreMinimal.h"

UENUM()
enum class EHaybaNodeSemantic : uint8
{
    Unknown, Foliage, Building, Light, Trigger, Character, Blueprint, ISM, Other
};

struct FHaybaSceneNode
{
    FString ActorId;
    FString Label;
    FVector2D WorldPos = FVector2D::ZeroVector;     // 2D after XY projection
    FVector2D Size = FVector2D(12.f, 12.f);
    EHaybaNodeSemantic Semantic = EHaybaNodeSemantic::Unknown;
    bool bSelected = false;
    bool bHovered = false;
};

struct FHaybaSceneEdge
{
    int32 FromIdx = -1;
    int32 ToIdx = -1;
    bool bHierarchical = false;
};

/** Minimal quadtree storing node index + position so splits can redistribute. */
struct FHaybaQuadtreeEntry
{
    int32 Idx = INDEX_NONE;
    FVector2D Pos = FVector2D::ZeroVector;
};

struct FHaybaQuadtreeNode
{
    FBox2D Bounds = FBox2D(ForceInit);
    TArray<FHaybaQuadtreeEntry> Entries;
    TUniquePtr<FHaybaQuadtreeNode> Children[4];
    bool bLeaf = true;

    static constexpr int32 MaxPerLeaf = 16;
    static constexpr int32 MaxDepth = 8;

    void Insert(int32 Idx, FVector2D Pos, int32 Depth = 0);
    void Query(const FBox2D& Rect, TArray<int32>& OutIndices) const;
};
