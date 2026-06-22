#pragma once

// Generic, UObject-agnostic reflection setters lifted VERBATIM from the
// material handler so other handlers CAN adopt them later. No material-specific
// logic lives here. Behavior must remain identical to the original inline copies.
#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "UObject/Object.h"
#include "UObject/UnrealType.h"
#include "UObject/EnumProperty.h"

namespace HaybaReflection
{
    // Set a single named field on an arbitrary struct instance by reflection.
    // Covers the subset of field types needed for FCustomInput
    // (FName/FString/bool/numeric).
    inline bool SetStructField(UScriptStruct* Struct, void* StructPtr, const FString& FieldName, const TSharedPtr<FJsonValue>& V)
    {
        if (!Struct || !StructPtr || !V.IsValid()) return false;
        FProperty* Prop = Struct->FindPropertyByName(FName(*FieldName));
        if (!Prop) return false;

        if (FNameProperty* Nm = CastField<FNameProperty>(Prop)) { Nm->SetPropertyValue_InContainer(StructPtr, FName(*V->AsString())); return true; }
        if (FStrProperty* S = CastField<FStrProperty>(Prop)) { S->SetPropertyValue_InContainer(StructPtr, V->AsString()); return true; }
        if (FBoolProperty* B = CastField<FBoolProperty>(Prop))
        {
            const bool bVal = (V->Type == EJson::Boolean) ? V->AsBool() : (V->AsNumber() != 0.0);
            B->SetPropertyValue_InContainer(StructPtr, bVal);
            return true;
        }
        if (FNumericProperty* N = CastField<FNumericProperty>(Prop))
        {
            void* Ptr = N->ContainerPtrToValuePtr<void>(StructPtr);
            if (N->IsFloatingPoint()) N->SetFloatingPointPropertyValue(Ptr, V->AsNumber());
            else N->SetIntPropertyValue(Ptr, (int64)V->AsNumber());
            return true;
        }
        return false;
    }

