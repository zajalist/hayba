#pragma once
#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"

// The Hayba Semantic Studio — a Material-Editor-style window with a StaticMesh
// as the canvas, for authoring masks + constraints on that mesh. Plan B builds
// this incrementally; B1 lays down the 4-region shell. See
// docs/superpowers/specs/2026-06-19-semantic-studio-design.md.
class SHaybaSemanticStudio : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SHaybaSemanticStudio) {}
        SLATE_ARGUMENT(FString, AssetPath)
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs);

private:
    FString AssetPath;
};
