#include "HaybaMCPProjectHandler.h"

TArray<FString> FHaybaMCPProjectHandler::GetCommands() const
{
    return {
        TEXT("project_get_info"),
        TEXT("project_get_settings"),
        TEXT("project_set_settings"),
        TEXT("project_list_plugins")
    };
}

FHaybaHandlerResult FHaybaMCPProjectHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>&)
{
    auto Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("status"), TEXT("not_implemented"));
    Out->SetStringField(TEXT("domain"), TEXT("project"));
    Out->SetStringField(TEXT("eta"), TEXT("v1.0"));
    Out->SetStringField(TEXT("command"), Cmd);
    return FHaybaHandlerResult::Ok(Out);
}
