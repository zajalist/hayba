#include "HaybaMCPDataAssetHandler.h"

TArray<FString> FHaybaMCPDataAssetHandler::GetCommands() const
{
    return {
        TEXT("data_create"),
        TEXT("data_get"),
        TEXT("data_set")
    };
}

FHaybaHandlerResult FHaybaMCPDataAssetHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>&)
{
    auto Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("status"), TEXT("not_implemented"));
    Out->SetStringField(TEXT("domain"), TEXT("data"));
    Out->SetStringField(TEXT("eta"), TEXT("v1.0"));
    Out->SetStringField(TEXT("command"), Cmd);
    return FHaybaHandlerResult::Ok(Out);
}
