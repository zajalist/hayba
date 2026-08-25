#pragma once

// Typed param extraction for command handlers.
//
// The thin GetString/GetNumber/GetBool helpers below are 1:1 wrappers over the
// FJsonObject TryGet* methods. They are kept because existing handlers use
// them, but they are the reason this header was ignored: wrapping a call in a
// call of the same shape saves nobody anything, so 549 sites went straight to
// TryGet*Field and each re-invented the same three things —
//
//   1. the missing-required-field error string, in a slightly different format
//      every time ("x is required", "missing x", "<cmd>: missing x");
//   2. one-at-a-time reporting, so a caller who got three params wrong had to
//      make three round trips to find that out;
//   3. defaults, spelled as an uninitialised local plus an ignored return.
//
// FHaybaParamReader does those three things once. It accumulates failures
// rather than returning on the first, so a handler validates everything and
// reports it together.

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "Misc/PackageName.h"

namespace HaybaParams
{
    // Thin wrapper over TryGetStringField. Returns false (Out untouched) if the
    // object is null or the field is missing / not a string.
    inline bool GetString(const TSharedPtr<FJsonObject>& Obj, const TCHAR* Key, FString& Out)
    {
        return Obj.IsValid() && Obj->TryGetStringField(Key, Out);
    }

    // Thin wrapper over TryGetNumberField.
    inline bool GetNumber(const TSharedPtr<FJsonObject>& Obj, const TCHAR* Key, double& Out)
    {
        return Obj.IsValid() && Obj->TryGetNumberField(Key, Out) && FMath::IsFinite(Out);
    }

    // Thin wrapper over TryGetBoolField.
    inline bool GetBool(const TSharedPtr<FJsonObject>& Obj, const TCHAR* Key, bool& Out)
    {
        return Obj.IsValid() && Obj->TryGetBoolField(Key, Out);
    }

    // Reads an exact 3-element JSON number array into an FVector. Returns false
    // (Out untouched) for extra components or any non-finite/non-number entry.
    inline bool GetVec3(const TSharedPtr<FJsonObject>& Obj, const TCHAR* Key, FVector& Out)
    {
        if (!Obj.IsValid()) return false;
        const TArray<TSharedPtr<FJsonValue>>* Arr = nullptr;
        if (!Obj->TryGetArrayField(Key, Arr) || !Arr || Arr->Num() != 3) return false;
        double X = 0.0, Y = 0.0, Z = 0.0;
        if (!(*Arr)[0].IsValid() || !(*Arr)[0]->TryGetNumber(X) || !FMath::IsFinite(X)
            || !(*Arr)[1].IsValid() || !(*Arr)[1]->TryGetNumber(Y) || !FMath::IsFinite(Y)
            || !(*Arr)[2].IsValid() || !(*Arr)[2]->TryGetNumber(Z) || !FMath::IsFinite(Z))
        {
            return false;
        }
        Out = FVector(X, Y, Z);
        return true;
    }
}

/**
 * Reads a command's params, collecting every problem instead of stopping at
 * the first.
 *
 * Usage mirrors how handlers already read params, minus the error plumbing:
 *
 *     FHaybaParamReader R(Params, TEXT("ui_set_brush"));
 *     const FString Path = R.RequiredString(TEXT("widget_blueprint_path"));
 *     const FString Name = R.RequiredString(TEXT("widget_name"));
 *     const double  Size = R.OptionalNumber(TEXT("size"), 12.0);
 *     if (R.HasErrors()) return FHaybaHandlerResult::Err(R.ErrorMessage());
 *
 * A caller who omitted two fields is told about both, once — rather than
 * fixing one, re-sending, and learning about the next.
 */
class FHaybaParamReader
{
public:
    FHaybaParamReader(const TSharedPtr<FJsonObject>& InParams, const FString& InCommandName)
        : Params(InParams), CommandName(InCommandName)
    {
        if (!Params.IsValid())
        {
            // A null params object is not "every field missing" — say the one
            // true thing rather than listing every field the handler asks for.
            Errors.Add(TEXT("no params object was supplied"));
            bParamsMissing = true;
        }
    }

