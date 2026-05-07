#include "HaybaMCPTestHandler.h"

TArray<FString> FHaybaMCPTestHandler::GetCommands() const
{
    return {
        TEXT("test_list"),
        TEXT("test_run"),
        TEXT("test_get_log")
    };
}

FHaybaHandlerResult FHaybaMCPTestHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>&)
{
    auto Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("status"), TEXT("not_implemented"));
    Out->SetStringField(TEXT("domain"), TEXT("test"));
    Out->SetStringField(TEXT("eta"), TEXT("v1.0"));
    Out->SetStringField(TEXT("command"), Cmd);
    return FHaybaHandlerResult::Ok(Out);
}
