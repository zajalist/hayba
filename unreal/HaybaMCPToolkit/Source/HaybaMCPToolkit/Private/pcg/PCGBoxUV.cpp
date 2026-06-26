#include "pcg/PCGBoxUV.h"
#include "pcg/HaybaPCGMesh.h"

#include "PCGContext.h"
#include "PCGPin.h"
#include "PCGCommon.h"
#include "DynamicMesh/DynamicMesh3.h"
#include "Parameterization/DynamicMeshUVEditor.h"
#include "FrameTypes.h"

#include UE_INLINE_GENERATED_CPP_BY_NAME(PCGBoxUV)

#define LOCTEXT_NAMESPACE "PCGBoxUV"

#if WITH_EDITOR
FText UPCGBoxUVSettings::GetDefaultNodeTitle() const { return LOCTEXT("Title", "Plumb | Box UV"); }
FText UPCGBoxUVSettings::GetNodeTooltipText() const
{
    return LOCTEXT("Tooltip",
        "Projects world-space box (tri-planar) UVs onto the input dynamic mesh so tiling "
        "grid materials map cleanly to the walls. TileSizeCm = world cm per UV tile.");
}
#endif

TArray<FPCGPinProperties> UPCGBoxUVSettings::InputPinProperties() const
{
    TArray<FPCGPinProperties> Pins;
    Pins.Emplace(PCGPinConstants::DefaultInputLabel, EPCGDataType::DynamicMesh, /*bAllowMultiple=*/false, /*bAllowMultipleData=*/false);
    return Pins;
}

TArray<FPCGPinProperties> UPCGBoxUVSettings::OutputPinProperties() const
{
    TArray<FPCGPinProperties> Pins;
    Pins.Emplace(PCGPinConstants::DefaultOutputLabel, EPCGDataType::DynamicMesh, /*bAllowMultiple=*/false, /*bAllowMultipleData=*/false);
    return Pins;
}

FPCGElementPtr UPCGBoxUVSettings::CreateElement() const { return MakeShared<FPCGBoxUVElement>(); }

bool FPCGBoxUVElement::ExecuteInternal(FPCGContext* Context) const
{
    using namespace UE::Geometry;
    TRACE_CPUPROFILER_EVENT_SCOPE(FPCGBoxUVElement::Execute);
    check(Context);

    const UPCGBoxUVSettings* Settings = Context->GetInputSettings<UPCGBoxUVSettings>();
    check(Settings);

    FDynamicMesh3 Mesh;
    TArray<UMaterialInterface*> Materials;
    TSet<FString> Tags;
    if (!HaybaPCGMesh::CopyFirstMesh(Context, PCGPinConstants::DefaultInputLabel, Mesh, &Materials, &Tags))
    {
        return true;   // no input mesh
    }

    if (!Mesh.HasAttributes()) { Mesh.EnableAttributes(); }

    FDynamicMeshUVEditor UVEditor(&Mesh, /*UVLayerIndex=*/0, /*bCreateIfMissing=*/true);
    TArray<int32> Tris;
    Tris.Reserve(Mesh.TriangleCount());
    for (const int32 tid : Mesh.TriangleIndicesItr()) { Tris.Add(tid); }

    const double S = FMath::Max(1.0, Settings->TileSizeCm);
    UVEditor.SetTriangleUVsFromBoxProjection(
        Tris,
        [](const FVector3d& P) { return P; },   // identity -> project in world space
        FFrame3d(),                              // world-aligned box at the origin
        FVector3d(S, S, S),                      // world cm per UV tile
        /*MinIslandTriCount=*/2);

    HaybaPCGMesh::Emit(Context, MoveTemp(Mesh), Materials, Tags);
    return true;
}

#undef LOCTEXT_NAMESPACE
