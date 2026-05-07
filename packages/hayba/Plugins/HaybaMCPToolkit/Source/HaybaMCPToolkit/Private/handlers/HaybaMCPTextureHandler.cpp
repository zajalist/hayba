#include "HaybaMCPTextureHandler.h"

TArray<FString> FHaybaMCPTextureHandler::GetCommands() const
{
    return {
        TEXT("texture_get_info"),
        TEXT("texture_set_compression"),
        TEXT("texture_list")
    };
}

FHaybaHandlerResult FHaybaMCPTextureHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>&)
{
    auto Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("status"), TEXT("not_implemented"));
    Out->SetStringField(TEXT("domain"), TEXT("texture"));
    Out->SetStringField(TEXT("eta"), TEXT("v1.0"));
    Out->SetStringField(TEXT("command"), Cmd);
    return FHaybaHandlerResult::Ok(Out);
}