    FString RequiredString(const TCHAR* Key, int32 MaxChars = 256 * 1024)
    {
        FString Out;
        if (!bParamsMissing && !Params->HasField(Key))
        {
            Missing(Key, TEXT("string"));
        }
        else if (!bParamsMissing && !Params->TryGetStringField(Key, Out))
        {
            WrongKind(Key, TEXT("string"));
        }
        else if (!bParamsMissing && Out.IsEmpty())
        {
            // An empty string is the shape of a caller that built the value and
            // got nothing, which fails later and further away.
            Errors.Add(FString::Printf(TEXT("'%s' is present but empty"), Key));
        }
        else if (!bParamsMissing && (MaxChars < 0 || Out.Len() > MaxChars))
        {
            Errors.Add(FString::Printf(
                TEXT("'%s' is %d characters; maximum is %d"), Key, Out.Len(), FMath::Max(0, MaxChars)));
            Out.Reset();
        }
        return Out;
    }

    double RequiredNumber(const TCHAR* Key)
    {
        double Out = 0.0;
        if (!bParamsMissing && !Params->HasField(Key)) Missing(Key, TEXT("number"));
        else if (!bParamsMissing && !Params->TryGetNumberField(Key, Out))
        {
            WrongKind(Key, TEXT("number"));
        }
        else if (!bParamsMissing && !FMath::IsFinite(Out))
        {
            Errors.Add(FString::Printf(TEXT("'%s' must be finite"), Key));
            Out = 0.0;
        }
        return Out;
    }

    double RequiredNumberInRange(const TCHAR* Key, double Min, double Max)
    {
        const int32 ErrorsBefore = Errors.Num();
        const double Out = RequiredNumber(Key);
        if (Errors.Num() != ErrorsBefore) return Out;
        if (!bParamsMissing && FMath::IsFinite(Out) && (Out < Min || Out > Max))
        {
            Errors.Add(FString::Printf(
                TEXT("'%s' must be between %.17g and %.17g"), Key, Min, Max));
            return FMath::Clamp(0.0, Min, Max);
        }
        return Out;
    }

    int32 RequiredInt(const TCHAR* Key)
    {
        const int32 ErrorsBefore = Errors.Num();
        const double Value = RequiredNumber(Key);
        if (Errors.Num() != ErrorsBefore) return 0;
        if (FMath::FloorToDouble(Value) != Value
            || Value < static_cast<double>(MIN_int32)
            || Value > static_cast<double>(MAX_int32))
        {
            Errors.Add(FString::Printf(
                TEXT("'%s' must be an integer in [%d, %d]; observed %s"),
                Key, MIN_int32, MAX_int32,
                FMath::IsFinite(Value) && FMath::FloorToDouble(Value) != Value
                    ? TEXT("fractional number") : TEXT("out-of-range number")));
            return 0;
        }
        return static_cast<int32>(Value);
    }

    FString OptionalString(
        const TCHAR* Key,
        const FString& Default = FString(),
        int32 MaxChars = 256 * 1024)
    {
        FString Out;
        if (bParamsMissing || !Params->HasField(Key)) return Default;
        if (!Params->TryGetStringField(Key, Out))
        {
            WrongKind(Key, TEXT("string"));
            return Default;
        }
        if (MaxChars < 0 || Out.Len() > MaxChars)
        {
            Errors.Add(FString::Printf(
                TEXT("'%s' is %d characters; maximum is %d"), Key, Out.Len(), FMath::Max(0, MaxChars)));
            return Default;
        }
        return Out;
    }

    double OptionalNumber(const TCHAR* Key, double Default = 0.0)
    {
        double Out = 0.0;
        if (bParamsMissing || !Params->HasField(Key)) return Default;
        if (!Params->TryGetNumberField(Key, Out))
        {
            WrongKind(Key, TEXT("number"));
            return Default;
        }
        if (!FMath::IsFinite(Out))
        {
            Errors.Add(FString::Printf(TEXT("'%s' must be finite"), Key));
            return Default;
        }
        return Out;
    }

