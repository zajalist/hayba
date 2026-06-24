#include "pcg/PCGTopologyConnect.h"

#include "PCGContext.h"
#include "PCGPin.h"
#include "PCGCommon.h"
#include "Data/PCGSplineData.h"
#include "Data/PCGBasePointData.h"
#include "PCGPoint.h"                 // FPCGPoint (explicit; do not rely on transitive)
#include "PCGPointPropertiesTraits.h" // EPCGPointNativeProperties
#include "Metadata/PCGMetadata.h"
#include "Metadata/PCGMetadataAttributeTpl.h"

// ARunPrimitive
#include "RunPrimitive.h"

// TActorIterator
#include "EngineUtils.h"

#include UE_INLINE_GENERATED_CPP_BY_NAME(PCGTopologyConnect)

#define LOCTEXT_NAMESPACE "PCGTopologyConnect"

// ---------------------------------------------------------------------------
// Settings boilerplate — mirrors PCGGrammarSolver
// ---------------------------------------------------------------------------
#if WITH_EDITOR
FText UPCGTopologyConnectSettings::GetDefaultNodeTitle() const
{
	return LOCTEXT("Title", "Topology Connect");
}
FText UPCGTopologyConnectSettings::GetNodeTooltipText() const
{
	return LOCTEXT("Tooltip",
		"Gathers all ARunPrimitive actors in the world and emits one PCG data item "
		"per primitive on the Out pin (UPCGBasePointData for rooms, UPCGSplineData "
		"for tunnels) with grammar attributes written as metadata default values. "
		"Runs on the game thread; not cacheable.");
}
#endif

TArray<FPCGPinProperties> UPCGTopologyConnectSettings::InputPinProperties() const
{
	// Generator node: no required input. Return an empty array.
	return TArray<FPCGPinProperties>();
}

TArray<FPCGPinProperties> UPCGTopologyConnectSettings::OutputPinProperties() const
{
	TArray<FPCGPinProperties> Pins;
	// Out: rooms emit PointData, tunnels emit SplineData. PointOrSpline covers both.
	Pins.Emplace(FName(TEXT("Out")), EPCGDataType::PointOrSpline);
	return Pins;
}

FPCGElementPtr UPCGTopologyConnectSettings::CreateElement() const
{
	return MakeShared<FPCGTopologyConnectElement>();
}

// ---------------------------------------------------------------------------
// Attribute write helper.
// Writes VALUE as the attribute's DEFAULT VALUE so that reading via
//   Data->ConstMetadata()->GetConstTypedAttribute<T>(name)->GetValue(PCGFirstEntryKey)
// returns Value regardless of any per-entry state. Per the task contract we do
// NOT also create per-point entries; the default IS the value.
// ---------------------------------------------------------------------------
namespace HaybaTopology
{
	template<typename T>
	static void WriteDefaultAttr(UPCGMetadata* Metadata, const FName& Name, const T& Value)
	{
		if (!Metadata) { return; }
		// FindOrCreateAttribute<T>(name, defaultValue, bAllowsInterpolation, bOverrideParent)
		// The default value is returned by GetValue(PCGFirstEntryKey) for entries that
		// have not been explicitly set. This satisfies the solver's ReadStrAttr / ReadNumAttr.
		Metadata->FindOrCreateAttribute<T>(Name, Value, /*bAllowsInterpolation=*/false, /*bOverrideParent=*/true);
	}

	// Write all per-primitive grammar attributes as default values on Metadata.
	// builder  : FString (solver reads GetConstTypedAttribute<FString>)
	// phase    : FString
	// seed     : double  (int cast)
	// w        : double
	// h        : double
	// importance: double
	// prim_id  : double
	static void WriteAttrs(UPCGMetadata* Metadata, const ARunPrimitive* Prim, int32 PrimId)
	{
		if (!Metadata || !Prim) { return; }

		WriteDefaultAttr<FString>(Metadata, FName(TEXT("builder")),    Prim->Builder.ToString());
		WriteDefaultAttr<FString>(Metadata, FName(TEXT("phase")),      Prim->Phase);
		WriteDefaultAttr<double> (Metadata, FName(TEXT("seed")),       static_cast<double>(Prim->Seed));
		WriteDefaultAttr<double> (Metadata, FName(TEXT("w")),          Prim->W);
		WriteDefaultAttr<double> (Metadata, FName(TEXT("h")),          Prim->H);
		WriteDefaultAttr<double> (Metadata, FName(TEXT("importance")), Prim->Importance);
		WriteDefaultAttr<double> (Metadata, FName(TEXT("prim_id")),    static_cast<double>(PrimId));
	}
}

