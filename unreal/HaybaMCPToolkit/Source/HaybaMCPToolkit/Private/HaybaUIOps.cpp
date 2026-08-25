#include "HaybaUIOps.h"

namespace HaybaUIOps
{
    namespace
    {
        bool IsScratchSourceName(const FName Name)
        {
            const FString Text = Name.ToString();
            return Name.IsNone()
                || Text.StartsWith(TEXT("TRASH_"))
                || Text.StartsWith(TEXT("HaybaMCP_Replaced"))
                || Text.StartsWith(TEXT("HaybaMCP_ReplacementStaging"));
        }

        FString JoinNames(const TArray<FName>& Names)
        {
            TArray<FString> Text;
            Text.Reserve(Names.Num());
            for (const FName Name : Names) Text.Add(Name.ToString());
            return FString::Join(Text, TEXT(", "));
        }

        FGuid FreshGuid(const FName Name, const TSet<FGuid>& Used)
        {
            // A deterministic replacement makes reconciliation idempotent even
            // before the asset is saved. Salt only changes in the vanishingly
            // unlikely case that the candidate is already used in this map.
            for (uint32 Salt = 0; Salt < MAX_uint32; ++Salt)
            {
                const FGuid Candidate = FGuid::NewDeterministicGuid(Name.ToString(), Salt);
                if (Candidate.IsValid() && !Used.Contains(Candidate)) return Candidate;
            }
            return FGuid::NewGuid();
        }
    }

    FString FVariableGuidReconciliation::BlockingReason() const
    {
        TArray<FString> Reasons;
        if (DuplicateSourceNames.Num() > 0)
            Reasons.Add(FString::Printf(TEXT("duplicate source names: %s"), *JoinNames(DuplicateSourceNames)));
        if (ScratchSourceNames.Num() > 0)
            Reasons.Add(FString::Printf(TEXT("temporary/trash source names leaked into the tree: %s"), *JoinNames(ScratchSourceNames)));
        return FString::Join(Reasons, TEXT("; "));
    }

    FString FVariableGuidReconciliation::RepairSummary() const
    {
        TArray<FString> Parts;
        if (Missing.Num() > 0)   Parts.Add(FString::Printf(TEXT("%d missing"), Missing.Num()));
        if (Stale.Num() > 0)     Parts.Add(FString::Printf(TEXT("%d stale"), Stale.Num()));
        if (Invalid.Num() > 0)   Parts.Add(FString::Printf(TEXT("%d invalid"), Invalid.Num()));
        if (Colliding.Num() > 0) Parts.Add(FString::Printf(TEXT("%d colliding"), Colliding.Num()));
        return Parts.IsEmpty() ? TEXT("no GUID repairs") : FString::Join(Parts, TEXT(", "));
    }

    FVariableGuidReconciliation PlanVariableGuidReconciliation(
        const TArray<FName>& SourceNames,
        const TMap<FName, FGuid>& Existing)
    {
        FVariableGuidReconciliation Out;

        TMap<FName, int32> Counts;
        for (const FName Name : SourceNames) Counts.FindOrAdd(Name)++;

        TArray<FName> UniqueNames;
        Counts.GetKeys(UniqueNames);
        UniqueNames.Sort([](const FName A, const FName B)
        {
            return A.ToString() < B.ToString();
        });

        TSet<FName> LiveNames;
        for (const FName Name : UniqueNames)
        {
            LiveNames.Add(Name);
            if (Counts.FindRef(Name) > 1) Out.DuplicateSourceNames.Add(Name);
            if (IsScratchSourceName(Name)) Out.ScratchSourceNames.Add(Name);
        }

        for (const TPair<FName, FGuid>& Pair : Existing)
        {
            if (!LiveNames.Contains(Pair.Key)) Out.Stale.Add(Pair.Key);
        }

        // A blocked tree is deliberately not "fixed" partially. The caller can
        // safely report the structural defect without changing the asset.
        if (!Out.CanApply())
        {
            Out.bChanged = false;
            return Out;
        }

        TSet<FGuid> Used;
        for (const FName Name : UniqueNames)
        {
            const FGuid* ExistingGuid = Existing.Find(Name);
            if (!ExistingGuid)
            {
                Out.Missing.Add(Name);
                const FGuid NewGuid = FreshGuid(Name, Used);
                Out.Reconciled.Add(Name, NewGuid);
                Used.Add(NewGuid);
                continue;
            }

            if (!ExistingGuid->IsValid())
            {
                Out.Invalid.Add(Name);
                const FGuid NewGuid = FreshGuid(Name, Used);
                Out.Reconciled.Add(Name, NewGuid);
                Used.Add(NewGuid);
                continue;
            }

            if (Used.Contains(*ExistingGuid))
            {
                Out.Colliding.Add(Name);
                const FGuid NewGuid = FreshGuid(Name, Used);
                Out.Reconciled.Add(Name, NewGuid);
                Used.Add(NewGuid);
                continue;
            }

            Out.Reconciled.Add(Name, *ExistingGuid);
            Used.Add(*ExistingGuid);
        }

        Out.bChanged = Out.Reconciled.Num() != Existing.Num();
        if (!Out.bChanged)
        {
            for (const TPair<FName, FGuid>& Pair : Out.Reconciled)
            {
                const FGuid* Before = Existing.Find(Pair.Key);
                if (!Before || *Before != Pair.Value)
                {
                    Out.bChanged = true;
                    break;
                }
            }
        }
        return Out;
    }