    double OptionalNumberInRange(const TCHAR* Key, double Default, double Min, double Max)
    {
        if (bParamsMissing || !Params->HasField(Key)) return Default;
        const int32 ErrorsBefore = Errors.Num();
        const double Out = OptionalNumber(Key, Default);
        if (Errors.Num() != ErrorsBefore) return Default;
        if (Out < Min || Out > Max)
        {
            Errors.Add(FString::Printf(
                TEXT("'%s' must be between %.17g and %.17g"), Key, Min, Max));
            return Default;
        }
        return Out;
    }

    bool OptionalBool(const TCHAR* Key, bool Default = false)
    {
        bool Out = false;
        if (bParamsMissing || !Params->HasField(Key)) return Default;
        if (!Params->TryGetBoolField(Key, Out))
        {
            WrongKind(Key, TEXT("boolean"));
            return Default;
        }
        return Out;
    }

    int32 OptionalInt(const TCHAR* Key, int32 Default = 0)
    {
        if (bParamsMissing || !Params->HasField(Key)) return Default;
        const double Value = OptionalNumber(Key, static_cast<double>(Default));
        if (!FMath::IsFinite(Value)) return Default; // OptionalNumber recorded it.
        if (FMath::FloorToDouble(Value) != Value
            || Value < static_cast<double>(MIN_int32)
            || Value > static_cast<double>(MAX_int32))
        {
            Errors.Add(FString::Printf(
                TEXT("'%s' must be an integer in [%d, %d]; observed %s"),
                Key, MIN_int32, MAX_int32,
                FMath::IsFinite(Value) && FMath::FloorToDouble(Value) != Value
                    ? TEXT("fractional number") : TEXT("out-of-range number")));
            return Default;
        }
        return static_cast<int32>(Value);
    }

    int32 OptionalIntInRange(const TCHAR* Key, int32 Default, int32 Min, int32 Max)
    {
        if (bParamsMissing || !Params->HasField(Key)) return Default;
        const int32 ErrorsBefore = Errors.Num();
        const int32 Out = OptionalInt(Key, Default);
        if (Errors.Num() != ErrorsBefore) return Default;
        if (Out < Min || Out > Max)
        {
            Errors.Add(FString::Printf(
                TEXT("'%s' must be an integer between %d and %d"), Key, Min, Max));
            return Default;
        }
        return Out;
    }

    const TArray<TSharedPtr<FJsonValue>>* OptionalArray(
        const TCHAR* Key,
        int32 MaxItems = 1024,
        int32 MinItems = 0)
    {
        if (bParamsMissing || !Params->HasField(Key)) return nullptr;
        const TArray<TSharedPtr<FJsonValue>>* Found = nullptr;
        if (!Params->TryGetArrayField(Key, Found) || !Found)
        {
            WrongKind(Key, TEXT("array"));
            return nullptr;
        }
        if (MaxItems < 0 || Found->Num() > MaxItems)
        {
            Errors.Add(FString::Printf(
                TEXT("'%s' has %d items; maximum is %d"), Key, Found->Num(), FMath::Max(0, MaxItems)));
            return nullptr;
        }
        if (MinItems < 0 || Found->Num() < MinItems)
        {
            Errors.Add(FString::Printf(
                TEXT("'%s' has %d items; minimum is %d"), Key, Found->Num(), FMath::Max(0, MinItems)));
            return nullptr;
        }
        return Found;
    }

    const TArray<TSharedPtr<FJsonValue>>* RequiredArray(
        const TCHAR* Key,
        int32 MinItems = 1,
        int32 MaxItems = 1024)
    {
        if (!bParamsMissing && !Params->HasField(Key))
        {
            Missing(Key, TEXT("array"));
            return nullptr;
        }
        return OptionalArray(Key, MaxItems, MinItems);
    }

