#include "HaybaMCPBehaviorTreeHandler.h"

TArray<FString> FHaybaMCPBehaviorTreeHandler::GetCommands() const
{
    return {
        TEXT("bt_get_info"),
        TEXT("bt_add_node"),
        TEXT("bt_connect"),
        TEXT("bt_compile")
    };
}

FHaybaHandlerResult FHaybaMCPBehaviorTreeHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>&)
{
    auto Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("status"), TEXT("not_implemented"));
    Out->SetStringField(TEXT("domain"), TEXT("bt"));
    Out->SetStringField(TEXT("eta"), TEXT("v1.0"));
    Out->SetStringField(TEXT("command"), Cmd);
    return FHaybaHandlerResult::Ok(Out);
}
