#include "pcg/PCGUndergroundTunnel.h"

#include "PCGContext.h"
#include "PCGPin.h"
#include "PCGCommon.h"
#include "Data/PCGSplineData.h"
#include "Data/PCGDynamicMeshData.h"
#include "Materials/MaterialInterface.h"

#include "DynamicMesh/DynamicMesh3.h"
#include "DynamicMesh/MeshNormals.h"
#include "IndexTypes.h"

#include UE_INLINE_GENERATED_CPP_BY_NAME(PCGUndergroundTunnel)

#define LOCTEXT_NAMESPACE "PCGUndergroundTunnel"

#if WITH_EDITOR
FText UPCGUndergroundTunnelSettings::GetDefaultNodeTitle() const
{
	return LOCTEXT("Title", "Underground Tunnel");
}
FText UPCGUndergroundTunnelSettings::GetNodeTooltipText() const
{
	return LOCTEXT("Tooltip", "Sweeps a single seamless tunnel shell (dynamic mesh) along the input spline. Per-control-point scale (Y=width, Z=height) drives hard-stepped sections with risers.");
}
#endif

TArray<FPCGPinProperties> UPCGUndergroundTunnelSettings::InputPinProperties() const
{
	TArray<FPCGPinProperties> Pins;
	Pins.Emplace(PCGPinConstants::DefaultInputLabel, EPCGDataType::Spline);
	return Pins;
}

TArray<FPCGPinProperties> UPCGUndergroundTunnelSettings::OutputPinProperties() const
{
	TArray<FPCGPinProperties> Pins;
	Pins.Emplace(PCGPinConstants::DefaultOutputLabel, EPCGDataType::DynamicMesh, /*bAllowMultipleConnections=*/false, /*bAllowMultipleData=*/false);
	return Pins;
}

FPCGElementPtr UPCGUndergroundTunnelSettings::CreateElement() const
{
	return MakeShared<FPCGUndergroundTunnelElement>();
}

