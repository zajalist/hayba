#include "pcg/PCGFlipNormals.h"
#include "pcg/HaybaPCGMesh.h"

#include "PCGContext.h"
#include "PCGPin.h"
#include "PCGCommon.h"
#include "DynamicMesh/DynamicMesh3.h"

#include UE_INLINE_GENERATED_CPP_BY_NAME(PCGFlipNormals)

#define LOCTEXT_NAMESPACE "PCGFlipNormals"

#if WITH_EDITOR
FText UPCGFlipNormalsSettings::GetDefaultNodeTitle() const { return LOCTEXT("Title", "Plumb | Flip Normals"); }
FText UPCGFlipNormalsSettings::GetNodeTooltipText() const
{
    return LOCTEXT("Tooltip",
        "Reverses the triangle winding and flips the normals of the input dynamic mesh "
        "(e.g. to render a swept shell single-sided from the inside).");
}
#endif

TArray<FPCGPinProperties> UPCGFlipNormalsSettings::InputPinProperties() const
{
    TArray<FPCGPinProperties> Pins;
    Pins.Emplace(PCGPinConstants::DefaultInputLabel, EPCGDataType::DynamicMesh, /*bAllowMultiple=*/false, /*bAllowMultipleData=*/false);
    return Pins;
}

TArray<FPCGPinProperties> UPCGFlipNormalsSettings::OutputPinProperties() const
{
    TArray<FPCGPinProperties> Pins;
    Pins.Emplace(PCGPinConstants::DefaultOutputLabel, EPCGDataType::DynamicMesh, /*bAllowMultiple=*/false, /*bAllowMultipleData=*/false);
    return Pins;
}

FPCGElementPtr UPCGFlipNormalsSettings::CreateElement() const { return MakeShared<FPCGFlipNormalsElement>(); }

bool FPCGFlipNormalsElement::ExecuteInternal(FPCGContext* Context) const
{
    using namespace UE::Geometry;
    TRACE_CPUPROFILER_EVENT_SCOPE(FPCGFlipNormalsElement::Execute);
    check(Context);

    FDynamicMesh3 Mesh;
    TArray<UMaterialInterface*> Materials;
    TSet<FString> Tags;
    if (!HaybaPCGMesh::CopyFirstMesh(Context, PCGPinConstants::DefaultInputLabel, Mesh, &Materials, &Tags))
    {
        return true;   // no input mesh -> nothing to emit
    }

    // Reverse winding AND flip the vertex/overlay normals in one pass.
    Mesh.ReverseOrientation(/*bFlipNormals=*/true);

    HaybaPCGMesh::Emit(Context, MoveTemp(Mesh), Materials, Tags);
    return true;
}

#undef LOCTEXT_NAMESPACE
