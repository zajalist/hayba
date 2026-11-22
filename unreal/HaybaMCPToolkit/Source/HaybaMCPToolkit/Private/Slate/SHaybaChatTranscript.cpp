#include "Slate/SHaybaChatTranscript.h"
#include "SWebBrowser.h"
#include "IWebBrowserWindow.h"
#include "Interfaces/IPluginManager.h"
#include "GenericPlatform/GenericPlatformHttp.h"
#include "Misc/Paths.h"
#include "HAL/PlatformTime.h"
#include "Async/Async.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

FString FHaybaTranscriptUpdates::Serialize(const TSharedRef<FJsonObject>& Snapshot)
{
    const FString NextGeneration = Snapshot->GetStringField(TEXT("generation"));
    const bool bFull = Revision == 0 || Revision == MAX_int32 || Generation != NextGeneration;
    if (bFull) Reset();
    const auto& Messages = Snapshot->GetArrayField(TEXT("messages"));
    TArray<FString> NextRows;
    TArray<TSharedPtr<FJsonValue>> Changed;
    NextRows.Reserve(Messages.Num());
    for (int32 Index = 0; Index < Messages.Num(); ++Index)
    {
        FString Json;
        FJsonSerializer::Serialize(Messages[Index]->AsObject().ToSharedRef(), TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Json));
        if (bFull || !Rows.IsValidIndex(Index) || Rows[Index] != Json) Changed.Add(Messages[Index]);
        NextRows.Add(MoveTemp(Json));
    }
    auto Payload = MakeShared<FJsonObject>();
    Payload->Values = Snapshot->Values;
    Payload->SetBoolField(TEXT("supportsMessageUpdates"), true);
    if (!bFull)
    {
        Payload->RemoveField(TEXT("messages"));
        auto Patch = MakeShared<FJsonObject>();
        Patch->SetNumberField(TEXT("base"), Revision);
        Patch->SetNumberField(TEXT("length"), Messages.Num());
        Patch->SetArrayField(TEXT("updates"), Changed);
        Payload->SetObjectField(TEXT("messagePatch"), Patch);
    }
    Payload->SetNumberField(TEXT("revision"), ++Revision);
    Generation = NextGeneration;
    Rows = MoveTemp(NextRows);
    FString Json;
    FJsonSerializer::Serialize(Payload, TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Json));
    Json.ReplaceInline(TEXT("\u2028"), TEXT("\\u2028"));
    Json.ReplaceInline(TEXT("\u2029"), TEXT("\\u2029"));
    return Json;
}

