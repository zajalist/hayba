#include "HaybaMCPInputHandler.h"

TArray<FString> FHaybaMCPInputHandler::GetCommands() const
{
    return {
        TEXT("input_create_action"),
        TEXT("input_create_mapping"),
        TEXT("input_add_mapping")
    };
}

FHaybaHandlerResult FHaybaMCPInputHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>&)
{
    auto Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("status"), TEXT("not_implemented"));
    Out->SetStringField(TEXT("domain"), TEXT("input"));
    Out->SetStringField(TEXT("eta"), TEXT("v1.0"));
    Out->SetStringField(TEXT("command"), Cmd);
    return FHaybaHandlerResult::Ok(Out);
}
