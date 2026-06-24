#include "pcg/PCGGrammarSolver.h"

#include "PCGContext.h"
#include "PCGPin.h"
#include "PCGCommon.h"
#include "Data/PCGSplineData.h"
#include "Data/PCGDynamicMeshData.h"
#include "Data/PCGBasePointData.h"
#include "PCGPoint.h"                 // FPCGPoint (explicit; do not rely on transitive)
#include "PCGPointPropertiesTraits.h" // EPCGPointNativeProperties flags
#include "Metadata/PCGMetadata.h"
#include "Metadata/PCGMetadataAttributeTpl.h"
#include "Materials/MaterialInterface.h"
#include "Engine/StaticMesh.h"

#include "DynamicMesh/DynamicMesh3.h"
#include "DynamicMesh/MeshNormals.h"
#include "DynamicMesh/Operations/MergeCoincidentMeshEdges.h" // weld co-located edges before normals
#include "IndexTypes.h"

#include "HAL/PlatformMisc.h" // FPlatformMisc::GetEnvironmentVariable
#include "Misc/Paths.h"
#include "Misc/FileHelper.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

#include "pcg/HaybaGrammarTypes.h"

#include UE_INLINE_GENERATED_CPP_BY_NAME(PCGGrammarSolver)

#define LOCTEXT_NAMESPACE "PCGGrammarSolver"

// ---------------------------------------------------------------------------
// Settings boilerplate
// ---------------------------------------------------------------------------
#if WITH_EDITOR
FText UPCGGrammarSolverSettings::GetDefaultNodeTitle() const
{
	return LOCTEXT("Title", "Grammar Solver");
}
FText UPCGGrammarSolverSettings::GetNodeTooltipText() const
{
	return LOCTEXT("Tooltip", "Reads grammar.json, expands a seed symbol via a production worklist, and emits placed points (columns, scattered rubble) on Out plus a welded inner shell (walls + bent vent) on Shell. Deterministic; structural guards (clearance, straight-air) evaluated in C++, full constraints in TS.");
}
#endif

TArray<FPCGPinProperties> UPCGGrammarSolverSettings::InputPinProperties() const
{
	TArray<FPCGPinProperties> Pins;
	Pins.Emplace(PCGPinConstants::DefaultInputLabel, EPCGDataType::PointOrSpline);
	return Pins;
}

TArray<FPCGPinProperties> UPCGGrammarSolverSettings::OutputPinProperties() const
{
	TArray<FPCGPinProperties> Pins;
	// Default "Out" = placed points (columns + rubble).
	Pins.Emplace(PCGPinConstants::DefaultOutputLabel, EPCGDataType::Point);
	// "Shell" = welded inner shell (walls + bent vent) dynamic mesh.
	Pins.Emplace(FName(TEXT("Shell")), EPCGDataType::DynamicMesh, /*bAllowMultipleConnections=*/false, /*bAllowMultipleData=*/false);
	return Pins;
}

FPCGElementPtr UPCGGrammarSolverSettings::CreateElement() const
{
	return MakeShared<FPCGGrammarSolverElement>();
}

// ---------------------------------------------------------------------------
// Element
// ---------------------------------------------------------------------------
namespace
{
	// The 6 rubble meshes (REFERENCE 4), round-robined by index % 6.
	static const TCHAR* GRubbleMeshPaths[] = {
		TEXT("/Game/Fab/Megascans/3D/Cement_Rubble_rinet/Medium/rinet_tier_2/StaticMeshes/rinet_tier_2.rinet_tier_2"),
		TEXT("/Game/Fab/Megascans/3D/Concrete_Rubble_Pile_tfxteboda/Medium/tfxteboda_tier_2/StaticMeshes/tfxteboda_tier_2.tfxteboda_tier_2"),
		TEXT("/Game/Fab/Megascans/3D/Concrete_Rubble_Pile_tgdtfg0da/Medium/tgdtfg0da_tier_2/StaticMeshes/tgdtfg0da_tier_2.tgdtfg0da_tier_2"),
		TEXT("/Game/Fab/Megascans/3D/Concrete_Rubble_Pile_ujriaadga/Medium/ujriaadga_tier_2/StaticMeshes/ujriaadga_tier_2.ujriaadga_tier_2"),
		TEXT("/Game/Fab/Megascans/3D/Construction_Rubble_rigrp/Medium/rigrp_tier_2/StaticMeshes/rigrp_tier_2.rigrp_tier_2"),
		TEXT("/Game/Fab/Megascans/3D/Stone_Rubble_Pile_udxlfezfa/Medium/udxlfezfa_tier_2/StaticMeshes/udxlfezfa_tier_2.udxlfezfa_tier_2"),
	};
	static constexpr int32 kNumRubble = 6;

	// Attribute name a downstream PCGStaticMeshSpawner (MeshSelectorByAttribute)
	// reads to pick the per-point mesh. Type MUST be FSoftObjectPath (REFERENCE 2c).
	static const FName kMeshAttributeName(TEXT("Mesh"));

	// Deterministic 0..1 jitter from (kind + index). NO FMath::Rand.
	// Mixes the FString hash with two integers via a fixed multiplicative hash
	// (Knuth's 2654435761) so the result is stable across runs and platforms.
	static double DeterministicUnit(const FString& Kind, int32 IndexA, int32 IndexB)
	{
		uint32 H = GetTypeHash(Kind);
		H ^= (uint32)IndexA * 2654435761u;
		H = (H << 13) | (H >> 19); // rotate to spread bits
		H ^= (uint32)IndexB * 2246822519u;
		// Map to [0,1): use the top 24 bits for a stable fraction.
		return (double)(H & 0xFFFFFFu) / (double)0x1000000u;
	}

