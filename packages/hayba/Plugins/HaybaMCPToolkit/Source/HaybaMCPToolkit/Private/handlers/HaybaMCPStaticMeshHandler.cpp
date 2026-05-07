#include "HaybaMCPStaticMeshHandler.h"

TArray<FString> FHaybaMCPStaticMeshHandler::GetCommands() const
{
    return {
        TEXT("mesh_get_info"),
        TEXT("mesh_set_lod"),
        TEXT("mesh_list")
    };
}

FHaybaHandlerResult FHaybaMCPStaticMeshHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>&)
{
    auto Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("status"), TEXT("not_implemented"));
    Out->SetStringField(TEXT("domain"), TEXT("mesh"));
    Out->SetStringField(TEXT("eta"), TEXT("v1.0"));
    Out->SetStringField(TEXT("command"), Cmd);
    return FHaybaHandlerResult::Ok(Out);
}
