#pragma once

// Generic, UObject-agnostic reflection setters, originally lifted from the
// material handler so other handlers could adopt them. No material-specific
// logic lives here.
//
// The type switch lives in ONE place (SetValueFromJson) and both public entry
// points delegate to it, so struct fields and object properties support the
// same JSON shapes at every nesting depth. That recursion is what makes nested
// UMG styling work: FSlateBrush / FSlateFontInfo / FSlateColor are structs
// whose fields are themselves structs and object refs, e.g.
//
//   { "Brush": { "ResourceObject": "/Game/UI/T_Panel",
//                "TintColor": { "SpecifiedColor": [1,1,1,1] },
//                "ImageSize": { "X": 64, "Y": 64 },
//                "DrawAs": "RoundedBox" } }
//
// Before the recursion existed, a JSON object handed to a struct property was
// rejected outright (returned false), so every nested style edit reported
// "property failed" no matter how well-formed it was.

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "UObject/Object.h"
#include "UObject/UnrealType.h"
#include "UObject/EnumProperty.h"
// FMargin / FSlateColor are handled explicitly in the numeric-array form because
// they are the two Slate layout structs MCP callers send most often.
#include "Layout/Margin.h"
#include "Styling/SlateColor.h"

namespace HaybaReflection
{
    // Set one already-resolved property inside `Container` from a JSON value.
    // `Outer` is the owning UObject when there is one (used as the import outer
    // for ImportText_Direct); it may be null for free-standing struct memory.
    inline bool SetValueFromJson(FProperty* Prop, void* Container, const TSharedPtr<FJsonValue>& V, UObject* Outer);

    /** Resolve a UObject reference from either a bare path string or an object
     *  wrapper such as {"ObjectPath": "/Game/..."} — MCP clients naturally send
     *  the latter when mirroring UE's own JSON export shape. */
    inline UObject* ResolveObjectRef(const TSharedPtr<FJsonValue>& V)
    {
        if (!V.IsValid()) return nullptr;
        if (V->Type == EJson::String)
        {
            const FString Path = V->AsString();
            if (Path.IsEmpty() || Path == TEXT("None")) return nullptr;
            return LoadObject<UObject>(nullptr, *Path);
        }
        if (V->Type == EJson::Object)
        {
            const TSharedPtr<FJsonObject>& Obj = V->AsObject();
            static const TCHAR* Keys[] = { TEXT("ObjectPath"), TEXT("object_path"), TEXT("AssetPath"), TEXT("asset_path"), TEXT("Path"), TEXT("path") };
            for (const TCHAR* Key : Keys)
            {
                FString Path;
                if (Obj->TryGetStringField(Key, Path) && !Path.IsEmpty() && Path != TEXT("None"))
                {
                    return LoadObject<UObject>(nullptr, *Path);
                }
            }
        }
        return nullptr;
    }

    /** Set a single named field on an arbitrary struct instance by reflection.
     *  Handles every type SetProp does, including nested structs. */
    inline bool SetStructField(UScriptStruct* Struct, void* StructPtr, const FString& FieldName, const TSharedPtr<FJsonValue>& V)
    {
        if (!Struct || !StructPtr || !V.IsValid()) return false;
        FProperty* Prop = Struct->FindPropertyByName(FName(*FieldName));
        if (!Prop) return false;
        return SetValueFromJson(Prop, StructPtr, V, nullptr);
    }

    /** Set every key of a JSON object onto a struct instance. Returns the
     *  number of fields that applied and, when `OutUnknown` is provided,
     *  collects the keys that matched no property so callers can report them
     *  instead of silently dropping them. */
    inline int32 ApplyStructFields(UScriptStruct* Struct, void* StructPtr, const TSharedPtr<FJsonObject>& Obj, TArray<FString>* OutUnknown = nullptr)
    {
        if (!Struct || !StructPtr || !Obj.IsValid()) return 0;
        int32 Applied = 0;
        for (const auto& Pair : Obj->Values)
        {
            // FJsonObject keys are a storage type, not FString, so they need an
            // explicit conversion before anything takes them by const FString&.
            const FString Key(Pair.Key);
            if (SetStructField(Struct, StructPtr, Key, Pair.Value)) ++Applied;
            else if (OutUnknown) OutUnknown->Add(Key);
        }
        return Applied;
    }

