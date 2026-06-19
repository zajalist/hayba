#pragma once
#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/Views/SListView.h"
#include "Studio/HaybaStudioModel.h"

class ITableRow;
class STableViewBase;

// The Hayba Semantic Studio — a Material-Editor-style window with a StaticMesh
// as the canvas, for authoring masks + constraints on that mesh. Plan B builds
// this incrementally; B2 adds profile loading + mask list + inspector. See
// docs/superpowers/specs/2026-06-19-semantic-studio-design.md.
class SHaybaSemanticStudio : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SHaybaSemanticStudio) {}
        SLATE_ARGUMENT(FString, AssetPath)
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs);

    /** Retarget an already-open Studio to a different mesh. */
    void SetAsset(const FString& InAssetPath);

private:
    TSharedRef<SWidget> BuildEmptyState();
    TSharedRef<SWidget> BuildStudio();
    TSharedRef<SWidget> BuildMaskList();
    TSharedRef<SWidget> BuildInspector();
    TSharedRef<ITableRow> GenerateMaskRow(TSharedPtr<FHaybaStudioMask> Mask, const TSharedRef<STableViewBase>& Owner);
    void OnMaskSelected(TSharedPtr<FHaybaStudioMask> Mask, ESelectInfo::Type);
    void ReloadProfile();

    FString AssetPath;
    FHaybaStudioProfile Profile;
    TArray<TSharedPtr<FHaybaStudioMask>> MaskItems;
    TSharedPtr<FHaybaStudioMask> SelectedMask;
    TSharedPtr<SListView<TSharedPtr<FHaybaStudioMask>>> MaskListView;
    TSharedPtr<class SBox> InspectorBox;
};
