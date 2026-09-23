#include "HaybaMCPWorldInspectSummary.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"

FHaybaWorldInspectSummary FHaybaWorldInspectSummary::FromResponse(
    bool bOk, const TSharedPtr<FJsonObject>& Data)
{
    FHaybaWorldInspectSummary Summary;
    Summary.Error = TEXT("Could not inspect this world. Check the editor connection and try again.");
    if (!bOk || !Data.IsValid()) return Summary;

    const TSharedPtr<FJsonObject>* World = nullptr;
    const TSharedPtr<FJsonObject>* Partition = nullptr;
    const TArray<TSharedPtr<FJsonValue>>* Landscapes = nullptr;
    if (!Data->TryGetObjectField(TEXT("world"), World) || !World || !World->IsValid()
        || !Data->TryGetObjectField(TEXT("partition"), Partition) || !Partition || !Partition->IsValid()
        || !Data->TryGetArrayField(TEXT("landscape"), Landscapes) || !Landscapes
        || !(*World)->TryGetStringField(TEXT("package"), Summary.LevelPackage)
        || Summary.LevelPackage.IsEmpty()
        || !(*World)->TryGetStringField(TEXT("current_level"), Summary.CurrentLevelPackage)
        || !(*Partition)->TryGetBoolField(TEXT("enabled"), Summary.bPartitionEnabled)
        || !Data->TryGetBoolField(TEXT("save_ready"), Summary.bSaveReady))
    {
        return Summary;
    }

    Summary.LoadedLandscapeCount = Landscapes->Num();
    Summary.bSuccess = true;
    Summary.Error.Empty();
    return Summary;
}

FString FHaybaWorldInspectSummary::ToConversationText() const
{
    if (!bSuccess) return Error;
    return FString::Printf(
        TEXT("Current map: %s\nWorld Partition: %s\nLoaded landscapes: %d\nCurrent level file (%s): %s\nCoverage: loaded world only; unloaded partition cells not inspected."),
        *LevelPackage,
        bPartitionEnabled ? TEXT("enabled") : TEXT("disabled"),
        LoadedLandscapeCount,
        CurrentLevelPackage.IsEmpty() ? TEXT("unknown") : *CurrentLevelPackage,
        bSaveReady ? TEXT("existing and writable") : TEXT("not confirmed writable"));
}