bool FPCGUndergroundTunnelElement::ExecuteInternal(FPCGContext* Context) const
{
	using namespace UE::Geometry; // variable-height via per-CP scale
	TRACE_CPUPROFILER_EVENT_SCOPE(FPCGUndergroundTunnelElement::Execute);
	check(Context);

	const UPCGUndergroundTunnelSettings* Settings = Context->GetInputSettings<UPCGUndergroundTunnelSettings>();
	check(Settings);

	UMaterialInterface* Mat = Settings->Material.LoadSynchronous();
	const double BaseW = Settings->Width;
	const double BaseH = Settings->Height;
	const double Spacing = FMath::Max(10.0f, Settings->SampleSpacing);

	const TArray<FPCGTaggedData> Inputs = Context->InputData.GetInputsByPin(PCGPinConstants::DefaultInputLabel);
	for (const FPCGTaggedData& In : Inputs)
	{
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

		// Per-control-point: distance along spline + size (from point scale: Y=width, Z=height mult).
		const FInterpCurveVector& ScaleCurve = SS.GetSplinePointsScale();
		TArray<double> CPDist; CPDist.Reserve(NumCP);
		TArray<double> CPW, CPH; CPW.Reserve(NumCP); CPH.Reserve(NumCP);
		for (int32 i = 0; i < NumCP; ++i)
		{
			CPDist.Add(SS.GetDistanceAlongSplineAtSplinePoint(i));
			const FVector S = ScaleCurve.Points.IsValidIndex(i) ? ScaleCurve.Points[i].OutVal : FVector(1, 1, 1);
			CPW.Add(BaseW * (S.Y > KINDA_SMALL_NUMBER ? S.Y : 1.0));
			CPH.Add(BaseH * (S.Z > KINDA_SMALL_NUMBER ? S.Z : 1.0));
		}

		FDynamicMesh3 Mesh;
		Mesh.EnableAttributes();

		// Frame (loc, right, up, tangent) at a world distance along the spline.
		auto Frame = [&](double D, FVector& Loc, FVector& Right, FVector& Up, FVector& Tan)
		{
			const float A = (float)FMath::Clamp(D / TotalLen, 0.0, 1.0);
			const FTransform T = Spline->GetTransformAtAlpha(A);
			Loc = T.GetLocation();
			Right = T.GetUnitAxis(EAxis::Y);
			Up = T.GetUnitAxis(EAxis::Z);
			Tan = T.GetUnitAxis(EAxis::X);
		};

		// Append a quad (4 world points) with UE-correct winding so the front face
		// points toward ND (the bore interior). Replicates the proven Python tunnel.
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

		// Build the 4 inner walls for a constant-size section [DStart, DEnd], welded along length.
		auto AddSection = [&](double DStart, double DEnd, double W, double H)
		{
			const double hw = W * 0.5;
			const int32 N = FMath::Max(1, FMath::CeilToInt((DEnd - DStart) / Spacing));
			// wall defs: {y0,z0, y1,z1, signNd, axis(0=up,1=right)}
			const double Walls[4][6] = {
				{ -hw, 0, hw, 0, +1, 0 }, // floor   -> +up
				{ -hw, H, hw, H, -1, 0 }, // ceiling -> -up
				{ -hw, 0, -hw, H, +1, 1 }, // left    -> +right
				{  hw, 0,  hw, H, -1, 1 }  // right   -> -right
			};
			for (int32 w = 0; w < 4; ++w)
			{
				int32 prevA = -1, prevB = -1;
				for (int32 i = 0; i <= N; ++i)
				{
					const double D = DStart + (DEnd - DStart) * (double)i / (double)N;
					FVector Loc, R, U, Tn; Frame(D, Loc, R, U, Tn);
					const FVector P0 = Loc + R * Walls[w][0] + U * Walls[w][1];
					const FVector P1 = Loc + R * Walls[w][2] + U * Walls[w][3];
					const int32 A = Mesh.AppendVertex(FVector3d(P0));
					const int32 B = Mesh.AppendVertex(FVector3d(P1));
					if (i > 0)
					{
						const FVector ND = (Walls[w][5] == 0) ? (U * Walls[w][4]) : (R * Walls[w][4]);
						const FVector3d p0 = Mesh.GetVertex(prevA), p1 = Mesh.GetVertex(A), p2 = Mesh.GetVertex(B);
						const FVector3d g = (p1 - p0).Cross(p2 - p0);
						if (g.Dot(FVector3d(ND)) < 0)
						{
							Mesh.AppendTriangle(FIndex3i(prevA, A, B));
							Mesh.AppendTriangle(FIndex3i(prevA, B, prevB));
						}
						else
						{
							Mesh.AppendTriangle(FIndex3i(prevA, B, A));
							Mesh.AppendTriangle(FIndex3i(prevA, prevB, B));
						}
					}
					prevA = A; prevB = B;
				}
			}
		};

		// Riser frame at a section boundary (the inverted-U step connecting the two
		// inner rects, sharing the floor), facing toward the larger section.
		auto AddRiser = [&](double D, double Wa, double Ha, double Wb, double Hb)
		{
			FVector Loc, R, U, Tn; Frame(D, Loc, R, U, Tn);
			const double bigW = FMath::Max(Wa, Wb), bigH = FMath::Max(Ha, Hb);
			const double smW = FMath::Min(Wa, Wb), smH = FMath::Min(Ha, Hb);
			const FVector ND = (Wa * Ha >= Wb * Hb) ? (Tn * -1.0) : Tn;
			auto P = [&](double y, double z) { return Loc + R * y + U * z; };
			if (bigH > smH + 1.0)
			{
				AddQuad(P(-smW / 2, smH), P(smW / 2, smH), P(smW / 2, bigH), P(-smW / 2, bigH), ND);
			}
			if (bigW > smW + 1.0)
			{
				AddQuad(P(-bigW / 2, 0), P(-smW / 2, 0), P(-smW / 2, bigH), P(-bigW / 2, bigH), ND);
				AddQuad(P(smW / 2, 0), P(bigW / 2, 0), P(bigW / 2, bigH), P(smW / 2, bigH), ND);
			}
		};

		// Build each segment between consecutive control points at the start point's
		// size (hold-until-next = hard step), with a riser at every interior step.
		for (int32 s = 0; s < NumCP - 1; ++s)
		{
			AddSection(CPDist[s], CPDist[s + 1], CPW[s], CPH[s]);
			if (s > 0 && (!FMath::IsNearlyEqual(CPW[s], CPW[s - 1]) || !FMath::IsNearlyEqual(CPH[s], CPH[s - 1])))
			{
				AddRiser(CPDist[s], CPW[s - 1], CPH[s - 1], CPW[s], CPH[s]);
			}
		}

		FMeshNormals::QuickRecomputeOverlayNormals(Mesh);

		UPCGDynamicMeshData* OutData = FPCGContext::NewObject_AnyThread<UPCGDynamicMeshData>(Context);
		TArray<UMaterialInterface*> Materials;
		if (Mat)
		{
			Materials.Add(Mat);
		}
		OutData->Initialize(MoveTemp(Mesh), Materials);

		FPCGTaggedData& Out = Context->OutputData.TaggedData.Emplace_GetRef();
		Out.Data = OutData;
		Out.Tags = In.Tags;
	}

	return true;
}

#undef LOCTEXT_NAMESPACE