	// Resolve the grammar.json path, honoring HAYBA_GRAMMAR / HAYBA_PROFILES env,
	// then the Settings override, then <ProjectDir>/.scratch/grammar.json.
	static FString ResolveGrammarPath(const FString& SettingsPath)
	{
		// 1) Explicit settings path wins if set.
		if (!SettingsPath.IsEmpty())
		{
			return SettingsPath;
		}
		// 2) HAYBA_GRAMMAR (full path).
		const FString EnvGrammar = FPlatformMisc::GetEnvironmentVariable(TEXT("HAYBA_GRAMMAR"));
		if (!EnvGrammar.IsEmpty())
		{
			return EnvGrammar;
		}
		// 3) HAYBA_PROFILES -> grammar.json in its directory.
		const FString EnvProfiles = FPlatformMisc::GetEnvironmentVariable(TEXT("HAYBA_PROFILES"));
		if (!EnvProfiles.IsEmpty())
		{
			return FPaths::Combine(FPaths::GetPath(EnvProfiles), TEXT("grammar.json"));
		}
		// 4) <ProjectDir>/.scratch/grammar.json.
		return FPaths::Combine(FPaths::ProjectDir(), TEXT(".scratch"), TEXT("grammar.json"));
	}
}

bool FPCGGrammarSolverElement::ExecuteInternal(FPCGContext* Context) const
{
	using namespace UE::Geometry;
	using namespace HaybaGrammar;
	TRACE_CPUPROFILER_EVENT_SCOPE(FPCGGrammarSolverElement::Execute);
	check(Context);

	const UPCGGrammarSolverSettings* Settings = Context->GetInputSettings<UPCGGrammarSolverSettings>();
	check(Settings);

	UMaterialInterface* ShellMat = Settings->ShellMaterial.LoadSynchronous();
	const FSoftObjectPath ColumnMeshPath = Settings->ColumnMesh.ToSoftObjectPath();

	// ---- Load + parse grammar.json once (REFERENCE 4 idiom). Missing file => {}.
	TArray<FProduction> Prods;
	{
		const FString GrammarFile = ResolveGrammarPath(Settings->GrammarPath);
		FString Raw;
		if (FFileHelper::LoadFileToString(Raw, *GrammarFile))
		{
			TSharedPtr<FJsonObject> Root;
			TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Raw);
			if (FJsonSerializer::Deserialize(Reader, Root) && Root.IsValid())
			{
				ParseGrammar(Root, Prods);
			}
			// Parse failure -> empty production set (silent fallback, like the TS store).
		}
		// Missing file -> empty production set; the seed yields a single rejected sentinel.
	}

	const TArray<FPCGTaggedData> Inputs = Context->InputData.GetInputsByPin(PCGPinConstants::DefaultInputLabel);
	for (const FPCGTaggedData& In : Inputs)
	{
		// ---- Determine kind early so we can branch to the room path before any
		// spline cast. Metadata is present on both spline and point data.
		const UPCGData* InData = In.Data;
		// Kind is determined by INPUT DATA TYPE (no 'kind' attribute): point data
		// => room, spline data => tunnel. Per-primitive attributes (builder/w/h/...)
		// still come from the DATA-domain metadata via ReadStr/NumAttr.
		const bool bIsRoom = (Cast<UPCGBasePointData>(InData) != nullptr);
		const FString EarlyKind = bIsRoom ? TEXT("room") : TEXT("tunnel");

		// ====================================================================
		// ROOM PATH: kind == "room"
		// Input is a single UPCGBasePointData point whose Transform.Location is
		// the room center and Transform.Scale3D carries the full box dimensions (cm).
		// Only "imperial" builder is realized here; "native" is a TODO (Task 7).
		// ====================================================================
		if (EarlyKind == TEXT("room"))
		{
			const UPCGBasePointData* PointData = Cast<UPCGBasePointData>(InData);
			if (!PointData || PointData->GetNumPoints() == 0)
			{
				// No usable point — skip this input silently.
				continue;
			}

			// Read the builder attr from metadata (same helper used by the tunnel path).
			const FString BuilderAttr = ReadStrAttr(InData, FName(TEXT("builder")), TEXT("native"));

			if (BuilderAttr != TEXT("imperial"))
			{
				// TODO(Task 7): native room builder. No-op for now.
				continue;
			}

			// ---- Read room geometry from the first point.
			// UE 5.7 UPCGBasePointData is SoA; GetPoint(int32) lives on the value-range
			// view, not the data object. The direct per-property accessor is
			// GetTransform(int32) (PCGBasePointData.h:223).
			const FTransform RoomXf = PointData->GetTransform(0);
			const FVector Center   = RoomXf.GetLocation();
			const FVector FullSize = RoomXf.GetScale3D(); // full box dims (cm)

			// ---- Build the shell mesh (closed inward-facing box).
			FDynamicMesh3 Mesh;
			Mesh.EnableAttributes();
			Mesh.Attributes()->EnableMaterialID();
			Mesh.Attributes()->SetNumUVLayers(1);
			bool bAnyShell = false;

			// AddRoomShellImperial: appends a CLOSED welded box shell with 8 shared
			// corner vertices and 12 triangles (6 faces × 2). All faces wind so their
			// computed normal points INWARD (toward the room centre).
			//
			// Winding strategy: for each face we compute the geometric normal of the
			// first triangle (cross product of edges from the first vertex) and compare
			// it to the desired inward direction. If the dot product is negative the
			// natural CCW winding already points inward; otherwise we swap the second and
			// third indices to flip. This is the same per-face flip used by AddQuad so
			// the scheme is consistent across the whole file.
			//
			// Corner layout (right-hand, Z-up):
			//   v0 = (-hx, -hy, -hz)  v1 = (+hx, -hy, -hz)
			//   v2 = (+hx, +hy, -hz)  v3 = (-hx, +hy, -hz)
			//   v4 = (-hx, -hy, +hz)  v5 = (+hx, -hy, +hz)
			//   v6 = (+hx, +hy, +hz)  v7 = (-hx, +hy, +hz)
			//
			// Each face names its 4 corners in a consistent CCW order when viewed from
			// the OUTSIDE; the flip then inverts the winding so normals point inward.
			auto AddRoomShellImperial = [&](const FVector& Ctr, const FVector& Size)
			{
				const FVector H = Size * 0.5; // half-extents

				// 8 shared corner vertices. Indices stored for face indexing.
				const int32 V[8] = {
					Mesh.AppendVertex(FVector3d(Ctr + FVector(-H.X, -H.Y, -H.Z))), // 0 BLL
					Mesh.AppendVertex(FVector3d(Ctr + FVector(+H.X, -H.Y, -H.Z))), // 1 BRL
					Mesh.AppendVertex(FVector3d(Ctr + FVector(+H.X, +H.Y, -H.Z))), // 2 BRR
					Mesh.AppendVertex(FVector3d(Ctr + FVector(-H.X, +H.Y, -H.Z))), // 3 BLR
					Mesh.AppendVertex(FVector3d(Ctr + FVector(-H.X, -H.Y, +H.Z))), // 4 TLL
					Mesh.AppendVertex(FVector3d(Ctr + FVector(+H.X, -H.Y, +H.Z))), // 5 TRL
					Mesh.AppendVertex(FVector3d(Ctr + FVector(+H.X, +H.Y, +H.Z))), // 6 TRR
					Mesh.AppendVertex(FVector3d(Ctr + FVector(-H.X, +H.Y, +H.Z)))  // 7 TLR
				};

				// AddFace: two triangles from a quad, flipped so the normal points
				// toward InwardDir (into the room). Sets per-triangle material ID and
				// per-wedge planar UVs (dots with UAxis/VAxis, cm→tiles at 1m scale).
				FDynamicMeshUVOverlay*         UVOv    = Mesh.Attributes()->PrimaryUV();
				FDynamicMeshMaterialAttribute* MatAttr = Mesh.Attributes()->GetMaterialID();
				auto AddFace = [&](int32 a, int32 b, int32 c, int32 d,
				                   const FVector3d& InwardDir,
				                   int32 MatId,
				                   const FVector3d& UAxis, const FVector3d& VAxis)
				{
					// Planar UV per corner: project world position onto face axes, cm→tiles.
					auto UVof = [&](int32 vi)
					{
						const FVector3d P = Mesh.GetVertex(vi);
						return FVector2f((float)(P.Dot(UAxis) / 100.0), (float)(P.Dot(VAxis) / 100.0));
					};
					const int32 ea = UVOv->AppendElement(UVof(a));
					const int32 eb = UVOv->AppendElement(UVof(b));
					const int32 ec = UVOv->AppendElement(UVof(c));
					const int32 ed = UVOv->AppendElement(UVof(d));

					// Triangle ABC: natural CCW normal = (B-A) x (C-A)
					const FVector3d pa = Mesh.GetVertex(a);
					const FVector3d pb = Mesh.GetVertex(b);
					const FVector3d pc = Mesh.GetVertex(c);
					const FVector3d n  = (pb - pa).Cross(pc - pa);
					int32 t0, t1;
					if (n.Dot(InwardDir) < 0.0)
					{
						// Natural winding already faces inward — keep it.
						t0 = Mesh.AppendTriangle(FIndex3i(a, b, c));
						t1 = Mesh.AppendTriangle(FIndex3i(a, c, d));
						if (t0 >= 0) { UVOv->SetTriangle(t0, FIndex3i(ea, eb, ec)); MatAttr->SetValue(t0, MatId); }
						if (t1 >= 0) { UVOv->SetTriangle(t1, FIndex3i(ea, ec, ed)); MatAttr->SetValue(t1, MatId); }
					}
					else
					{
						// Natural winding faces outward — flip.
						t0 = Mesh.AppendTriangle(FIndex3i(a, c, b));
						t1 = Mesh.AppendTriangle(FIndex3i(a, d, c));
						if (t0 >= 0) { UVOv->SetTriangle(t0, FIndex3i(ea, ec, eb)); MatAttr->SetValue(t0, MatId); }
						if (t1 >= 0) { UVOv->SetTriangle(t1, FIndex3i(ea, ed, ec)); MatAttr->SetValue(t1, MatId); }
					}
				};

				// 6 faces; inward normal = direction from face toward centre.
				// Slot 0 = floor/ceiling, Slot 1 = walls.
				// Floor   (Z-): inward +Z, planar XY
				AddFace(V[0], V[1], V[2], V[3], FVector3d( 0,  0, +1), 0, FVector3d(1,0,0), FVector3d(0,1,0));
				// Ceiling (Z+): inward -Z, planar XY
				AddFace(V[4], V[5], V[6], V[7], FVector3d( 0,  0, -1), 0, FVector3d(1,0,0), FVector3d(0,1,0));
				// Front   (Y-): inward +Y, planar XZ
				AddFace(V[0], V[1], V[5], V[4], FVector3d( 0, +1,  0), 1, FVector3d(1,0,0), FVector3d(0,0,1));
				// Back    (Y+): inward -Y, planar XZ
				AddFace(V[3], V[2], V[6], V[7], FVector3d( 0, -1,  0), 1, FVector3d(1,0,0), FVector3d(0,0,1));
				// Left    (X-): inward +X, planar YZ
				AddFace(V[0], V[3], V[7], V[4], FVector3d(+1,  0,  0), 1, FVector3d(0,1,0), FVector3d(0,0,1));
				// Right   (X+): inward -X, planar YZ
				AddFace(V[1], V[2], V[6], V[5], FVector3d(-1,  0,  0), 1, FVector3d(0,1,0), FVector3d(0,0,1));
			};

			AddRoomShellImperial(Center, FullSize);
			bAnyShell = true;

			// ---- Weld + normals + emit on Shell pin (same path as the tunnel shell).
			if (bAnyShell && Mesh.TriangleCount() > 0)
			{
				FMergeCoincidentMeshEdges Welder(&Mesh);
				Welder.Apply();

				FMeshNormals::QuickRecomputeOverlayNormals(Mesh);

				UPCGDynamicMeshData* ShellData = FPCGContext::NewObject_AnyThread<UPCGDynamicMeshData>(Context);
				// Slot 0 = floor/ceiling material; Slot 1 = wall material.
				// Fall back to ShellMat for any slot whose asset isn't found at cook time.
				UMaterialInterface* FCMat   = Cast<UMaterialInterface>(StaticLoadObject(UMaterialInterface::StaticClass(), nullptr, TEXT("/Game/Hayba/Generated/Mat/MI_RoomFloorCeil.MI_RoomFloorCeil")));
				UMaterialInterface* WallMat = Cast<UMaterialInterface>(StaticLoadObject(UMaterialInterface::StaticClass(), nullptr, TEXT("/Game/Hayba/Generated/Mat/MI_RoomWall.MI_RoomWall")));
				TArray<UMaterialInterface*> RoomMats;
				RoomMats.Add(FCMat   ? FCMat   : ShellMat); // slot 0: floor + ceiling
				RoomMats.Add(WallMat ? WallMat : ShellMat); // slot 1: walls
				ShellData->Initialize(MoveTemp(Mesh), RoomMats);

				FPCGTaggedData& OutShell = Context->OutputData.TaggedData.Emplace_GetRef();
				OutShell.Data = ShellData;
				OutShell.Pin = FName(TEXT("Shell"));
				OutShell.Tags = In.Tags;
			}

			// Room path does not emit any Out points for now (no grammar expansion).
			continue; // skip the spline/tunnel path below for this input
		}

		// ====================================================================
		// TUNNEL PATH (unchanged): kind != "room" — requires a spline input.
		// ====================================================================
		const UPCGSplineData* Spline = Cast<UPCGSplineData>(In.Data);
		if (!Spline)
		{
			continue;
		}

		const FPCGSplineStruct& SS = Spline->SplineStruct;
		const double TotalLen = SS.GetSplineLength();
		const int32 NumCP = SS.GetNumberOfPoints();
		if (TotalLen < 1.0 || NumCP < 2)
		{
			continue;
		}

		const double LenMetres = TotalLen / 100.0; // UE units are cm.

		// ---- Seed symbol: read per-primitive attributes from input data metadata,
		// falling back to the original literals when an attribute is absent.
		const int32 PrimId = (int32)ReadNumAttr(InData, FName(TEXT("prim_id")),    0.0); // stashed for Task 8/9
		(void)PrimId; // Task 8/9 will use this; suppress unused-variable warning until then.
		FSymbol Seed;
		Seed.Kind = EarlyKind; // already read above
		Seed.Attrs.Add(TEXT("builder"),    FAttr::MakeStr(ReadStrAttr(InData, FName(TEXT("builder")),   TEXT("native"))));
		Seed.Attrs.Add(TEXT("phase"),      FAttr::MakeStr(ReadStrAttr(InData, FName(TEXT("phase")),     TEXT("I"))));
		Seed.Attrs.Add(TEXT("importance"), FAttr::MakeNum(ReadNumAttr(InData, FName(TEXT("importance")), 0.3)));
		Seed.Attrs.Add(TEXT("len"),        FAttr::MakeNum(LenMetres)); // always computed from spline length
		Seed.Attrs.Add(TEXT("w"),          FAttr::MakeNum(ReadNumAttr(InData, FName(TEXT("w")),          1.8)));
		Seed.Attrs.Add(TEXT("h"),          FAttr::MakeNum(ReadNumAttr(InData, FName(TEXT("h")),          2.4)));
		// seed (int32 read as double, cast): stored as number attr on the symbol if non-zero.
		{
			const int32 SeedVal = (int32)ReadNumAttr(InData, FName(TEXT("seed")), 0.0);
			Seed.Attrs.Add(TEXT("seed"), FAttr::MakeNum((double)SeedVal));
		}

		FPlacementPlan Plan;
		ExpandGrammar(Seed, Prods, Plan);

		// ---- Source bore width/height ONCE from the seed so the shell build, the
		// column lateral offset, and the clearance guard all agree on the same w/h.
		// (Avoids three independent literals silently diverging.)
		auto SeedNum = [&](const TCHAR* Key, double Fallback) -> double
		{
			const FAttr* A = Seed.Attrs.Find(Key);
			return (A && A->Type == FAttr::EType::Number) ? A->Num : Fallback;
		};
		const double BoreW = SeedNum(TEXT("w"), 1.8); // metres
		const double BoreH = SeedNum(TEXT("h"), 2.4); // metres
		const double BoreWcm = BoreW * 100.0;
		const double BoreHcm = BoreH * 100.0;
		const double BoreHalfWcm = BoreW * 0.5 * 100.0; // bore half-width (cm)

		// ---- Frame helper (shared by shell + along-edge point placement).
		// X=tangent, Y=right, Z=up. Distance D is in UE units (cm).
		auto Frame = [&](double D, FVector& Loc, FVector& Right, FVector& Up, FVector& Tan)
		{
			const float A = (float)FMath::Clamp(D / TotalLen, 0.0, 1.0);
			const FTransform T = Spline->GetTransformAtAlpha(A);
			Loc = T.GetLocation();
			Right = T.GetUnitAxis(EAxis::Y);
			Up = T.GetUnitAxis(EAxis::Z);
			Tan = T.GetUnitAxis(EAxis::X);
		};

		// ====================================================================
		// SHELL MESH (walls + bent vent). Reuses the proven tunnel winding.
		// ====================================================================
		FDynamicMesh3 Mesh;
		Mesh.EnableAttributes();
		Mesh.Attributes()->EnableMaterialID();
		Mesh.Attributes()->SetNumUVLayers(1);
		bool bAnyShell = false;

		// AddQuad: UE-correct winding so the front face points toward ND.
		auto AddQuad = [&](const FVector& P0, const FVector& P1, const FVector& P2, const FVector& P3, const FVector& ND)
		{
			const int32 A = Mesh.AppendVertex(FVector3d(P0));
			const int32 B = Mesh.AppendVertex(FVector3d(P1));
			const int32 C = Mesh.AppendVertex(FVector3d(P2));
			const int32 Dd = Mesh.AppendVertex(FVector3d(P3));
			const FVector3d g = (FVector3d(P1) - FVector3d(P0)).Cross(FVector3d(P2) - FVector3d(P0));
			if (g.Dot(FVector3d(ND)) < 0)
			{
				Mesh.AppendTriangle(FIndex3i(A, B, C));
				Mesh.AppendTriangle(FIndex3i(A, C, Dd));
			}
			else
			{
				Mesh.AppendTriangle(FIndex3i(A, C, B));
				Mesh.AppendTriangle(FIndex3i(A, Dd, C));
			}
		};

		// AddSection: 4 welded inner walls for a constant-size run [DStart,DEnd].
		// Copied verbatim (winding-wise) from the tunnel node. W/H in UE units (cm).
		// Material IDs: floor (w=0) + ceiling (w=1) -> 0; left (w=2) + right (w=3) -> 1.
		// UVs: U = spline distance / 100 (metres along), V = cross-distance / 100.
		auto AddSection = [&](double DStart, double DEnd, double W, double H)
		{
			const double Spacing = 60.0; // cm ring spacing (matches tunnel default)
			const double hw = W * 0.5;
			const int32 N = FMath::Max(1, FMath::CeilToInt((DEnd - DStart) / Spacing));
			const double Walls[4][6] = {
				{ -hw, 0, hw, 0, +1, 0 }, // floor   -> +up
				{ -hw, H, hw, H, -1, 0 }, // ceiling -> -up
				{ -hw, 0, -hw, H, +1, 1 }, // left    -> +right
				{  hw, 0,  hw, H, -1, 1 }  // right   -> -right
			};
			FDynamicMeshUVOverlay*         UVOv    = Mesh.Attributes()->PrimaryUV();
			FDynamicMeshMaterialAttribute* MatAttr = Mesh.Attributes()->GetMaterialID();
			for (int32 w = 0; w < 4; ++w)
			{
				const int32 MatId = (w <= 1) ? 0 : 1; // floor+ceil=0, left+right=1
				int32 prevA = -1, prevB = -1;
				int32 prevUVA = -1, prevUVB = -1;
				for (int32 i = 0; i <= N; ++i)
				{
					const double D = DStart + (DEnd - DStart) * (double)i / (double)N;
					FVector Loc, R, U, Tn; Frame(D, Loc, R, U, Tn);
					const FVector P0 = Loc + R * Walls[w][0] + U * Walls[w][1];
					const FVector P1 = Loc + R * Walls[w][2] + U * Walls[w][3];
					const int32 A = Mesh.AppendVertex(FVector3d(P0));
					const int32 B = Mesh.AppendVertex(FVector3d(P1));
					// UV: U = distance along spline (cm -> metres), V = 0 for P0, cross-width/100 for P1
					const float UCoord  = (float)(D / 100.0);
					const float VCoordA = 0.0f;
					const float VCoordB = (float)(FVector::Dist(P0, P1) / 100.0);
					const int32 uvA = UVOv->AppendElement(FVector2f(UCoord, VCoordA));
					const int32 uvB = UVOv->AppendElement(FVector2f(UCoord, VCoordB));
					if (i > 0)
					{
						const FVector ND = (Walls[w][5] == 0) ? (U * Walls[w][4]) : (R * Walls[w][4]);
						const FVector3d p0 = Mesh.GetVertex(prevA), p1 = Mesh.GetVertex(A), p2 = Mesh.GetVertex(B);
						const FVector3d g = (p1 - p0).Cross(p2 - p0);
						int32 t0, t1;
						if (g.Dot(FVector3d(ND)) < 0)
						{
							t0 = Mesh.AppendTriangle(FIndex3i(prevA, A, B));
							t1 = Mesh.AppendTriangle(FIndex3i(prevA, B, prevB));
							if (t0 >= 0) { UVOv->SetTriangle(t0, FIndex3i(prevUVA, uvA, uvB)); MatAttr->SetValue(t0, MatId); }
							if (t1 >= 0) { UVOv->SetTriangle(t1, FIndex3i(prevUVA, uvB, prevUVB)); MatAttr->SetValue(t1, MatId); }
						}
						else
						{
							t0 = Mesh.AppendTriangle(FIndex3i(prevA, B, A));
							t1 = Mesh.AppendTriangle(FIndex3i(prevA, prevB, B));
							if (t0 >= 0) { UVOv->SetTriangle(t0, FIndex3i(prevUVA, uvB, uvA)); MatAttr->SetValue(t0, MatId); }
							if (t1 >= 0) { UVOv->SetTriangle(t1, FIndex3i(prevUVA, prevUVB, uvB)); MatAttr->SetValue(t1, MatId); }
						}
					}
					prevA = A; prevB = B;
					prevUVA = uvA; prevUVB = uvB;
				}
			}
		};

		// AddVentTube: a short straight tube riding up from the ceiling, then a bend
		// at BendAtM (metres). Built as a box-section tube along an up+forward path so
		// it welds (shares world space) into the shell. Faces inward (toward axis).
		auto AddVentTube = [&](double AtAlpha, double BendAtM)
		{
			// Anchor: ceiling centre at AtAlpha. Lift to the shell ceiling (seed h)
			// so the shaft springs from the top of the bore, not the floor centreline.
			FVector Loc, R, U, Tn; Frame(AtAlpha * TotalLen, Loc, R, U, Tn);
			const double VentW = 120.0;          // cm, square-ish shaft
			const double CeilingCm = BoreHcm;     // shell H (sourced from seed h)
			const double BendCm = FMath::Clamp(BendAtM, 0.5, kMaxStraightRunM) * 100.0;
			const FVector Base  = Loc + U * CeilingCm;   // mouth at the ceiling
			const FVector PApex = Base + U * BendCm;     // bend point
			const FVector PEnd  = PApex + Tn * BendCm;   // far (capped) end
			const double h = VentW * 0.5;

			// Three cross-section rings, each 4 verts appended ONCE. The vertical and
			// horizontal legs reference the SAME miter-ring indices, so the elbow is
			// connected BY CONSTRUCTION -- no reliance on FMergeCoincidentMeshEdges,
			// which won't fuse the same-oriented seam edges a positional miter produces.
			// Corner order is consistent around the tube so wall k spans corners k..k+1
			// on both rings. base k -> miter k -> end k map by (R sign, in-plane sign):
			//   k0:(-R,near) k1:(+R,near) k2:(+R,far) k3:(-R,far)
			const FVector Inner = U * h + Tn * h;       // inner (concave) corner offset
			const FVector BaseRing[4] = {               // R/Tn plane (vertical leg, OPEN mouth)
				Base + R*-h + Tn*-h, Base + R* h + Tn*-h, Base + R* h + Tn* h, Base + R*-h + Tn* h };
			const FVector MiterRing[4] = {              // shared fold loop (the miter)
				PApex - Inner + R*-h, PApex - Inner + R* h, PApex + Inner + R* h, PApex + Inner + R*-h };
			const FVector EndRing[4] = {                // R/U plane (horizontal leg)
				PEnd + R*-h + U*-h, PEnd + R* h + U*-h, PEnd + R* h + U* h, PEnd + R*-h + U* h };

			int32 B[4], M[4], E[4];
			for (int32 k = 0; k < 4; ++k)
			{
				B[k] = Mesh.AppendVertex(FVector3d(BaseRing[k]));
				M[k] = Mesh.AppendVertex(FVector3d(MiterRing[k]));
				E[k] = Mesh.AppendVertex(FVector3d(EndRing[k]));
			}

			// Uniform tube winding. Wall k spans corner k..n on a (near,far) ring pair.
			// Because the three rings share corner ordering with NO twist (verified: each
			// k keeps its R sign and flows its in-plane sign Base->Miter->End), winding
			// every wall with the SAME scheme makes the whole bent tube consistently
			// orientable -- which CheckValidity's default options require. A single flip
			// (decided from wall 0, the -Tn wall, which must face inward +Tn) orients all
			// walls into the bore. Both ends stay OPEN: the Base mouth into the bore and
			// the far mouth venting to the surface.
			const FVector3d gTest = (FVector3d(BaseRing[1]) - FVector3d(BaseRing[0]))
				.Cross(FVector3d(MiterRing[1]) - FVector3d(BaseRing[0]));
			const bool bFlip = gTest.Dot(FVector3d(Tn)) < 0.0;
			FDynamicMeshUVOverlay*         VentUVOv    = Mesh.Attributes()->PrimaryUV();
			FDynamicMeshMaterialAttribute* VentMatAttr = Mesh.Attributes()->GetMaterialID();
			// Vent walls are all slot 1 (wall material). UVs are flat (0,0) — acceptable
			// for a small vent shaft; the material tint is what matters.
			auto Wall = [&](int32 a0, int32 a1, int32 b1, int32 b0) // near a0..a1, far b0..b1
			{
				// Append UV elements — all (0,0) flat for vent tris.
				const int32 uv0 = VentUVOv->AppendElement(FVector2f(0.0f, 0.0f));
				const int32 uv1 = VentUVOv->AppendElement(FVector2f(0.0f, 0.0f));
				const int32 uv2 = VentUVOv->AppendElement(FVector2f(0.0f, 0.0f));
				const int32 uv3 = VentUVOv->AppendElement(FVector2f(0.0f, 0.0f));
				int32 t0, t1;
				if (!bFlip)
				{
					t0 = Mesh.AppendTriangle(FIndex3i(a0, a1, b1));
					t1 = Mesh.AppendTriangle(FIndex3i(a0, b1, b0));
					if (t0 >= 0) { VentUVOv->SetTriangle(t0, FIndex3i(uv0, uv1, uv2)); VentMatAttr->SetValue(t0, 1); }
					if (t1 >= 0) { VentUVOv->SetTriangle(t1, FIndex3i(uv0, uv2, uv3)); VentMatAttr->SetValue(t1, 1); }
				}
				else
				{
					t0 = Mesh.AppendTriangle(FIndex3i(a0, b1, a1));
					t1 = Mesh.AppendTriangle(FIndex3i(a0, b0, b1));
					if (t0 >= 0) { VentUVOv->SetTriangle(t0, FIndex3i(uv0, uv2, uv1)); VentMatAttr->SetValue(t0, 1); }
					if (t1 >= 0) { VentUVOv->SetTriangle(t1, FIndex3i(uv0, uv3, uv2)); VentMatAttr->SetValue(t1, 1); }
				}
			};
			for (int32 k = 0; k < 4; ++k)
			{
				const int32 n = (k + 1) % 4;
				Wall(B[k], B[n], M[n], M[k]); // vertical-leg wall, base -> miter
				Wall(M[k], M[n], E[n], E[k]); // horizontal-leg wall, miter -> end
			}

			bAnyShell = true;
		};

		// ====================================================================
		// POINT OUTPUT (columns + rubble). Staged into a UPCGBasePointData.
		// ====================================================================
		struct FStagedPoint
		{
			FTransform Xform;
			bool bHasMesh = false;
			FSoftObjectPath MeshPath;
		};
		TArray<FStagedPoint> StagedPoints;

		// ---- Walk the placement plan and realize each item.
		for (const FPlacedItem& Item : Plan.Items)
		{
			if (Item.Kind == TEXT("asset") && Item.Role == TEXT("column"))
			{
				// N = floor(len / spacing). len is metres on the symbol; spacing_m on op.
				const double SpacingM = Item.Op.bHasSpacing && Item.Op.SpacingM > KINDA_SMALL_NUMBER ? Item.Op.SpacingM : 3.0;
				const int32 NCols = FMath::FloorToInt(LenMetres / SpacingM);
				if (NCols <= 0)
				{
					continue;
				}
				const double HalfWcm = (BoreW * 0.5 - 0.1) * 100.0; // (w/2 - 0.1) m -> cm; w sourced from seed
				for (int32 i = 0; i < NCols; ++i)
				{
					const double Alpha = (double)i / (double)NCols;
					const FTransform T = Spline->GetTransformAtAlpha((float)FMath::Clamp(Alpha, 0.0, 1.0));
					const FVector Y = T.GetUnitAxis(EAxis::Y);
					const double Side = (i % 2 == 0) ? +1.0 : -1.0; // alternate
					const FVector Up = T.GetUnitAxis(EAxis::Z);
					// Floor-to-ceiling pillar: scale the unit cube to a slender column the
					// full bore height and lift its centre to mid-height so it stands on the
					// floor instead of sitting half-buried as a 1 m cube.
					FTransform Out = T;
					Out.SetLocation(T.GetLocation() + Y * (Side * HalfWcm) + Up * (BoreHcm * 0.5));
					Out.SetScale3D(FVector(0.45, 0.45, BoreHcm / 100.0));
					FStagedPoint SP;
					SP.Xform = Out;
					if (!ColumnMeshPath.IsNull())
					{
						SP.bHasMesh = true;
						SP.MeshPath = ColumnMeshPath;
					}
					StagedPoints.Add(SP);
				}
			}
			else if (Item.Kind == TEXT("scatter") && Item.Tag == TEXT("rubble"))
			{
				// Sample points along a Phase-IV sub-range of the spline (the back
				// quarter — the "decay" tail). Round-robin the 6 rubble meshes; z=0
				// (floor); deterministic yaw + tiny pitch/roll. NO FMath::Rand.
				const double RangeStart = 0.75; // Phase-IV sub-range
				const double RangeEnd = 1.0;
				const double SubLenM = LenMetres * (RangeEnd - RangeStart);
				const double ScatterSpacingM = 2.0;
				const int32 NScatter = FMath::Max(1, FMath::FloorToInt(SubLenM / ScatterSpacingM));
				for (int32 i = 0; i < NScatter; ++i)
				{
					const double T01 = (NScatter > 1) ? (double)i / (double)(NScatter - 1) : 0.0;
					const double Alpha = RangeStart + (RangeEnd - RangeStart) * T01;
					const FTransform T = Spline->GetTransformAtAlpha((float)FMath::Clamp(Alpha, 0.0, 1.0));

					// Deterministic jitter from (production index + point index).
					const double UYaw   = DeterministicUnit(Item.SymbolKind, Item.Index, i);
					const double UPitch = DeterministicUnit(Item.SymbolKind, Item.Index, i + 7919);
					const double URoll  = DeterministicUnit(Item.SymbolKind, Item.Index, i + 104729);
					const double Yaw   = UYaw * 360.0;          // full yaw spread
					const double Pitch = (UPitch * 2.0 - 1.0) * 3.0; // +/-3 deg
					const double Roll  = (URoll  * 2.0 - 1.0) * 3.0; // +/-3 deg

					// Deterministic lateral spread across the floor so rubble does not
					// stack down the centreline. Keep |LatU| inside the walls (bore
					// half-width minus a 30 cm margin). z=0: the spline transform already
					// sits on the floor centreline, so we only offset along right (Y).
					const double ULat = DeterministicUnit(Item.SymbolKind, Item.Index, i + 200);
					const double LatU = (ULat * 2.0 - 1.0) * FMath::Max(0.0, BoreHalfWcm - 30.0);
					FTransform Out;
					Out.SetLocation(T.GetLocation() + T.GetUnitAxis(EAxis::Y) * LatU);
					Out.SetRotation(FRotator(Pitch, Yaw, Roll).Quaternion());
					Out.SetScale3D(FVector(1.0));

					FStagedPoint SP;
					SP.Xform = Out;
					SP.bHasMesh = true;
					SP.MeshPath = FSoftObjectPath(GRubbleMeshPaths[i % kNumRubble]);
					StagedPoints.Add(SP);
				}
			}
			else if (Item.Kind == TEXT("shell") && Item.Role == TEXT("wall"))
			{
				// Arched/curved inner shell along the full spline. Reuse the tunnel
				// section winding. W/H sourced once from the seed (metres -> cm).
				AddSection(0.0, TotalLen, BoreWcm, BoreHcm);
				bAnyShell = true;
			}
			else if (Item.Kind == TEXT("shell") && Item.Role == TEXT("vent"))
			{
				// Child shaft: short straight tube then a bend at bend_at_m, welded in.
				const double BendAtM = Item.Op.bHasBendAt ? Item.Op.BendAtM : kMaxStraightRunM;
				AddVentTube(0.5, BendAtM); // mid-run vent
			}
			else if (Item.Kind == TEXT("decal") || Item.Kind == TEXT("fill"))
			{
				// TODO(vertical-slice): decal + fill emits are no-ops for now. A full
				// implementation would project decals along the spline (decal.along)
				// and fill voids at attachment points (fill.at). Out of scope here.
			}
			// Unknown emit kinds: ignored (the slice covers the contract's geometry ops).
		}

		// ---- Emit the SHELL dynamic mesh (one per input spline) if anything built.
		if (bAnyShell && Mesh.TriangleCount() > 0)
		{
			// Weld co-located edges: AppendVertex never merges duplicates, so the
			// per-quad/per-ring vertices (shell walls, vent legs, elbow bridge) sit
			// on top of each other but are topologically separate. Merge coincident
			// edges so the shell + vent form one welded surface before normals.
			FMergeCoincidentMeshEdges Welder(&Mesh);
			Welder.Apply();

			FMeshNormals::QuickRecomputeOverlayNormals(Mesh);

			UPCGDynamicMeshData* ShellData = FPCGContext::NewObject_AnyThread<UPCGDynamicMeshData>(Context);
			// Slot 0 = floor/ceiling material; Slot 1 = wall material (same assets as room).
			UMaterialInterface* FCMat   = Cast<UMaterialInterface>(StaticLoadObject(UMaterialInterface::StaticClass(), nullptr, TEXT("/Game/Hayba/Generated/Mat/MI_RoomFloorCeil.MI_RoomFloorCeil")));
			UMaterialInterface* WallMat = Cast<UMaterialInterface>(StaticLoadObject(UMaterialInterface::StaticClass(), nullptr, TEXT("/Game/Hayba/Generated/Mat/MI_RoomWall.MI_RoomWall")));
			TArray<UMaterialInterface*> TunnelMats;
			TunnelMats.Add(FCMat   ? FCMat   : ShellMat); // slot 0: floor + ceiling
			TunnelMats.Add(WallMat ? WallMat : ShellMat); // slot 1: walls
			ShellData->Initialize(MoveTemp(Mesh), TunnelMats);

			FPCGTaggedData& OutShell = Context->OutputData.TaggedData.Emplace_GetRef();
			OutShell.Data = ShellData;
			OutShell.Pin = FName(TEXT("Shell"));
			OutShell.Tags = In.Tags;
		}

		// ---- Emit POINTS (columns + rubble) on the default Out pin.
		if (StagedPoints.Num() > 0)
		{
			UPCGBasePointData* OutPointData = FPCGContext::NewPointData_AnyThread(Context);
			check(OutPointData);

			const int32 N = StagedPoints.Num();
			OutPointData->SetNumPoints(N, /*bInitializeValues=*/false);
			// Allocate Transform + MetadataEntry (we write a per-point mesh attribute).
			OutPointData->AllocateProperties(EPCGPointNativeProperties::Transform | EPCGPointNativeProperties::MetadataEntry);

			// Per-point mesh attribute (FSoftObjectPath) for MeshSelectorByAttribute.
			FPCGMetadataAttribute<FSoftObjectPath>* MeshAttr = nullptr;
			if (OutPointData->Metadata)
			{
				MeshAttr = OutPointData->Metadata->FindOrCreateAttribute<FSoftObjectPath>(
					kMeshAttributeName, FSoftObjectPath(), /*bAllowsInterpolation=*/false, /*bOverrideParent=*/true);
			}

			FPCGPointValueRanges OutRanges(OutPointData, /*bAllocate=*/false);
			for (int32 i = 0; i < N; ++i)
			{
				const FStagedPoint& SP = StagedPoints[i];
				FPCGPoint OutPoint;
				OutPoint.Transform = SP.Xform;
				if (OutPointData->Metadata)
				{
					OutPointData->Metadata->InitializeOnSet(OutPoint.MetadataEntry);
					if (MeshAttr && SP.bHasMesh)
					{
						MeshAttr->SetValue(OutPoint.MetadataEntry, SP.MeshPath);
					}
				}
				OutRanges.SetFromPoint(i, OutPoint);
			}

			FPCGTaggedData& OutPts = Context->OutputData.TaggedData.Emplace_GetRef();
			OutPts.Data = OutPointData;
			OutPts.Pin = PCGPinConstants::DefaultOutputLabel;
			OutPts.Tags = In.Tags;
		}
	}

	return true;
}

#undef LOCTEXT_NAMESPACE