    /** Reads a 3-number array. Unset when the key is absent — which is not the
     *  same as [0,0,0], and callers that conflate the two silently move actors
     *  to the origin. A present-but-malformed value is an error, not an absence. */
    TOptional<FVector> OptionalVec3(const TCHAR* Key)
    {
        if (bParamsMissing) return {};
        if (!Params->HasField(Key)) return {};
        const TArray<TSharedPtr<FJsonValue>>* Arr = nullptr;
        if (!Params->TryGetArrayField(Key, Arr) || !Arr)
        {
            WrongKind(Key, TEXT("array"));
            return {};
        }
        if (Arr->Num() != 3)
        {
            Errors.Add(FString::Printf(
                TEXT("'%s' needs 3 numbers, got %d"), Key, Arr->Num()));
            return {};
        }
        double Components[3] = { 0.0, 0.0, 0.0 };
        bool bValid = true;
        for (int32 Index = 0; Index < 3; ++Index)
        {
            const TSharedPtr<FJsonValue>& Value = (*Arr)[Index];
            if (!Value.IsValid() || Value->Type != EJson::Number
                || !Value->TryGetNumber(Components[Index])
                || !FMath::IsFinite(Components[Index]))
            {
                Errors.Add(FString::Printf(
                    TEXT("'%s[%d]' must be a finite number; observed %s"),
                    Key, Index, *JsonKind(Value)));
                bValid = false;
            }
        }
        if (!bValid) return {};
        return FVector(Components[0], Components[1], Components[2]);
    }

    TOptional<FVector> RequiredVec3(const TCHAR* Key)
    {
        if (bParamsMissing) return {};
        if (!Params->HasField(Key))
        {
            Missing(Key, TEXT("3-number vector"));
            return {};
        }
        return OptionalVec3(Key);
    }

    /** As OptionalVec3, read as [pitch, yaw, roll] — UE's FRotator argument
     *  order, which is not the order the components are declared in. */
    TOptional<FRotator> OptionalRotator(const TCHAR* Key)
    {
        const TOptional<FVector> V = OptionalVec3(Key);
        if (!V.IsSet()) return {};
        return FRotator(V->X, V->Y, V->Z);
    }

    /** Reads a string enum and returns the canonical spelling from Allowed.
     *  Diagnostics enumerate the bounded contract, never the untrusted value. */
    FString RequiredEnum(
        const TCHAR* Key,
        const TArray<FString>& Allowed,
        ESearchCase::Type SearchCase = ESearchCase::IgnoreCase)
    {
        const int32 ErrorsBefore = Errors.Num();
        const FString RawValue = RequiredString(Key, 128);
        if (Errors.Num() != ErrorsBefore) return FString();
        for (const FString& Candidate : Allowed)
        {
            if (RawValue.Equals(Candidate, SearchCase)) return Candidate;
        }
        Errors.Add(FString::Printf(
            TEXT("'%s' must be one of [%s]; observed unrecognized string"),
            Key, *FString::Join(Allowed, TEXT(", "))));
        return FString();
    }

    FString OptionalEnum(
        const TCHAR* Key,
        const FString& Default,
        const TArray<FString>& Allowed,
        ESearchCase::Type SearchCase = ESearchCase::IgnoreCase)
    {
        if (bParamsMissing || !Params->HasField(Key)) return Default;
        const int32 ErrorsBefore = Errors.Num();
        const FString RawValue = OptionalString(Key, Default, 128);
        if (Errors.Num() != ErrorsBefore) return Default;
        for (const FString& Candidate : Allowed)
        {
            if (RawValue.Equals(Candidate, SearchCase)) return Candidate;
        }
        Errors.Add(FString::Printf(
            TEXT("'%s' must be one of [%s]; observed unrecognized string"),
            Key, *FString::Join(Allowed, TEXT(", "))));
        return Default;
    }

    /** A bounded /Game path suitable for package or object lookups. This is a
     *  lexical boundary, not an existence check; handlers still decide whether
     *  package paths, object paths, or folders are meaningful for the command. */
    FString RequiredGamePath(const TCHAR* Key, int32 MaxChars = 1024)
    {
        const int32 ErrorsBefore = Errors.Num();
        FString Value = RequiredString(Key, MaxChars);
        if (Errors.Num() != ErrorsBefore) return FString();
        if (!IsSafeGamePath(Value))
        {
            Errors.Add(FString::Printf(
                TEXT("'%s' must be a bounded /Game path without traversal, backslashes, control characters, or empty segments"),
                Key));
            Value.Reset();
        }
        return Value;
    }

