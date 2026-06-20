#pragma once
#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/Views/SListView.h"
#include "UObject/GCObject.h"
#include "Studio/HaybaStudioModel.h"

class ITableRow;
class STableViewBase;
class UEdGraph;
class SGraphEditor;

// The Hayba Semantic Studio — a Material-Editor-style window with a StaticMesh
// as the canvas, for authoring masks + constraints on that mesh. Plan B builds
// this incrementally; B2 adds profile loading + mask list + inspector. See
// docs/superpowers/specs/2026-06-19-semantic-studio-design.md.
class SHaybaSemanticStudio : public SCompoundWidget, public FGCObject
{
public:
    SLATE_BEGIN_ARGS(SHaybaSemanticStudio) {}
        SLATE_ARGUMENT(FString, AssetPath)
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs);

    /** Retarget an already-open Studio to a different mesh. */
    void SetAsset(const FString& InAssetPath);

    // FGCObject — keep the constraint graph + its nodes alive.
    virtual void AddReferencedObjects(FReferenceCollector& Collector) override;
    virtual FString GetReferencerName() const override { return TEXT("SHaybaSemanticStudio"); }

private:
    TSharedRef<SWidget> BuildEmptyState();
    TSharedRef<SWidget> BuildStudio();
    TSharedRef<SWidget> BuildToolbar();
    TSharedRef<SWidget> BuildMaskList();
    TSharedRef<SWidget> BuildViewport();
    TSharedRef<SWidget> BuildInspector();
    TSharedRef<SWidget> BuildGraph();
    TSharedRef<SWidget> BuildNodeInspector();
    void OnGraphSelectionChanged(const TSet<class UObject*>& NewSelection);
    TSharedRef<ITableRow> GenerateMaskRow(TSharedPtr<FHaybaStudioMask> Mask, const TSharedRef<STableViewBase>& Owner);
    void OnMaskSelected(TSharedPtr<FHaybaStudioMask> Mask, ESelectInfo::Type);
    void ReloadProfile();
    void PushMasksToViewport();
    FReply OnSaveConstraints();   // compile the graph -> constraints.json

    FString AssetPath;
    FHaybaStudioProfile Profile;
    TArray<TSharedPtr<FHaybaStudioMask>> MaskItems;
    TSet<FString> HiddenMaskIds;
    TSharedPtr<FHaybaStudioMask> SelectedMask;
    TSharedPtr<SListView<TSharedPtr<FHaybaStudioMask>>> MaskListView;
    TSharedPtr<class SBox> InspectorBox;
    TSharedPtr<class SHaybaStudioViewport> Viewport;
    TObjectPtr<UEdGraph> ConstraintGraph = nullptr;
    TSharedPtr<SGraphEditor> GraphEditorWidget;
    TSharedPtr<class SBox> NodeInspectorBox;
    TWeakObjectPtr<class UHaybaConstraintGraphNode> SelectedGraphNode;
};