    // Generic reflection setter: set ANY UPROPERTY on the target by its real
    // name, coercing from the JSON value by property type. Covers enums-by-string
    // (e.g. InputType="FunctionInput_Scalar"), bool bitfields (ComponentMask R/G/B/A),
    // numerics, FName/FString, struct-from-array (LinearColor/Vector/Vector4f/Vector2D/Color),
    // and object refs by asset path. Returns true if the property existed.
    inline bool SetProp(UObject* Target, const FString& Name, const TSharedPtr<FJsonValue>& V)
    {
        if (!Target || !V.IsValid()) return false;
        FProperty* Prop = Target->GetClass()->FindPropertyByName(FName(*Name));
        if (!Prop) return false;
        void* Owner = Target;

        if (FBoolProperty* B = CastField<FBoolProperty>(Prop))
        {
            const bool bVal = (V->Type == EJson::Boolean) ? V->AsBool() : (V->AsNumber() != 0.0);
            B->SetPropertyValue_InContainer(Owner, bVal);
            return true;
        }
        if (FByteProperty* By = CastField<FByteProperty>(Prop))
        {
            if (V->Type == EJson::String && By->Enum)
            {
                int64 E = By->Enum->GetValueByNameString(V->AsString());
                if (E == INDEX_NONE)
                {
                    const FString First = By->Enum->GetNameStringByIndex(0);
                    int32 Underscore;
                    if (First.FindChar('_', Underscore))
                        E = By->Enum->GetValueByNameString(First.Left(Underscore) + TEXT("_") + V->AsString());
                }
                if (E != INDEX_NONE) By->SetIntPropertyValue(By->ContainerPtrToValuePtr<void>(Owner), E);
            }
            else By->SetIntPropertyValue(By->ContainerPtrToValuePtr<void>(Owner), (int64)V->AsNumber());
            return true;
        }
        if (FEnumProperty* En = CastField<FEnumProperty>(Prop))
        {
            int64 Val = 0;
            if (V->Type == EJson::String && En->GetEnum())
            {
                Val = En->GetEnum()->GetValueByNameString(V->AsString());
                if (Val == INDEX_NONE) Val = 0;
            }
            else Val = (int64)V->AsNumber();
            En->GetUnderlyingProperty()->SetIntPropertyValue(En->ContainerPtrToValuePtr<void>(Owner), Val);
            return true;
        }
        if (FNumericProperty* N = CastField<FNumericProperty>(Prop))
        {
            void* Ptr = N->ContainerPtrToValuePtr<void>(Owner);
            if (N->IsFloatingPoint()) N->SetFloatingPointPropertyValue(Ptr, V->AsNumber());
            else N->SetIntPropertyValue(Ptr, (int64)V->AsNumber());
            return true;
        }
        if (FNameProperty* Nm = CastField<FNameProperty>(Prop)) { Nm->SetPropertyValue_InContainer(Owner, FName(*V->AsString())); return true; }
        if (FStrProperty* S = CastField<FStrProperty>(Prop)) { S->SetPropertyValue_InContainer(Owner, V->AsString()); return true; }
        if (FObjectProperty* O = CastField<FObjectProperty>(Prop))
        {
            if (V->Type == EJson::String)
                if (UObject* Obj = LoadObject<UObject>(nullptr, *V->AsString()))
                    if (Obj->IsA(O->PropertyClass)) O->SetObjectPropertyValue_InContainer(Owner, Obj);
            return true;
        }
        if (FStructProperty* St = CastField<FStructProperty>(Prop))
        {
            if (V->Type == EJson::Array)
            {
                const TArray<TSharedPtr<FJsonValue>>& A = V->AsArray();
                auto Num = [&A](int32 i) { return A.IsValidIndex(i) ? (float)A[i]->AsNumber() : 0.f; };
                void* Ptr = St->ContainerPtrToValuePtr<void>(Owner);
                const FString SN = St->Struct->GetName();
                if (SN == TEXT("LinearColor"))                        *(FLinearColor*)Ptr = FLinearColor(Num(0), Num(1), Num(2), A.Num() > 3 ? Num(3) : 1.f);
                else if (SN == TEXT("Vector"))                        *(FVector*)Ptr      = FVector(Num(0), Num(1), Num(2));
                else if (SN == TEXT("Vector4") || SN == TEXT("Vector4f")) *(FVector4f*)Ptr = FVector4f(Num(0), Num(1), Num(2), Num(3));
                else if (SN == TEXT("Vector2D"))                      *(FVector2D*)Ptr    = FVector2D(Num(0), Num(1));
                else if (SN == TEXT("Color"))                         *(FColor*)Ptr       = FColor((uint8)Num(0), (uint8)Num(1), (uint8)Num(2), A.Num() > 3 ? (uint8)Num(3) : 255);
            }
            return true;
        }
        // TArray support — each element is a JSON object whose keys are set
        // via SetStructField. Primary use: MaterialExpressionCustom.Inputs
        // where each element is an FCustomInput struct with an InputName FName field.
        if (FArrayProperty* Arr = CastField<FArrayProperty>(Prop))
        {
            if (V->Type != EJson::Array) return false;  // don't claim success on a non-array value
            {
                FScriptArrayHelper Helper(Arr, Arr->ContainerPtrToValuePtr<void>(Owner));
                const TArray<TSharedPtr<FJsonValue>>& JArr = V->AsArray();
                Helper.Resize(JArr.Num());
                if (FStructProperty* InnerSt = CastField<FStructProperty>(Arr->Inner))
                {
                    for (int32 i = 0; i < JArr.Num(); ++i)
                    {
                        void* ElemPtr = Helper.GetRawPtr(i);
                        InnerSt->Struct->InitializeStruct(ElemPtr);
                        if (JArr[i].IsValid() && JArr[i]->Type == EJson::Object)
                        {
                            const TSharedPtr<FJsonObject>& ElemObj = JArr[i]->AsObject();
                            for (const TPair<FString, TSharedPtr<FJsonValue>>& F : ElemObj->Values)
                                SetStructField(InnerSt->Struct, ElemPtr, F.Key, F.Value);
                        }
                    }
                }
            }
            return true;
        }
        return false;
    }
}
