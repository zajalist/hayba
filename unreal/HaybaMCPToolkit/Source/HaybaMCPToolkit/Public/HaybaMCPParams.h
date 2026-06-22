#pragma once

// Tiny, header-only typed param-extraction helpers over a TSharedPtr<FJsonObject>.
// These are thin wrappers over the FJsonObject TryGet* methods so handlers can
// read params ergonomically. They preserve the exact semantics of the underlying
// TryGet* calls (return false on missing/wrong-type, leave Out untouched).
#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

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
        return Obj.IsValid() && Obj->TryGetNumberField(Key, Out);
    }

    // Thin wrapper over TryGetBoolField.
    inline bool GetBool(const TSharedPtr<FJsonObject>& Obj, const TCHAR* Key, bool& Out)
    {
        return Obj.IsValid() && Obj->TryGetBoolField(Key, Out);
    }

    // Reads a 3-element JSON number array into an FVector. Returns false (Out
    // untouched) unless the field is an array with at least 3 numeric entries.
    inline bool GetVec3(const TSharedPtr<FJsonObject>& Obj, const TCHAR* Key, FVector& Out)
    {
        if (!Obj.IsValid()) return false;
        const TArray<TSharedPtr<FJsonValue>>* Arr = nullptr;
        if (!Obj->TryGetArrayField(Key, Arr) || !Arr || Arr->Num() < 3) return false;
        Out = FVector(
            (*Arr)[0]->AsNumber(),
            (*Arr)[1]->AsNumber(),
            (*Arr)[2]->AsNumber());
        return true;
    }
}
