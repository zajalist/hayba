#include "pcg/PCGWallPlan.h"

#include "PCGContext.h"
#include "PCGPin.h"
#include "PCGCommon.h"
#include "Data/PCGSplineData.h"
#include "Data/PCGPointData.h"
#include "Metadata/PCGMetadata.h"
#include "pcg/PlumbWallPlanner.h"

#include UE_INLINE_GENERATED_CPP_BY_NAME(PCGWallPlan)

#define LOCTEXT_NAMESPACE "PCGWallPlan"

namespace PCGWallPlanPins
{
	static const FName Others(TEXT("Others"));
	static const FName Segments(TEXT("WallSegments"));
	static const FName Sockets(TEXT("Sockets"));
	static const FName Rejects(TEXT("Rejects"));
	static const FName FloorLoop(TEXT("FloorLoop"));
	static const FName Fills(TEXT("FillPoints"));
}

#if WITH_EDITOR
FText UPCGWallPlanSettings::GetDefaultNodeTitle() const
{
	return LOCTEXT("Title", "Plumb | Wall Plan");
}
FText UPCGWallPlanSettings::GetNodeTooltipText() const
{
	return LOCTEXT("Tooltip", "Resolves wall topology against neighboring structures: exact junction sockets (one per shared span, solver-typed), retiled wall segments with guaranteed coverage, and explained rejects. Realization stays downstream.");
}
#endif

TArray<FPCGPinProperties> UPCGWallPlanSettings::InputPinProperties() const
{
	TArray<FPCGPinProperties> Pins;
	Pins.Emplace(PCGPinConstants::DefaultInputLabel, EPCGDataType::Spline);
	Pins.Emplace(PCGWallPlanPins::Others, EPCGDataType::Spline);
	return Pins;
}

TArray<FPCGPinProperties> UPCGWallPlanSettings::OutputPinProperties() const
{
	TArray<FPCGPinProperties> Pins;
	Pins.Emplace(PCGWallPlanPins::Segments, EPCGDataType::Spline);
	Pins.Emplace(PCGWallPlanPins::Sockets, EPCGDataType::Point);
	Pins.Emplace(PCGWallPlanPins::Rejects, EPCGDataType::Point);
	Pins.Emplace(PCGWallPlanPins::FloorLoop, EPCGDataType::Spline);
	Pins.Emplace(PCGWallPlanPins::Fills, EPCGDataType::Point);
	return Pins;
}

FPCGElementPtr UPCGWallPlanSettings::CreateElement() const
{
	return MakeShared<FPCGWallPlanElement>();
}

namespace
{
	// Spline data -> planner structure. Identity = source actor name when known (deterministic
	// across both structures' cooks), else the data UID. Kind falls out of closure:
	// closed = room, open = corridor — the product's own rule.
	bool ToStructure(const UPCGSplineData* Spline, const UPCGWallPlanSettings* S, FPlumbStructure& Out)
	{
		if (!Spline) return false;
		const FPCGSplineStruct& SS = Spline->SplineStruct;
		const int32 N = SS.GetNumberOfPoints();
		if (N < 2) return false;

		Out.bClosed = SS.IsClosedLoop();
		Out.Kind = Out.bClosed ? EPlumbStructureKind::Room : EPlumbStructureKind::Corridor;
		Out.WallHeight = S->WallHeight;
		Out.CorridorWidth = S->CorridorWidth;

		Out.Points.Reset(N);
		double MinZ = TNumericLimits<double>::Max();
		uint64 Hash = 1469598103934665603ull; // FNV-1a over quantized points: GEOMETRIC identity.
		for (int32 i = 0; i < N; ++i)
		{
			const FVector P = SS.GetLocationAtSplineInputKey((float)i, ESplineCoordinateSpace::World);
			Out.Points.Add(P);
			MinZ = FMath::Min(MinZ, P.Z);
			const int64 Q[3] = { (int64)FMath::RoundToDouble(P.X), (int64)FMath::RoundToDouble(P.Y), (int64)FMath::RoundToDouble(P.Z) };
			for (int64 V : Q) { Hash ^= (uint64)V; Hash *= 1099511628211ull; }
		}
		Out.FloorZ = MinZ;

		// Identity: the same drawn spline seen through ANY pin/data path hashes identically —
		// self-exclusion cannot depend on TargetActor being populated (it isn't, in parse mode).
		Out.Id = FName(*FString::Printf(TEXT("geo_%016llx"), Hash));
		return true;
	}
}

