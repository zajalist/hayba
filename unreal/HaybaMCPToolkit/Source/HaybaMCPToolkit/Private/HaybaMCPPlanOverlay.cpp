#include "HaybaMCPPlanOverlay.h"
#include "HaybaMCPSettings.h"
#include "Editor.h"
#include "EngineUtils.h"
#include "GameFramework/Actor.h"
#include "Engine/World.h"
#include "DrawDebugHelpers.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "HAL/PlatformMisc.h"

namespace
{
    FString VerdictsPath()
    {
        const FString Override = FPlatformMisc::GetEnvironmentVariable(TEXT("HAYBA_VERDICTS"));
        if (!Override.IsEmpty()) return Override;
        const FString Profiles = FPlatformMisc::GetEnvironmentVariable(TEXT("HAYBA_PROFILES"));
        const FString Dir = Profiles.IsEmpty()
            ? FPaths::Combine(FPaths::ProjectDir(), TEXT(".scratch"))
            : FPaths::GetPath(Profiles);
        return FPaths::Combine(Dir, TEXT("verdicts.json"));
    }
}

void FHaybaPlanOverlay::Register()
{
    TickHandle = FTSTicker::GetCoreTicker().AddTicker(
        FTickerDelegate::CreateRaw(this, &FHaybaPlanOverlay::Tick), 0.15f);
}

void FHaybaPlanOverlay::Unregister()
{
    if (TickHandle.IsValid()) { FTSTicker::GetCoreTicker().RemoveTicker(TickHandle); TickHandle.Reset(); }
}

bool FHaybaPlanOverlay::Tick(float)
{
#if ENABLE_DRAW_DEBUG
    if (!FHaybaMCPSettings::Get().bPlanModeEnabled) return true;
    if (!GEditor) return true;
    UWorld* World = GEditor->GetEditorWorldContext().World();
    if (!World) return true;

    FString Raw;
    if (!FFileHelper::LoadFileToString(Raw, *VerdictsPath())) return true;
    TSharedPtr<FJsonObject> Root;
    const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Raw);
    if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid()) return true;

    for (TActorIterator<AActor> It(World); It; ++It)
    {
        AActor* Actor = *It;
        const FString Label = Actor->GetActorLabel();
        const TSharedPtr<FJsonObject>* V = nullptr;
        if (!Root->TryGetObjectField(Label, V) || !V) continue;

        bool bOk = true; (*V)->TryGetBoolField(TEXT("ok"), bOk);
        FVector Origin, Extent;
        Actor->GetActorBounds(false, Origin, Extent);

        const FColor Color = bOk ? FColor(40, 220, 90) : FColor(235, 60, 60);
        // Re-drawn each tick with a lifetime just over the tick interval, so it
        // stays solid without accumulating.
        DrawDebugBox(World, Origin, Extent + FVector(2.f), Color, false, 0.2f, 0, 2.5f);

        if (!bOk)
        {
            const TArray<TSharedPtr<FJsonValue>>* Fix = nullptr;
            if ((*V)->TryGetArrayField(TEXT("fix"), Fix) && Fix->Num() == 3)
            {
                const FVector FixCm(
                    (*Fix)[0]->AsNumber() * 100.0, (*Fix)[1]->AsNumber() * 100.0, (*Fix)[2]->AsNumber() * 100.0);
                if (!FixCm.IsNearlyZero())
                {
                    DrawDebugDirectionalArrow(World, Origin, Origin + FixCm, 40.f, FColor(255, 210, 60), false, 0.2f, 0, 3.f);
                }
            }
        }
    }
#endif
    return true;
}
