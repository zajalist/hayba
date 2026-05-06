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
    // Recursively walk and trim a JSON object in place.
    // Because FJsonValueString and FJsonValueArray have no public setters, we
    // replace the TSharedPtr<FJsonValue> entry in the parent map/array when a
    // mutation is needed.
    void WalkObjectInPlace(const TSharedPtr<FJsonObject>& Object,
                           const FHaybaMCPResponseBuilder& Builder,
                           TSet<FString>& TruncatedKeys);

    // Walk an array's items, possibly replacing them; returns true if any item changed.
    // If a child string/array was trimmed, AssociatedKey is added to TruncatedKeys.
    bool WalkArrayItemsInPlace(TArray<TSharedPtr<FJsonValue>>& Items,
                               const FString& AssociatedKey,
                               const FHaybaMCPResponseBuilder& Builder,
                               TSet<FString>& TruncatedKeys)
    {
        bool bChanged = false;
        for (TSharedPtr<FJsonValue>& Item : Items)
        {
            if (!Item.IsValid())
            {
                continue;
            }

            switch (Item->Type)
            {
            case EJson::String:
            {
                FString Str = Item->AsString();
                if (Builder.TrimString(Str))
                {
                    Item = MakeShared<FJsonValueString>(Str);
                    TruncatedKeys.Add(AssociatedKey);
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
                    TruncatedKeys.Add(AssociatedKey);
                }
                if (WalkArrayItemsInPlace(Inner, AssociatedKey, Builder, TruncatedKeys))
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
                WalkObjectInPlace(Item->AsObject(), Builder, TruncatedKeys);
                break;
            }
            default:
                break;
            }
        }
        return bChanged;
    }

    void WalkObjectInPlace(const TSharedPtr<FJsonObject>& Object,
                           const FHaybaMCPResponseBuilder& Builder,
                           TSet<FString>& TruncatedKeys)
    {
        if (!Object.IsValid())
        {
            return;
        }

        for (auto& Pair : Object->Values)
        {
            const FString& Key = Pair.Key;
            TSharedPtr<FJsonValue>& Value = Pair.Value;
            if (!Value.IsValid())
            {
                continue;
            }

            switch (Value->Type)
            {
            case EJson::String:
            {
                FString Str = Value->AsString();
                if (Builder.TrimString(Str))
                {
                    Value = MakeShared<FJsonValueString>(Str);
                    TruncatedKeys.Add(Key);
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
                    TruncatedKeys.Add(Key);
                }
                if (WalkArrayItemsInPlace(Items, Key, Builder, TruncatedKeys))
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
                WalkObjectInPlace(Value->AsObject(), Builder, TruncatedKeys);
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
    // Deep-copy via serialize/deserialize so we don't mutate the caller's object.
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

    TSet<FString> TruncatedKeys;
    WalkObjectInPlace(Copy, *this, TruncatedKeys);

    // Enforce MaxTopLevelFields by dropping extra top-level entries.
    if (Limits.MaxTopLevelFields > 0 && Copy->Values.Num() > Limits.MaxTopLevelFields)
    {
        TArray<FString> Keys;
        Copy->Values.GetKeys(Keys);
        for (int32 i = Limits.MaxTopLevelFields; i < Keys.Num(); ++i)
        {
            TruncatedKeys.Add(Keys[i]);
            Copy->Values.Remove(Keys[i]);
        }
    }

    if (TruncatedKeys.Num() > 0)
    {
        TArray<TSharedPtr<FJsonValue>> TruncatedArray;
        TruncatedArray.Reserve(TruncatedKeys.Num());
        for (const FString& K : TruncatedKeys)
        {
            TruncatedArray.Add(MakeShared<FJsonValueString>(K));
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