    FSlotPropsPayload ResolveSlotProps(const TSharedPtr<FJsonObject>& Params)
    {
        FSlotPropsPayload Out;
        if (!Params.IsValid()) return Out;

        // Public schema first, so a caller sending both gets the documented one.
        static const TPair<const TCHAR*, ESlotPropsSpelling> Candidates[] = {
            { TEXT("slot_props"),      ESlotPropsSpelling::SlotProps },
            { TEXT("slot_properties"), ESlotPropsSpelling::SlotProperties },
            { TEXT("slot_layout"),     ESlotPropsSpelling::SlotLayout },
        };

        for (const auto& C : Candidates)
        {
            const TSharedPtr<FJsonObject>* Found = nullptr;
            if (Params->TryGetObjectField(C.Key, Found) && Found && Found->IsValid())
            {
                Out.Object = *Found;
                Out.Spelling = C.Value;
                return Out;
            }
        }
        return Out;
    }

    bool FSetPropertiesRequest::HasAnythingToApply() const
    {
        const bool bHasProps = Properties.IsValid() && Properties->Values.Num() > 0;
        const bool bHasSlot  = Slot.IsSet() && Slot.Object->Values.Num() > 0;
        return bHasProps || bHasSlot;
    }

    FSetPropertiesRequest ParseSetProperties(FHaybaParamReader& R)
    {
        FSetPropertiesRequest Req;
        Req.BlueprintPath = R.RequiredString(TEXT("widget_blueprint_path"));
        Req.WidgetName    = R.RequiredString(TEXT("widget_name"));
        Req.Properties    = R.OptionalObject(TEXT("properties"));
        Req.Slot          = ResolveSlotProps(R.Raw());

        if (!Req.HasAnythingToApply())
        {
            // An empty `properties` object reads as a well-formed request and is
            // not one. Left to the editor it marks the blueprint dirty, applies
            // nothing, and fails with an empty list of rejected keys.
            R.AddError(TEXT("no properties to apply — pass 'properties' (widget properties) "
                            "and/or 'slot_props' (layout on the parent panel's slot), each a non-empty object"));
        }
        return Req;
    }

    FString SlotKeyName(const FString& Key)
    {
        return FString::Printf(TEXT("slot.%s"), *Key);
    }

    TSharedPtr<FJsonObject> ShapeSetProperties(const FSetPropertiesResult& Result)
    {
        auto ToJsonArray = [](const TArray<FString>& In)
        {
            TArray<TSharedPtr<FJsonValue>> Arr;
            for (const FString& S : In) Arr.Add(MakeShared<FJsonValueString>(S));
            return Arr;
        };

        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("widget_name"), Result.WidgetName);
        Out->SetNumberField(TEXT("succeeded"), Result.Succeeded);
        Out->SetNumberField(TEXT("failed"), Result.Failed);
        if (Result.FailedProps.Num() > 0)      Out->SetArrayField(TEXT("failed_properties"), ToJsonArray(Result.FailedProps));
        if (Result.UnknownSlotProps.Num() > 0) Out->SetArrayField(TEXT("unknown_slot_props"), ToJsonArray(Result.UnknownSlotProps));
        if (Result.Warnings.Num() > 0)         Out->SetArrayField(TEXT("warnings"), ToJsonArray(Result.Warnings));

        // Only worth saying when the caller did not use the documented name: a
        // response that always carries it teaches nothing, and one that never
        // does lets a deprecated spelling look like the right one.
        if (Result.SlotSpelling != ESlotPropsSpelling::None &&
            Result.SlotSpelling != ESlotPropsSpelling::SlotProps)
        {
            Out->SetStringField(TEXT("slot_props_read_from"), SpellingName(Result.SlotSpelling));
        }
        return Out;
    }

    FString NothingAppliedError(const FSetPropertiesResult& Result)
    {
        return FString::Printf(
            TEXT("ui_set_widget_properties: nothing applied to '%s'. Rejected: %s"),
            *Result.WidgetName, *FString::Join(Result.FailedProps, TEXT(", ")));
    }

    const TCHAR* SpellingName(ESlotPropsSpelling Spelling)
    {
        switch (Spelling)
        {
        case ESlotPropsSpelling::SlotProps:      return TEXT("slot_props");
        case ESlotPropsSpelling::SlotProperties: return TEXT("slot_properties");
        case ESlotPropsSpelling::SlotLayout:     return TEXT("slot_layout");
        default:                                 return TEXT("");
        }
    }
}
