#include "HaybaEditorOps.h"

namespace
{
    bool ReadVec3(const TSharedPtr<FJsonObject>& P, const TCHAR* Key, FVector& Out)
    {
        const TArray<TSharedPtr<FJsonValue>>* Arr = nullptr;
        if (!P->TryGetArrayField(Key, Arr) || !Arr || Arr->Num() < 3) return false;
        Out = FVector((*Arr)[0]->AsNumber(), (*Arr)[1]->AsNumber(), (*Arr)[2]->AsNumber());
        return true;
    }
}

namespace HaybaEditorOps
{
    FCameraOrientation ResolveCameraRotation(
        const TSharedPtr<FJsonObject>& Params,
        const FVector& CameraLocation,
        const FRotator& Current)
    {
        FCameraOrientation Out;
        Out.Rotation = Current;
        if (!Params.IsValid()) return Out;

        // 1. look_at wins. FVector::Rotation() gives pitch+yaw to face the
        //    target and roll = 0, so the horizon stays level by construction.
        FVector Target;
        if (ReadVec3(Params, TEXT("look_at"), Target))
        {
            const FVector Dir = Target - CameraLocation;
            if (!Dir.IsNearlyZero())
            {
                Out.Rotation = Dir.Rotation();
                Out.Source = ECameraRotationSource::LookAt;
                return Out;
            }
            // Aiming at where the camera already is says nothing about facing.
            // Fall through rather than snapping to a zero rotation.
        }

        // 2. rotation as an object: unambiguous, and the only opt-in to roll.
        const TSharedPtr<FJsonObject>* RotObj = nullptr;
        if (Params->TryGetObjectField(TEXT("rotation"), RotObj) && RotObj && RotObj->IsValid())
        {
            double Pitch = Current.Pitch;
            double Yaw   = Current.Yaw;
            double Roll  = 0.0;   // not Current.Roll: absent roll means level, not "keep the tilt"
            (*RotObj)->TryGetNumberField(TEXT("pitch"), Pitch);
            (*RotObj)->TryGetNumberField(TEXT("yaw"),   Yaw);
            (*RotObj)->TryGetNumberField(TEXT("roll"),  Roll);
            Out.Rotation = FRotator(Pitch, Yaw, Roll);
            Out.Source = ECameraRotationSource::RotationObj;
            return Out;
        }

        // 3. rotation as an array [pitch, yaw]. A third element would be read as
        //    roll by FRotator's argument order — which is exactly the mistake
        //    this guard exists for — so it is ignored.
        const TArray<TSharedPtr<FJsonValue>>* RotArr = nullptr;
        if (Params->TryGetArrayField(TEXT("rotation"), RotArr) && RotArr && RotArr->Num() >= 2)
        {
            Out.Rotation = FRotator(
                (*RotArr)[0]->AsNumber(),
                (*RotArr)[1]->AsNumber(),
                0.0);
            Out.Source = ECameraRotationSource::RotationArr;
            return Out;
        }

        return Out;
    }

    const TCHAR* RotationSourceName(ECameraRotationSource Source)
    {
        switch (Source)
        {
        case ECameraRotationSource::LookAt:      return TEXT("look_at");
        case ECameraRotationSource::RotationObj: return TEXT("rotation_object");
        case ECameraRotationSource::RotationArr: return TEXT("rotation_array");
        default:                                 return TEXT("unchanged");
        }
    }
}
