#include "pcg/PCGSocketBond.h"

#include "PCGContext.h"
#include "PCGPin.h"
#include "PCGCommon.h"
#include "Data/PCGDynamicMeshData.h"
#include "Materials/MaterialInterface.h"
#include "DrawDebugHelpers.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"

#include "DynamicMesh/DynamicMesh3.h"
// NOTE(API-DEVIATION): DynamicMeshEditor.h lives at
// GeometryCore/Public/DynamicMeshEditor.h (not inside a DynamicMesh/ subdir).
// The brief flagged "DynamicMesh/DynamicMeshEditor.h" as uncertain — confirmed:
// the real path in UE 5.7 is "DynamicMeshEditor.h".
#include "DynamicMeshEditor.h"

// UDynamicMesh (GetMeshRef) — comes from GeometryFramework via the PCGDynamicMeshData header
#include "UDynamicMesh.h"

#include "pcg/HaybaSocketStore.h"
#include "pcg/HaybaSocketSolver.h"
#include "pcg/HaybaUnsatCore.h"
#include "pcg/HaybaOpening.h"
#include "pcg/HaybaMeshOps.h"

#include UE_INLINE_GENERATED_CPP_BY_NAME(PCGSocketBond)

#define LOCTEXT_NAMESPACE "PCGSocketBond"

#if WITH_EDITOR
FText UPCGSocketBondSettings::GetDefaultNodeTitle() const { return LOCTEXT("Title", "Plumb | Socket Bond"); }
FText UPCGSocketBondSettings::GetNodeTooltipText() const
{
    return LOCTEXT("Tooltip",
        "Bonds the Host and Branch shells by socket-contract cost-min (reads "
        ".scratch/sockets.json). Always writes .scratch/unsat-core.json (the test oracle) and "
        "draws the human-readable bond status at the junction. On success, cuts openings wherever "
        "the Branch crosses the Host (once, twice, or N times) and merges the spaces; on failure, "
        "Host is emitted unchanged (the shells stay sealed).");
}
#endif

TArray<FPCGPinProperties> UPCGSocketBondSettings::InputPinProperties() const
{
    TArray<FPCGPinProperties> Pins;
    Pins.Emplace(FName(TEXT("Host")),   EPCGDataType::DynamicMesh, /*bAllowMultiple=*/false, /*bAllowMultipleData=*/false);
    Pins.Emplace(FName(TEXT("Branch")), EPCGDataType::DynamicMesh, /*bAllowMultiple=*/false, /*bAllowMultipleData=*/false);
    return Pins;
}

TArray<FPCGPinProperties> UPCGSocketBondSettings::OutputPinProperties() const
{
    TArray<FPCGPinProperties> Pins;
    Pins.Emplace(PCGPinConstants::DefaultOutputLabel, EPCGDataType::DynamicMesh, false, false);
    return Pins;
}

FPCGElementPtr UPCGSocketBondSettings::CreateElement() const { return MakeShared<FPCGSocketBondElement>(); }

namespace
{
    // First DynamicMesh on a named input pin (copied, so we can mutate it).
    static bool CopyMeshFromPin(FPCGContext* Context, const FName& Pin, UE::Geometry::FDynamicMesh3& Out)
    {
        const TArray<FPCGTaggedData> In = Context->InputData.GetInputsByPin(Pin);
        for (const FPCGTaggedData& D : In)
        {
            if (const UPCGDynamicMeshData* DM = Cast<UPCGDynamicMeshData>(D.Data))
            {
                // GetDynamicMesh() returns const UDynamicMesh*; an upstream node can emit a
                // bare (un-Initialize'd) UPCGDynamicMeshData whose inner UDynamicMesh is null,
                // so guard it — chaining ->GetMeshRef() on null is a cook-time crash.
                if (const UDynamicMesh* UM = DM->GetDynamicMesh())
                {
                    // GetMeshRef() copies the underlying FDynamicMesh3 by value so we can
                    // mutate our local copy safely.
                    Out = UM->GetMeshRef(); // copy
                    return true;
                }
            }
        }
        return false;
    }
}

