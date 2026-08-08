#include "HaybaUIOps.h"

namespace HaybaUIOps
{
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
