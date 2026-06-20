#include "Studio/Graph/HaybaConstraintGraphSchema.h"
#include "Studio/Graph/HaybaConstraintPins.h"
#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphPin.h"

#define LOCTEXT_NAMESPACE "HaybaConstraintGraphSchema"

// The closed set — must mirror src/plumb/primitives.ts (11 primitives).
static const TCHAR* GPrimitives[] = {
    TEXT("grounded"), TEXT("clearance"), TEXT("support_margin"), TEXT("upright"),
    TEXT("scale_range"), TEXT("count_per_m2"), TEXT("proximity"), TEXT("inside_outside"),
    TEXT("facing"), TEXT("affordance_clear"), TEXT("surface_contact"),
};
static const TCHAR* GGates[] = { TEXT("collision"), TEXT("stability"), TEXT("constraints") };

void HaybaGetClosedPalette(TArray<FHaybaPaletteEntry>& Out)
{
    Out.Reset();
    Out.Add({ EHaybaNodeKind::Mask,     FString(), TEXT("Sources"), TEXT("Mask") });
    Out.Add({ EHaybaNodeKind::Geometry, FString(), TEXT("Sources"), TEXT("Geometry") });
    for (const TCHAR* P : GPrimitives) Out.Add({ EHaybaNodeKind::Primitive, FString(P), TEXT("Primitives"), FString(P) });
    for (const TCHAR* G : GGates)      Out.Add({ EHaybaNodeKind::Gate, FString(G), TEXT("Gates"), FString::Printf(TEXT("Gate: %s"), G) });
    Out.Add({ EHaybaNodeKind::Verdict,  FString(), TEXT("Gates"), TEXT("Verdict") });
}

UEdGraphNode* FHaybaSchemaAction_NewNode::PerformAction(UEdGraph* ParentGraph, UEdGraphPin* FromPin, const FVector2D Location, bool bSelectNewNode)
{
    UHaybaConstraintGraphNode* Node = NewObject<UHaybaConstraintGraphNode>(ParentGraph);
    Node->Kind = Kind;
    if (Kind == EHaybaNodeKind::Primitive) Node->PrimitiveId = Id;
    else if (Kind == EHaybaNodeKind::Gate) Node->GateName = Id;
    Node->CreateNewGuid();
    Node->NodePosX = Location.X;
    Node->NodePosY = Location.Y;
    ParentGraph->AddNode(Node, true, bSelectNewNode);
    Node->AllocateDefaultPins();
    if (FromPin) Node->AutowireNewNode(FromPin);
    return Node;
}

void UHaybaConstraintGraphSchema::GetGraphContextActions(FGraphContextMenuBuilder& ContextMenuBuilder) const
{
    TArray<FHaybaPaletteEntry> Palette;
    HaybaGetClosedPalette(Palette);
    for (const FHaybaPaletteEntry& E : Palette)
    {
        TSharedPtr<FHaybaSchemaAction_NewNode> A = MakeShared<FHaybaSchemaAction_NewNode>(
            E.Kind, E.Id, FText::FromString(E.Category), FText::FromString(E.Label), LOCTEXT("NewNodeTip", "Add a closed-set node"));
        ContextMenuBuilder.AddAction(A);
    }
}

const FPinConnectionResponse UHaybaConstraintGraphSchema::CanCreateConnection(const UEdGraphPin* A, const UEdGraphPin* B) const
{
    if (!A || !B)
        return FPinConnectionResponse(CONNECT_RESPONSE_DISALLOW, LOCTEXT("NullPin", "Invalid pin"));
    if (A->GetOwningNode() == B->GetOwningNode())
        return FPinConnectionResponse(CONNECT_RESPONSE_DISALLOW, LOCTEXT("Same", "Can't connect a node to itself"));
    if (A->Direction == B->Direction)
        return FPinConnectionResponse(CONNECT_RESPONSE_DISALLOW, LOCTEXT("Dir", "Connect an output to an input"));

    const UEdGraphPin* Out = (A->Direction == EGPD_Output) ? A : B;
    const UEdGraphPin* In  = (A->Direction == EGPD_Output) ? B : A;

    // Typed rules: Region|Geometry -> Primitive input; Result -> Gate; Flow -> Verdict.
    const FName OutCat = Out->PinType.PinCategory;
    const FName InCat  = In->PinType.PinCategory;

    const bool bOk =
        (InCat == HaybaPin::Region   && (OutCat == HaybaPin::Region || OutCat == HaybaPin::Geometry)) ||
        (InCat == HaybaPin::Result   &&  OutCat == HaybaPin::Result) ||
        (InCat == HaybaPin::Flow     &&  OutCat == HaybaPin::Flow);

    if (!bOk)
        return FPinConnectionResponse(CONNECT_RESPONSE_DISALLOW, LOCTEXT("TypeMismatch", "Pin types are incompatible"));

    return FPinConnectionResponse(CONNECT_RESPONSE_MAKE, LOCTEXT("Ok", "Connect"));
}

void UHaybaConstraintGraphSchema::CreateDefaultNodesForGraph(UEdGraph& Graph) const
{
    // Seed every graph with a Verdict sink + a Geometry source.
    UHaybaConstraintGraphNode* Verdict = NewObject<UHaybaConstraintGraphNode>(&Graph);
    Verdict->Kind = EHaybaNodeKind::Verdict;
    Verdict->CreateNewGuid();
    Verdict->NodePosX = 600; Verdict->NodePosY = 0;
    Graph.AddNode(Verdict, true, false);
    Verdict->AllocateDefaultPins();

    UHaybaConstraintGraphNode* Geo = NewObject<UHaybaConstraintGraphNode>(&Graph);
    Geo->Kind = EHaybaNodeKind::Geometry;
    Geo->CreateNewGuid();
    Geo->NodePosX = -200; Geo->NodePosY = 0;
    Graph.AddNode(Geo, true, false);
    Geo->AllocateDefaultPins();
}

FLinearColor UHaybaConstraintGraphSchema::GetPinTypeColor(const FEdGraphPinType& PinType) const
{
    if (PinType.PinCategory == HaybaPin::Region)   return FLinearColor(0.3f, 0.9f, 0.4f);
    if (PinType.PinCategory == HaybaPin::Geometry) return FLinearColor(0.3f, 0.6f, 1.0f);
    if (PinType.PinCategory == HaybaPin::Result)   return FLinearColor(1.0f, 0.6f, 0.2f);
    if (PinType.PinCategory == HaybaPin::Flow)     return FLinearColor(0.8f, 0.8f, 0.85f);
    return FLinearColor::White;
}

#undef LOCTEXT_NAMESPACE