    FString OptionalGamePath(
        const TCHAR* Key,
        const FString& Default = FString(),
        int32 MaxChars = 1024)
    {
        if (bParamsMissing || !Params->HasField(Key)) return Default;
        const int32 ErrorsBefore = Errors.Num();
        FString Value = OptionalString(Key, Default, MaxChars);
        if (Errors.Num() != ErrorsBefore) return Default;
        if (Value.IsEmpty() || !IsSafeGamePath(Value))
        {
            Errors.Add(FString::Printf(
                TEXT("'%s' must be a bounded /Game path without traversal, backslashes, control characters, or empty segments"),
                Key));
            return Default;
        }
        return Value;
    }

    TOptional<FLinearColor> OptionalColor(const TCHAR* Key)
    {
        if (bParamsMissing || !Params->HasField(Key)) return {};
        const TArray<TSharedPtr<FJsonValue>>* Arr = nullptr;
        if (!Params->TryGetArrayField(Key, Arr) || !Arr)
        {
            WrongKind(Key, TEXT("3- or 4-number color array"));
            return {};
        }
        if (Arr->Num() != 3 && Arr->Num() != 4)
        {
            Errors.Add(FString::Printf(
                TEXT("'%s' needs 3 or 4 normalized color components, got %d"), Key, Arr->Num()));
            return {};
        }
        double Components[4] = { 0.0, 0.0, 0.0, 1.0 };
        bool bValid = true;
        for (int32 Index = 0; Index < Arr->Num(); ++Index)
        {
            const TSharedPtr<FJsonValue>& Value = (*Arr)[Index];
            if (!Value.IsValid() || Value->Type != EJson::Number
                || !Value->TryGetNumber(Components[Index])
                || !FMath::IsFinite(Components[Index])
                || Components[Index] < 0.0 || Components[Index] > 1.0)
            {
                Errors.Add(FString::Printf(
                    TEXT("'%s[%d]' must be a finite number in [0, 1]; observed %s"),
                    Key, Index, *JsonKind(Value)));
                bValid = false;
            }
        }
        if (!bValid) return {};
        return FLinearColor(
            Components[0], Components[1], Components[2], Components[3]);
    }

    /** Reads {location:[x,y,z], rotation:[pitch,yaw,roll], scale:[x,y,z]}.
     *  Components are optional, but an empty object is not a transform. */
    TOptional<FTransform> OptionalTransform(const TCHAR* Key)
    {
        if (bParamsMissing || !Params->HasField(Key)) return {};
        const int32 ErrorsBefore = Errors.Num();
        const TSharedPtr<FJsonObject> Object = OptionalObject(Key, 3);
        if (!Object.IsValid()) return {};

        const bool bHasLocation = Object->HasField(TEXT("location"));
        const bool bHasRotation = Object->HasField(TEXT("rotation"));
        const bool bHasScale = Object->HasField(TEXT("scale"));
        const int32 KnownFieldCount = static_cast<int32>(bHasLocation)
            + static_cast<int32>(bHasRotation)
            + static_cast<int32>(bHasScale);
        if (Object->Values.Num() != KnownFieldCount)
        {
            Errors.Add(FString::Printf(
                TEXT("'%s' contains unsupported fields; allowed fields are [location, rotation, scale]"),
                Key));
        }
        if (!bHasLocation && !bHasRotation && !bHasScale)
        {
            Errors.Add(FString::Printf(
                TEXT("'%s' must contain location, rotation, and/or scale"), Key));
            return {};
        }

        const FVector Location = bHasLocation
            ? ReadObjectVec3(Object, TEXT("location"), FString::Printf(TEXT("%s.location"), Key)).Get(FVector::ZeroVector)
            : FVector::ZeroVector;
        const FVector Rotation = bHasRotation
            ? ReadObjectVec3(Object, TEXT("rotation"), FString::Printf(TEXT("%s.rotation"), Key)).Get(FVector::ZeroVector)
            : FVector::ZeroVector;
        const FVector Scale = bHasScale
            ? ReadObjectVec3(Object, TEXT("scale"), FString::Printf(TEXT("%s.scale"), Key)).Get(FVector::OneVector)
            : FVector::OneVector;
        if (Errors.Num() != ErrorsBefore) return {};
        return FTransform(FRotator(Rotation.X, Rotation.Y, Rotation.Z), Location, Scale);
    }

