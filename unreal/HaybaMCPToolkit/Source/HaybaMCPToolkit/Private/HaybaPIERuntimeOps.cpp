#include "HaybaPIERuntimeOps.h"

#include "Dom/JsonObject.h"

namespace
{
    FString OptionalStrictString(
        FHaybaParamReader& R,
        const TCHAR* Name,
        const FString& Default = FString(),
        bool bRejectEmpty = false)
    {
        const TSharedPtr<FJsonObject>& Raw = R.Raw();
        if (!Raw.IsValid() || !Raw->HasField(Name)) return Default;
        const TSharedPtr<FJsonValue> Field = Raw->TryGetField(Name);
        FString Value;
        // FJsonValueNumber/Boolean::TryGetString intentionally coerce their
        // values in UE, so TryGetStringField alone is not a wire-type check.
        if (!Field.IsValid() || Field->Type != EJson::String || !Field->TryGetString(Value))
        {
            R.AddError(FString::Printf(TEXT("'%s' must be a string"), Name));
            return Default;
        }
        if (bRejectEmpty && Value.IsEmpty())
        {
            R.AddError(FString::Printf(TEXT("'%s' is present but empty"), Name));
        }
        return Value;
    }

    bool OptionalStrictBool(FHaybaParamReader& R, const TCHAR* Name, bool Default)
    {
        const TSharedPtr<FJsonObject>& Raw = R.Raw();
        if (!Raw.IsValid() || !Raw->HasField(Name)) return Default;
        const TSharedPtr<FJsonValue> Field = Raw->TryGetField(Name);
        bool Value = Default;
        // UE's JSON DOM accepts every JSON string as a bool (via ToBool) and
        // numbers as value != 0. Runtime inspection is a direct-wire boundary:
        // accepting those shapes makes malformed commands look successful.
        if (!Field.IsValid() || Field->Type != EJson::Boolean || !Field->TryGetBool(Value))
        {
            R.AddError(FString::Printf(TEXT("'%s' must be a boolean"), Name));
            return Default;
        }
        return Value;
    }

    TOptional<FVector> OptionalFiniteVec3(FHaybaParamReader& R, const TCHAR* Name)
    {
        const TSharedPtr<FJsonObject>& Raw = R.Raw();
        if (!Raw.IsValid() || !Raw->HasField(Name)) return {};
        const TArray<TSharedPtr<FJsonValue>>* Array = nullptr;
        if (!Raw->TryGetArrayField(Name, Array) || !Array || Array->Num() != 3)
        {
            R.AddError(FString::Printf(TEXT("'%s' must be an array of exactly 3 finite numbers"), Name));
            return {};
        }
        double Values[3] = {0.0, 0.0, 0.0};
        for (int32 Index = 0; Index < 3; ++Index)
        {
            if (!(*Array)[Index].IsValid()
                || (*Array)[Index]->Type != EJson::Number
                || !(*Array)[Index]->TryGetNumber(Values[Index])
                || !FMath::IsFinite(Values[Index]))
            {
                R.AddError(FString::Printf(TEXT("'%s' must contain exactly 3 finite numbers"), Name));
                return {};
            }
            if (FMath::Abs(Values[Index]) > HaybaPIERuntimeOps::MaxWorldCoordinateAbs)
            {
                R.AddError(FString::Printf(
                    TEXT("'%s' coordinates must be within +/- %.0f cm"),
                    Name,
                    HaybaPIERuntimeOps::MaxWorldCoordinateAbs));
                return {};
            }
        }
        return FVector(Values[0], Values[1], Values[2]);
    }

    void ValidateShortString(FHaybaParamReader& R, const TCHAR* Name, const FString& Value)
    {
        if (Value.Len() > HaybaPIERuntimeOps::MaxFilterLength)
        {
            R.AddError(FString::Printf(
                TEXT("'%s' exceeds the %d character limit"),
                Name,
                HaybaPIERuntimeOps::MaxFilterLength));
        }
    }

    void ValidateReferenceString(FHaybaParamReader& R, const TCHAR* Name, const FString& Value)
    {
        if (Value.Len() > HaybaPIERuntimeOps::MaxReferenceLength)
        {
            R.AddError(FString::Printf(
                TEXT("'%s' exceeds the %d character limit"),
                Name,
                HaybaPIERuntimeOps::MaxReferenceLength));
        }
    }

