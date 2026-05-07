#include "HaybaMCPAnimationHandler.h"

TArray<FString> FHaybaMCPAnimationHandler::GetCommands() const
{
    return {
        TEXT("anim_blueprint_get_info"),
        TEXT("anim_blueprint_add_state"),
        TEXT("anim_blueprint_add_transition"),
        TEXT("anim_blueprint_set_condition"),
        TEXT("anim_blueprint_compile")
    };
}

FHaybaHandlerResult FHaybaMCPAnimationHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>&)
{
    auto Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("status"), TEXT("not_implemented"));
    Out->SetStringField(TEXT("domain"), TEXT("anim"));
    Out->SetStringField(TEXT("eta"), TEXT("v1.0"));
    Out->SetStringField(TEXT("command"), Cmd);
    return FHaybaHandlerResult::Ok(Out);
}