    double RequiredRadius(const TCHAR* Key, double Max)
    {
        return RequiredNumberInRange(Key, 0.0, Max);
    }

    double OptionalRadius(const TCHAR* Key, double Default, double Max)
    {
        return OptionalNumberInRange(Key, Default, 0.0, Max);
    }

    double OptionalDensity(const TCHAR* Key, double Default, double Max)
    {
        return OptionalNumberInRange(Key, Default, 0.0, Max);
    }

    /** Reads a bounded nested object. Absence is unset; null, the wrong type,
     *  or too many fields are errors so malformed input cannot masquerade as an
     *  omitted optional and reach a mutation as a harmless default. */
    TSharedPtr<FJsonObject> OptionalObject(
        const TCHAR* Key,
        int32 MaxFields = 256,
        int32 MinFields = 0)
    {
        if (bParamsMissing || !Params->HasField(Key)) return nullptr;
        const TSharedPtr<FJsonObject>* Found = nullptr;
        if (!Params->TryGetObjectField(Key, Found) || !Found || !Found->IsValid())
        {
            WrongKind(Key, TEXT("object"));
            return nullptr;
        }
        if (MaxFields < 0 || (*Found)->Values.Num() > MaxFields)
        {
            Errors.Add(FString::Printf(
                TEXT("'%s' has %d fields; maximum is %d"),
                Key, (*Found)->Values.Num(), FMath::Max(0, MaxFields)));
            return nullptr;
        }
        if (MinFields < 0 || (*Found)->Values.Num() < MinFields)
        {
            Errors.Add(FString::Printf(
                TEXT("'%s' has %d fields; minimum is %d"),
                Key, (*Found)->Values.Num(), FMath::Max(0, MinFields)));
            return nullptr;
        }
        return *Found;
    }

    TSharedPtr<FJsonObject> RequiredObject(
        const TCHAR* Key,
        int32 MinFields = 1,
        int32 MaxFields = 256)
    {
        if (!bParamsMissing && !Params->HasField(Key))
        {
            Missing(Key, TEXT("object"));
            return nullptr;
        }
        return OptionalObject(Key, MaxFields, MinFields);
    }

    /** The params object itself, for the rare read this class cannot express —
     *  chiefly a field whose *name* is the question (see
     *  HaybaUIOps::ResolveSlotProps). Not a general escape hatch: a read that
     *  belongs here should be added here. Null when no params were supplied. */
    const TSharedPtr<FJsonObject>& Raw() const { return Params; }

    /** Record a problem the reader cannot detect on its own (a value out of
     *  range, a combination that does not make sense). */
    void AddError(const FString& Message) { Errors.Add(Message); }

    bool HasErrors() const { return Errors.Num() > 0; }

    /** One message naming the command and every problem found. */
    FString ErrorMessage() const
    {
        return FString::Printf(TEXT("%s: %s"), *CommandName, *FString::Join(Errors, TEXT("; ")));
    }

private:
    static FString JsonKind(const TSharedPtr<FJsonValue>& Value)
    {
        if (!Value.IsValid()) return TEXT("invalid/null value");
        switch (Value->Type)
        {
        case EJson::Null: return TEXT("null");
        case EJson::String: return TEXT("string");
        case EJson::Boolean: return TEXT("boolean");
        case EJson::Array: return TEXT("array");
        case EJson::Object: return TEXT("object");
        case EJson::Number:
        {
            double Number = 0.0;
            return Value->TryGetNumber(Number) && FMath::IsFinite(Number)
                ? TEXT("number") : TEXT("non-finite number");
        }
        default: return TEXT("unknown JSON kind");
        }
    }