    /** Generic reflection setter: set ANY UPROPERTY on the target by its real
     *  name, coercing from the JSON value by property type. Covers enums-by-string
     *  (e.g. InputType="FunctionInput_Scalar"), bool bitfields (ComponentMask R/G/B/A),
     *  numerics, FName/FString/FText, structs (from string, numeric array, or
     *  nested JSON object), object refs by asset path, and arrays.
     *  Returns true if the property existed and the value was applied. */
    inline bool SetProp(UObject* Target, const FString& Name, const TSharedPtr<FJsonValue>& V)
    {
        if (!Target || !V.IsValid()) return false;
        FProperty* Prop = Target->GetClass()->FindPropertyByName(FName(*Name));
        if (!Prop) return false;
        return SetValueFromJson(Prop, Target, V, Target);
    }

    inline bool SetValueFromJson(FProperty* Prop, void* Container, const TSharedPtr<FJsonValue>& V, UObject* Outer)
    {
        if (!Prop || !Container || !V.IsValid()) return false;

        if (FBoolProperty* B = CastField<FBoolProperty>(Prop))
        {
            const bool bVal = (V->Type == EJson::Boolean) ? V->AsBool() : (V->AsNumber() != 0.0);
            B->SetPropertyValue_InContainer(Container, bVal);
            return true;
        }
        if (FByteProperty* By = CastField<FByteProperty>(Prop))
        {
            if (V->Type == EJson::String && By->Enum)
            {
                int64 E = By->Enum->GetValueByNameString(V->AsString());
                if (E == INDEX_NONE)
                {
                    // Accept the bare tail of a prefixed enumerator, e.g. "Center"
                    // for ETextJustify::Center or HAlign_Center.
                    const FString First = By->Enum->GetNameStringByIndex(0);
                    int32 Underscore;
                    if (First.FindChar('_', Underscore))
                        E = By->Enum->GetValueByNameString(First.Left(Underscore) + TEXT("_") + V->AsString());
                }
                if (E == INDEX_NONE) return false;
                By->SetIntPropertyValue(By->ContainerPtrToValuePtr<void>(Container), E);
                return true;
            }
            By->SetIntPropertyValue(By->ContainerPtrToValuePtr<void>(Container), (int64)V->AsNumber());
            return true;
        }
        if (FEnumProperty* En = CastField<FEnumProperty>(Prop))
        {
            int64 Val = 0;
            if (V->Type == EJson::String && En->GetEnum())
            {
                Val = En->GetEnum()->GetValueByNameString(V->AsString());
                if (Val == INDEX_NONE)
                {
                    const FString Qualified = En->GetEnum()->GetName() + TEXT("::") + V->AsString();
                    Val = En->GetEnum()->GetValueByNameString(Qualified);
                }
                if (Val == INDEX_NONE) return false;
            }
            else Val = (int64)V->AsNumber();
            En->GetUnderlyingProperty()->SetIntPropertyValue(En->ContainerPtrToValuePtr<void>(Container), Val);
            return true;
        }
        if (FNumericProperty* N = CastField<FNumericProperty>(Prop))
        {
            void* Ptr = N->ContainerPtrToValuePtr<void>(Container);
            if (N->IsFloatingPoint()) N->SetFloatingPointPropertyValue(Ptr, V->AsNumber());
            else N->SetIntPropertyValue(Ptr, (int64)V->AsNumber());
            return true;
        }
        if (FNameProperty* Nm = CastField<FNameProperty>(Prop)) { Nm->SetPropertyValue_InContainer(Container, FName(*V->AsString())); return true; }
        if (FStrProperty* S = CastField<FStrProperty>(Prop)) { S->SetPropertyValue_InContainer(Container, V->AsString()); return true; }
        if (FTextProperty* T = CastField<FTextProperty>(Prop))
        {
            if (V->Type != EJson::String) return false;
            T->SetPropertyValue_InContainer(Container, FText::FromString(V->AsString()));
            return true;
        }
        if (FObjectProperty* O = CastField<FObjectProperty>(Prop))
        {
            // An explicit null clears the reference; anything else must both
            // resolve and be type-compatible, otherwise this is a failure the
            // caller needs to hear about rather than a silent no-op.
            if (V->Type == EJson::Null)
            {
                O->SetObjectPropertyValue_InContainer(Container, nullptr);
                return true;
            }
            UObject* Obj = ResolveObjectRef(V);
            if (!Obj || !Obj->IsA(O->PropertyClass)) return false;
            O->SetObjectPropertyValue_InContainer(Container, Obj);
            return true;
        }
        if (FStructProperty* St = CastField<FStructProperty>(Prop))
        {
            void* Ptr = St->ContainerPtrToValuePtr<void>(Container);

            if (V->Type == EJson::String)
            {
                const TCHAR* End = St->ImportText_Direct(*V->AsString(), Ptr, Outer, PPF_None);
                return End != nullptr;
            }
            if (V->Type == EJson::Object)
            {
                // Nested struct: recurse field by field. Partial application is
                // still success — callers merge onto the existing value, so
                // {"Size": 32} on a font leaves the typeface untouched.
                return ApplyStructFields(St->Struct, Ptr, V->AsObject()) > 0;
            }
            if (V->Type == EJson::Array)
            {
                const TArray<TSharedPtr<FJsonValue>>& A = V->AsArray();
                auto Num = [&A](int32 i) { return A.IsValidIndex(i) ? (float)A[i]->AsNumber() : 0.f; };
                const FString SN = St->Struct->GetName();
                if (SN == TEXT("LinearColor"))                        *(FLinearColor*)Ptr = FLinearColor(Num(0), Num(1), Num(2), A.Num() > 3 ? Num(3) : 1.f);
                else if (SN == TEXT("Vector"))                        *(FVector*)Ptr      = FVector(Num(0), Num(1), Num(2));
                else if (SN == TEXT("Vector4") || SN == TEXT("Vector4f")) *(FVector4f*)Ptr = FVector4f(Num(0), Num(1), Num(2), Num(3));
                else if (SN == TEXT("Vector2D"))                      *(FVector2D*)Ptr    = FVector2D(Num(0), Num(1));
                else if (SN == TEXT("Color"))                         *(FColor*)Ptr       = FColor((uint8)Num(0), (uint8)Num(1), (uint8)Num(2), A.Num() > 3 ? (uint8)Num(3) : 255);
                // Slate layout structs are the common UMG case: a 4-number
                // array is a margin, a 2-number array is a 2D size/offset.
                else if (SN == TEXT("Margin"))                        *(FMargin*)Ptr      = A.Num() >= 4 ? FMargin(Num(0), Num(1), Num(2), Num(3))
                                                                                          : A.Num() == 2 ? FMargin(Num(0), Num(1), Num(0), Num(1))
                                                                                                         : FMargin(Num(0));
                else if (SN == TEXT("SlateColor"))                    *(FSlateColor*)Ptr  = FSlateColor(FLinearColor(Num(0), Num(1), Num(2), A.Num() > 3 ? Num(3) : 1.f));
                else return false;
                return true;
            }
            return false;
        }
        // TArray support — each element is a JSON value applied through the same
        // switch, so arrays of primitives, structs and object refs all work.
        // Primary original use: MaterialExpressionCustom.Inputs (FCustomInput).
        if (FArrayProperty* Arr = CastField<FArrayProperty>(Prop))
        {
            if (V->Type != EJson::Array) return false;  // don't claim success on a non-array value
            FScriptArrayHelper Helper(Arr, Arr->ContainerPtrToValuePtr<void>(Container));
            const TArray<TSharedPtr<FJsonValue>>& JArr = V->AsArray();
            Helper.Resize(JArr.Num());
            for (int32 i = 0; i < JArr.Num(); ++i)
            {
                void* ElemPtr = Helper.GetRawPtr(i);
                if (FStructProperty* InnerSt = CastField<FStructProperty>(Arr->Inner))
                {
                    InnerSt->Struct->InitializeStruct(ElemPtr);
                    if (JArr[i].IsValid() && JArr[i]->Type == EJson::Object)
                    {
                        ApplyStructFields(InnerSt->Struct, ElemPtr, JArr[i]->AsObject());
                    }
                }
                else
                {
                    // Inner properties address the element directly rather than
                    // through a container offset, so hand the element pointer in
                    // as the container with the inner property's own zero offset.
                    SetValueFromJson(Arr->Inner, ElemPtr, JArr[i], Outer);
                }
            }
            return true;
        }
        return false;
    }
}