// ---------------------------------------------------------------------------
// Element
// ---------------------------------------------------------------------------
bool FPCGTopologyConnectElement::ExecuteInternal(FPCGContext* Context) const
{
	TRACE_CPUPROFILER_EVENT_SCOPE(FPCGTopologyConnectElement::Execute);
	check(Context);

	// ---- Get the world via the execution's target actor (5.7-correct;
	// FPCGContext::SourceComponent is deprecated since 5.6). GetTargetActor(nullptr)
	// returns the actor that owns the graph execution (the manager actor).
	UWorld* World = nullptr;
	if (AActor* TargetActor = Context->GetTargetActor(nullptr))
	{
		World = TargetActor->GetWorld();
	}

	if (!World)
	{
		// Fallback for cook / commandlet edge cases.
		World = GWorld;
	}

	if (!World)
	{
		UE_LOG(LogTemp, Warning, TEXT("PCGTopologyConnect: could not resolve UWorld; skipping."));
		return true;
	}

	// ---- Iterate ARunPrimitive actors. Must be on the game thread (CanExecuteOnlyOnMainThread).
	int32 PrimId = 0;
	for (TActorIterator<ARunPrimitive> It(World); It; ++It)
	{
		ARunPrimitive* Prim = *It;
		if (!Prim) { continue; }

		if (Prim->Kind == ERunPrimitiveKind::Room)
		{
			// ----------------------------------------------------------------
			// ROOM: emit a single-point UPCGBasePointData.
			// Transform.Location = box world centre; Transform.Scale3D = full box size (cm).
			// ----------------------------------------------------------------
			UPCGBasePointData* PointData = FPCGContext::NewPointData_AnyThread(Context);
			check(PointData);

			// One point.
			PointData->SetNumPoints(1, /*bInitializeValues=*/false);
			PointData->AllocateProperties(EPCGPointNativeProperties::Transform | EPCGPointNativeProperties::MetadataEntry);

			// Build the transform: Location = box world centre, Scale = full box size in cm.
			// FLAG [UNCERTAIN]: UPCGBasePointData::GetTransform(int32) and SetFromPoint
			// are used by PCGGrammarSolver (line ~720, ~1213). We mirror that pattern.
			FTransform RoomXf;
			if (Prim->BoxComponent)
			{
				const FVector WorldLoc  = Prim->BoxComponent->GetComponentLocation();
				// GetScaledBoxExtent() returns HALF-extents; multiply by 2 to get full size.
				const FVector FullSize  = Prim->BoxComponent->GetScaledBoxExtent() * 2.0;
				RoomXf.SetLocation(WorldLoc);
				RoomXf.SetRotation(FQuat::Identity);
				RoomXf.SetScale3D(FullSize);
			}
			else
			{
				RoomXf.SetLocation(Prim->GetActorLocation());
				RoomXf.SetScale3D(FVector(
					Prim->W * 100.0,
					Prim->W * 100.0,
					Prim->H * 100.0));
			}

			// Write the single point via the same FPCGPointValueRanges pattern used by
			// PCGGrammarSolver (line ~1199-1213).
			FPCGPoint RoomPoint;
			RoomPoint.Transform = RoomXf;

			// Initialize metadata entry for the point (required before SetValue calls).
			if (PointData->Metadata)
			{
				PointData->Metadata->InitializeOnSet(RoomPoint.MetadataEntry);
			}

			FPCGPointValueRanges OutRanges(PointData, /*bAllocate=*/false);
			OutRanges.SetFromPoint(0, RoomPoint);

			// Write grammar attributes as metadata default values.
			HaybaTopology::WriteAttrs(PointData->MutableMetadata(), Prim, PrimId);

			// Emit on "Out".
			FPCGTaggedData& Out = Context->OutputData.TaggedData.Emplace_GetRef();
			Out.Data = PointData;
			Out.Pin  = FName(TEXT("Out"));
		}
		else // ERunPrimitiveKind::Tunnel
		{
			// ----------------------------------------------------------------
			// TUNNEL: emit a UPCGSplineData initialized from the actor's SplineComponent.
			// FLAG [UNCERTAIN]: In UE 5.7 the cleanest path to initialize UPCGSplineData
			// from a USplineComponent is UPCGSplineData::Initialize(USplineComponent*).
			// This overload was present in 5.3+ but the exact signature may differ in 5.7.
			// Fallback: FPCGSplineStruct::ApplyTo / Initialize(const FSplineStruct&).
			// We use the direct Initialize(USplineComponent*) path here and flag it.
			// ----------------------------------------------------------------
			if (!Prim->SplineComponent)
			{
				++PrimId;
				continue;
			}

			UPCGSplineData* SplineData = FPCGContext::NewObject_AnyThread<UPCGSplineData>(Context);
			check(SplineData);

			// Initialize the PCG spline data from the actor's spline component.
			// FLAG [UNCERTAIN]: UPCGSplineData::Initialize(USplineComponent*) — verify
			// this overload exists in UE 5.7. If not available, use:
			//   SplineData->SplineStruct.ApplyToComponent(Prim->SplineComponent, ...);
			// or copy the FSplineStruct from the component's SplineCurves.
			SplineData->Initialize(Prim->SplineComponent);

			// Write grammar attributes as metadata default values.
			HaybaTopology::WriteAttrs(SplineData->MutableMetadata(), Prim, PrimId);

			// Emit on "Out".
			FPCGTaggedData& Out = Context->OutputData.TaggedData.Emplace_GetRef();
			Out.Data = SplineData;
			Out.Pin  = FName(TEXT("Out"));
		}

		++PrimId;
	}

	return true;
}

#undef LOCTEXT_NAMESPACE
