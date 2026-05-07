#include "HaybaMCPBuildHandler.h"

TArray<FString> FHaybaMCPBuildHandler::GetCommands() const
{
    return {
        TEXT("build_project"),
        TEXT("build_cook"),
        TEXT("build_generate_project_files")
    };
}

FHaybaHandlerResult FHaybaMCPBuildHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>&)
{
    auto Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("status"), TEXT("not_implemented"));
    Out->SetStringField(TEXT("domain"), TEXT("build"));
    Out->SetStringField(TEXT("eta"), TEXT("v1.0"));
    Out->SetStringField(TEXT("command"), Cmd);
    return FHaybaHandlerResult::Ok(Out);
}
