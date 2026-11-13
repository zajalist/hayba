#include "HaybaMCPFabHandler.h"
#include "HaybaMCPFab.h"
#include "HaybaMCPLeaseManager.h"

TArray<FString> FHaybaMCPFabHandler::GetCommands() const
{
    return { TEXT("fab_search"), TEXT("fab_search_status") };
}

FHaybaHandlerResult FHaybaMCPFabHandler::Handle(const FString& Command, const TSharedPtr<FJsonObject>& Params)
{
    return HaybaFab::Execute(Command, Params, FHaybaMCPLeaseManager::Get().EffectiveOwner());
}
