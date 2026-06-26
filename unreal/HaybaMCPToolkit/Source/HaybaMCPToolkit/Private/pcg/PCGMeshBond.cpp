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
        "Bonds two dynamic meshes: cuts an opening in each wherever the other passes "
        "through (once, twice, or N times) and merges them into one connected space. "
        "The geometry half of Socket Bond, without the constraint solver.");
}
#endif

TArray<FPCGPinProperties> UPCGMeshBondSettings::InputPinProperties() const
{
    TArray<FPCGPinProperties> Pins;
    Pins.Emplace(FName(TEXT("A")), EPCGDataType::DynamicMesh, /*bAllowMultiple=*/false, /*bAllowMultipleData=*/false);
    Pins.Emplace(FName(TEXT("B")), EPCGDataType::DynamicMesh, /*bAllowMultiple=*/false, /*bAllowMultipleData=*/false);
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

    FDynamicMesh3 A;
    TArray<UMaterialInterface*> Materials;
    TSet<FString> Tags;
    if (!HaybaPCGMesh::CopyFirstMesh(Context, FName(TEXT("A")), A, &Materials, &Tags))
    {
        // No A to anchor on — pass B through if present so the cook still emits.
        FDynamicMesh3 B;
        if (HaybaPCGMesh::CopyFirstMesh(Context, FName(TEXT("B")), B, &Materials, &Tags))
        {
            HaybaPCGMesh::Emit(Context, MoveTemp(B), Materials, Tags);
        }
        return true;
    }

    FDynamicMesh3 B;
    if (HaybaPCGMesh::CopyFirstMesh(Context, FName(TEXT("B")), B))
    {
        // Trims each mesh by the other's bounds + merges; A becomes the bonded result.
        HaybaOpening::CutSocket(A, B, HaybaOpening::FSocketCut{});
    }

    HaybaPCGMesh::Emit(Context, MoveTemp(A), Materials, Tags);
    return true;
}

#undef LOCTEXT_NAMESPACE