    TOptional<int32> OptionalBoundedInt(
        FHaybaParamReader& R,
        const TCHAR* Name,
        int32 Minimum,
        int32 Maximum)
    {
        const TSharedPtr<FJsonObject>& Raw = R.Raw();
        if (!Raw.IsValid() || !Raw->HasField(Name)) return {};

        const TSharedPtr<FJsonValue> Field = Raw->TryGetField(Name);
        double Value = 0.0;
        // TryGetNumberField coerces booleans and numeric strings in UE. Keep
        // this API's integer contract strict before applying range checks.
        if (!Field.IsValid()
            || Field->Type != EJson::Number
            || !Field->TryGetNumber(Value)
            || !FMath::IsFinite(Value)
            || FMath::FloorToDouble(Value) != Value)
        {
            R.AddError(FString::Printf(TEXT("'%s' must be a finite integer"), Name));
            return {};
        }
        if (Value < Minimum || Value > Maximum)
        {
            R.AddError(FString::Printf(
                TEXT("'%s' must be between %d and %d"), Name, Minimum, Maximum));
            return {};
        }
        return static_cast<int32>(Value);
    }

    HaybaPIERuntimeOps::FWorldSelector ParseWorldSelector(FHaybaParamReader& R)
    {
        HaybaPIERuntimeOps::FWorldSelector Out;
        Out.PIEInstance = OptionalBoundedInt(R, TEXT("pie_instance"), 0, 1024);
        return Out;
    }

    HaybaPIERuntimeOps::FActorReference ParseActorReference(FHaybaParamReader& R)
    {
        HaybaPIERuntimeOps::FActorReference Out;
        Out.Path = OptionalStrictString(R, TEXT("actor_path"), FString(), true);
        Out.Id = OptionalStrictString(R, TEXT("actor_id"), FString(), true);
        Out.Label = OptionalStrictString(R, TEXT("actor_label"), FString(), true);
        ValidateReferenceString(R, TEXT("actor_path"), Out.Path);
        ValidateReferenceString(R, TEXT("actor_id"), Out.Id);
        ValidateReferenceString(R, TEXT("actor_label"), Out.Label);
        return Out;
    }

    int32 PresentActorReferenceCount(const FHaybaParamReader& R)
    {
        const TSharedPtr<FJsonObject>& Raw = R.Raw();
        if (!Raw.IsValid()) return 0;
        return (Raw->HasField(TEXT("actor_path")) ? 1 : 0)
            + (Raw->HasField(TEXT("actor_id")) ? 1 : 0)
            + (Raw->HasField(TEXT("actor_label")) ? 1 : 0);
    }

    void ValidateExactlyOneActorReference(FHaybaParamReader& R, int32 PresentCount)
    {
        if (PresentCount == 0)
        {
            R.AddError(TEXT("pass exactly one of actor_path, actor_id, or actor_label"));
        }
        else if (PresentCount > 1)
        {
            R.AddError(TEXT("actor_path, actor_id, and actor_label are mutually exclusive"));
        }
    }
}

namespace HaybaPIERuntimeOps
{
    FListRequest ParseList(FHaybaParamReader& R)
    {
        FListRequest Out;
        Out.World = ParseWorldSelector(R);
        Out.ClassFilter = OptionalStrictString(R, TEXT("class_filter"));
        Out.NameFilter = OptionalStrictString(R, TEXT("name_filter"));
        Out.Tag = OptionalStrictString(R, TEXT("tag"));
        Out.Offset = OptionalBoundedInt(R, TEXT("offset"), 0, MaxListOffset).Get(0);
        Out.Limit = OptionalBoundedInt(R, TEXT("limit"), 1, MaxListLimit).Get(50);
        ValidateShortString(R, TEXT("class_filter"), Out.ClassFilter);
        ValidateShortString(R, TEXT("name_filter"), Out.NameFilter);
        ValidateShortString(R, TEXT("tag"), Out.Tag);
        return Out;
    }

    FInspectRequest ParseInspect(FHaybaParamReader& R)
    {
        FInspectRequest Out;
        Out.World = ParseWorldSelector(R);
        Out.Actor = ParseActorReference(R);
        Out.ComponentFilter = OptionalStrictString(R, TEXT("component_filter"));
        Out.ComponentOffset = OptionalBoundedInt(R, TEXT("component_offset"), 0, MaxComponentOffset).Get(0);
        Out.ComponentLimit = OptionalBoundedInt(R, TEXT("component_limit"), 1, MaxComponents).Get(50);
        ValidateExactlyOneActorReference(R, PresentActorReferenceCount(R));
        ValidateShortString(R, TEXT("component_filter"), Out.ComponentFilter);
        return Out;
    }

