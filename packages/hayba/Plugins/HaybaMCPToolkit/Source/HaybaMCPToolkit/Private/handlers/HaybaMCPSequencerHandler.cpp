#include "HaybaMCPSequencerHandler.h"

TArray<FString> FHaybaMCPSequencerHandler::GetCommands() const
{
    return {
        TEXT("seq_create"),
        TEXT("seq_add_track"),
        TEXT("seq_add_keyframe"),
        TEXT("seq_get_info"),
        TEXT("seq_play"),
        TEXT("seq_export"),
        TEXT("seq_add_camera_cut"),
        TEXT("seq_set_playback_range")
    };
}

FHaybaHandlerResult FHaybaMCPSequencerHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>&)
{
    auto Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("status"), TEXT("not_implemented"));
    Out->SetStringField(TEXT("domain"), TEXT("seq"));
    Out->SetStringField(TEXT("eta"), TEXT("v1.0"));
    Out->SetStringField(TEXT("command"), Cmd);
    return FHaybaHandlerResult::Ok(Out);
}
