#include "HaybaMCPAudioHandler.h"

TArray<FString> FHaybaMCPAudioHandler::GetCommands() const
{
    return {
        TEXT("audio_play"),
        TEXT("audio_list"),
        TEXT("audio_set_volume")
    };
}

FHaybaHandlerResult FHaybaMCPAudioHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>&)
{
    auto Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("status"), TEXT("not_implemented"));
    Out->SetStringField(TEXT("domain"), TEXT("audio"));
    Out->SetStringField(TEXT("eta"), TEXT("v1.0"));
    Out->SetStringField(TEXT("command"), Cmd);
    return FHaybaHandlerResult::Ok(Out);
}