    void WrongKind(const TCHAR* Key, const TCHAR* Expected)
    {
        const TSharedPtr<FJsonValue> Value = Params.IsValid()
            ? Params->TryGetField(Key) : nullptr;
        Errors.Add(FString::Printf(
            TEXT("'%s' must be %s; observed %s"),
            Key, Expected, *JsonKind(Value)));
    }

    static bool IsSafeGamePath(const FString& Value)
    {
        if (!(Value == TEXT("/Game")
                || Value.StartsWith(TEXT("/Game/"), ESearchCase::CaseSensitive))
            || Value.Contains(TEXT("\\"))
            || Value.Contains(TEXT(".."))
            || Value.Contains(TEXT("//"))
            || Value.EndsWith(TEXT("/"))
            || (!FPackageName::IsValidLongPackageName(Value)
                && !FPackageName::IsValidObjectPath(Value)))
        {
            return false;
        }
        for (const TCHAR Ch : Value)
        {
            if (FChar::IsWhitespace(Ch) || FChar::IsControl(Ch)
                || Ch == TEXT('<') || Ch == TEXT('>') || Ch == TEXT('|')
                || Ch == TEXT('?') || Ch == TEXT('*') || Ch == TEXT('"')
                || Ch == TEXT(':') || Ch == TEXT('\'') || Ch == TEXT('%')
                || Ch == TEXT('#'))
            {
                return false;
            }
        }
        return true;
    }

    TOptional<FVector> ReadObjectVec3(
        const TSharedPtr<FJsonObject>& Object,
        const TCHAR* Field,
        const FString& Path)
    {
        const TArray<TSharedPtr<FJsonValue>>* Arr = nullptr;
        if (!Object.IsValid() || !Object->TryGetArrayField(Field, Arr) || !Arr)
        {
            const TSharedPtr<FJsonValue> Value = Object.IsValid()
                ? Object->TryGetField(Field) : nullptr;
            Errors.Add(FString::Printf(
                TEXT("'%s' must be a 3-number array; observed %s"),
                *Path, *JsonKind(Value)));
            return {};
        }
        if (Arr->Num() != 3)
        {
            Errors.Add(FString::Printf(
                TEXT("'%s' needs exactly 3 finite numbers, got %d"),
                *Path, Arr->Num()));
            return {};
        }
        double Components[3] = { 0.0, 0.0, 0.0 };
        bool bValid = true;
        for (int32 Index = 0; Index < 3; ++Index)
        {
            const TSharedPtr<FJsonValue>& Value = (*Arr)[Index];
            if (!Value.IsValid() || Value->Type != EJson::Number
                || !Value->TryGetNumber(Components[Index])
                || !FMath::IsFinite(Components[Index]))
            {
                Errors.Add(FString::Printf(
                    TEXT("'%s[%d]' must be a finite number; observed %s"),
                    *Path, Index, *JsonKind(Value)));
                bValid = false;
            }
        }
        if (!bValid) return {};
        return FVector(Components[0], Components[1], Components[2]);
    }

    void Missing(const TCHAR* Key, const TCHAR* Type)
    {
        Errors.Add(FString::Printf(TEXT("missing required %s '%s'"), Type, Key));
    }

    TSharedPtr<FJsonObject> Params;
    FString CommandName;
    TArray<FString> Errors;
    bool bParamsMissing = false;
};

/**
 * PIE input coordinate spaces.
 *
 * editor_pie_widget_tree reports a widget's position from Slate geometry, which
 * is ABSOLUTE DESKTOP space. editor_pie_mouse used to add the game window's
 * on-screen origin to whatever it was given — correct only if the caller had
 * measured from the window. Feeding it tree coordinates, which the tree's own
 * note told callers to do, therefore double-counted the origin and every click
 * landed low and right by the window's offset.
 *
 * That offset is the window chrome: 24px at 1080p with a title bar, but it is a
 * function of DPI, window position and whether a title bar exists at all — so
 * it must be computed, never assumed. The error is smaller than a large button,
 * which is why it went unnoticed: it only misses on targets under ~48px, like a
 * 33px tab or a 26px text field.
 */