bool SHaybaChatTranscript::ValidateAction(const FJsonObject& Event, const FString& Token, const FString& CurrentGeneration)
{
    FString ReceivedToken, ReceivedGeneration, Action, Value;
    if (Token.IsEmpty() || !Event.HasTypedField<EJson::String>(TEXT("token")) || !Event.HasTypedField<EJson::String>(TEXT("generation")) ||
        !Event.HasTypedField<EJson::String>(TEXT("action")) || !Event.HasTypedField<EJson::String>(TEXT("value")) ||
        !Event.TryGetStringField(TEXT("token"), ReceivedToken) || ReceivedToken != Token ||
        !Event.TryGetStringField(TEXT("action"), Action) || !Event.TryGetStringField(TEXT("value"), Value) ||
        !Event.TryGetStringField(TEXT("generation"), ReceivedGeneration)) return false;
    if (Action == TEXT("ready")) return Event.Values.Num() == 4 && ReceivedGeneration.IsEmpty() && Value.IsEmpty();
    // Recovery must work when the snapshot introducing a new generation was lost.
    if (Action == TEXT("resync")) return Event.Values.Num() == 4 && Value.IsEmpty();
    if (CurrentGeneration.IsEmpty() || ReceivedGeneration != CurrentGeneration) return false;
    static const TSet<FString> Allowed = { TEXT("copy"), TEXT("link"), TEXT("draft"), TEXT("inspect"),
        TEXT("retry"), TEXT("community"), TEXT("approve"), TEXT("reject"), TEXT("send"), TEXT("draft_changed"),
        TEXT("stop"), TEXT("new"), TEXT("history"), TEXT("session"), TEXT("models"), TEXT("model"), TEXT("effort"),
        TEXT("mode"), TEXT("settings"), TEXT("activity"), TEXT("diagnostics"), TEXT("resync"), TEXT("enable_updates"), TEXT("attach_selection"), TEXT("attach_file"),
        TEXT("remove_context"), TEXT("fab_browser"), TEXT("connections"), TEXT("connect_provider"), TEXT("disconnect_provider"),
        TEXT("generate_3d"), TEXT("refresh_3d"), TEXT("open_result"), TEXT("use_result"),
        TEXT("subagents"), TEXT("cancel_subagent"), TEXT("use_subagent_result") };
    if (!Allowed.Contains(Action) || Value.Len() > 262144) return false;
    const bool bDraft = Action == TEXT("send") || Action == TEXT("draft_changed");
    const bool bGeneration = Action == TEXT("generate_3d");
    const bool bApproval = Action == TEXT("approve") || Action == TEXT("reject");
    for (const auto& Field : Event.Values)
    {
        if (!Field.Value.IsValid()) return false;
        if (Field.Key == TEXT("seq") && bDraft)
        {
            double Seq;
            if (Field.Value->Type != EJson::Number || !Field.Value->TryGetNumber(Seq) || !FMath::IsFinite(Seq) || Seq < 0 || Seq > 9007199254740991.0 || FMath::FloorToDouble(Seq) != Seq) return false;
        }
        else if (Field.Key == TEXT("approval") && bApproval)
        { FString Id; if (Field.Value->Type != EJson::String || !Field.Value->TryGetString(Id) || Id.IsEmpty() || Id.Len() > 256) return false; }
        else if (bGeneration && (Field.Key == TEXT("prompt") || Field.Key == TEXT("model") || Field.Key == TEXT("style") ||
            Field.Key == TEXT("image_url") || Field.Key == TEXT("preview_task_id") || Field.Key == TEXT("kind")))
        { FString Item; if (Field.Value->Type != EJson::String || !Field.Value->TryGetString(Item) || Item.Len() > (Field.Key == TEXT("prompt") ? 8000 : 2048)) return false; }
        else if (Action == TEXT("history") && Field.Key == TEXT("query"))
        { FString Query; if (Field.Value->Type != EJson::String || !Field.Value->TryGetString(Query) || Query.Len() > 200) return false; }
        else if (Action == TEXT("history") && Field.Key == TEXT("offset"))
        { double Offset; if (Field.Value->Type != EJson::Number || !Field.Value->TryGetNumber(Offset) || !FMath::IsFinite(Offset) || Offset < 0 || Offset > MAX_int32 - 50 || FMath::FloorToDouble(Offset) != Offset) return false; }
        else if (Field.Key != TEXT("token") && Field.Key != TEXT("generation") && Field.Key != TEXT("action") && Field.Key != TEXT("value")) return false;
    }
    if (bDraft && !Event.HasTypedField<EJson::Number>(TEXT("seq"))) return false;
    if (bApproval && !Event.HasTypedField<EJson::String>(TEXT("approval"))) return false;
    if (Action == TEXT("connect_provider") || Action == TEXT("disconnect_provider") || bGeneration)
        return Value == TEXT("meshy") || Value == TEXT("tripo") || Value == TEXT("aholo") || Value == TEXT("fal") || Value == TEXT("worldlabs");
    return true;
}

