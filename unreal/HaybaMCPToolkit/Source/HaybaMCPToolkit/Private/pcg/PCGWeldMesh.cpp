#include "pcg/PCGWeldMesh.h"
#include "pcg/HaybaPCGMesh.h"
#include "pcg/HaybaMeshOps.h"

#include "PCGContext.h"
#include "PCGPin.h"
#include "PCGCommon.h"
#include "DynamicMesh/DynamicMesh3.h"

#include UE_INLINE_GENERATED_CPP_BY_NAME(PCGWeldMesh)

#define LOCTEXT_NAMESPACE "PCGWeldMesh"

#if WITH_EDITOR
FText UPCGWeldMeshSettings::GetDefaultNodeTitle() const { return LOCTEXT("Title", "Plumb | Weld"); }
FText UPCGWeldMeshSettings::GetNodeTooltipText() const
{
    return LOCTEXT("Tooltip",
        "Welds coincident edges of the input dynamic mesh and recomputes normals — "
        "joins separate-but-touching pieces into one watertight surface.");
}
#endif

TArray<FPCGPinProperties> UPCGWeldMeshSettings::InputPinProperties() const
{
    TArray<FPCGPinProperties> Pins;
    Pins.Emplace(PCGPinConstants::DefaultInputLabel, EPCGDataType::DynamicMesh, /*bAllowMultiple=*/false, /*bAllowMultipleData=*/false);
    return Pins;
}

TArray<FPCGPinProperties> UPCGWeldMeshSettings::OutputPinProperties() const
{
    TArray<FPCGPinProperties> Pins;
    Pins.Emplace(PCGPinConstants::DefaultOutputLabel, EPCGDataType::DynamicMesh, /*bAllowMultiple=*/false, /*bAllowMultipleData=*/false);
    return Pins;
}

FPCGElementPtr UPCGWeldMeshSettings::CreateElement() const { return MakeShared<FPCGWeldMeshElement>(); }

bool FPCGWeldMeshElement::ExecuteInternal(FPCGContext* Context) const
{
    using namespace UE::Geometry;
    TRACE_CPUPROFILER_EVENT_SCOPE(FPCGWeldMeshElement::Execute);
    check(Context);

    FDynamicMesh3 Mesh;
    TArray<UMaterialInterface*> Materials;
    TSet<FString> Tags;
    if (!HaybaPCGMesh::CopyFirstMesh(Context, PCGPinConstants::DefaultInputLabel, Mesh, &Materials, &Tags))
    {
        return true;   // no input mesh -> nothing to emit
    }

    FHaybaMeshOps::WeldAndNormals(Mesh);

    HaybaPCGMesh::Emit(Context, MoveTemp(Mesh), Materials, Tags);
    return true;
}

#undef LOCTEXT_NAMESPACE
