#include "HaybaMCPDataAssetHandler.h"

#include "Json.h"
#include "Engine/DataAsset.h"
#include "AssetToolsModule.h"
#include "IAssetTools.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "HaybaMCPAssetGuard.h"
#include "HaybaMCPParams.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "EditorAssetLibrary.h"
#include "UObject/UnrealType.h"
#include "UObject/Class.h"
#include "UObject/Package.h"
#include "UObject/UObjectGlobals.h"
#include "UObject/SavePackage.h"
#include "Misc/PackageName.h"
#include "Modules/ModuleManager.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPDataAsset, Log, All);

TArray<FString> FHaybaMCPDataAssetHandler::GetCommands() const
{
    return {
        TEXT("data_create"),
        TEXT("data_get"),
        TEXT("data_set")
    };
}

// ---------- helpers ----------

namespace HaybaMCPDataAssetHelpers
{
    constexpr int32 MaxDataAssetPathChars = 1024;
    constexpr int32 MaxDataAssetNameChars = 256;
    constexpr int32 MaxDataAssetClassChars = 1024;
    constexpr int32 MaxDataAssetPropertyNameChars = 256;
    constexpr int32 MaxMutationStringChars = 64 * 1024;
    constexpr int32 MaxMutationTotalStringChars = 256 * 1024;
    constexpr int32 MaxMutationStagingBytes = 1024 * 1024;

    // Reflection is performed before the command router's response trimmer.
    // These limits therefore bound the work and allocations used to *produce*
    // the response, rather than relying on a later wire-size limit.
    constexpr int32 MaxReflectedProperties = 256;
    constexpr int32 MaxReflectionDepth = 16;
    constexpr int32 MaxReflectionNodes = 4096;
    constexpr int32 MaxReflectionContainerItems = 1024;
    constexpr int32 MaxReflectionContainerSlots = 1024;
    constexpr int32 MaxReflectionFieldsPerStruct = 256;
    constexpr int32 MaxReflectionStringChars = 16 * 1024;
    constexpr int32 MaxReflectionTotalStringChars = 256 * 1024;
    constexpr int32 MaxReportedOmittedProperties = 64;
    constexpr int64 MaxExactJsonInteger = 9007199254740991LL;

    static bool IsSafeAssetName(const FString& Value)
    {
        if (Value.IsEmpty()) return false;
        for (const TCHAR Ch : Value)
        {
            // Keep untrusted names out of FName/package internals until their
            // lexical shape is known. Package/object names do not need control
            // characters, separators, or punctuation when the folder is a
            // separate parameter.
            if (Ch == TEXT('\0') || FChar::IsControl(Ch)
                || !(FChar::IsAlnum(Ch) || Ch == TEXT('_')))
            {
                return false;
            }
        }
        return true;
    }

    static bool IsSafePropertyName(const FString& Value)
    {
        // Reflected field names originate as FNames. Refuse attacker-controlled
        // punctuation/control characters before FindFProperty constructs or
        // probes a name-table entry.
        return IsSafeAssetName(Value);
    }

    static bool IsSafeClassReference(const FString& Value)
    {
        if (Value.IsEmpty()
            || Value.Contains(TEXT(".."))
            || Value.Contains(TEXT("//"))
            || Value.Contains(TEXT("\\")))
        {
            return false;
        }
        for (const TCHAR Ch : Value)
        {
            // ResolveClass accepts short names, Module.Class, and /Game or
            // /Script object paths. None requires quotes, whitespace, control
            // characters, or punctuation beyond slash/dot/underscore.
            if (Ch == TEXT('\0') || FChar::IsControl(Ch)
                || !(FChar::IsAlnum(Ch)
                    || Ch == TEXT('_') || Ch == TEXT('/') || Ch == TEXT('.')))
            {
                return false;
            }
        }
        if (Value.StartsWith(TEXT("/"), ESearchCase::CaseSensitive))
        {
            if (!(Value.StartsWith(TEXT("/Game/"), ESearchCase::CaseSensitive)
                    || Value.StartsWith(TEXT("/Script/"), ESearchCase::CaseSensitive)))
            {
                return false;
            }
            int32 LastSlash = INDEX_NONE;
            int32 FirstDot = INDEX_NONE;
            int32 LastDot = INDEX_NONE;
            Value.FindLastChar(TEXT('/'), LastSlash);
            Value.FindChar(TEXT('.'), FirstDot);
            Value.FindLastChar(TEXT('.'), LastDot);
            return FirstDot == LastDot
                && FirstDot > LastSlash + 1
                && FirstDot < Value.Len() - 1;
        }
        if (Value.Contains(TEXT("/"))) return false;
        int32 FirstDot = INDEX_NONE;
        int32 LastDot = INDEX_NONE;
        if (!Value.FindChar(TEXT('.'), FirstDot)) return true;
        Value.FindLastChar(TEXT('.'), LastDot);
        return FirstDot == LastDot && FirstDot > 0 && FirstDot < Value.Len() - 1;
    }

    // Resolve a UClass* by user-supplied name. Accepts:
    //   "/Script/MyGame.MyClass"  (path)
    //   "MyClass" or "MyClass_C"  (short name)
    //   "MyGame.MyClass"          (module.class)
    static UClass* ResolveClass(const FString& InName)
    {
        if (InName.IsEmpty()) return nullptr;

        FString Name = InName;
        // Strip trailing _C if user passed a blueprint generated class short name —
        // FindFirstObject works on the UClass name.
        // For full paths, prefer LoadClass / LoadObject.
        if (Name.StartsWith(TEXT("/")))
        {
            if (UClass* C = LoadClass<UObject>(nullptr, *Name)) return C;
            if (UClass* C = LoadObject<UClass>(nullptr, *Name)) return C;
        }

        // Try as-is, then with _C, then short name.
        if (UClass* C = FindFirstObject<UClass>(*Name, EFindFirstObjectOptions::NativeFirst))
            return C;

        if (Name.EndsWith(TEXT("_C")))
        {
            FString Trim = Name.LeftChop(2);
            if (UClass* C = FindFirstObject<UClass>(*Trim, EFindFirstObjectOptions::NativeFirst))
                return C;
        }
        else
        {
            FString WithC = Name + TEXT("_C");
            if (UClass* C = FindFirstObject<UClass>(*WithC, EFindFirstObjectOptions::NativeFirst))
                return C;
        }

        // Module.Class form -> /Script/Module.Class
        int32 Dot;
        if (Name.FindChar('.', Dot))
        {
            FString ScriptPath = FString::Printf(TEXT("/Script/%s"), *Name);
            if (UClass* C = LoadClass<UObject>(nullptr, *ScriptPath)) return C;
            if (UClass* C = LoadObject<UClass>(nullptr, *ScriptPath)) return C;
        }

        return nullptr;
    }

    struct FReflectionBudget
    {
        int32 Nodes = 0;
        int32 StringChars = 0;
        int32 UnsupportedValues = 0;
        int32 IntegerStrings = 0;
        bool bTruncated = false;
        FString FirstLimitReason;

        bool Refuse(const TCHAR* Reason)
        {
            bTruncated = true;
            if (FirstLimitReason.IsEmpty()) FirstLimitReason = Reason;
            return false;
        }

        bool ReserveNode()
        {
            if (Nodes >= MaxReflectionNodes)
                return Refuse(TEXT("reflection node budget exhausted"));
            ++Nodes;
            return true;
        }

        bool ReserveString(const FString& Value)
        {
            if (Value.Len() > MaxReflectionStringChars)
                return Refuse(TEXT("a reflected string exceeds the per-value character limit"));
            if (StringChars > MaxReflectionTotalStringChars - Value.Len())
                return Refuse(TEXT("reflection string-character budget exhausted"));
            StringChars += Value.Len();
            return true;
        }
    };

    struct FReflectionResult
    {
        TSharedPtr<FJsonObject> Properties = MakeShared<FJsonObject>();
        FReflectionBudget Budget;
        int32 PropertiesExamined = 0;
        int32 PropertiesReturned = 0;
        int32 PropertiesOmitted = 0;
        bool bPropertyScanLimitHit = false;
        TArray<FString> OmittedPropertyNames;
    };

    static bool ValidateReflectionContainerBounds(
        int32 Num,
        int32 MaxIndex,
        const TCHAR* Kind,
        FReflectionBudget& Budget)
    {
        if (Num > MaxReflectionContainerItems)
        {
            return Budget.Refuse(*FString::Printf(
                TEXT("a reflected %s exceeds the item limit"), Kind));
        }
        // FScriptSet/Map iterators and CopyValuesInternal scan sparse storage
        // through GetMaxIndex(), not merely the live element count. A set/map
        // with few survivors can therefore hide an arbitrarily long scan behind
        // a small Num(). Bound the physical slot range before either iterator or
        // any future container-copy staging boundary can be reached (data_set
        // itself currently rejects all containers before staging).
        if (MaxIndex > MaxReflectionContainerSlots)
        {
            return Budget.Refuse(*FString::Printf(
                TEXT("a reflected %s exceeds the sparse-slot traversal limit"), Kind));
        }
        return true;
    }