bool FPCGWallPlanElement::ExecuteInternal(FPCGContext* Context) const
{
	TRACE_CPUPROFILER_EVENT_SCOPE(FPCGWallPlanElement::Execute);
	check(Context);
	const UPCGWallPlanSettings* Settings = Context->GetInputSettings<UPCGWallPlanSettings>();
	check(Settings);

	FPlumbPlanParams P;
	P.CornerAngleDeg = Settings->CornerAngleDeg;
	P.MinOverlap     = Settings->MinOverlap;
	P.WallThickness  = Settings->WallThickness;
	P.CoincidenceTol = FMath::Max(Settings->WallThickness, 26.0);
	P.OpeningWidth   = Settings->DefaultOpeningWidth;
	P.OpeningHeight  = Settings->DefaultOpeningHeight;
	P.bFlipWallFacing = Settings->bFlipWallFacing;

	// Gather neighbors once.
	TArray<FPlumbStructure> Others;
	for (const FPCGTaggedData& In : Context->InputData.GetInputsByPin(PCGWallPlanPins::Others))
	{
		FPlumbStructure O;
		if (ToStructure(Cast<UPCGSplineData>(In.Data), Settings, O))
		{
			Others.Add(MoveTemp(O));
		}
	}

	for (const FPCGTaggedData& In : Context->InputData.GetInputsByPin(PCGPinConstants::DefaultInputLabel))
	{
		const UPCGSplineData* SelfSpline = Cast<UPCGSplineData>(In.Data);
		FPlumbStructure Self;
		if (!ToStructure(SelfSpline, Settings, Self))
		{
			continue;
		}

		const FPlumbWallPlan Plan = PlumbWallPlanner::Plan(Self, Others, P);

		// -- WallSegments: one open 2-point linear spline per segment --
		for (const FPlumbSegmentPlan& Seg : Plan.Segments)
		{
			UPCGSplineData* SegData = FPCGContext::NewObject_AnyThread<UPCGSplineData>(Context);
			TArray<FSplinePoint> Pts;
			FSplinePoint PA(0.f, Seg.A); PA.Type = ESplinePointType::Linear;
			FSplinePoint PB(1.f, Seg.B); PB.Type = ESplinePointType::Linear;
			Pts.Add(PA); Pts.Add(PB);
			SegData->Initialize(Pts, /*bClosed*/false, FTransform::Identity);
			if (UPCGMetadata* MD = SegData->MutableMetadata())
			{
				MD->CreateAttribute<double>(TEXT("Z0"), Seg.Z0, false, true);
				MD->CreateAttribute<double>(TEXT("Z1"), Seg.Z1, false, true);
			}
			FPCGTaggedData& Out = Context->OutputData.TaggedData.Emplace_GetRef();
			Out.Data = SegData;
			Out.Pin = PCGWallPlanPins::Segments;
		}

		// -- FloorLoop: one closed linear spline (rooms: drawn loop; corridors: tunnel footprint) --
		if (Plan.FloorLoop.Num() >= 3)
		{
			UPCGSplineData* LoopData = FPCGContext::NewObject_AnyThread<UPCGSplineData>(Context);
			TArray<FSplinePoint> Pts;
			for (int32 i = 0; i < Plan.FloorLoop.Num(); ++i)
			{
				FSplinePoint SP((float)i, Plan.FloorLoop[i]); SP.Type = ESplinePointType::Linear;
				Pts.Add(SP);
			}
			LoopData->Initialize(Pts, /*bClosed*/true, FTransform::Identity);
			FPCGTaggedData& OutT = Context->OutputData.TaggedData.Emplace_GetRef();
			OutT.Data = LoopData;
			OutT.Pin = PCGWallPlanPins::FloorLoop;
		}

		// -- FillPoints: guaranteed-coverage patches (small remainders, over-door bands) --
		if (Plan.Fills.Num() > 0)
		{
			UPCGPointData* PD = FPCGContext::NewObject_AnyThread<UPCGPointData>(Context);
			UPCGMetadata* MD = PD->MutableMetadata();
			FPCGMetadataAttribute<double>* AW  = MD->CreateAttribute<double>(TEXT("Width"), 0.0, false, true);
			FPCGMetadataAttribute<int64>* AG = MD->CreateAttribute<int64>(TEXT("FillIndex"), 0, false, true);
			FPCGMetadataAttribute<double>* AZ0 = MD->CreateAttribute<double>(TEXT("Z0"), 0.0, false, true);
			FPCGMetadataAttribute<double>* AZ1 = MD->CreateAttribute<double>(TEXT("Z1"), 0.0, false, true);
			TArray<FPCGPoint>& Pts = PD->GetMutablePoints();
			Pts.SetNum(Plan.Fills.Num());
			for (int32 i = 0; i < Plan.Fills.Num(); ++i)
			{
				const FPlumbFillPlan& F = Plan.Fills[i];
				FPCGPoint& Pt = Pts[i];
				const FQuat Rot = FRotationMatrix::MakeFromXY(F.Tangent, F.Normal).ToQuat().GetNormalized();
				Pt.Transform = FTransform(Rot, F.Center);
				// Asymmetric Y-bounds [0,+1]: staging's center-justify then tucks the module
				// 0.5 toward the interior — the SAME convention as every SubdivideSpline wall
				// module (measured: all planes sit at drawn-line + 0.5*inward).
				Pt.BoundsMin = FVector(-F.Width * 0.5, 0.0, 0.0);
				Pt.BoundsMax = FVector( F.Width * 0.5, 1.0, F.Z1 - F.Z0);
				Pt.MetadataEntry = MD->AddEntry();
				AW->SetValue(Pt.MetadataEntry, F.Width);
				AG->SetValue(Pt.MetadataEntry, (int64)F.BandIndex);
				AZ0->SetValue(Pt.MetadataEntry, F.Z0);
				AZ1->SetValue(Pt.MetadataEntry, F.Z1);
			}
			FPCGTaggedData& OutT = Context->OutputData.TaggedData.Emplace_GetRef();
			OutT.Data = PD;
			OutT.Pin = PCGWallPlanPins::Fills;
		}

		// -- Sockets / Rejects as point data --
		auto EmitPoints = [&](FName Pin, int32 Num, TFunctionRef<void(int32, FPCGPoint&, UPCGMetadata*)> Fill)
		{
			if (Num == 0) return;
			UPCGPointData* PD = FPCGContext::NewObject_AnyThread<UPCGPointData>(Context);
			UPCGMetadata* MD = PD->MutableMetadata();
			TArray<FPCGPoint>& Pts = PD->GetMutablePoints();
			Pts.SetNum(Num);
			for (int32 i = 0; i < Num; ++i)
			{
				Pts[i].MetadataEntry = MD->AddEntry();
				Fill(i, Pts[i], MD);
			}
			FPCGTaggedData& Out = Context->OutputData.TaggedData.Emplace_GetRef();
			Out.Data = PD;
			Out.Pin = Pin;
		};

		// Socket attributes: everything realization needs (Q9 — nothing modular-specific).
		{
			UPCGPointData* PD = FPCGContext::NewObject_AnyThread<UPCGPointData>(Context);
			UPCGMetadata* MD = PD->MutableMetadata();
			FPCGMetadataAttribute<FName>*   AType   = MD->CreateAttribute<FName>(TEXT("SocketType"), NAME_None, false, true);
			FPCGMetadataAttribute<double>*  AWidth  = MD->CreateAttribute<double>(TEXT("Width"), 0.0, false, true);
			FPCGMetadataAttribute<double>*  AZ0     = MD->CreateAttribute<double>(TEXT("Z0"), 0.0, false, true);
			FPCGMetadataAttribute<double>*  AZ1     = MD->CreateAttribute<double>(TEXT("Z1"), 0.0, false, true);
			FPCGMetadataAttribute<double>*  ADelta  = MD->CreateAttribute<double>(TEXT("FloorDelta"), 0.0, false, true);
			FPCGMetadataAttribute<double>*  ATrans  = MD->CreateAttribute<double>(TEXT("TransitionRadius"), 0.0, false, true);
			FPCGMetadataAttribute<bool>*    AOwned  = MD->CreateAttribute<bool>(TEXT("Owned"), false, false, true);
			FPCGMetadataAttribute<bool>*    ARelax  = MD->CreateAttribute<bool>(TEXT("Relaxed"), false, false, true);
			FPCGMetadataAttribute<FName>*   AOther  = MD->CreateAttribute<FName>(TEXT("OtherId"), NAME_None, false, true);

			TArray<FPCGPoint>& Pts = PD->GetMutablePoints();
			Pts.SetNum(Plan.Sockets.Num());
			for (int32 i = 0; i < Plan.Sockets.Num(); ++i)
			{
				const FPlumbSocketPlan& S = Plan.Sockets[i];
				FPCGPoint& Pt = Pts[i];
				// MakeFromXY re-orthonormalizes and stays right-handed even when Normal = -Y
				// (a raw FMatrix basis can be mirrored -> non-normalized quat -> PCG asserts).
				const FQuat Rot = FRotationMatrix::MakeFromXY(S.Tangent, S.Normal).ToQuat().GetNormalized();
				Pt.Transform = FTransform(Rot, S.Center);
				Pt.BoundsMin = FVector(-S.Width * 0.5, -Settings->WallThickness * 0.5, 0.0);
				Pt.BoundsMax = FVector( S.Width * 0.5,  Settings->WallThickness * 0.5, S.Z1 - S.Z0);
				Pt.MetadataEntry = MD->AddEntry();
				AType->SetValue(Pt.MetadataEntry, S.TypeName);
				AWidth->SetValue(Pt.MetadataEntry, S.Width);
				AZ0->SetValue(Pt.MetadataEntry, S.Z0);
				AZ1->SetValue(Pt.MetadataEntry, S.Z1);
				ADelta->SetValue(Pt.MetadataEntry, S.FloorDeltaSelf);
				ATrans->SetValue(Pt.MetadataEntry, S.TransitionRadius);
				AOwned->SetValue(Pt.MetadataEntry, S.bOwned);
				ARelax->SetValue(Pt.MetadataEntry, S.bRelaxedBond);
				AOther->SetValue(Pt.MetadataEntry, S.OtherId);
			}
			if (Pts.Num() > 0)
			{
				FPCGTaggedData& Out = Context->OutputData.TaggedData.Emplace_GetRef();
				Out.Data = PD;
				Out.Pin = PCGWallPlanPins::Sockets;
			}
		}

		// Rejects: position + human reason (Q13 overlay source).
		{
			UPCGPointData* PD = FPCGContext::NewObject_AnyThread<UPCGPointData>(Context);
			UPCGMetadata* MD = PD->MutableMetadata();
			FPCGMetadataAttribute<FString>* AReason = MD->CreateAttribute<FString>(TEXT("Reason"), FString(), false, true);
			FPCGMetadataAttribute<FName>*   AOther  = MD->CreateAttribute<FName>(TEXT("OtherId"), NAME_None, false, true);
			TArray<FPCGPoint>& Pts = PD->GetMutablePoints();
			Pts.SetNum(Plan.Rejects.Num());
			for (int32 i = 0; i < Plan.Rejects.Num(); ++i)
			{
				FPCGPoint& Pt = Pts[i];
				Pt.Transform = FTransform(Plan.Rejects[i].At);
				Pt.MetadataEntry = MD->AddEntry();
				AReason->SetValue(Pt.MetadataEntry, Plan.Rejects[i].Reason);
				AOther->SetValue(Pt.MetadataEntry, Plan.Rejects[i].OtherId);
			}
			if (Pts.Num() > 0)
			{
				FPCGTaggedData& Out = Context->OutputData.TaggedData.Emplace_GetRef();
				Out.Data = PD;
				Out.Pin = PCGWallPlanPins::Rejects;
			}
		}
	}

	return true;
}

#undef LOCTEXT_NAMESPACE
