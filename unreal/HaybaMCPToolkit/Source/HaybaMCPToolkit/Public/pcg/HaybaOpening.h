// Deterministic doorway opening: remove every triangle whose centroid falls
// inside an oriented door box in BondXf-local space. Open-mesh-safe (no boolean,
// no plane-cut) — the SP-1 realization of "punch a hole where the bores connect".
// Local axes match the tunnel frame: x=tangent(depth), y=right(width), z=up(height).
#pragma once

#include "CoreMinimal.h"
#include "DynamicMesh/DynamicMesh3.h"
#include "DynamicMeshEditor.h"            // FDynamicMeshEditor, FMeshIndexMappings (GeometryCore)
#include "DynamicMesh/MeshNormals.h"      // FMeshNormals::QuickRecomputeOverlayNormals (GeometryCore)
#include "DynamicMesh/Operations/MergeCoincidentMeshEdges.h"  // FMergeCoincidentMeshEdges (GeometryCore — seam weld)
#include "Generators/GridBoxMeshGenerator.h"  // FGridBoxMeshGenerator (GeometryCore — clean closed box cutter)
#include "FrameTypes.h"                   // FFrame3d (GeometryCore)
#include "BoxTypes.h"                     // FOrientedBox3d / FAxisAlignedBox3d (GeometryCore)
#include "Operations/MeshBoolean.h"       // FMeshBoolean TrimInside (GeometryCore — carve openings)

namespace HaybaOpening
{
    // Seam treatment where the two bonded shells meet. uint8 values match
    // EHaybaSeamStyle on the Socket Bond node (kept in lockstep by index).
    enum class ESeamStyle : uint8 { ButtJoint = 0, Welded = 1, Collar = 2 };

    // Knobs handed to CutSocket. (The bond geometry is fully derived from the two
    // meshes' bounds, so the only authored knob today is the seam treatment.)
    struct FSocketCut
    {
        ESeamStyle Seam = ESeamStyle::Welded;
    };

    // A clean CLOSED box mesh matching another mesh's axis-aligned bounds, optionally
    // inflated. TrimInside needs a closed cutter; a shell's bounding box is always one,
    // unlike the open shell itself (which can't be reliably capped).
    inline UE::Geometry::FDynamicMesh3 BoundsBox(const UE::Geometry::FDynamicMesh3& M, double Inflate = 0.0)
    {
        using namespace UE::Geometry;
        FAxisAlignedBox3d B = M.GetBounds();
        FGridBoxMeshGenerator Gen;
        Gen.Box = FOrientedBox3d(FFrame3d(B.Center()), B.Extents() + FVector3d(Inflate, Inflate, Inflate));
        Gen.EdgeVertices = FIndex3i(1, 1, 1);
        Gen.Generate();
        return FDynamicMesh3(&Gen);
    }

    // Trim away the part of A that lies inside the closed cutter Cutter (in place).
    inline void TrimInsideBy(UE::Geometry::FDynamicMesh3& A, const UE::Geometry::FDynamicMesh3& Cutter)
    {
        using namespace UE::Geometry;
        FDynamicMesh3 Out;
        FMeshBoolean Trim(&A, FTransformSRT3d::Identity(),
                          &Cutter, FTransformSRT3d::Identity(),
                          &Out, FMeshBoolean::EBooleanOp::TrimInside);
        Trim.bWeldSharedEdges = false;        // nothing to weld during the carve
        Trim.bSimplifyAlongNewEdges = false;  // keep the clean cut edges along the intersection
        if (Trim.Compute() && Out.TriangleCount() > 0)
        {
            A = MoveTemp(Out);
        }
    }