    static bool ReflectPropertyValueBounded(
        FProperty* Property,
        const void* Value,
        int32 Depth,
        FReflectionBudget& Budget,
        TSharedPtr<FJsonValue>& OutValue);

    static bool MakeBoundedStringValue(
        const FString& Value,
        FReflectionBudget& Budget,
        TSharedPtr<FJsonValue>& OutValue)
    {
        if (!Budget.ReserveNode() || !Budget.ReserveString(Value)) return false;
        OutValue = MakeShared<FJsonValueString>(Value);
        return true;
    }

    static bool MakeUnsupportedValue(
        FReflectionBudget& Budget,
        TSharedPtr<FJsonValue>& OutValue)
    {
        static const FString Marker = TEXT("<unsupported-by-bounded-reflection>");
        ++Budget.UnsupportedValues;
        return MakeBoundedStringValue(Marker, Budget, OutValue);
    }

    static bool IsUnsignedIntegerProperty(const FNumericProperty* Property)
    {
        return Property
            && (Property->IsA<FByteProperty>()
                || Property->IsA<FUInt16Property>()
                || Property->IsA<FUInt32Property>()
                || Property->IsA<FUInt64Property>());
    }

    static bool MakeExactSignedIntegerValue(
        int64 Value,
        FReflectionBudget& Budget,
        TSharedPtr<FJsonValue>& OutValue)
    {
        if (Value >= -MaxExactJsonInteger && Value <= MaxExactJsonInteger)
        {
            if (!Budget.ReserveNode()) return false;
            OutValue = MakeShared<FJsonValueNumber>(static_cast<double>(Value));
            return true;
        }

        // JSON numbers are IEEE-754 doubles. Preserve large integers as exact
        // decimal strings instead of silently rounding them.
        ++Budget.IntegerStrings;
        return MakeBoundedStringValue(LexToString(Value), Budget, OutValue);
    }

    static bool MakeExactUnsignedIntegerValue(
        uint64 Value,
        FReflectionBudget& Budget,
        TSharedPtr<FJsonValue>& OutValue)
    {
        if (Value <= static_cast<uint64>(MaxExactJsonInteger))
        {
            if (!Budget.ReserveNode()) return false;
            OutValue = MakeShared<FJsonValueNumber>(static_cast<double>(Value));
            return true;
        }

        ++Budget.IntegerStrings;
        return MakeBoundedStringValue(LexToString(Value), Budget, OutValue);
    }

    static bool ReflectEnumValueBounded(
        FNumericProperty* UnderlyingProperty,
        const UEnum* Enum,
        const void* Value,
        FReflectionBudget& Budget,
        TSharedPtr<FJsonValue>& OutValue)
    {
        if (!UnderlyingProperty || !Enum || !Value)
            return Budget.Refuse(TEXT("reflection encountered an invalid enum"));

        if (IsUnsignedIntegerProperty(UnderlyingProperty))
        {
            const uint64 Raw = UnderlyingProperty->GetUnsignedIntPropertyValue(Value);
            if (Raw <= static_cast<uint64>(MAX_int64)
                && Enum->IsValidEnumValueOrBitfield(static_cast<int64>(Raw)))
            {
                return MakeBoundedStringValue(
                    Enum->GetValueOrBitfieldAsAuthoredNameString(static_cast<int64>(Raw)),
                    Budget,
                    OutValue);
            }
            return MakeExactUnsignedIntegerValue(Raw, Budget, OutValue);
        }

        const int64 Raw = UnderlyingProperty->GetSignedIntPropertyValue(Value);
        if (Enum->IsValidEnumValueOrBitfield(Raw))
        {
            return MakeBoundedStringValue(
                Enum->GetValueOrBitfieldAsAuthoredNameString(Raw), Budget, OutValue);
        }
        return MakeExactSignedIntegerValue(Raw, Budget, OutValue);
    }

    static bool ReflectObjectReferenceBounded(
        const UObject* Object,
        FReflectionBudget& Budget,
        TSharedPtr<FJsonValue>& OutValue)
    {
        if (!Object)
        {
            if (!Budget.ReserveNode()) return false;
            OutValue = MakeShared<FJsonValueNull>();
            return true;
        }

        // GetPathName allocates the full outer chain. Establish a strict bound
        // from FName lengths and outer depth before asking it to materialize.
        int32 EstimatedChars = 0;
        int32 OuterDepth = 0;
        for (const UObject* Cursor = Object; Cursor; Cursor = Cursor->GetOuter())
        {
            if (++OuterDepth > MaxReflectionDepth)
                return Budget.Refuse(TEXT("an object reference exceeds the outer-depth limit"));
            const int32 NameChars = static_cast<int32>(Cursor->GetFName().GetStringLength());
            if (EstimatedChars > MaxReflectionStringChars - NameChars - 2)
                return Budget.Refuse(TEXT("an object reference path exceeds the character limit"));
            EstimatedChars += NameChars + 2;
        }
        const FString ObjectPath = Object->GetPathName();
        return MakeBoundedStringValue(ObjectPath, Budget, OutValue);
    }