namespace HaybaPieCoords
{
    /**
     * Resolve an input coordinate to the absolute desktop point to click.
     *
     * `WindowOrigin` is the game window's top-left in screen space. It is added
     * ONLY for viewport-relative input; absolute input is already in the space
     * Slate dispatches in and must pass through untouched.
     */
    inline FVector2D ToAbsolute(const FVector2D& Input, const FVector2D& WindowOrigin, bool bViewportRelative)
    {
        return bViewportRelative ? (WindowOrigin + Input) : Input;
    }
}

/**
 * PIE pointer gestures — the pure arithmetic behind a synthetic drag.
 *
 * A Slate widget that tracks a held gesture reads exactly two things off the
 * FPointerEvent it receives on a move: whether the button is still down
 * (FPointerEvent::IsMouseButtonDown) and how far the pointer travelled
 * (FPointerEvent::GetCursorDelta). SScrollBar::OnMouseMove is the reference
 * consumer and is blunt about it:
 *
 *     if (this->HasMouseCapture())
 *         if (!MouseEvent.GetCursorDelta().IsZero())
 *             ... scroll ...
 *     return FReply::Unhandled();
 *
 * A move with a zero delta is therefore not a weak move, it is NO move. This
 * namespace exists so the "is this step actually going to move anything?"
 * question is answered by testable arithmetic instead of by hoping.
 *
 * The quantisation matters and is not incidental: FSlateApplication::SetCursorPos
 * forwards to FSlateUser::SetCursorPosition(int32, int32), which casts. Two
 * waypoints less than a pixel apart therefore land on the same stored position
 * and produce a zero delta no matter what the caller asked for — a 6px drag
 * split into 8 steps is mostly no-ops. PlanDragPath drops those steps rather
 * than dispatching moves that cannot do anything.
 */
namespace HaybaPieGesture
{
    /**
     * The position Slate will actually store for a requested pointer position.
     *
     * Mirrors FSlateUser::SetCursorPosition's `(int32)` cast — truncation toward
     * zero, not floor, because a multi-monitor desktop has negative coordinates
     * to the left of the primary display and the engine truncates there too.
     */
    inline FVector2D QuantiseToPixel(const FVector2D& P)
    {
        return FVector2D((double)(int32)P.X, (double)(int32)P.Y);
    }

    /** The cursor delta Slate will report for a move between two requested points. */
    inline FVector2D DeltaFor(const FVector2D& From, const FVector2D& To)
    {
        return QuantiseToPixel(To) - QuantiseToPixel(From);
    }

    /**
     * The waypoints a drag from Start to End should visit, in order.
     *
     * Every returned point differs from its predecessor by at least one whole
     * pixel, so every dispatched move carries a non-zero cursor delta. The last
     * point is always the destination. A zero-length drag returns an empty path
     * — which is the honest answer, and lets the caller report "0 moves
     * delivered" instead of claiming a gesture it did not perform.
     */
    inline TArray<FVector2D> PlanDragPath(const FVector2D& Start, const FVector2D& End, int32 Steps)
    {
        TArray<FVector2D> Path;
        Steps = FMath::Clamp(Steps, 1, 256);

        FVector2D Last = QuantiseToPixel(Start);
        for (int32 i = 1; i <= Steps; ++i)
        {
            const double T = (double)i / (double)Steps;
            const FVector2D P = QuantiseToPixel(Start + (End - Start) * T);
            if (P.Equals(Last, 0.0)) continue;  // Slate would see a zero delta; skip it.
            Path.Add(P);
            Last = P;
        }

        // Interpolation plus truncation can stop a pixel short of the target.
        // A drag has to finish where the caller said it finishes.
        const FVector2D Destination = QuantiseToPixel(End);
        if (!Destination.Equals(Last, 0.0))
        {
            Path.Add(Destination);
        }
        return Path;
    }
}