    // Bond two open shells into a connected space using each other's BOUNDING BOX as a
    // clean closed cutter. TrimInside(host, branchBox) carves an opening wherever the
    // branch's volume crosses the host — automatically once, twice, or N times. TrimInside
    // (branch, hostBox) drops the branch run inside the host bounds, leaving stubs whose
    // mouths sit at the host walls, so the two spaces MERGE. Open-mesh-safe (single-sided).
    inline int32 CutSocket(UE::Geometry::FDynamicMesh3& Host, UE::Geometry::FDynamicMesh3& Branch,
                           const FSocketCut& S)
    {
        using namespace UE::Geometry;

        const FDynamicMesh3 BranchBox = BoundsBox(Branch);
        const FDynamicMesh3 HostBox   = BoundsBox(Host);

        TrimInsideBy(Host, BranchBox);     // openings in the host at every branch crossing
        TrimInsideBy(Branch, HostBox);     // drop the branch run inside the host (merge spaces)

        FDynamicMeshEditor Editor(&Host);
        FMeshIndexMappings Map;
        Editor.AppendMesh(&Branch, Map);
        if (S.Seam != ESeamStyle::ButtJoint)
        {
            FMergeCoincidentMeshEdges Merge(&Host);
            Merge.Apply();
        }
        FMeshNormals::QuickRecomputeOverlayNormals(Host);
        return Host.TriangleCount();
    }

    inline int32 PunchDoorway(UE::Geometry::FDynamicMesh3& Mesh, const FTransform& BondXf,
                              double WidthCm, double HeightCm, double DepthCm)
    {
        const double HalfW = WidthCm * 0.5;
        const double HalfD = DepthCm * 0.5;

        // Keep all math double-precision: SP-1's real junction sits at world
        // coordinates, not origin, so narrowing the centroid through float before
        // the inverse-transform would misclassify boundary triangles. Build the
        // double-precision bond transform once, outside the loop.
        const FTransform3d BondXf3d(BondXf);

        // Collect first (do not mutate the mesh while iterating its triangle set).
        TArray<int32> ToRemove;
        for (const int32 tid : Mesh.TriangleIndicesItr())
        {
            const FVector3d Cw = Mesh.GetTriCentroid(tid);
            const FVector3d L = BondXf3d.InverseTransformPosition(Cw);
            if (FMath::Abs(L.Y) <= HalfW && L.Z >= 0.0 && L.Z <= HeightCm && FMath::Abs(L.X) <= HalfD)
            {
                ToRemove.Add(tid);
            }
        }
        for (const int32 tid : ToRemove)
        {
            Mesh.RemoveTriangle(tid, /*bRemoveIsolatedVertices=*/true, /*bPreserveManifold=*/false);
        }
        return ToRemove.Num();
    }

    // Flat wall in the Y-Z plane at x=0: y in [-HalfWidth, HalfWidth], z in [0, Height].
    inline void AppendWallGrid(UE::Geometry::FDynamicMesh3& Mesh, double HalfWidthCm, double HeightCm,
                               int32 Cols, int32 Rows)
    {
        using namespace UE::Geometry;
        Cols = FMath::Max(1, Cols);
        Rows = FMath::Max(1, Rows);
        // (Cols+1)x(Rows+1) vertex grid.
        TArray<int32> V; V.SetNum((Cols + 1) * (Rows + 1));
        auto Idx = [Cols](int32 c, int32 r) { return r * (Cols + 1) + c; };
        for (int32 r = 0; r <= Rows; ++r)
        {
            const double z = HeightCm * (double)r / (double)Rows;
            for (int32 c = 0; c <= Cols; ++c)
            {
                const double y = -HalfWidthCm + (2.0 * HalfWidthCm) * (double)c / (double)Cols;
                V[Idx(c, r)] = Mesh.AppendVertex(FVector3d(0.0, y, z));
            }
        }
        for (int32 r = 0; r < Rows; ++r)
        {
            for (int32 c = 0; c < Cols; ++c)
            {
                const int32 A = V[Idx(c,     r)];
                const int32 B = V[Idx(c + 1, r)];
                const int32 C = V[Idx(c + 1, r + 1)];
                const int32 D = V[Idx(c,     r + 1)];
                Mesh.AppendTriangle(FIndex3i(A, B, C));
                Mesh.AppendTriangle(FIndex3i(A, C, D));
            }
        }
    }
}