    static bool ReflectScalarPropertyBounded(
        FProperty* Property,
        const void* Value,
        int32 Depth,
        FReflectionBudget& Budget,
        TSharedPtr<FJsonValue>& OutValue)
    {
        if (!Property || !Value) return Budget.Refuse(TEXT("reflection encountered an invalid property value"));
        if (Depth > MaxReflectionDepth)
            return Budget.Refuse(TEXT("reflection depth limit exhausted"));
        if (Property->HasSetterOrGetter())
        {
            // Raw storage is not the logical value for accessor-backed fields.
            // Calling an accessor would execute arbitrary native code, while
            // bypassing it could report a false value, so data_get stays partial.
            return MakeUnsupportedValue(Budget, OutValue);
        }

        if (FEnumProperty* EnumProperty = CastField<FEnumProperty>(Property))
        {
            return ReflectEnumValueBounded(
                EnumProperty->GetUnderlyingProperty(),
                EnumProperty->GetEnum(),
                Value,
                Budget,
                OutValue);
        }
        if (FNumericProperty* NumericProperty = CastField<FNumericProperty>(Property))
        {
            if (NumericProperty->IsFloatingPoint())
            {
                if (!Budget.ReserveNode()) return false;
                const double Number = NumericProperty->GetFloatingPointPropertyValue(Value);
                if (!FMath::IsFinite(Number))
                {
                    OutValue = MakeShared<FJsonValueNull>();
                    ++Budget.UnsupportedValues;
                    return true;
                }
                OutValue = MakeShared<FJsonValueNumber>(Number);
                return true;
            }
            if (NumericProperty->IsInteger())
            {
                if (NumericProperty->IsEnum())
                {
                    return ReflectEnumValueBounded(
                        NumericProperty,
                        NumericProperty->GetIntPropertyEnum(),
                        Value,
                        Budget,
                        OutValue);
                }
                return IsUnsignedIntegerProperty(NumericProperty)
                    ? MakeExactUnsignedIntegerValue(
                        NumericProperty->GetUnsignedIntPropertyValue(Value), Budget, OutValue)
                    : MakeExactSignedIntegerValue(
                        NumericProperty->GetSignedIntPropertyValue(Value), Budget, OutValue);
            }
            return MakeUnsupportedValue(Budget, OutValue);
        }
        if (FBoolProperty* BoolProperty = CastField<FBoolProperty>(Property))
        {
            if (!Budget.ReserveNode()) return false;
            OutValue = MakeShared<FJsonValueBoolean>(BoolProperty->GetPropertyValue(Value));
            return true;
        }
        if (FStrProperty* StringProperty = CastField<FStrProperty>(Property))
        {
            // GetPropertyValue returns a const reference, so checking Len()
            // does not first duplicate an attacker-sized FString.
            const FString& StringValue = StringProperty->GetPropertyValue(Value);
            return MakeBoundedStringValue(StringValue, Budget, OutValue);
        }
        if (FNameProperty* NameProperty = CastField<FNameProperty>(Property))
        {
            return MakeBoundedStringValue(
                NameProperty->GetPropertyValue(Value).ToString(), Budget, OutValue);
        }
        if (FTextProperty* TextProperty = CastField<FTextProperty>(Property))
        {
            // FText::ToString can expand an arbitrarily large formatted
            // history before its length is observable. Do not call it on this
            // untrusted reflection surface.
            (void)TextProperty;
            return MakeUnsupportedValue(Budget, OutValue);
        }
        if (Property->IsA<FSoftObjectProperty>()
            || Property->IsA<FSoftClassProperty>()
            || Property->IsA<FWeakObjectProperty>()
            || Property->IsA<FLazyObjectProperty>())
        {
            // Wrapper references can contain a valid path while their object is
            // unloaded. GetObjectPropertyValue would turn that state into null
            // and falsely claim a complete read, so keep it explicitly partial.
            return MakeUnsupportedValue(Budget, OutValue);
        }
        if (FObjectPropertyBase* ObjectProperty = CastField<FObjectPropertyBase>(Property))
        {
            return ReflectObjectReferenceBounded(
                ObjectProperty->GetObjectPropertyValue(Value), Budget, OutValue);
        }
        if (FArrayProperty* ArrayProperty = CastField<FArrayProperty>(Property))
        {
            FScriptArrayHelper Helper(ArrayProperty, Value);
            if (Helper.Num() > MaxReflectionContainerItems)
                return Budget.Refuse(TEXT("a reflected array exceeds the item limit"));
            if (!Budget.ReserveNode()) return false;
            TArray<TSharedPtr<FJsonValue>> Items;
            Items.Reserve(Helper.Num());
            for (int32 Index = 0; Index < Helper.Num(); ++Index)
            {
                TSharedPtr<FJsonValue> Item;
                if (!ReflectPropertyValueBounded(
                        ArrayProperty->Inner, Helper.GetRawPtr(Index), Depth + 1, Budget, Item))
                    return false;
                Items.Add(Item);
            }
            OutValue = MakeShared<FJsonValueArray>(MoveTemp(Items));
            return true;
        }
        if (FSetProperty* SetProperty = CastField<FSetProperty>(Property))
        {
            FScriptSetHelper Helper(SetProperty, Value);
            if (!ValidateReflectionContainerBounds(
                    Helper.Num(), Helper.GetMaxIndex(), TEXT("set"), Budget))
                return false;
            if (!Budget.ReserveNode()) return false;
            TArray<TSharedPtr<FJsonValue>> Items;
            Items.Reserve(Helper.Num());
            for (FScriptSetHelper::FIterator It(Helper); It; ++It)
            {
                TSharedPtr<FJsonValue> Item;
                if (!ReflectPropertyValueBounded(
                        SetProperty->ElementProp, Helper.GetElementPtr(It), Depth + 1, Budget, Item))
                    return false;
                Items.Add(Item);
            }
            OutValue = MakeShared<FJsonValueArray>(MoveTemp(Items));
            return true;
        }
        if (FMapProperty* MapProperty = CastField<FMapProperty>(Property))
        {
            FScriptMapHelper Helper(MapProperty, Value);
            if (!ValidateReflectionContainerBounds(
                    Helper.Num(), Helper.GetMaxIndex(), TEXT("map"), Budget))
                return false;
            if (!Budget.ReserveNode()) return false;
            TSharedPtr<FJsonObject> MapObject = MakeShared<FJsonObject>();
            for (FScriptMapHelper::FIterator It(Helper); It; ++It)
            {
                TSharedPtr<FJsonValue> KeyValue;
                TSharedPtr<FJsonValue> ItemValue;
                if (!ReflectPropertyValueBounded(
                        MapProperty->KeyProp, Helper.GetKeyPtr(It), Depth + 1, Budget, KeyValue)
                    || !ReflectPropertyValueBounded(
                        MapProperty->ValueProp, Helper.GetValuePtr(It), Depth + 1, Budget, ItemValue))
                    return false;

                FString KeyString;
                if (!KeyValue.IsValid() || !KeyValue->TryGetString(KeyString))
                    return Budget.Refuse(TEXT("a reflected map key is not a bounded string"));
                if (!Budget.ReserveString(KeyString)) return false;
                MapObject->SetField(KeyString, ItemValue);
            }
            OutValue = MakeShared<FJsonValueObject>(MapObject);
            return true;
        }
        if (FStructProperty* StructProperty = CastField<FStructProperty>(Property))
        {
            if (!StructProperty->Struct || !Budget.ReserveNode()) return false;
            TSharedPtr<FJsonObject> StructObject = MakeShared<FJsonObject>();
            int32 Fields = 0;
            for (TFieldIterator<FProperty> It(StructProperty->Struct); It; ++It)
            {
                if (++Fields > MaxReflectionFieldsPerStruct)
                    return Budget.Refuse(TEXT("a reflected struct exceeds the field limit"));
                FProperty* Field = *It;
                if (!Field) continue;
                const FString FieldName = Field->GetName();
                if (!Budget.ReserveString(FieldName)) return false;
                TSharedPtr<FJsonValue> FieldValue;
                if (!ReflectPropertyValueBounded(
                        Field, Field->ContainerPtrToValuePtr<void>(Value), Depth + 1, Budget, FieldValue))
                    return false;
                StructObject->SetField(FieldName, FieldValue);
            }
            OutValue = MakeShared<FJsonValueObject>(StructObject);
            return true;
        }

        // ExportTextItem and custom struct converters can allocate arbitrary
        // strings or recursively materialize objects. Keep unsupported values
        // explicit without invoking those unbounded hooks.
        return MakeUnsupportedValue(Budget, OutValue);
    }

    static bool ReflectPropertyValueBounded(
        FProperty* Property,
        const void* Value,
        int32 Depth,
        FReflectionBudget& Budget,
        TSharedPtr<FJsonValue>& OutValue)
    {
        if (!Property || !Value) return Budget.Refuse(TEXT("reflection encountered an invalid property value"));
        if (Depth > MaxReflectionDepth)
            return Budget.Refuse(TEXT("reflection depth limit exhausted"));

        if (Property->ArrayDim > 1)
        {
            if (Property->ArrayDim > MaxReflectionContainerItems)
                return Budget.Refuse(TEXT("a reflected fixed array exceeds the item limit"));
            if (!Budget.ReserveNode()) return false;
            TArray<TSharedPtr<FJsonValue>> Items;
            Items.Reserve(Property->ArrayDim);
            for (int32 Index = 0; Index < Property->ArrayDim; ++Index)
            {
                TSharedPtr<FJsonValue> Item;
                const void* Element = static_cast<const uint8*>(Value)
                    + Index * Property->GetElementSize();
                if (!ReflectScalarPropertyBounded(
                        Property, Element, Depth + 1, Budget, Item))
                    return false;
                Items.Add(Item);
            }
            OutValue = MakeShared<FJsonValueArray>(MoveTemp(Items));
            return true;
        }
        return ReflectScalarPropertyBounded(Property, Value, Depth, Budget, OutValue);
    }

    // Reflect a bounded prefix of properties. A property that exceeds any
    // nested budget is omitted atomically; no half-value is returned.
    static FReflectionResult ReflectObjectPropertiesBounded(const UObject* Object)
    {
        FReflectionResult Result;
        if (!Object) return Result;

        for (TFieldIterator<FProperty> It(Object->GetClass()); It; ++It)
        {
            if (Result.PropertiesExamined >= MaxReflectedProperties)
            {
                Result.bPropertyScanLimitHit = true;
                Result.Budget.Refuse(TEXT("reflection property scan limit exhausted"));
                break;
            }

            FProperty* Property = *It;
            if (!Property) continue;
            ++Result.PropertiesExamined;
            const FString PropertyName = Property->GetName();
            if (!Result.Budget.ReserveString(PropertyName))
            {
                ++Result.PropertiesOmitted;
                if (Result.OmittedPropertyNames.Num() < MaxReportedOmittedProperties)
                    Result.OmittedPropertyNames.Add(PropertyName);
                continue;
            }

            TSharedPtr<FJsonValue> JsonValue;
            if (ReflectPropertyValueBounded(
                    Property,
                    Property->ContainerPtrToValuePtr<void>(Object),
                    0,
                    Result.Budget,
                    JsonValue))
            {
                Result.Properties->SetField(PropertyName, JsonValue);
                ++Result.PropertiesReturned;
            }
            else
            {
                ++Result.PropertiesOmitted;
                if (Result.OmittedPropertyNames.Num() < MaxReportedOmittedProperties)
                    Result.OmittedPropertyNames.Add(PropertyName);
            }
        }
        return Result;
    }

