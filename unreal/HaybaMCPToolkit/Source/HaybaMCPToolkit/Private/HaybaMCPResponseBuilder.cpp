#include "HaybaMCPResponseBuilder.h"
#include "Dom/JsonValue.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

FHaybaMCPResponseBuilder::FHaybaMCPResponseBuilder(const FHaybaResponseLimits& InLimits)
    : Limits(InLimits)
{
}

bool FHaybaMCPResponseBuilder::TrimString(FString& InOutValue) const
{
    if (Limits.MaxStringChars <= 0)
    {
        return false;
    }

    if (InOutValue.Len() > Limits.MaxStringChars)
    {
        const FString Ellipsis = TEXT("...");
        const int32 KeepLen = FMath::Max(0, Limits.MaxStringChars - Ellipsis.Len());
        InOutValue = InOutValue.Left(KeepLen) + Ellipsis;
        return true;
    }
    return false;
}

bool FHaybaMCPResponseBuilder::IsFieldExempt(const FString& Key) const
{
    return Limits.NeverTrimFields.Contains(Key);
}

int32 FHaybaMCPResponseBuilder::TrimArray(TArray<TSharedPtr<FJsonValue>>& InOutItems) const
{
    if (Limits.MaxArrayItems < 0)
    {
        return 0;
    }

    if (InOutItems.Num() > Limits.MaxArrayItems)
    {
        const int32 Removed = InOutItems.Num() - Limits.MaxArrayItems;
        InOutItems.SetNum(Limits.MaxArrayItems);
        return Removed;
    }
    return 0;
}

namespace
{
    // Safety guard against pathological/cyclic input. When reached, recursion
    // simply stops descending — no _truncated entry is emitted (silent guard).
    static constexpr int32 MaxRecursionDepth = 64;

    struct FTruncationEntry
    {
        FString Path;
        FString Kind;   // "string" | "array" | "fields"
        int32   Removed = 0;
    };

    // Recursively walk and trim a JSON object in place.
    // Because FJsonValueString and FJsonValueArray have no public setters, we
    // replace the TSharedPtr<FJsonValue> entry in the parent map/array when a
    // mutation is needed.
    void WalkObjectInPlace(const TSharedPtr<FJsonObject>& Object,
                           const FString& Path,
                           int32 Depth,
                           const FHaybaMCPResponseBuilder& Builder,
                           TArray<FTruncationEntry>& Truncations);

    bool WalkArrayItemsInPlace(TArray<TSharedPtr<FJsonValue>>& Items,
                               const FString& Path,
                               int32 Depth,
                               const FHaybaMCPResponseBuilder& Builder,
                               TArray<FTruncationEntry>& Truncations)
    {
        if (Depth >= MaxRecursionDepth)
        {
            return false;
        }

        bool bChanged = false;
        for (int32 Index = 0; Index < Items.Num(); ++Index)
        {
            TSharedPtr<FJsonValue>& Item = Items[Index];
            if (!Item.IsValid())
            {
                continue;
            }

            const FString ItemPath = Path + FString::Printf(TEXT("[%d]"), Index);

            switch (Item->Type)
            {
            case EJson::String:
            {
                FString Str = Item->AsString();
                const int32 OriginalLen = Str.Len();
                if (Builder.TrimString(Str))
                {
                    Item = MakeShared<FJsonValueString>(Str);
                    Truncations.Add({ItemPath, TEXT("string"), OriginalLen - Str.Len()});
                    bChanged = true;
                }
                break;
            }
            case EJson::Array:
            {
                TArray<TSharedPtr<FJsonValue>> Inner = Item->AsArray();
                const int32 Removed = Builder.TrimArray(Inner);
                bool bInnerChanged = (Removed > 0);
                if (Removed > 0)
                {
                    Truncations.Add({ItemPath, TEXT("array"), Removed});
                }
                if (WalkArrayItemsInPlace(Inner, ItemPath, Depth + 1, Builder, Truncations))
                {
                    bInnerChanged = true;
                }
                if (bInnerChanged)
                {
                    Item = MakeShared<FJsonValueArray>(Inner);
                    bChanged = true;
                }
                break;
            }
            case EJson::Object:
            {
                WalkObjectInPlace(Item->AsObject(), ItemPath, Depth + 1, Builder, Truncations);
                break;
            }
            default:
                break;
            }
        }
        return bChanged;
    }

