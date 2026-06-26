#include "pcg/HaybaSocketStore.h"

#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "HAL/PlatformMisc.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Dom/JsonObject.h"

namespace
{
    // JSON string array -> TArray<FString>; absent/!array -> empty.
    static TArray<FString> ReadStrArray(const TSharedPtr<FJsonObject>& Obj, const FString& Field)
    {
        TArray<FString> Out;
        const TArray<TSharedPtr<FJsonValue>>* Arr = nullptr;
        if (Obj.IsValid() && Obj->TryGetArrayField(Field, Arr) && Arr)
        {
            for (const TSharedPtr<FJsonValue>& V : *Arr)
            {
                FString S;
                if (V.IsValid() && V->TryGetString(S)) { Out.Add(S); }
            }
        }
        return Out;
    }
}

FString HaybaSocketStore::ResolvePath(const FString& SettingsPath)
{
    if (!SettingsPath.IsEmpty()) { return SettingsPath; }
    const FString Env = FPlatformMisc::GetEnvironmentVariable(TEXT("HAYBA_SOCKETS"));
    if (!Env.IsEmpty()) { return Env; }
    return FPaths::Combine(FPaths::ProjectDir(), TEXT(".scratch"), TEXT("sockets.json"));
}

bool HaybaSocketStore::Load(const FString& Path, FHaybaSocketSet& Out, FString& OutError)
{
    FString Raw;
    if (!FFileHelper::LoadFileToString(Raw, *Path))
    {
        OutError = FString::Printf(TEXT("sockets.json could not read %s"), *Path);
        return false;
    }
    TSharedPtr<FJsonObject> Root;
    const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Raw);
    if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid())
    {
        OutError = FString::Printf(TEXT("sockets.json malformed at %s"), *Path);
        return false;
    }

    const TSharedPtr<FJsonObject>* Sockets = nullptr;
    if (Root->TryGetObjectField(TEXT("sockets"), Sockets) && Sockets)
    {
        for (const auto& Pair : (*Sockets)->Values)
        {
            const TSharedPtr<FJsonObject> S = Pair.Value.IsValid() ? Pair.Value->AsObject() : nullptr;
            if (!S.IsValid()) { continue; }

            FHaybaSocketContract C;
            C.Name             = FName(*Pair.Key);
            C.Provides         = ReadStrArray(S, TEXT("provides"));
            C.Requires.All     = ReadStrArray(S, TEXT("requires_all"));
            C.Requires.Exclude = ReadStrArray(S, TEXT("requires_exclude"));
            S->TryGetStringField(TEXT("polarity"), C.Polarity);
            double CW = 1.0; S->TryGetNumberField(TEXT("cost_weight"), CW); C.CostWeight = CW;
            bool   RX = true; S->TryGetBoolField(TEXT("relaxable"),   RX); C.bRelaxable = RX;
            Out.Sockets.Add(C.Name, C);
        }
    }

    const TSharedPtr<FJsonObject>* Bond = nullptr;
    if (Root->TryGetObjectField(TEXT("bond"), Bond) && Bond)
    {
        FString F, Cand;
        if ((*Bond)->TryGetStringField(TEXT("frontier"),  F))    { Out.BondFrontier  = FName(*F); }
        if ((*Bond)->TryGetStringField(TEXT("candidate"), Cand)) { Out.BondCandidate = FName(*Cand); }
    }

    if (Out.Sockets.Num() == 0)
    {
        OutError = TEXT("sockets.json parsed but contained no sockets");
        return false;
    }
    return true;
}