    FProjectRequest ParseProject(FHaybaParamReader& R)
    {
        FProjectRequest Out;
        Out.World = ParseWorldSelector(R);
        Out.Actor = ParseActorReference(R);
        Out.WorldLocation = OptionalFiniteVec3(R, TEXT("world_location"));
        Out.ComponentName = OptionalStrictString(R, TEXT("component_name"), FString(), true);
        Out.Sample = OptionalStrictString(R, TEXT("sample"), TEXT("bounds_origin"), true);
        Out.PlayerIndex = OptionalBoundedInt(R, TEXT("player_index"), 0, 16).Get(0);
        Out.bTraceVisibility = OptionalStrictBool(R, TEXT("trace_visibility"), true);

        ValidateReferenceString(R, TEXT("component_name"), Out.ComponentName);

        const TSharedPtr<FJsonObject>& Raw = R.Raw();
        const bool bWorldLocationPresent = Raw.IsValid() && Raw->HasField(TEXT("world_location"));
        const int32 ActorReferenceCount = PresentActorReferenceCount(R);
        const bool bComponentNamePresent = Raw.IsValid() && Raw->HasField(TEXT("component_name"));
        if (bWorldLocationPresent)
        {
            if (ActorReferenceCount > 0)
            {
                R.AddError(TEXT("world_location is mutually exclusive with actor_path, actor_id, and actor_label"));
            }
            if (bComponentNamePresent)
            {
                R.AddError(TEXT("component_name requires an actor target"));
            }
        }
        else
        {
            ValidateExactlyOneActorReference(R, ActorReferenceCount);
        }

        if (Out.Sample != TEXT("actor_location")
            && Out.Sample != TEXT("component_location")
            && Out.Sample != TEXT("bounds_origin"))
        {
            R.AddError(TEXT("'sample' must be actor_location, component_location, or bounds_origin"));
        }
        const bool bSampleWasSupplied = Raw.IsValid() && Raw->HasField(TEXT("sample"));
        if (bWorldLocationPresent && bSampleWasSupplied)
        {
            R.AddError(TEXT("'sample' is not used with an explicit world_location"));
        }
        if (!Out.ComponentName.IsEmpty() && Out.Sample == TEXT("actor_location"))
        {
            R.AddError(TEXT("'actor_location' cannot be combined with component_name"));
        }
        if (Out.ComponentName.IsEmpty() && Out.Sample == TEXT("component_location"))
        {
            R.AddError(TEXT("'component_location' requires component_name"));
        }
        return Out;
    }

    FActorInteractionRequest ParseActorInteraction(FHaybaParamReader& R)
    {
        FActorInteractionRequest Out;
        Out.Projection = ParseProject(R);
        Out.Action = OptionalStrictString(R, TEXT("action"), TEXT("click"), true);

        // Unlike read-only probes, an interaction must not silently ignore a
        // misspelled/direct-wire field and then click a different target under
        // the caller's feet. The public Zod schema is strict; enforce the same
        // boundary natively because hayba_invoke can bypass TypeScript.
        static const TSet<FString> AllowedFields = {
            TEXT("pie_instance"), TEXT("actor_path"), TEXT("actor_id"), TEXT("actor_label"),
            TEXT("component_name"), TEXT("sample"), TEXT("player_index"), TEXT("action"),
            TEXT("world_location"), TEXT("trace_visibility")
        };
        if (R.Raw().IsValid())
        {
            for (const TPair<FString, TSharedPtr<FJsonValue>>& Field : R.Raw()->Values)
            {
                if (!AllowedFields.Contains(Field.Key))
                {
                    R.AddError(FString::Printf(TEXT("unknown field '%s'"), *Field.Key));
                    break;
                }
            }
        }

        // Interaction is deliberately actor-only. An arbitrary world point has
        // no identity to compare with the first Visibility hit, so accepting it
        // would turn a verified actor tool back into a coordinate click.
        if (Out.Projection.WorldLocation.IsSet())
        {
            R.AddError(TEXT("world_location is not supported; pass exactly one actor reference"));
        }
        if (!Out.Projection.bTraceVisibility)
        {
            R.AddError(TEXT("trace_visibility cannot be disabled for actor interaction"));
        }
        if (Out.Action != TEXT("click"))
        {
            R.AddError(TEXT(
                "'action' must be click; exact hover is unavailable because UE exposes no public viewport route that both preserves native hover state and guarantees zero OS cursor movement"));
        }
        return Out;
    }

