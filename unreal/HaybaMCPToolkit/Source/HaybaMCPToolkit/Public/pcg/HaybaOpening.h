// Deterministic doorway opening: remove every triangle whose centroid falls
// inside an oriented door box in BondXf-local space. Open-mesh-safe (no boolean,
// no plane-cut) — the SP-1 realization of "punch a hole where the bores connect".
// Local axes match the tunnel frame: x=tangent(depth), y=right(width), z=up(height).
#pragma once

#include "CoreMinimal.h"
#include "DynamicMesh/DynamicMesh3.h"

namespace HaybaOpening
{
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
