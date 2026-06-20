#pragma once
#include "CoreMinimal.h"
#include "EdGraph/EdGraphNode.h"
#include "HaybaConstraintGraphNode.generated.h"

// The closed set of node kinds — the WHOLE constraint grammar, as a graph.
// No operators, no expression nodes: a graph is masks/geometry feeding the 11
// primitives, primitives feeding gates, gates feeding one verdict.
UENUM()
enum class EHaybaNodeKind : uint8
{
    Mask,
    Geometry,
    Primitive,
    Gate,
    Verdict,
};

UCLASS()
class UHaybaConstraintGraphNode : public UEdGraphNode
{
    GENERATED_BODY()

public:
    UPROPERTY() EHaybaNodeKind Kind = EHaybaNodeKind::Primitive;

    // Primitive nodes: the closed-set primitive id (e.g. "grounded", "clearance").
    UPROPERTY() FString PrimitiveId;
    // Mask nodes: the mask id this node references.
    UPROPERTY() FString MaskId;
    // Gate nodes: the gate name (collision/stability/constraints).
    UPROPERTY() FString GateName;

    // UEdGraphNode
    virtual void AllocateDefaultPins() override;
    virtual FText GetNodeTitle(ENodeTitleType::Type TitleType) const override;
    virtual FLinearColor GetNodeTitleColor() const override;
    virtual FText GetTooltipText() const override;
};
