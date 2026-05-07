#include "HaybaMCPUIHandler.h"

TArray<FString> FHaybaMCPUIHandler::GetCommands() const
{
    return {
        TEXT("ui_create_widget"),
        TEXT("ui_add_element"),
        TEXT("ui_query")
    };
}

FHaybaHandlerResult FHaybaMCPUIHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>&)
{
    auto Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("status"), TEXT("not_implemented"));
    Out->SetStringField(TEXT("domain"), TEXT("ui"));
    Out->SetStringField(TEXT("eta"), TEXT("v1.0"));
    Out->SetStringField(TEXT("command"), Cmd);
    return FHaybaHandlerResult::Ok(Out);
}
