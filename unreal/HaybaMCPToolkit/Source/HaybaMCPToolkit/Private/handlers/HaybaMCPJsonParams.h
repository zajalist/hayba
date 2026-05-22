#pragma once

// ============================================================================
// FHaybaJsonParams
// ----------------------------------------------------------------------------
// A thin, header-only wrapper over TSharedPtr<FJsonObject> that makes MCP
// command-handler parameter extraction terse and centralises error formatting.
//
// Pattern: accumulate-first-error / check-once.
//   - Optional getters (GetString/GetNumber/GetInt/GetBool/GetArray/GetObject)
//     never record errors; they return the supplied default when the field is
//     absent or of the wrong type.
//   - RequireString() records an error ("<field>: required") the FIRST time a
//     required field is missing or empty. Subsequent RequireString failures do
//     NOT overwrite that first error — first missing field wins.
//   - After issuing any number of RequireString() calls, the handler performs a
//     single HasError() check and, if true, returns Error() (a fully-formed
//     FHaybaHandlerResult::Err).
//
// Intended usage in a handler:
//     FHaybaJsonParams Args(P);
//     const FString ClassPath = Args.RequireString(TEXT("class_path"));
//     const FString Name      = Args.RequireString(TEXT("name"));
//     if (Args.HasError()) return Args.Error();
//
// A null underlying FJsonObject is handled defensively: every field is treated
// as absent, optional getters return their defaults, and RequireString records
// the "<field>: required" error.
// ============================================================================

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "IHaybaMCPHandler.h"

class FHaybaJsonParams
{
public:
    explicit FHaybaJsonParams(const TSharedPtr<FJsonObject>& InObj)
        : Obj(InObj)
    {
    }

    /**
     * Required string field. If the field is missing or empty, records the
     * error "<Field>: required" (only if no error has been recorded yet) and
     * returns an empty string.
     */
    FString RequireString(const TCHAR* Field)
    {
        FString Value;
        if (Obj.IsValid() && Obj->TryGetStringField(Field, Value) && !Value.IsEmpty())
        {
            return Value;
        }
        RecordError(FString::Printf(TEXT("%s: required"), Field));
        return FString();
    }

    /**
     * Required numeric field. If the field is missing (or not a number),
     * records the error "<Field>: required" (only if no error has been
     * recorded yet) and returns 0.0.
     */
    double RequireNumber(const TCHAR* Field)
    {
        double Value = 0.0;
        if (Obj.IsValid() && Obj->TryGetNumberField(Field, Value))
        {
            return Value;
        }
        RecordError(FString::Printf(TEXT("%s: required"), Field));
        return 0.0;
    }

    /** Optional string field; returns Default when absent or wrong type. */
    FString GetString(const TCHAR* Field, const FString& Default = FString()) const
    {
        FString Value;
        if (Obj.IsValid() && Obj->TryGetStringField(Field, Value))
        {
            return Value;
        }
        return Default;
    }

    /** Optional numeric field; returns Default when absent or wrong type. */
    double GetNumber(const TCHAR* Field, double Default = 0.0) const
    {
        double Value = Default;
        if (Obj.IsValid() && Obj->TryGetNumberField(Field, Value))
        {
            return Value;
        }
        return Default;
    }

    /** Optional integer field; returns Default when absent or wrong type. */
    int32 GetInt(const TCHAR* Field, int32 Default = 0) const
    {
        int32 Value = Default;
        if (Obj.IsValid() && Obj->TryGetNumberField(Field, Value))
        {
            return Value;
        }
        return Default;
    }

    /** Optional boolean field; returns Default when absent or wrong type. */
    bool GetBool(const TCHAR* Field, bool Default = false) const
    {
        bool Value = Default;
        if (Obj.IsValid() && Obj->TryGetBoolField(Field, Value))
        {
            return Value;
        }
        return Default;
    }

    /** Optional array field; returns nullptr when absent or wrong type. */
    const TArray<TSharedPtr<FJsonValue>>* GetArray(const TCHAR* Field) const
    {
        const TArray<TSharedPtr<FJsonValue>>* OutArray = nullptr;
        if (Obj.IsValid() && Obj->TryGetArrayField(Field, OutArray))
        {
            return OutArray;
        }
        return nullptr;
    }

    /** Optional object field; returns nullptr when absent or wrong type. */
    TSharedPtr<FJsonObject> GetObject(const TCHAR* Field) const
    {
        const TSharedPtr<FJsonObject>* OutObject = nullptr;
        if (Obj.IsValid() && Obj->TryGetObjectField(Field, OutObject) && OutObject)
        {
            return *OutObject;
        }
        return nullptr;
    }

    /** True once any RequireString() call has failed. */
    bool HasError() const
    {
        return bHasError;
    }

    /** Builds the failure result from the first recorded error message. */
    FHaybaHandlerResult Error() const
    {
        return FHaybaHandlerResult::Err(ErrorMessage);
    }

private:
    void RecordError(const FString& Msg)
    {
        if (!bHasError)
        {
            bHasError = true;
            ErrorMessage = Msg;
        }
    }

    TSharedPtr<FJsonObject> Obj;
    bool bHasError = false;
    FString ErrorMessage;
};