    static bool ValidateMutationJsonShape(
        const TSharedPtr<FJsonValue>& Value,
        int32 Depth,
        int32& Nodes,
        int32& StringChars,
        FString& OutReason)
    {
        if (!Value.IsValid()) { OutReason = TEXT("invalid JSON value"); return false; }
        if (++Nodes > 4096) { OutReason = TEXT("exceeds the 4096-value mutation limit"); return false; }
        if (Depth > 32) { OutReason = TEXT("exceeds the 32-level mutation depth limit"); return false; }
        if (Value->Type == EJson::Array)
        {
            if (Value->AsArray().Num() > 1024)
            {
                OutReason = TEXT("contains an array larger than 1024 items");
                return false;
            }
            for (const TSharedPtr<FJsonValue>& Child : Value->AsArray())
                if (!ValidateMutationJsonShape(Child, Depth + 1, Nodes, StringChars, OutReason)) return false;
        }
        else if (Value->Type == EJson::Object)
        {
            const TSharedPtr<FJsonObject>& Object = Value->AsObject();
            if (!Object.IsValid()) { OutReason = TEXT("contains an invalid object"); return false; }
            if (Object->Values.Num() > 256)
            {
                OutReason = TEXT("contains an object larger than 256 fields");
                return false;
            }
            for (const auto& Pair : Object->Values)
            {
                if (Pair.Key.Len() > MaxDataAssetPropertyNameChars)
                {
                    OutReason = TEXT("contains an object key longer than 256 characters");
                    return false;
                }
                if (StringChars > MaxMutationTotalStringChars - Pair.Key.Len())
                {
                    OutReason = TEXT("exceeds the 262144-character mutation limit");
                    return false;
                }
                StringChars += Pair.Key.Len();
                if (!ValidateMutationJsonShape(Pair.Value, Depth + 1, Nodes, StringChars, OutReason)) return false;
            }
        }
        else if (Value->Type == EJson::String)
        {
            // GetMemoryFootprint lets us reject a huge stored JSON string
            // before AsString/TryGetString duplicates it.
            const SIZE_T MaxFootprint =
                static_cast<SIZE_T>(MaxMutationStringChars + 256) * sizeof(TCHAR);
            if (Value->GetMemoryFootprint() > MaxFootprint)
            {
                OutReason = TEXT("contains a string larger than 65536 characters");
                return false;
            }
            const FString StringValue = Value->AsString();
            if (StringValue.Len() > MaxMutationStringChars)
            {
                OutReason = TEXT("contains a string larger than 65536 characters");
                return false;
            }
            if (StringChars > MaxMutationTotalStringChars - StringValue.Len())
            {
                OutReason = TEXT("exceeds the 262144-character mutation limit");
                return false;
            }
            StringChars += StringValue.Len();
        }
        else if (Value->Type == EJson::Number)
        {
            double Number = 0.0;
            if (!Value->TryGetNumber(Number) || !FMath::IsFinite(Number))
            {
                OutReason = TEXT("contains a non-finite number");
                return false;
            }
        }
        return true;
    }

    static bool ValidateMutationPropertyGraph(
        const FProperty* Property,
        int32 Depth,
        int32& Nodes,
        FString& OutReason)
    {
        if (!Property)
        {
            OutReason = TEXT("has an invalid reflected property");
            return false;
        }
        if (++Nodes > 4096)
        {
            OutReason = TEXT("has a property graph larger than 4096 fields");
            return false;
        }
        if (Depth > 32)
        {
            OutReason = TEXT("has a property graph deeper than 32 levels");
            return false;
        }
        if (Property->HasAnyPropertyFlags(
                CPF_InstancedReference | CPF_PersistentInstance | CPF_ContainsInstancedReference))
        {
            OutReason = TEXT("contains instanced object construction hooks");
            return false;
        }
        if (Property->HasSetterOrGetter())
        {
            OutReason = TEXT("has a native getter or setter; raw storage would bypass its semantics and calling it would execute unaudited code");
            return false;
        }
        if (Property->ArrayDim != 1)
        {
            OutReason = TEXT("is a fixed array; data_set supports only one scalar value");
            return false;
        }

        // Exact concrete property classes only. IsA would admit a custom field
        // subclass overriding virtual assignment/import behavior. data_set does
        // not call JsonValueToUProperty or ImportText_Direct at all.
        const FFieldClass* PropertyClass = Property->GetClass();
        const bool bExactAuditedScalar =
            PropertyClass == FEnumProperty::StaticClass()
            || PropertyClass == FByteProperty::StaticClass()
            || PropertyClass == FInt8Property::StaticClass()
            || PropertyClass == FInt16Property::StaticClass()
            || PropertyClass == FIntProperty::StaticClass()
            || PropertyClass == FInt64Property::StaticClass()
            || PropertyClass == FUInt16Property::StaticClass()
            || PropertyClass == FUInt32Property::StaticClass()
            || PropertyClass == FUInt64Property::StaticClass()
            || PropertyClass == FFloatProperty::StaticClass()
            || PropertyClass == FDoubleProperty::StaticClass()
            || PropertyClass == FBoolProperty::StaticClass()
            || PropertyClass == FStrProperty::StaticClass()
            || PropertyClass == FNameProperty::StaticClass();
        if (bExactAuditedScalar)
        {
            return true;
        }
        // Deliberately no arrays, sets, maps, or structs. Container copy and
        // comparison can scan sparse/corrupt storage, and even a hook-free
        // UUserDefinedStruct runs InitializeStruct, which copies its mutable
        // DefaultInstance into staging before request conversion. Complex
        // properties need domain-specific setters with their own invariants.
        OutReason = FString::Printf(
            TEXT("is not one of the supported scalar property types (numeric, enum, bool, string, or name); %s requires a domain-specific setter"),
            *Property->GetClass()->GetName());
        return false;
    }

    static bool IsBoundedNameLikeString(const FString& Value)
    {
        if (Value.IsEmpty() || Value.Len() > MaxDataAssetPropertyNameChars)
            return false;
        for (const TCHAR Ch : Value)
        {
            if (Ch == TEXT('\0') || FChar::IsControl(Ch)) return false;
        }
        return true;
    }

    static bool TryParseCanonicalSignedDecimal(
        const FString& Value,
        int64& OutValue)
    {
        if (Value.IsEmpty() || Value.Len() > 20) return false;
        int32 Index = 0;
        if (Value[0] == TEXT('-'))
        {
            if (Value.Len() == 1) return false;
            Index = 1;
        }
        for (; Index < Value.Len(); ++Index)
        {
            if (!FChar::IsDigit(Value[Index])) return false;
        }
        if (!LexTryParseString(OutValue, *Value)) return false;
        return LexToString(OutValue) == Value;
    }

    static bool TryParseCanonicalUnsignedDecimal(
        const FString& Value,
        uint64& OutValue)
    {
        if (Value.IsEmpty() || Value.Len() > 20) return false;
        if (Value.Len() > 1 && Value[0] == TEXT('0')) return false;
        uint64 Accumulator = 0;
        for (const TCHAR Ch : Value)
        {
            if (Ch < TEXT('0') || Ch > TEXT('9')) return false;
            const uint64 Digit = static_cast<uint64>(Ch - TEXT('0'));
            if (Accumulator > (MAX_uint64 - Digit) / 10) return false;
            Accumulator = Accumulator * 10 + Digit;
        }
        OutValue = Accumulator;
        return true;
    }

    static bool ResolveAuditedEnumString(
        const UEnum* Enum,
        const FString& Text,
        int64& OutValue,
        FString& OutReason)
    {
        if (!Enum || !IsBoundedNameLikeString(Text))
        {
            OutReason = TEXT("must be a bounded authored enum name or flag list");
            return false;
        }

        TArray<FString> Tokens;
        Text.ParseIntoArray(Tokens, TEXT("|"), false);
        if (Tokens.Num() == 0 || Tokens.Num() > 64)
        {
            OutReason = TEXT("must contain between one and 64 authored enum names");
            return false;
        }
        if (Tokens.Num() > 1 && !Enum->HasAnyEnumFlags(EEnumFlags::Flags))
        {
            OutReason = TEXT("uses a flag list for an enum that is not declared as flags");
            return false;
        }

        uint64 Combined = 0;
        for (FString& Token : Tokens)
        {
            Token.TrimStartAndEndInline();
            if (Token.IsEmpty())
            {
                OutReason = TEXT("contains an empty enum flag name");
                return false;
            }
            const int32 Index = Enum->GetIndexByNameString(
                Token, EGetByNameFlags::CheckAuthoredName);
            if (Index == INDEX_NONE)
            {
                OutReason = FString::Printf(
                    TEXT("contains unknown authored enum name '%s'"), *Token);
                return false;
            }
            const int64 TokenValue = Enum->GetValueByIndex(Index);
            if (Tokens.Num() == 1)
            {
                // Preserve an exact signed value such as -1. GetValueByName*
                // cannot use INDEX_NONE as a failure sentinel here because -1
                // is also a legal underlying enum value.
                OutValue = TokenValue;
                return true;
            }
            Combined |= static_cast<uint64>(TokenValue);
        }

        OutValue = static_cast<int64>(Combined);
        return true;
    }

