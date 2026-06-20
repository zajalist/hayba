#pragma once
#include "CoreMinimal.h"
#include "EdGraph/EdGraphSchema.h"
#include "Studio/Graph/HaybaConstraintGraphNode.h"
#include "HaybaConstraintGraphSchema.generated.h"

// Context-menu action that spawns one closed-set node.
USTRUCT()
struct FHaybaSchemaAction_NewNode : public FEdGraphSchemaAction
{
    GENERATED_BODY()

    EHaybaNodeKind Kind = EHaybaNodeKind::Primitive;
    FString Id;   // primitive id, or gate name

    FHaybaSchemaAction_NewNode() = default;
    FHaybaSchemaAction_NewNode(EHaybaNodeKind InKind, const FString& InId, const FText& Category, const FText& MenuDesc, const FText& Tooltip)
        : FEdGraphSchemaAction(Category, MenuDesc, Tooltip, 0), Kind(InKind), Id(InId) {}

    virtual UEdGraphNode* PerformAction(UEdGraph* ParentGraph, UEdGraphPin* FromPin, const FVector2D Location, bool bSelectNewNode = true) override;
};

UCLASS()
class UHaybaConstraintGraphSchema : public UEdGraphSchema
{
    GENERATED_BODY()

public:
    // UEdGraphSchema
    virtual void GetGraphContextActions(FGraphContextMenuBuilder& ContextMenuBuilder) const override;
    virtual const FPinConnectionResponse CanCreateConnection(const UEdGraphPin* A, const UEdGraphPin* B) const override;
    virtual void CreateDefaultNodesForGraph(UEdGraph& Graph) const override;
    virtual FLinearColor GetPinTypeColor(const FEdGraphPinType& PinType) const override;
};
