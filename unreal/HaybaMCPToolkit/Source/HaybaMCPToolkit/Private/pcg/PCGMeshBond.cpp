#include "pcg/PCGMeshBond.h"
#include "pcg/HaybaPCGMesh.h"
#include "pcg/HaybaOpening.h"

#include "PCGContext.h"
#include "PCGPin.h"
#include "PCGCommon.h"
#include "DynamicMesh/DynamicMesh3.h"

#include UE_INLINE_GENERATED_CPP_BY_NAME(PCGMeshBond)

#define LOCTEXT_NAMESPACE "PCGMeshBond"

#if WITH_EDITOR
FText UPCGMeshBondSettings::GetDefaultNodeTitle() const { return LOCTEXT("Title", "Plumb | Mesh Bond"); }
FText UPCGMeshBondSettings::GetNodeTooltipText() const
{
    return LOCTEXT("Tooltip",
        "Bonds N dynamic meshes on one pin: cuts an opening in each wherever another "
        "crosses it (once, twice, N times) and merges them all into one connected space. "
        "Host/branch-free; the geometry of Socket Bond without the constraint solver.");
}
#endif

TArray<FPCGPinProperties> UPCGMeshBondSettings::InputPinProperties() const
{
    TArray<FPCGPinProperties> Pins;
    // One pin that accepts N shells (every spline's swept mesh) — host/branch-free.
    Pins.Emplace(FName(TEXT("Meshes")), EPCGDataType::DynamicMesh, /*bAllowMultiple=*/true, /*bAllowMultipleData=*/true);
    return Pins;
}

TArray<FPCGPinProperties> UPCGMeshBondSettings::OutputPinProperties() const
{
    TArray<FPCGPinProperties> Pins;
    Pins.Emplace(PCGPinConstants::DefaultOutputLabel, EPCGDataType::DynamicMesh, /*bAllowMultiple=*/false, /*bAllowMultipleData=*/false);
    return Pins;
}

FPCGElementPtr UPCGMeshBondSettings::CreateElement() const { return MakeShared<FPCGMeshBondElement>(); }

bool FPCGMeshBondElement::ExecuteInternal(FPCGContext* Context) const
{
    using namespace UE::Geometry;
    TRACE_CPUPROFILER_EVENT_SCOPE(FPCGMeshBondElement::Execute);
    check(Context);

    // Collect every shell on the Meshes pin (one per spline).
    TArray<FDynamicMesh3> Meshes;
    TArray<UMaterialInterface*> Materials;
    TSet<FString> Tags;
    for (const FPCGTaggedData& D : Context->InputData.GetInputsByPin(FName(TEXT("Meshes"))))
    {
        const UPCGDynamicMeshData* DM = Cast<UPCGDynamicMeshData>(D.Data);
        if (!DM) { continue; }
        const UDynamicMesh* UM = DM->GetDynamicMesh();
        if (!UM) { continue; }
        Meshes.Add(UM->GetMeshRef());   // copy
        if (Materials.IsEmpty())
        {
            for (const TObjectPtr<UMaterialInterface>& M : DM->GetMaterials()) { Materials.Add(M); }
        }
        Tags.Append(D.Tags);
    }
    if (Meshes.Num() == 0)
    {
        return true;   // nothing to bond
    }

    // Cut openings at every crossing + merge into one connected mesh (N-way).
    FDynamicMesh3 Out;
    HaybaOpening::BondMeshes(Out, Meshes, HaybaOpening::ESeamStyle::Welded);

    HaybaPCGMesh::Emit(Context, MoveTemp(Out), Materials, Tags);
    return true;
}

#undef LOCTEXT_NAMESPACE