    static bool ValidateMutationValueForProperty(
        const FProperty* Property,
        const TSharedPtr<FJsonValue>& Value,
        int32 Depth,
        int32& Nodes,
        FString& OutReason,
        bool bFixedArrayElement = false)
    {
        if (!Property || !Value.IsValid() || Value->IsNull())
        {
            OutReason = TEXT("does not match a non-null property value");
            return false;
        }
        if (++Nodes > 4096 || Depth > 32)
        {
            OutReason = TEXT("exceeds the audited property/value recursion budget");
            return false;
        }

        if (!bFixedArrayElement && Property->ArrayDim > 1)
        {
            if (Value->Type != EJson::Array
                || Value->AsArray().Num() != Property->ArrayDim)
            {
                OutReason = TEXT("must be an exact-size JSON array for a fixed property array");
                return false;
            }
            for (const TSharedPtr<FJsonValue>& Item : Value->AsArray())
            {
                if (!ValidateMutationValueForProperty(
                        Property, Item, Depth + 1, Nodes, OutReason, true))
                    return false;
            }
            return true;
        }

        const auto ValidateEnum = [&](const FNumericProperty* Underlying, const UEnum* Enum)
        {
            if (!Underlying || !Enum)
            {
                OutReason = TEXT("has invalid enum metadata");
                return false;
            }
            if (Value->Type == EJson::String)
            {
                int64 EnumValue = 0;
                if (!ResolveAuditedEnumString(
                        Enum, Value->AsString(), EnumValue, OutReason))
                    return false;
                if (!Underlying->CanHoldValue(EnumValue)
                    || !Enum->IsValidEnumValueOrBitfield(EnumValue))
                {
                    OutReason = TEXT("authored enum names do not fit the underlying type or form a valid value/bitfield");
                    return false;
                }
                return true;
            }
            double Number = 0.0;
            if (Value->Type != EJson::Number
                || !Value->TryGetNumber(Number)
                || !FMath::IsFinite(Number)
                || FMath::TruncToDouble(Number) != Number
                || Number < -static_cast<double>(MaxExactJsonInteger)
                || Number > static_cast<double>(MaxExactJsonInteger))
            {
                OutReason = TEXT("must be a bounded authored enum name or exact integral JSON number");
                return false;
            }
            const int64 Signed = static_cast<int64>(Number);
            if (!Underlying->CanHoldValue(Signed))
            {
                OutReason = TEXT("is outside the enum underlying type's range");
                return false;
            }
            if (!Enum->IsValidEnumValueOrBitfield(Signed))
            {
                OutReason = TEXT("is not a declared enum value or valid bitfield");
                return false;
            }
            return true;
        };

        if (const FEnumProperty* EnumProperty = CastField<FEnumProperty>(Property))
        {
            return ValidateEnum(
                EnumProperty->GetUnderlyingProperty(), EnumProperty->GetEnum());
        }
        if (const FNumericProperty* NumericProperty = CastField<FNumericProperty>(Property))
        {
            if (NumericProperty->IsEnum())
                return ValidateEnum(NumericProperty, NumericProperty->GetIntPropertyEnum());
            if (NumericProperty->IsFloatingPoint())
            {
                double Number = 0.0;
                if (Value->Type != EJson::Number
                    || !Value->TryGetNumber(Number)
                    || !FMath::IsFinite(Number)
                    || !NumericProperty->CanHoldValue(Number))
                {
                    OutReason = TEXT("must be a finite JSON number in the property's range");
                    return false;
                }
                return true;
            }
            if (NumericProperty->IsInteger())
            {
                if (IsUnsignedIntegerProperty(NumericProperty))
                {
                    uint64 Unsigned = 0;
                    if (Value->Type == EJson::String)
                    {
                        if (!TryParseCanonicalUnsignedDecimal(
                                Value->AsString(), Unsigned))
                        {
                            OutReason = TEXT("must be an exact unsigned 64-bit decimal string");
                            return false;
                        }
                    }
                    else
                    {
                        double Number = 0.0;
                        if (Value->Type != EJson::Number
                            || !Value->TryGetNumber(Number)
                            || !FMath::IsFinite(Number)
                            || FMath::TruncToDouble(Number) != Number
                            || Number < 0.0
                            || Number > static_cast<double>(MaxExactJsonInteger))
                        {
                            OutReason = TEXT("must be an exact non-negative integral JSON number or unsigned decimal string");
                            return false;
                        }
                        Unsigned = static_cast<uint64>(Number);
                    }
                    if (!NumericProperty->CanHoldValue(Unsigned))
                    {
                        OutReason = TEXT("is outside the unsigned integer property's range");
                        return false;
                    }
                    return true;
                }
                int64 Signed = 0;
                if (Value->Type == EJson::String)
                {
                    const FString NumberString = Value->AsString();
                    if (!TryParseCanonicalSignedDecimal(NumberString, Signed))
                    {
                        OutReason = TEXT("must be an exact signed 64-bit decimal string");
                        return false;
                    }
                }
                else
                {
                    double Number = 0.0;
                    if (Value->Type != EJson::Number
                        || !Value->TryGetNumber(Number)
                        || !FMath::IsFinite(Number)
                        || FMath::TruncToDouble(Number) != Number
                        || Number < -static_cast<double>(MaxExactJsonInteger)
                        || Number > static_cast<double>(MaxExactJsonInteger))
                    {
                        OutReason = TEXT("must be an exact integral JSON number or signed decimal string");
                        return false;
                    }
                    Signed = static_cast<int64>(Number);
                }
                if (!NumericProperty->CanHoldValue(Signed))
                {
                    OutReason = TEXT("is outside the integer property's range");
                    return false;
                }
                return true;
            }
            OutReason = TEXT("uses an unknown numeric representation");
            return false;
        }
        if (Property->IsA<FBoolProperty>())
        {
            if (Value->Type != EJson::Boolean)
            {
                OutReason = TEXT("must be a JSON boolean");
                return false;
            }
            return true;
        }
        if (Property->IsA<FStrProperty>())
        {
            if (Value->Type != EJson::String
                || Value->AsString().Len() > MaxReflectionStringChars)
            {
                OutReason = TEXT("must be a JSON string no longer than the 16384-character readback limit");
                return false;
            }
            return true;
        }
        if (Property->IsA<FNameProperty>())
        {
            if (Value->Type != EJson::String
                || !IsBoundedNameLikeString(Value->AsString()))
            {
                OutReason = TEXT("must be a non-empty control-free string of at most 256 characters");
                return false;
            }
            return true;
        }
        OutReason = TEXT("does not match an audited scalar property type");
        return false;
    }

    static bool AssignAuditedScalarValue(
        FProperty* Property,
        const TSharedPtr<FJsonValue>& Value,
        void* Destination,
        FString& OutReason)
    {
        // ValidateMutationPropertyGraph has already required an exact engine
        // field class and ValidateMutationValueForProperty has checked the JSON
        // kind/range. These setters avoid JsonValueToUProperty's generic
        // ImportText_Direct fallback entirely.
        if (FEnumProperty* EnumProperty = CastField<FEnumProperty>(Property))
        {
            FNumericProperty* Underlying = EnumProperty->GetUnderlyingProperty();
            UEnum* Enum = EnumProperty->GetEnum();
            if (!Underlying || !Enum) return false;
            int64 EnumValue = 0;
            if (Value->Type == EJson::String)
            {
                if (!ResolveAuditedEnumString(
                        Enum, Value->AsString(), EnumValue, OutReason))
                    return false;
            }
            else
            {
                EnumValue = static_cast<int64>(Value->AsNumber());
            }
            if (IsUnsignedIntegerProperty(Underlying))
                Underlying->SetIntPropertyValue(Destination, static_cast<uint64>(EnumValue));
            else
                Underlying->SetIntPropertyValue(Destination, EnumValue);
            return true;
        }
        if (FNumericProperty* NumericProperty = CastField<FNumericProperty>(Property))
        {
            if (NumericProperty->IsEnum())
            {
                UEnum* Enum = NumericProperty->GetIntPropertyEnum();
                if (!Enum) return false;
                int64 EnumValue = 0;
                if (Value->Type == EJson::String)
                {
                    if (!ResolveAuditedEnumString(
                            Enum, Value->AsString(), EnumValue, OutReason))
                        return false;
                }
                else
                {
                    EnumValue = static_cast<int64>(Value->AsNumber());
                }
                if (IsUnsignedIntegerProperty(NumericProperty))
                    NumericProperty->SetIntPropertyValue(
                        Destination, static_cast<uint64>(EnumValue));
                else
                    NumericProperty->SetIntPropertyValue(Destination, EnumValue);
                return true;
            }
            if (NumericProperty->IsFloatingPoint())
            {
                NumericProperty->SetFloatingPointPropertyValue(
                    Destination, Value->AsNumber());
                return true;
            }
            if (IsUnsignedIntegerProperty(NumericProperty))
            {
                uint64 UnsignedValue = 0;
                if (Value->Type == EJson::String)
                {
                    if (!TryParseCanonicalUnsignedDecimal(
                            Value->AsString(), UnsignedValue))
                        return false;
                }
                else
                {
                    UnsignedValue = static_cast<uint64>(Value->AsNumber());
                }
                NumericProperty->SetIntPropertyValue(Destination, UnsignedValue);
                return true;
            }
            int64 SignedValue = 0;
            if (Value->Type == EJson::String)
            {
                if (!TryParseCanonicalSignedDecimal(Value->AsString(), SignedValue))
                    return false;
            }
            else
            {
                SignedValue = static_cast<int64>(Value->AsNumber());
            }
            NumericProperty->SetIntPropertyValue(Destination, SignedValue);
            return true;
        }
        if (FBoolProperty* BoolProperty = CastField<FBoolProperty>(Property))
        {
            BoolProperty->SetPropertyValue(Destination, Value->AsBool());
            return true;
        }
        if (FStrProperty* StringProperty = CastField<FStrProperty>(Property))
        {
            StringProperty->SetPropertyValue(Destination, Value->AsString());
            return true;
        }
        if (FNameProperty* NameProperty = CastField<FNameProperty>(Property))
        {
            NameProperty->SetPropertyValue(Destination, FName(*Value->AsString()));
            return true;
        }
        OutReason = TEXT("property type escaped the exact scalar allowlist");
        return false;
    }
}

