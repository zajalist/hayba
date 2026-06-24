#pragma once
#include "CoreMinimal.h"
#include "DynamicMesh/DynamicMesh3.h"
#include "DynamicMesh/Operations/MergeCoincidentMeshEdges.h"
#include "DynamicMesh/MeshNormals.h"

struct FHaybaMeshOps
{
	// Weld coincident edges then recompute overlay normals.
	// Verbatim extraction of the two-call weld+normals pattern from PCGGrammarSolver.cpp
	// (tunnel shell finalize and room shell finalize — Task 0.2, H2 partial).
	// Call order: Welder.Apply() first, QuickRecomputeOverlayNormals second — matches both sites.
	static void WeldAndNormals(UE::Geometry::FDynamicMesh3& Mesh)
	{
		UE::Geometry::FMergeCoincidentMeshEdges Welder(&Mesh);
		Welder.Apply();
		UE::Geometry::FMeshNormals::QuickRecomputeOverlayNormals(Mesh);
	}
};
