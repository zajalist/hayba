#include "Studio/Graph/HaybaConstraintGraphNode.h"
#include "Studio/Graph/HaybaConstraintPins.h"
#include "EdGraph/EdGraphPin.h"

// Single definition of the typed pin categories (declared extern in the header).
namespace HaybaPin
{
    const FName Region(TEXT("Region"));
    const FName Geometry(TEXT("Geometry"));
    const FName Result(TEXT("Result"));
    const FName Flow(TEXT("Flow"));
}

void UHaybaConstraintGraphNode::AllocateDefaultPins()
{
    switch (Kind)
    {
    case EHaybaNodeKind::Mask:
        CreatePin(EGPD_Output, HaybaPin::Region, TEXT("Region"));
        break;
    case EHaybaNodeKind::Geometry:
        CreatePin(EGPD_Output, HaybaPin::Geometry, TEXT("Geometry"));
        break;
    case EHaybaNodeKind::Primitive:
        // Accepts either a Region (mask-referencing) or Geometry (pure-math) input.
        CreatePin(EGPD_Input, HaybaPin::Region, TEXT("In"));
        CreatePin(EGPD_Output, HaybaPin::Result, TEXT("Result"));
        break;
    case EHaybaNodeKind::Gate:
        CreatePin(EGPD_Input, HaybaPin::Result, TEXT("Results"));
        CreatePin(EGPD_Output, HaybaPin::Flow, TEXT("Gate"));
        break;
    case EHaybaNodeKind::Verdict:
        CreatePin(EGPD_Input, HaybaPin::Flow, TEXT("Gates"));
        break;
    }
}

FText UHaybaConstraintGraphNode::GetNodeTitle(ENodeTitleType::Type) const
{
    switch (Kind)
    {
    case EHaybaNodeKind::Mask:      return FText::FromString(MaskId.IsEmpty() ? TEXT("Mask (unset)") : FString::Printf(TEXT("Mask: %s"), *MaskId));
    case EHaybaNodeKind::Geometry:  return FText::FromString(TEXT("Geometry"));
    case EHaybaNodeKind::Primitive: return FText::FromString(PrimitiveId);
    case EHaybaNodeKind::Gate:      return FText::FromString(FString::Printf(TEXT("Gate: %s"), *GateName));
    case EHaybaNodeKind::Verdict:   return FText::FromString(TEXT("Verdict"));
    }
    return FText::FromString(TEXT("Node"));
}

FLinearColor UHaybaConstraintGraphNode::GetNodeTitleColor() const
{
    switch (Kind)
    {
    case EHaybaNodeKind::Mask:      return FLinearColor(0.15f, 0.45f, 0.20f); // green (region)
    case EHaybaNodeKind::Geometry:  return FLinearColor(0.10f, 0.25f, 0.55f); // blue
    case EHaybaNodeKind::Primitive: return FLinearColor(0.55f, 0.35f, 0.10f); // orange
    case EHaybaNodeKind::Gate:      return FLinearColor(0.30f, 0.30f, 0.35f); // grey
    case EHaybaNodeKind::Verdict:   return FLinearColor(0.45f, 0.10f, 0.30f); // magenta
    }
    return FLinearColor::Gray;
}

FText UHaybaConstraintGraphNode::GetTooltipText() const
{
    return GetNodeTitle(ENodeTitleType::FullTitle);
}