#if WITH_DEV_AUTOMATION_TESTS
namespace HaybaMCPDataAssetTestHooks
{
    bool IsReflectionTraversalBounded(
        int32 Num,
        int32 MaxIndex,
        const TCHAR* Kind,
        FString& OutReason)
    {
        HaybaMCPDataAssetHelpers::FReflectionBudget Budget;
        const bool bAllowed =
            HaybaMCPDataAssetHelpers::ValidateReflectionContainerBounds(
                Num, MaxIndex, Kind, Budget);
        OutReason = Budget.FirstLimitReason;
        return bAllowed;
    }

    bool ParseExactUnsignedDecimal(const FString& Text, uint64& OutValue)
    {
        return HaybaMCPDataAssetHelpers::TryParseCanonicalUnsignedDecimal(
            Text, OutValue);
    }

    bool ResolveEnumString(
        const UEnum* Enum,
        const FString& Text,
        int64& OutValue,
        FString& OutReason)
    {
        return HaybaMCPDataAssetHelpers::ResolveAuditedEnumString(
            Enum, Text, OutValue, OutReason);
    }
}
#endif

// ---------- handler ----------

FHaybaHandlerResult FHaybaMCPDataAssetHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& P)
{
    using namespace HaybaMCPDataAssetHelpers;

    // ---------- data_create ----------
    if (Cmd == TEXT("data_create"))
    {
        // Parse and bound every attacker-controlled string before any path
        // concatenation, object/class lookup, module load, or asset mutation.
        FHaybaParamReader R(P, TEXT("data_create"));
        const FString PackagePath = R.RequiredGamePath(TEXT("path"), MaxDataAssetPathChars);
        const FString AssetName = R.RequiredString(TEXT("name"), MaxDataAssetNameChars);
        const FString ClassName = R.RequiredString(TEXT("class_name"), MaxDataAssetClassChars);
        if (!PackagePath.IsEmpty() && !FPackageName::IsValidLongPackageName(PackagePath))
        {
            R.AddError(TEXT("'path' must name a /Game content folder, not an object path"));
        }
        if (!AssetName.IsEmpty() && !IsSafeAssetName(AssetName))
        {
            R.AddError(TEXT("'name' must contain only letters, numbers, or underscores; control characters and separators are not allowed"));
        }
        if (!ClassName.IsEmpty() && !IsSafeClassReference(ClassName))
        {
            R.AddError(TEXT("'class_name' must be a bounded short class name, Module.Class, or /Game or /Script class path without control characters or traversal"));
        }
        if (R.HasErrors())
            return FHaybaHandlerResult::Err(R.ErrorMessage());

        const FString IntendedPackage = PackagePath / AssetName;
        if (!(PackagePath == TEXT("/Game") || PackagePath.StartsWith(TEXT("/Game/")))
            || !FPackageName::IsValidLongPackageName(IntendedPackage))
        {
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("data_create: target must resolve to a valid package under /Game; got '%s'. Nothing was created."),
                *IntendedPackage));
        }

        // Refuse a taken name instead of letting CreateAsset raise a modal
        // overwrite dialog, which would block the game thread and hang every
        // queued MCP request. See HaybaMCPAssetGuard.h.
        if (HaybaAssetGuard::AssetNameTaken(PackagePath, AssetName))
        {
            return FHaybaHandlerResult::Err(
                HaybaAssetGuard::NameTakenError(TEXT("data_create"), PackagePath, AssetName));
        }

        FString CreatedObjectPath;
        FString CreatedClassPath;
        TWeakObjectPtr<UObject> CreatedWeak;
        {
            // No class/asset/module pointer from creation may cross the dirty
            // broadcast below. Capture stable identity strings and a weak
            // reachability check, then end this scope first.
            UClass* Class = ResolveClass(ClassName);
            if (!Class)
                return FHaybaHandlerResult::Err(FString::Printf(
                    TEXT("data_create: class not found: %s"), *ClassName));

            if (!Class->IsChildOf(UDataAsset::StaticClass())
                || Class->HasAnyClassFlags(
                    CLASS_Abstract | CLASS_Deprecated | CLASS_NewerVersionExists
                    | CLASS_Transient))
                return FHaybaHandlerResult::Err(FString::Printf(
                    TEXT("data_create: class %s must be a current, persistent, non-deprecated, concrete UDataAsset subclass; nothing was created"), *ClassName));

            FAssetToolsModule* AssetToolsModule =
                FModuleManager::LoadModulePtr<FAssetToolsModule>(TEXT("AssetTools"));
            if (!AssetToolsModule)
                return FHaybaHandlerResult::Err(TEXT("data_create: AssetTools module is unavailable; nothing was created"));
            IAssetTools& AssetTools = AssetToolsModule->Get();

            UObject* NewAsset = AssetTools.CreateAsset(
                AssetName, PackagePath, Class, nullptr);
            if (!NewAsset)
                return FHaybaHandlerResult::Err(TEXT("data_create: CreateAsset failed"));

            CreatedObjectPath = NewAsset->GetPathName();
            CreatedClassPath = NewAsset->GetClass()->GetPathName();
            CreatedWeak = NewAsset;
        }

        // MarkPackageDirty broadcasts arbitrary callbacks. The pointer used to
        // enter it is not inspected after the call returns.
        bool bDirtyMarked = false;
        {
            UObject* DirtyTarget = CreatedWeak.Get();
            if (DirtyTarget
                && DirtyTarget->GetPathName() == CreatedObjectPath
                && DirtyTarget->GetClass()->GetPathName() == CreatedClassPath)
            {
                bDirtyMarked = DirtyTarget->MarkPackageDirty();
            }
        }

        // Re-resolve immediately before saving. SaveLoadedAsset can itself run
        // editor callbacks, so its raw argument is never dereferenced after the
        // call and a second resolution supplies every response fact.
        bool bPreSaveReResolved = false;
        bool bSaveAttempted = false;
        bool bSaved = false;
        {
            UObject* SaveTarget = LoadObject<UObject>(nullptr, *CreatedObjectPath);
            if (SaveTarget
                && SaveTarget->IsA<UDataAsset>()
                && SaveTarget->GetClass()->GetPathName() == CreatedClassPath
                && !SaveTarget->GetClass()->HasAnyClassFlags(
                    CLASS_Abstract | CLASS_Deprecated | CLASS_NewerVersionExists
                    | CLASS_Transient))
            {
                bPreSaveReResolved = true;
                bSaveAttempted = true;
                bSaved = UEditorAssetLibrary::SaveLoadedAsset(
                    SaveTarget, /*bOnlyIfDirty*/false);
            }
        }

        bool bTargetReResolved = false;
        bool bDirtyKnown = false;
        bool bDirty = false;
        {
            UObject* ObservedAsset = LoadObject<UObject>(
                nullptr, *CreatedObjectPath);
            if (ObservedAsset
                && ObservedAsset->IsA<UDataAsset>()
                && ObservedAsset->GetClass()->GetPathName() == CreatedClassPath
                && !ObservedAsset->GetClass()->HasAnyClassFlags(
                    CLASS_Abstract | CLASS_Deprecated | CLASS_NewerVersionExists
                    | CLASS_Transient))
            {
                bTargetReResolved = true;
                UPackage* ObservedPackage = ObservedAsset->GetOutermost();
                bDirtyKnown = ObservedPackage != nullptr;
                bDirty = ObservedPackage && ObservedPackage->IsDirty();
            }
        }

        const bool bOutcomeTrustworthy = bDirtyMarked
            && bPreSaveReResolved
            && bSaveAttempted
            && bSaved
            && bTargetReResolved
            && bDirtyKnown;

        auto Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("path"), CreatedObjectPath);
        Out->SetStringField(TEXT("class"), CreatedClassPath);
        Out->SetStringField(TEXT("name"), AssetName);
        Out->SetBoolField(TEXT("create_call_succeeded"), true);
        Out->SetBoolField(TEXT("dirty_marked"), bDirtyMarked);
        Out->SetBoolField(TEXT("pre_save_re_resolved"), bPreSaveReResolved);
        Out->SetBoolField(TEXT("save_attempted"), bSaveAttempted);
        if (bSaveAttempted) Out->SetBoolField(TEXT("saved"), bSaved);
        Out->SetBoolField(TEXT("target_re_resolved"), bTargetReResolved);
        Out->SetBoolField(TEXT("dirty_known"), bDirtyKnown);
        if (bDirtyKnown) Out->SetBoolField(TEXT("dirty"), bDirty);
        Out->SetBoolField(TEXT("ok"), bOutcomeTrustworthy);
        if (!bOutcomeTrustworthy)
        {
            Out->SetStringField(TEXT("error"),
                TEXT("data_create_unknown_outcome: creation returned an object, but dirty marking, save identity, persistence, or final re-resolution was not trustworthy; inspect the target path before retrying"));
            Out->SetStringField(TEXT("save_note"),
                TEXT("Do not assume this object was persisted. Inspect dirty_marked, pre_save_re_resolved, save_attempted, saved, and target_re_resolved, then query the exact path before retrying or saving."));
        }
        return FHaybaHandlerResult::Ok(Out);
    }

    // ---------- data_get ----------
    // UEditorAssetLibrary::LoadAsset resolves through the asset registry, which
    // only knows assets that are on disk. A failed/bypassed create save can
    // still leave an object in memory, so LoadObject checks that state before
    // falling back to the registry-backed loader.
    const auto LoadDataAsset = [](const FString& Path) -> UObject*
    {
        if (UObject* InMemory = LoadObject<UObject>(nullptr, *Path)) return InMemory;
        return UEditorAssetLibrary::LoadAsset(Path);
    };

    if (Cmd == TEXT("data_get"))
    {
        FHaybaParamReader R(P, TEXT("data_get"));
        const FString Path = R.RequiredGamePath(TEXT("path"), MaxDataAssetPathChars);
        if (R.HasErrors())
            return FHaybaHandlerResult::Err(R.ErrorMessage());

        UObject* Asset = LoadDataAsset(Path);
        if (!Asset)
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("data_get: could not load %s"), *Path));
        if (!Asset->IsA<UDataAsset>())
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("data_get: %s is a %s, not a UDataAsset; no state was changed"),
                *Path, *Asset->GetClass()->GetName()));

        const FReflectionResult Reflection = ReflectObjectPropertiesBounded(Asset);

        auto Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("path"), Asset->GetPathName());
        Out->SetStringField(TEXT("class"), Asset->GetClass()->GetPathName());
        Out->SetObjectField(TEXT("properties"), Reflection.Properties);
        Out->SetBoolField(TEXT("reflection_complete"),
            !Reflection.Budget.bTruncated
                && Reflection.Budget.UnsupportedValues == 0
                && !Reflection.bPropertyScanLimitHit);
        Out->SetBoolField(TEXT("reflection_truncated"), Reflection.Budget.bTruncated);
        Out->SetNumberField(TEXT("properties_examined"), Reflection.PropertiesExamined);
        Out->SetNumberField(TEXT("properties_returned"), Reflection.PropertiesReturned);
        Out->SetNumberField(TEXT("properties_omitted_at_least"),
            Reflection.PropertiesOmitted + (Reflection.bPropertyScanLimitHit ? 1 : 0));
        Out->SetBoolField(TEXT("omitted_count_exact"), !Reflection.bPropertyScanLimitHit);
        Out->SetNumberField(TEXT("unsupported_values"), Reflection.Budget.UnsupportedValues);
        Out->SetNumberField(TEXT("large_integers_as_strings"),
            Reflection.Budget.IntegerStrings);
        if (!Reflection.Budget.FirstLimitReason.IsEmpty())
            Out->SetStringField(TEXT("reflection_limit_reason"), Reflection.Budget.FirstLimitReason);
        if (Reflection.OmittedPropertyNames.Num() > 0)
        {
            TArray<TSharedPtr<FJsonValue>> Names;
            Names.Reserve(Reflection.OmittedPropertyNames.Num());
            for (const FString& Name : Reflection.OmittedPropertyNames)
                Names.Add(MakeShared<FJsonValueString>(Name));
            Out->SetArrayField(TEXT("omitted_property_names"), MoveTemp(Names));
        }
        TSharedPtr<FJsonObject> Limits = MakeShared<FJsonObject>();
        Limits->SetNumberField(TEXT("max_properties"), MaxReflectedProperties);
        Limits->SetNumberField(TEXT("max_depth"), MaxReflectionDepth);
        Limits->SetNumberField(TEXT("max_nodes"), MaxReflectionNodes);
        Limits->SetNumberField(TEXT("max_container_items"), MaxReflectionContainerItems);
        Limits->SetNumberField(TEXT("max_container_slots"), MaxReflectionContainerSlots);
        Limits->SetNumberField(TEXT("max_fields_per_struct"), MaxReflectionFieldsPerStruct);
        Limits->SetNumberField(TEXT("max_string_chars"), MaxReflectionStringChars);
        Limits->SetNumberField(TEXT("max_total_string_chars"), MaxReflectionTotalStringChars);
        Limits->SetStringField(TEXT("integer_encoding"),
            TEXT("exact JSON numbers through +/-9007199254740991; larger integers are exact decimal strings"));
        Out->SetObjectField(TEXT("reflection_limits"), Limits);
        return FHaybaHandlerResult::Ok(Out);
    }

    // ---------- data_set ----------
    if (Cmd == TEXT("data_set"))
    {
        FHaybaParamReader R(P, TEXT("data_set"));
        const FString Path = R.RequiredGamePath(TEXT("path"), MaxDataAssetPathChars);
        const FString PropertyName =
            R.RequiredString(TEXT("property_name"), MaxDataAssetPropertyNameChars);
        if (!PropertyName.IsEmpty() && !IsSafePropertyName(PropertyName))
            R.AddError(TEXT("'property_name' must contain only letters, numbers, or underscores; control characters and punctuation are not allowed"));

        TSharedPtr<FJsonValue> Value;
        if (R.Raw().IsValid())
        {
            Value = R.Raw()->TryGetField(TEXT("value"));
            if (!Value.IsValid()) R.AddError(TEXT("'value' is required"));
        }
        if (R.HasErrors())
            return FHaybaHandlerResult::Err(R.ErrorMessage());

        int32 JsonNodes = 0;
        int32 JsonStringChars = 0;
        FString ShapeReason;
        if (!ValidateMutationJsonShape(
                Value, 0, JsonNodes, JsonStringChars, ShapeReason))
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("data_set: value %s; nothing was changed"), *ShapeReason));

        TWeakObjectPtr<UObject> TargetWeak;
        FString TargetObjectPath;
        FString TargetClassPath;
        TSharedPtr<FJsonValue> IntendedValue;

        // Every UObject/FProperty pointer and every property-owned temporary is
        // confined to this scope. MarkPackageDirty broadcasts arbitrary editor
        // callbacks, so none of them may survive to be dereferenced—or have a
        // non-trivial destructor run—after that callback boundary.
        {
        UObject* Asset = LoadDataAsset(Path);
        if (!Asset)
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("data_set: could not load %s"), *Path));
        if (!Asset->IsA<UDataAsset>())
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("data_set: %s is a %s, not a UDataAsset; nothing was changed"),
                *Path, *Asset->GetClass()->GetName()));

        UClass* Class = Asset->GetClass();
        if (Class->HasAnyClassFlags(
                CLASS_Abstract | CLASS_Deprecated | CLASS_NewerVersionExists
                | CLASS_Transient))
        {
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("data_set: %s uses an abstract, transient, deprecated, or superseded DataAsset class; refusing to construct staging state; nothing was changed"),
                *Path));
        }
        FProperty* Prop = FindFProperty<FProperty>(Class, *PropertyName);
        if (!Prop)
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("data_set: property %s not found on %s"),
                *PropertyName, *Class->GetName()));
        if (!Prop->HasAnyPropertyFlags(CPF_Edit)
            || Prop->HasAnyPropertyFlags(
                CPF_EditConst | CPF_Transient | CPF_Deprecated | CPF_SkipSerialization))
        {
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("data_set: property %s (%s) is not a mutable persisted editor property; nothing was changed"),
                *PropertyName, *Prop->GetClass()->GetName()));
        }

        int32 PropertyGraphNodes = 0;
        FString PropertyGraphReason;
        if (!ValidateMutationPropertyGraph(
                Prop, 0, PropertyGraphNodes, PropertyGraphReason))
        {
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("data_set: property %s (%s) is not supported by the crash-safe converter because it %s; nothing was changed"),
                *PropertyName,
                *Prop->GetClass()->GetName(),
                *PropertyGraphReason));
        }

        int32 CompatibilityNodes = 0;
        FString CompatibilityReason;
        if (!ValidateMutationValueForProperty(
                Prop, Value, 0, CompatibilityNodes, CompatibilityReason))
        {
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("data_set: value for property %s (%s) %s; conversion was not entered and nothing was changed"),
                *PropertyName,
                *Prop->GetClass()->GetName(),
                *CompatibilityReason));
        }

        if (Prop->GetSize() <= 0 || Prop->GetSize() > MaxMutationStagingBytes)
        {
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("data_set: property %s requires %d bytes of inline staging storage; maximum is %d and nothing was changed"),
                *PropertyName,
                Prop->GetSize(),
                MaxMutationStagingBytes));
        }

        // CopyCompleteValue can duplicate the current live string. Bound that
        // scalar before the copy, not after it. Complex containers and structs
        // were already refused by the graph gate above.
        const void* LiveValuePtr = Prop->ContainerPtrToValuePtr<void>(Asset);
        FReflectionBudget ExistingValueBudget;
        TSharedPtr<FJsonValue> ExistingValueProbe;
        if (!ReflectPropertyValueBounded(
                Prop,
                LiveValuePtr,
                0,
                ExistingValueBudget,
                ExistingValueProbe)
            || ExistingValueBudget.UnsupportedValues > 0)
        {
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("data_set: existing value of property %s exceeds the crash-safe staging budget (%s); conversion was not entered and nothing was changed"),
                *PropertyName,
                ExistingValueBudget.FirstLimitReason.IsEmpty()
                    ? TEXT("unsupported existing value")
                    : *ExistingValueBudget.FirstLimitReason));
        }

        // Stage only the selected audited scalar. Constructing an entire
        // untrusted DataAsset subclass—or even initializing a user-defined
        // struct—can run constructor/default-copy hooks before conversion.
        // FDefaultConstructedPropertyElement is safe here because the graph gate
        // above admits only bounded scalar property implementations.
        FDefaultConstructedPropertyElement StagedValue(Prop);
        void* StagedValuePtr = StagedValue.GetObjAddress();
        Prop->CopyCompleteValue(StagedValuePtr, LiveValuePtr);
        FString AssignmentReason;
        const bool bOk = AssignAuditedScalarValue(
            Prop, Value, StagedValuePtr, AssignmentReason);

        if (!bOk)
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("data_set: direct scalar assignment failed for property %s (%s): %s; the live asset was not changed"),
                *PropertyName,
                *Prop->GetClass()->GetName(),
                AssignmentReason.IsEmpty() ? TEXT("unsupported exact scalar") : *AssignmentReason));

        FReflectionBudget IntendedBudget;
        if (!ReflectPropertyValueBounded(
                Prop, StagedValuePtr, 0, IntendedBudget, IntendedValue))
        {
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("data_set: staged value for property %s could not be captured within the readback budget (%s); the live asset was not changed"),
                *PropertyName,
                IntendedBudget.FirstLimitReason.IsEmpty()
                    ? TEXT("unsupported staged value")
                    : *IntendedBudget.FirstLimitReason));
        }

        // Execute without Modify(), PreEditChange, PostEditChangeProperty, or
        // an implicit save. Capture only bounded value data and identity that
        // remains safe after the later dirty-notification callback.
        TargetWeak = Asset;
        TargetObjectPath = Asset->GetPathName();
        TargetClassPath = Class->GetPathName();
        void* LiveMutableValuePtr = Prop->ContainerPtrToValuePtr<void>(Asset);
        Prop->CopyCompleteValue(LiveMutableValuePtr, StagedValuePtr);
        }

        // This call can broadcast PackageMarkedDirtyEvent and run arbitrary
        // callbacks that unload, reinstance, or mutate the target. The raw
        // pointer is used only to enter the call and is never dereferenced after
        // it returns. All staged/property-owned state was destroyed above.
        bool bDirtyMarked = false;
        {
            UObject* DirtyTarget = TargetWeak.Get();
            if (DirtyTarget
                && DirtyTarget->GetPathName() == TargetObjectPath
                && DirtyTarget->GetClass()->GetPathName() == TargetClassPath)
            {
                bDirtyMarked = DirtyTarget->MarkPackageDirty();
            }
        }

        // Resolve from stable path identity after the broadcast. Never trust the
        // pre-callback UObject, UClass, FProperty, value pointer, or verification.
        bool bTargetReResolved = false;
        bool bVerified = false;
        bool bDirtyKnown = false;
        bool bDirty = false;
        FReflectionBudget ObservedBudget;
        TSharedPtr<FJsonValue> Observed;
        {
            UObject* ObservedAsset = LoadDataAsset(TargetObjectPath);
            if (!ObservedAsset)
            {
                ObservedBudget.Refuse(TEXT("the target could not be re-resolved after dirty notification"));
            }
            else if (!ObservedAsset->IsA<UDataAsset>()
                || ObservedAsset->GetClass()->GetPathName() != TargetClassPath)
            {
                ObservedBudget.Refuse(TEXT("the target class changed during dirty notification"));
            }
            else
            {
                UPackage* ObservedPackage = ObservedAsset->GetOutermost();
                bDirtyKnown = ObservedPackage != nullptr;
                bDirty = ObservedPackage && ObservedPackage->IsDirty();

                UClass* ObservedClass = ObservedAsset->GetClass();
                FProperty* ObservedProp =
                    FindFProperty<FProperty>(ObservedClass, *PropertyName);
                int32 ObservedGraphNodes = 0;
                FString ObservedGraphReason;
                if (ObservedClass->HasAnyClassFlags(
                        CLASS_Abstract | CLASS_Deprecated | CLASS_NewerVersionExists
                        | CLASS_Transient)
                    || !ObservedProp
                    || !ObservedProp->HasAnyPropertyFlags(CPF_Edit)
                    || ObservedProp->HasAnyPropertyFlags(
                        CPF_EditConst | CPF_Transient | CPF_Deprecated | CPF_SkipSerialization)
                    || !ValidateMutationPropertyGraph(
                        ObservedProp, 0, ObservedGraphNodes, ObservedGraphReason))
                {
                    ObservedBudget.Refuse(TEXT("the property schema changed during dirty notification"));
                }
                else
                {
                    bTargetReResolved = true;
                    if (ReflectPropertyValueBounded(
                            ObservedProp,
                            ObservedProp->ContainerPtrToValuePtr<void>(ObservedAsset),
                            0,
                            ObservedBudget,
                            Observed))
                    {
                        bVerified = IntendedValue.IsValid()
                            && Observed.IsValid()
                            && FJsonValue::CompareEqual(*IntendedValue, *Observed);
                    }
                }
            }
        }

        const bool bOutcomeTrustworthy = bTargetReResolved
            && bVerified
            && bDirtyMarked
            && bDirtyKnown
            && bDirty;
        auto Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("path"), TargetObjectPath);
        Out->SetStringField(TEXT("property"), PropertyName);
        Out->SetBoolField(TEXT("copy_completed"), true);
        Out->SetBoolField(TEXT("ok"), bOutcomeTrustworthy);
        if (!bOutcomeTrustworthy)
        {
            Out->SetStringField(TEXT("error"),
                TEXT("data_set_unknown_outcome: scalar copy completed, but final target re-resolution, verification, or dirty marking was not trustworthy; read back the target before retrying or saving"));
        }
        Out->SetBoolField(TEXT("verified"), bVerified);
        Out->SetBoolField(TEXT("target_re_resolved"), bTargetReResolved);
        Out->SetBoolField(TEXT("dirty_marked"), bDirtyMarked);
        Out->SetBoolField(TEXT("save_requested"), false);
        Out->SetBoolField(TEXT("dirty_known"), bDirtyKnown);
        if (bDirtyKnown) Out->SetBoolField(TEXT("dirty"), bDirty);
        if (Observed.IsValid())
        {
            Out->SetField(TEXT("observed_value"), Observed);
        }
        else
        {
            Out->SetBoolField(TEXT("observed_value_omitted"), true);
            Out->SetStringField(TEXT("observed_value_reason"),
                ObservedBudget.FirstLimitReason.IsEmpty()
                    ? TEXT("the value is not supported by bounded reflection")
                    : ObservedBudget.FirstLimitReason);
        }
        Out->SetBoolField(TEXT("observed_value_truncated"), ObservedBudget.bTruncated);
        Out->SetNumberField(TEXT("observed_value_nodes"), ObservedBudget.Nodes);
        Out->SetNumberField(TEXT("observed_value_string_chars"), ObservedBudget.StringChars);
        Out->SetNumberField(TEXT("observed_value_unsupported_values"),
            ObservedBudget.UnsupportedValues);
        Out->SetNumberField(TEXT("observed_value_large_integers_as_strings"),
            ObservedBudget.IntegerStrings);
        if (!bVerified)
        {
            Out->SetStringField(TEXT("warning"),
                TEXT("Direct scalar readback did not match the staged value. Treat the outcome as unknown; inspect observed_value and do not retry blindly."));
        }
        Out->SetStringField(TEXT("persistence_tip"),
            !bOutcomeTrustworthy
                ? TEXT("The scalar was copied, but final identity, verification, or dirty state was not trustworthy. Do not assume asset_save can persist it; inspect target_re_resolved, dirty_marked, dirty_known, dirty, and observed_value first.")
                : TEXT("The verified scalar edit is memory-only. Call asset_save explicitly after reviewing observed_value; closing the editor first discards it."));
        return FHaybaHandlerResult::Ok(Out);
    }

    return FHaybaHandlerResult::Err(FString::Printf(
        TEXT("DataAssetHandler: unknown command %s"), *Cmd));
}
