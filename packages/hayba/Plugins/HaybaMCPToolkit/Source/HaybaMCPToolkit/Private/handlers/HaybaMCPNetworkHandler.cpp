#include "HaybaMCPNetworkHandler.h"

TArray<FString> FHaybaMCPNetworkHandler::GetCommands() const
{
    return {
        TEXT("net_debug"),
        TEXT("net_set_replication")
    };
}

FHaybaHandlerResult FHaybaMCPNetworkHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>&)
{
    auto Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("status"), TEXT("not_implemented"));
    Out->SetStringField(TEXT("domain"), TEXT("net"));
    Out->SetStringField(TEXT("eta"), TEXT("v1.0"));
    Out->SetStringField(TEXT("command"), Cmd);
    return FHaybaHandlerResult::Ok(Out);
}