    void WalkObjectInPlace(const TSharedPtr<FJsonObject>& Object,
                           const FString& Path,
                           int32 Depth,
                           const FHaybaMCPResponseBuilder& Builder,
                           TArray<FTruncationEntry>& Truncations)
    {
        if (!Object.IsValid() || Depth >= MaxRecursionDepth)
        {
            return;
        }

        for (auto& Pair : Object->Values)
        {
            const FString Key = FString(*Pair.Key);
            TSharedPtr<FJsonValue>& Value = Pair.Value;
            if (!Value.IsValid())
            {
                continue;
            }

            const FString ChildPath = Path.IsEmpty() ? Key : (Path + TEXT(".") + Key);

            switch (Value->Type)
            {
            case EJson::String:
            {
                // An exempt field passes through whole. Clipping a base64 image
                // does not shorten it, it invalidates it — see NeverTrimFields.
                if (Builder.IsFieldExempt(Key))
                {
                    break;
                }
                FString Str = Value->AsString();
                const int32 OriginalLen = Str.Len();
                if (Builder.TrimString(Str))
                {
                    Value = MakeShared<FJsonValueString>(Str);
                    Truncations.Add({ChildPath, TEXT("string"), OriginalLen - Str.Len()});
                }
                break;
            }
            case EJson::Array:
            {
                TArray<TSharedPtr<FJsonValue>> Items = Value->AsArray();
                const int32 Removed = Builder.TrimArray(Items);
                bool bChanged = (Removed > 0);
                if (Removed > 0)
                {
                    Truncations.Add({ChildPath, TEXT("array"), Removed});
                }
                if (WalkArrayItemsInPlace(Items, ChildPath, Depth + 1, Builder, Truncations))
                {
                    bChanged = true;
                }
                if (bChanged)
                {
                    Value = MakeShared<FJsonValueArray>(Items);
                }
                break;
            }
            case EJson::Object:
            {
                WalkObjectInPlace(Value->AsObject(), ChildPath, Depth + 1, Builder, Truncations);
                break;
            }
            default:
                break;
            }
        }
    }
}

TSharedRef<FJsonObject> FHaybaMCPResponseBuilder::Build(const TSharedRef<FJsonObject>& Source) const
{
    // TODO(perf): Deep-copy via serialize/deserialize round-trip so we don't
    // mutate the caller's object. If profiling shows this as a hotspot, replace
    // with a structural clone that walks the tree directly.
    FString Serialized;
    TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Serialized);
    FJsonSerializer::Serialize(Source, Writer);

    TSharedPtr<FJsonObject> Copy;
    TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Serialized);
    if (!FJsonSerializer::Deserialize(Reader, Copy) || !Copy.IsValid())
    {
        // Fallback: return the source unchanged (shouldn't happen for valid input).
        return Source;
    }

    TArray<FTruncationEntry> Truncations;
    WalkObjectInPlace(Copy, FString(), 0, *this, Truncations);

    // Enforce MaxTopLevelFields by dropping extra top-level entries.
    // Sort keys lexicographically first so the drop is deterministic across
    // runs (TMap iteration order is otherwise unspecified).
    if (Limits.MaxTopLevelFields > 0 && Copy->Values.Num() > Limits.MaxTopLevelFields)
    {
        TArray<FString> Keys;
        for (const auto& Pair : Copy->Values) { Keys.Add(FString(*Pair.Key)); }
        Keys.Sort();
        TArray<FString> OrdinaryKeys;
        int32 ProtectedPresent = 0;
        for (const FString& Key : Keys)
        {
            if (Limits.NeverDropTopLevelFields.Contains(Key))
            {
                ++ProtectedPresent;
            }
            else
            {
                OrdinaryKeys.Add(Key);
            }
        }
        const int32 OrdinaryBudget = FMath::Max(0, Limits.MaxTopLevelFields - ProtectedPresent);
        const int32 RemovedCount = FMath::Max(0, OrdinaryKeys.Num() - OrdinaryBudget);
        for (int32 i = OrdinaryBudget; i < OrdinaryKeys.Num(); ++i)
        {
            Copy->RemoveField(OrdinaryKeys[i]);
        }
        if (RemovedCount > 0)
        {
            Truncations.Add({TEXT("_root"), TEXT("fields"), RemovedCount});
        }
    }

    if (Truncations.Num() > 0)
    {
        TArray<TSharedPtr<FJsonValue>> TruncatedArray;
        TruncatedArray.Reserve(Truncations.Num());
        for (const FTruncationEntry& Entry : Truncations)
        {
            TSharedRef<FJsonObject> Obj = MakeShared<FJsonObject>();
            Obj->SetStringField(TEXT("path"), Entry.Path);
            Obj->SetStringField(TEXT("kind"), Entry.Kind);
            Obj->SetNumberField(TEXT("removed"), Entry.Removed);
            TruncatedArray.Add(MakeShared<FJsonValueObject>(Obj));
        }
        Copy->SetArrayField(TEXT("_truncated"), TruncatedArray);
    }

    return Copy.ToSharedRef();
}

FString FHaybaMCPResponseBuilder::Serialize(const TSharedRef<FJsonObject>& Source) const
{
    TSharedRef<FJsonObject> Built = Build(Source);
    FString Out;
    TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
        TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Out);
    FJsonSerializer::Serialize(Built, Writer);
    return Out;
}