    FWorldSelection SelectWorld(
        const TArray<FWorldCandidate>& Candidates,
        const TOptional<int32>& RequestedPIEInstance,
        bool bRequireViewport)
    {
        FWorldSelection Out;
        if (Candidates.IsEmpty())
        {
            Out.Error = TEXT("no live PIE worlds (start PIE first)");
            return Out;
        }

        auto Eligible = [&](const FWorldCandidate& Candidate)
        {
            return !bRequireViewport || Candidate.bHasViewport;
        };

        if (RequestedPIEInstance.IsSet())
        {
            int32 MatchedIndex = INDEX_NONE;
            int32 MatchedCount = 0;
            for (int32 Index = 0; Index < Candidates.Num(); ++Index)
            {
                if (Candidates[Index].PIEInstance == *RequestedPIEInstance)
                {
                    MatchedIndex = Index;
                    ++MatchedCount;
                }
            }
            if (MatchedCount > 1)
            {
                Out.Error = FString::Printf(
                    TEXT("PIE instance %d is duplicated across %d live worlds"),
                    *RequestedPIEInstance,
                    MatchedCount);
                return Out;
            }
            if (MatchedCount == 1)
            {
                if (!Eligible(Candidates[MatchedIndex]))
                {
                    Out.Error = FString::Printf(
                        TEXT("PIE instance %d has no game viewport"), *RequestedPIEInstance);
                    return Out;
                }
                Out.CandidateIndex = MatchedIndex;
                Out.Reason = TEXT("explicit_pie_instance");
                Out.bWasAmbiguous = Candidates.Num() > 1;
                return Out;
            }
            Out.Error = FString::Printf(TEXT("PIE instance %d was not found"), *RequestedPIEInstance);
            return Out;
        }

        TArray<int32> EligibleIndices;
        TArray<int32> ViewportIndices;
        TArray<int32> PlayWorldIndices;
        for (int32 Index = 0; Index < Candidates.Num(); ++Index)
        {
            if (!Eligible(Candidates[Index])) continue;
            EligibleIndices.Add(Index);
            if (Candidates[Index].bHasViewport) ViewportIndices.Add(Index);
            if (Candidates[Index].bIsPlayWorld) PlayWorldIndices.Add(Index);
        }

        if (EligibleIndices.IsEmpty())
        {
            Out.Error = TEXT("no live PIE world has a game viewport");
            return Out;
        }
        if (EligibleIndices.Num() == 1)
        {
            Out.CandidateIndex = EligibleIndices[0];
            Out.Reason = TEXT("only_eligible_world");
            Out.bWasAmbiguous = Candidates.Num() > 1;
            return Out;
        }
        if (ViewportIndices.Num() == 1)
        {
            Out.CandidateIndex = ViewportIndices[0];
            Out.Reason = TEXT("only_viewport_world");
            Out.bWasAmbiguous = Candidates.Num() > 1;
            return Out;
        }
        if (bRequireViewport && ViewportIndices.Num() > 1)
        {
            Out.bWasAmbiguous = true;
            Out.Error = TEXT("multiple PIE worlds have game viewports; pass pie_instance from available_worlds");
            return Out;
        }
        if (PlayWorldIndices.Num() == 1 && (!bRequireViewport || Candidates[PlayWorldIndices[0]].bHasViewport))
        {
            Out.CandidateIndex = PlayWorldIndices[0];
            Out.Reason = TEXT("active_play_world");
            Out.bWasAmbiguous = true;
            return Out;
        }

        Out.bWasAmbiguous = true;
        Out.Error = TEXT("multiple eligible PIE worlds; pass pie_instance from available_worlds");
        return Out;
    }

    FPageWindow ComputePage(int32 Offset, int32 Limit, int32 RetainedCount)
    {
        FPageWindow Out;
        const int32 SafeCount = FMath::Max(0, RetainedCount);
        Out.Start = FMath::Clamp(Offset, 0, SafeCount);
        Out.End = FMath::Clamp(Out.Start + FMath::Max(0, Limit), Out.Start, SafeCount);
        Out.bHasMore = Out.End < SafeCount;
        if (Out.bHasMore) Out.NextOffset = Out.End;
        return Out;
    }

    bool IsFiniteVector(const FVector& Value)
    {
        return FMath::IsFinite(Value.X) && FMath::IsFinite(Value.Y) && FMath::IsFinite(Value.Z);
    }

    bool IsFiniteRotator(const FRotator& Value)
    {
        return FMath::IsFinite(Value.Pitch) && FMath::IsFinite(Value.Yaw) && FMath::IsFinite(Value.Roll);
    }

    FString CollisionEnabledName(ECollisionEnabled::Type Value)
    {
        switch (Value)
        {
        case ECollisionEnabled::NoCollision:     return TEXT("none");
        case ECollisionEnabled::QueryOnly:       return TEXT("query_only");
        case ECollisionEnabled::PhysicsOnly:     return TEXT("physics_only");
        case ECollisionEnabled::QueryAndPhysics: return TEXT("query_and_physics");
        case ECollisionEnabled::ProbeOnly:       return TEXT("probe_only");
        case ECollisionEnabled::QueryAndProbe:   return TEXT("query_and_probe");
        default:                                 return TEXT("unknown");
        }
    }
}
