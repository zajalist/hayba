#pragma once

#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"
#include "Dom/JsonObject.h"

class SWebBrowser;
DECLARE_DELEGATE_OneParam(FOnHaybaTranscriptAction, const FJsonObject&);

/** Retain every history row locally; send only changed rows after the first snapshot. */
struct FHaybaTranscriptUpdates
{
    FString Serialize(const TSharedRef<FJsonObject>& Snapshot);
    void Reset() { Generation.Empty(); Rows.Reset(); Revision = 0; }
private:
    FString Generation;
    TArray<FString> Rows;
    int32 Revision = 0;
};

/** One local document, presentation-only. No server, credentials or general editor binding. */
class SHaybaChatTranscript : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SHaybaChatTranscript) {}
        SLATE_EVENT(FOnHaybaTranscriptAction, OnAction)
    SLATE_END_ARGS()
    void Construct(const FArguments& Args);
    virtual void Tick(const FGeometry& Geometry, double Time, float Delta) override;
    void SetSnapshot(const TSharedRef<FJsonObject>& Snapshot);
    void AcknowledgeCopy(bool bSucceeded);
    bool IsReady() const { return bReady && !bFailed; }
    bool HasFailed() const { return bFailed; }
    static bool ValidateAction(const FJsonObject& Event, const FString& Token, const FString& Generation);
private:
    void PushSnapshot();
    TSharedPtr<SWebBrowser> Browser;
    FOnHaybaTranscriptAction OnAction;
    FString DocumentToken, Generation;
    TSharedPtr<FJsonObject> LatestSnapshot;
    FHaybaTranscriptUpdates Updates;
    double StartedAt = 0;
    bool bReady = false;
    bool bMessageUpdates = false;
    bool bFailed = false;
};
