// Shared PCG <-> DynamicMesh I/O for the Plumb mesh primitive nodes. Keeps the
// read-first-mesh / emit-mesh boilerplate in one place so each node body is just
// its geometry op.
#pragma once

#include "CoreMinimal.h"
#include "PCGContext.h"
#include "PCGPin.h"
#include "PCGCommon.h"
#include "Data/PCGDynamicMeshData.h"
#include "UDynamicMesh.h"
#include "DynamicMesh/DynamicMesh3.h"
#include "Materials/MaterialInterface.h"

namespace HaybaPCGMesh
{
    // Copy the first DynamicMesh on a named input pin into OutMesh (a mutable copy so
    // the caller can edit it). Optionally also returns its materials (converted from
    // TObjectPtr to raw pointers for UPCGDynamicMeshData::Initialize) and its tags.
    // Returns false if the pin has no DynamicMesh data (or it is un-initialized).
    inline bool CopyFirstMesh(FPCGContext* Context, const FName& Pin,
                              UE::Geometry::FDynamicMesh3& OutMesh,
                              TArray<UMaterialInterface*>* OutMaterials = nullptr,
                              TSet<FString>* OutTags = nullptr)
    {
        for (const FPCGTaggedData& D : Context->InputData.GetInputsByPin(Pin))
        {
            const UPCGDynamicMeshData* DM = Cast<UPCGDynamicMeshData>(D.Data);
            if (!DM) { continue; }
            const UDynamicMesh* UM = DM->GetDynamicMesh();
            if (!UM) { continue; }   // present but un-initialized -> skip (no crash)

            OutMesh = UM->GetMeshRef();   // GetMeshRef() const -> copy into OutMesh
            if (OutMaterials)
            {
                OutMaterials->Reset();
                for (const TObjectPtr<UMaterialInterface>& M : DM->GetMaterials())
                {
                    OutMaterials->Add(M);
                }
            }
            if (OutTags) { *OutTags = D.Tags; }
            return true;
        }
        return false;
    }

    // Emit a DynamicMesh on the node's default output pin with the given materials/tags.
    inline void Emit(FPCGContext* Context, UE::Geometry::FDynamicMesh3&& Mesh,
                     const TArray<UMaterialInterface*>& Materials, const TSet<FString>& Tags)
    {
        UPCGDynamicMeshData* OutData = FPCGContext::NewObject_AnyThread<UPCGDynamicMeshData>(Context);
        OutData->Initialize(MoveTemp(Mesh), Materials);

        FPCGTaggedData& Out = Context->OutputData.TaggedData.Emplace_GetRef();
        Out.Data = OutData;
        Out.Pin  = PCGPinConstants::DefaultOutputLabel;
        Out.Tags = Tags;
    }
}
