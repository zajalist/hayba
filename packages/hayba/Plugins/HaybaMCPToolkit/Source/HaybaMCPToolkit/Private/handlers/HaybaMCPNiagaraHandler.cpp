#include "HaybaMCPNiagaraHandler.h"

TArray<FString> FHaybaMCPNiagaraHandler::GetCommands() const
{
    return {
        TEXT("niagara_list"),
        TEXT("niagara_spawn"),
        TEXT("niagara_set_param")
    };
}

FHaybaHandlerResult FHaybaMCPNiagaraHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>&)
{
    auto Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("status"), TEXT("not_implemented"));
    Out->SetStringField(TEXT("domain"), TEXT("niagara"));
    Out->SetStringField(TEXT("eta"), TEXT("v1.0"));
    Out->SetStringField(TEXT("command"), Cmd);
    return FHaybaHandlerResult::Ok(Out);
}
