#include "HaybaMCPMetaSoundHandler.h"

TArray<FString> FHaybaMCPMetaSoundHandler::GetCommands() const
{
    return {
        TEXT("metasound_create"),
        TEXT("metasound_add_node"),
        TEXT("metasound_connect"),
        TEXT("metasound_set_input"),
        TEXT("metasound_compile"),
        TEXT("metasound_list")
    };
}

FHaybaHandlerResult FHaybaMCPMetaSoundHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>&)
{
    auto Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("status"), TEXT("not_implemented"));
    Out->SetStringField(TEXT("domain"), TEXT("metasound"));
    Out->SetStringField(TEXT("eta"), TEXT("v1.0"));
    Out->SetStringField(TEXT("command"), Cmd);
    return FHaybaHandlerResult::Ok(Out);
}
