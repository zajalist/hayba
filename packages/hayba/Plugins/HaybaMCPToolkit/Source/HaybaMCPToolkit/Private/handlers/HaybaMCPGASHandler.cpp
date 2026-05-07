#include "HaybaMCPGASHandler.h"

TArray<FString> FHaybaMCPGASHandler::GetCommands() const
{
    return {
        TEXT("gas_create_ability"),
        TEXT("gas_grant_ability"),
        TEXT("gas_create_effect"),
        TEXT("gas_apply_effect")
    };
}

FHaybaHandlerResult FHaybaMCPGASHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>&)
{
    auto Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("status"), TEXT("not_implemented"));
    Out->SetStringField(TEXT("domain"), TEXT("gas"));
    Out->SetStringField(TEXT("eta"), TEXT("v1.0"));
    Out->SetStringField(TEXT("command"), Cmd);
    return FHaybaHandlerResult::Ok(Out);
}
