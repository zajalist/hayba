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
#include "Elements/PCGActorSelector.h"

// ARoomVolume, ATunnelSpline
#include "RoomVolume.h"
#include "TunnelSpline.h"

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
		"Gathers all ARoomVolume and ATunnelSpline actors in the world and emits one "
		"PCG data item per primitive on the Out pin (UPCGBasePointData for rooms, "
		"UPCGSplineData for tunnels) with grammar attributes written as metadata "
		"default values. Runs on the game thread; not cacheable.");
}

void UPCGTopologyConnectSettings::GetStaticTrackedKeys(
	FPCGSelectionKeyToSettingsMap& OutKeysToSettings,
	TArray<TObjectPtr<const UPCGGraph>>& OutVisitedGraphs) const
{
	// Re-execute whenever any actor tagged "hayba.primitive" is added, removed,
	// or modified. FPCGSelectionKey(FName tag) constructs a tag-based tracking key.
	// FLAG [UNCERTAIN]: FPCGSelectionKey tag-constructor — verify available in UE 5.7.
	// If not, use FPCGSelectionKey(EActorFilter::AllWorldActors) as a broader fallback.
	OutKeysToSettings.FindOrAdd(FPCGSelectionKey(FName("hayba.primitive"))).Emplace(this, /*bCulling=*/false);
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
// Attribute write helpers.
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

	// Write per-room grammar attributes (no w/h — room dimensions come from the BoxComponent).
	static void WriteRoomAttrs(UPCGMetadata* Metadata, const ARoomVolume* Room, int32 PrimId)
	{
		if (!Metadata || !Room) { return; }

		WriteDefaultAttr<FString>(Metadata, FName(TEXT("builder")),    Room->Builder.ToString());
		WriteDefaultAttr<FString>(Metadata, FName(TEXT("phase")),      Room->Phase);
		WriteDefaultAttr<double> (Metadata, FName(TEXT("seed")),       static_cast<double>(Room->Seed));
		WriteDefaultAttr<double> (Metadata, FName(TEXT("importance")), Room->Importance);
		WriteDefaultAttr<double> (Metadata, FName(TEXT("prim_id")),    static_cast<double>(PrimId));
	}

	// Write per-tunnel grammar attributes (includes w/h bore dimensions).
	static void WriteTunnelAttrs(UPCGMetadata* Metadata, const ATunnelSpline* Tunnel, int32 PrimId)
	{
		if (!Metadata || !Tunnel) { return; }

		WriteDefaultAttr<FString>(Metadata, FName(TEXT("builder")),    Tunnel->Builder.ToString());
		WriteDefaultAttr<FString>(Metadata, FName(TEXT("phase")),      Tunnel->Phase);
		WriteDefaultAttr<double> (Metadata, FName(TEXT("seed")),       static_cast<double>(Tunnel->Seed));
		WriteDefaultAttr<double> (Metadata, FName(TEXT("w")),          Tunnel->W);
		WriteDefaultAttr<double> (Metadata, FName(TEXT("h")),          Tunnel->H);
		WriteDefaultAttr<double> (Metadata, FName(TEXT("importance")), Tunnel->Importance);
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

	// Shared prim_id counter across both loops — each primitive gets a unique
	// monotonically-increasing id regardless of type.
	int32 PrimId = 0;

	// ---- Loop 1: ARoomVolume actors. Must be on the game thread (CanExecuteOnlyOnMainThread).
	for (TActorIterator<ARoomVolume> It(World); It; ++It)
	{
		ARoomVolume* Room = *It;
		if (!Room) { continue; }

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
		if (Room->BoxComponent)
		{
			const FVector WorldLoc = Room->BoxComponent->GetComponentLocation();
			// GetScaledBoxExtent() returns HALF-extents; multiply by 2 to get full size.
			const FVector FullSize = Room->BoxComponent->GetScaledBoxExtent() * 2.0;
			RoomXf.SetLocation(WorldLoc);
			RoomXf.SetRotation(FQuat::Identity);
			RoomXf.SetScale3D(FullSize);
		}
		else
		{
			RoomXf.SetLocation(Room->GetActorLocation());
			RoomXf.SetScale3D(FVector(800.0, 600.0, 350.0)); // fallback: 2x default half-extents in cm
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

		// Write grammar attributes as metadata default values (no w/h for rooms).
		HaybaTopology::WriteRoomAttrs(PointData->MutableMetadata(), Room, PrimId);

		// Emit on "Out".
		FPCGTaggedData& Out = Context->OutputData.TaggedData.Emplace_GetRef();
		Out.Data = PointData;
		Out.Pin  = FName(TEXT("Out"));

		++PrimId;
	}

	// ---- Loop 2: ATunnelSpline actors. Must be on the game thread (CanExecuteOnlyOnMainThread).
	for (TActorIterator<ATunnelSpline> It(World); It; ++It)
	{
		ATunnelSpline* Tunnel = *It;
		if (!Tunnel) { continue; }

		// ----------------------------------------------------------------
		// TUNNEL: emit a UPCGSplineData initialized from the actor's SplineComponent.
		// FLAG [UNCERTAIN]: In UE 5.7 the cleanest path to initialize UPCGSplineData
		// from a USplineComponent is UPCGSplineData::Initialize(USplineComponent*).
		// This overload was present in 5.3+ but the exact signature may differ in 5.7.
		// Fallback: FPCGSplineStruct::ApplyTo / Initialize(const FSplineStruct&).
		// We use the direct Initialize(USplineComponent*) path here and flag it.
		// ----------------------------------------------------------------
		if (!Tunnel->SplineComponent)
		{
			++PrimId;
			continue;
		}

		UPCGSplineData* SplineData = FPCGContext::NewObject_AnyThread<UPCGSplineData>(Context);
		check(SplineData);

		// Initialize the PCG spline data from the actor's spline component.
		// FLAG [UNCERTAIN]: UPCGSplineData::Initialize(USplineComponent*) — verify
		// this overload exists in UE 5.7. If not available, use:
		//   SplineData->SplineStruct.ApplyToComponent(Tunnel->SplineComponent, ...);
		// or copy the FSplineStruct from the component's SplineCurves.
		SplineData->Initialize(Tunnel->SplineComponent);

		// Write grammar attributes as metadata default values (includes w/h for tunnels).
		HaybaTopology::WriteTunnelAttrs(SplineData->MutableMetadata(), Tunnel, PrimId);

		// Emit on "Out".
		FPCGTaggedData& Out = Context->OutputData.TaggedData.Emplace_GetRef();
		Out.Data = SplineData;
		Out.Pin  = FName(TEXT("Out"));

		++PrimId;
	}

	return true;
}

#undef LOCTEXT_NAMESPACE
