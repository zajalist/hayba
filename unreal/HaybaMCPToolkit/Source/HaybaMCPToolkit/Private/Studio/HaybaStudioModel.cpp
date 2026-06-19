#include "Studio/HaybaStudioModel.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "HAL/PlatformMisc.h"

namespace
{
    FVector ReadVec3(const TSharedPtr<FJsonObject>& Obj, const TCHAR* Field, const FVector& Default)
    {
        const TArray<TSharedPtr<FJsonValue>>* Arr = nullptr;
        if (Obj.IsValid() && Obj->TryGetArrayField(Field, Arr) && Arr->Num() == 3)
        {
            return FVector((*Arr)[0]->AsNumber(), (*Arr)[1]->AsNumber(), (*Arr)[2]->AsNumber());
        }
        return Default;
    }

    FLinearColor ParseColor(const FString& Hex)
    {
        if (Hex.IsEmpty()) return FLinearColor(0.25f, 0.55f, 1.f);
        return FLinearColor(FColor::FromHex(Hex));
    }
}

FString HaybaStudio::ScratchDir()
{
    const FString Override = FPlatformMisc::GetEnvironmentVariable(TEXT("HAYBA_PROFILES"));
    if (!Override.IsEmpty()) return FPaths::GetPath(Override);
    return FPaths::Combine(FPaths::ProjectDir(), TEXT(".scratch"));
}

bool HaybaStudio::LoadProfile(const FString& AssetPath, FHaybaStudioProfile& Out)
{
    Out = FHaybaStudioProfile();
    Out.AssetId = AssetPath;

    const FString Path = FPaths::Combine(ScratchDir(), TEXT("profiles.json"));
    FString Raw;
    if (!FFileHelper::LoadFileToString(Raw, *Path)) return false;

    TSharedPtr<FJsonObject> Root;
    const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Raw);
    if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid()) return false;

    const TSharedPtr<FJsonObject>* ProfilePtr = nullptr;
    if (!Root->TryGetObjectField(AssetPath, ProfilePtr) || !ProfilePtr) return false;
    const TSharedPtr<FJsonObject> Profile = *ProfilePtr;

    Out.Archetype = Profile->GetStringField(TEXT("profile"));

    const TArray<TSharedPtr<FJsonValue>>* Masks = nullptr;
    if (Profile->TryGetArrayField(TEXT("masks"), Masks))
    {
        for (const TSharedPtr<FJsonValue>& V : *Masks)
        {
            const TSharedPtr<FJsonObject> M = V->AsObject();
            if (!M.IsValid()) continue;

            FHaybaStudioMask Mask;
            Mask.Id = M->GetStringField(TEXT("id"));
            M->TryGetStringField(TEXT("type"), Mask.Type);
            M->TryGetStringField(TEXT("source"), Mask.Source);
            M->TryGetStringField(TEXT("detail"), Mask.Detail);
            Mask.Color = ParseColor(M->GetStringField(TEXT("color")));
            double Conf = 1.0; M->TryGetNumberField(TEXT("confidence"), Conf); Mask.Confidence = (float)Conf;
            M->TryGetBoolField(TEXT("locked"), Mask.bLocked);

            const TArray<TSharedPtr<FJsonValue>>* Tris = nullptr;
            if (M->TryGetArrayField(TEXT("triangles"), Tris))
            {
                for (const TSharedPtr<FJsonValue>& T : *Tris) Mask.Triangles.Add((int32)T->AsNumber());
            }

            const TSharedPtr<FJsonObject>* ShapePtr = nullptr;
            if (M->TryGetObjectField(TEXT("shape"), ShapePtr) && ShapePtr)
            {
                const TSharedPtr<FJsonObject> Shape = *ShapePtr;
                Mask.bHasShape = true;
                Shape->TryGetStringField(TEXT("kind"), Mask.Shape.Kind);
                double R = 0.5; Shape->TryGetNumberField(TEXT("radius"), R); Mask.Shape.Radius = (float)R;
                Mask.Shape.Extents = ReadVec3(Shape, TEXT("extents"), FVector(0.5f));
                const TSharedPtr<FJsonObject>* XformPtr = nullptr;
                if (Shape->TryGetObjectField(TEXT("transform"), XformPtr) && XformPtr)
                {
                    Mask.Shape.Pos = ReadVec3(*XformPtr, TEXT("pos"), FVector::ZeroVector);
                    const TArray<TSharedPtr<FJsonValue>>* Q = nullptr;
                    if ((*XformPtr)->TryGetArrayField(TEXT("quat"), Q) && Q->Num() == 4)
                    {
                        Mask.Shape.Rot = FQuat((*Q)[0]->AsNumber(), (*Q)[1]->AsNumber(), (*Q)[2]->AsNumber(), (*Q)[3]->AsNumber());
                    }
                }
            }

            Out.Masks.Add(MoveTemp(Mask));
        }
    }

    Out.bLoaded = true;
    return true;
}
