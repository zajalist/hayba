#pragma once
#include "IHaybaMCPHandler.h"

class FHaybaMCPSequencerHandler : public IHaybaMCPHandler
{
public:
    virtual FString GetDomain() const override { return TEXT("seq"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params) override;

private:
    FHaybaHandlerResult SeqCreate(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult SeqAddTrack(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult SeqAddKeyframe(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult SeqAddCameraCut(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult SeqSetPlaybackRange(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult SeqPlay(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult SeqGetInfo(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult SeqExport(const TSharedPtr<FJsonObject>& P);
};