bool FPCGSocketBondElement::ExecuteInternal(FPCGContext* Context) const
{
    TRACE_CPUPROFILER_EVENT_SCOPE(FPCGSocketBondElement::Execute);
    check(Context);
    using namespace UE::Geometry;

    const UPCGSocketBondSettings* Settings = Context->GetInputSettings<UPCGSocketBondSettings>();
    check(Settings);

    FDynamicMesh3 Host, Branch;
    const bool bHasHost   = CopyMeshFromPin(Context, FName(TEXT("Host")),   Host);
    const bool bHasBranch = CopyMeshFromPin(Context, FName(TEXT("Branch")), Branch);
    if (!bHasHost)
    {
        UE_LOG(LogTemp, Warning, TEXT("SocketBond: no Host mesh; nothing to emit."));
        return true;
    }

    // ---- Load contracts + solve the one named bond.
    const FString SocketsFile = HaybaSocketStore::ResolvePath(Settings->SocketsPath);
    FHaybaSocketSet Set; FString LoadErr;
    FHaybaBondOutcome Outcome;
    FName Frontier = NAME_None, Candidate = NAME_None;
    if (HaybaSocketStore::Load(SocketsFile, Set, LoadErr))
    {
        Frontier  = Set.BondFrontier;
        Candidate = Set.BondCandidate;
        const FHaybaSocketContract* F = Set.Sockets.Find(Frontier);
        const FHaybaSocketContract* C = Set.Sockets.Find(Candidate);
        if (F && C)
        {
            TArray<FHaybaSocketContract> Cands = { *C };
            Outcome = HaybaSocketSolver::SolveBond(*F, Cands);
            // SolveBond fills Requirer/Provider from the offending direction; for a clean
            // bond those are NAME_None, so stamp the named endpoints for the OK overlay.
            if (Outcome.bOk && !Outcome.bRelaxed)
            {
                Outcome.RequirerName = Frontier;
                Outcome.ProviderName = Candidate;
            }
        }
        else
        {
            UE_LOG(LogTemp, Warning, TEXT("SocketBond: bond endpoints %s/%s not found in %s"),
                *Frontier.ToString(), *Candidate.ToString(), *SocketsFile);
        }
    }
    else
    {
        UE_LOG(LogTemp, Warning, TEXT("SocketBond: %s"), *LoadErr);
    }

    // ---- The bond geometry (CutSocket) trims the two shells against each other's
    //      closed hulls, so it only needs the seam style. We still derive a bond
    //      position from the branch bounds for the unsat-core viewport overlay.
    FTransform BondXf = FTransform::Identity;
    HaybaOpening::FSocketCut Cut;
    bool bHaveFrame = false;
    if (bHasBranch)
    {
        const FAxisAlignedBox3d BB = Branch.GetBounds();
        BondXf = FTransform(FQuat::Identity, FVector(BB.Center()) + Settings->BondLocalOffset);
        Cut.Seam = static_cast<HaybaOpening::ESeamStyle>(static_cast<uint8>(Settings->SeamStyle));
        bHaveFrame = true;
    }

    // ---- Always write the unsat-core report (the test oracle). The Task 9 gate
    //      reads this file, so a silent write failure must not pass unnoticed.
    {
        FString WriteErr;
        if (!HaybaUnsatCore::Write(Outcome, Frontier, Candidate, HaybaUnsatCore::ResolvePath(), WriteErr)
            || !WriteErr.IsEmpty())
        {
            UE_LOG(LogTemp, Warning, TEXT("SocketBond: unsat-core write failed: %s"), *WriteErr);
        }
    }

    // ---- Draw the human line at the junction.
    if (AActor* TargetActor = Context->GetTargetActor(nullptr))
    {
        if (UWorld* World = TargetActor->GetWorld())
        {
            const FColor Col = Outcome.bOk ? (Outcome.bRelaxed ? FColor::Yellow : FColor::Green) : FColor::Red;
            DrawDebugString(World, BondXf.GetLocation() + FVector(0, 0, 50.0),
                HaybaUnsatCore::BuildHuman(Outcome), nullptr, Col, /*Duration=*/0.f, /*DrawShadow=*/true);
        }
    }

    // ---- Realize geometry: openings where the shells cross + merged spaces (CutSocket
    //      trims each shell by the other's bounds, then welds/normals per SeamStyle).
    FDynamicMesh3 Result = Host;
    if (Outcome.bOk && bHaveFrame)
    {
        HaybaOpening::CutSocket(Result, Branch, Cut);
    }

    UPCGDynamicMeshData* OutData = FPCGContext::NewObject_AnyThread<UPCGDynamicMeshData>(Context);
    TArray<UMaterialInterface*> Materials;
    if (UMaterialInterface* M = Settings->ShellMaterial.LoadSynchronous()) { Materials.Add(M); }
    OutData->Initialize(MoveTemp(Result), Materials);

    FPCGTaggedData& Out = Context->OutputData.TaggedData.Emplace_GetRef();
    Out.Data = OutData;
    Out.Pin  = PCGPinConstants::DefaultOutputLabel;
    return true;
}

#undef LOCTEXT_NAMESPACE