void SHaybaChatTranscript::Construct(const FArguments& Args)
{
    OnAction = Args._OnAction;
    DocumentToken = FGuid::NewGuid().ToString(EGuidFormats::Digits);
    StartedAt = FPlatformTime::Seconds();
    const TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("HaybaMCPToolkit"));
    const FString Path = Plugin.IsValid() ? FPaths::ConvertRelativePathToFull(Plugin->GetBaseDir() / TEXT("Resources/chat/index.html")) : FString();
    if (Path.IsEmpty() || !FPaths::FileExists(Path)) { bFailed = true; return; }
    const FString Url = TEXT("file:///") + Path.Replace(TEXT("\\"), TEXT("/"));
    TWeakPtr<SHaybaChatTranscript> Weak = SharedThis(this);
    ChildSlot
    [
        SAssignNew(Browser, SWebBrowser)
        .InitialURL(Url).ShowControls(false).ShowAddressBar(false).SupportsTransparency(false)
        .OnBeforePopup_Lambda([](FString, FString) { return true; })
        .OnBeforeNavigation_Lambda([Weak, Url](const FString& Target, const FWebNavigationRequest& Request)
        {
            const FString Prefix = TEXT("hayba-chat://event/");
            if (Target.StartsWith(Prefix))
            {
                if (!Request.bIsMainFrame || Target.Len() > 1600000) return true;
                const FString Json = FGenericPlatformHttp::UrlDecode(Target.Mid(Prefix.Len()));
                TSharedPtr<FJsonObject> Event;
                if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Json), Event) || !Event.IsValid()) return true;
                AsyncTask(ENamedThreads::GameThread, [Weak, Event]()
                {
                    const auto Self = Weak.Pin();
                    if (!Self || Self->bFailed) return;
                    const bool bValid = ValidateAction(*Event, Self->DocumentToken, Self->Generation);
                    FString Action;
                    Event->TryGetStringField(TEXT("action"), Action);
                    if (bValid)
                    {
                        if (Event->GetStringField(TEXT("action")) == TEXT("ready"))
                        { Self->bReady = true; Self->bMessageUpdates = false; Self->Updates.Reset(); Self->PushSnapshot(); }
                        else if (Action == TEXT("resync")) { Self->Updates.Reset(); Self->PushSnapshot(); }
                        else if (Action == TEXT("enable_updates")) Self->bMessageUpdates = true;
                        else if (Self->bReady) Self->OnAction.ExecuteIfBound(*Event);
                    }
                    if (Action == TEXT("copy"))
                    { if (!bValid || !Self->bReady) Self->AcknowledgeCopy(false); }
                    else if (Action == TEXT("resync") && Self->Browser)
                        Self->Browser->ExecuteJavascript(TEXT("window.haybaChat && window.haybaChat.ack({action:'resync'});"));
                    else if (Self->Browser) Self->Browser->ExecuteJavascript(TEXT("window.haybaChat && window.haybaChat.ack();"));
                });
                return true;
            }
            const auto Self = Weak.Pin();
            // The local document is loaded once. Block all other navigation, including reloads.
            return !Self || Self->bReady || !Request.bIsMainFrame ||
                !(Target.Equals(Url, ESearchCase::IgnoreCase) || FGenericPlatformHttp::UrlDecode(Target).Equals(Url, ESearchCase::IgnoreCase));
        })
        .OnLoadCompleted_Lambda([Weak]()
        {
            if (const auto Self = Weak.Pin())
                Self->Browser->ExecuteJavascript(FString::Printf(TEXT("window.haybaChat && window.haybaChat.init('%s');"), *Self->DocumentToken));
        })
        .OnLoadError_Lambda([Weak]() { if (const auto Self = Weak.Pin()) { Self->bFailed = true; Self->bReady = false; } })
    ];
}

void SHaybaChatTranscript::AcknowledgeCopy(bool bSucceeded)
{
    if (Browser) Browser->ExecuteJavascript(bSucceeded
        ? TEXT("window.haybaChat && window.haybaChat.ack({action:'copy',ok:true});")
        : TEXT("window.haybaChat && window.haybaChat.ack({action:'copy',ok:false});"));
}

void SHaybaChatTranscript::Tick(const FGeometry& Geometry, double Time, float Delta)
{
    SCompoundWidget::Tick(Geometry, Time, Delta);
    if (!bReady && FPlatformTime::Seconds() - StartedAt > 8.0) bFailed = true;
}

void SHaybaChatTranscript::SetSnapshot(const TSharedRef<FJsonObject>& Snapshot)
{
    Generation = Snapshot->GetStringField(TEXT("generation"));
    LatestSnapshot = Snapshot;
    if (IsReady()) PushSnapshot();
}

void SHaybaChatTranscript::PushSnapshot()
{
    if (Browser && LatestSnapshot.IsValid())
    {
        // Older documents still receive full snapshots until they explicitly opt in.
        if (!bMessageUpdates) Updates.Reset();
        Browser->ExecuteJavascript(TEXT("window.haybaChat.receive(") + Updates.Serialize(LatestSnapshot.ToSharedRef()) + TEXT(");"));
    }
}
