#include "HaybaMCPModelDiscovery.h"

#include "HaybaMCPSettings.h"
#include "Editor.h"
#include "GenericPlatform/GenericPlatformHttp.h"
#include "HttpModule.h"
#include "Interfaces/IHttpResponse.h"
#include "Json.h"
#include "Misc/Guid.h"

namespace
{
    constexpr int32 MaxModels = 3000;
    constexpr int32 MaxResponseBytes = 4 * 1024 * 1024;

    FString JsonToString(const TSharedRef<FJsonObject>& Object)
    {
        FString Out;
        const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Out);
        FJsonSerializer::Serialize(Object, Writer);
        return Out;
    }

    bool SafeModelId(const FString& Id)
    {
        if (Id.IsEmpty() || Id.Len() > 256) return false;
        for (const TCHAR Character : Id)
            if (FChar::IsWhitespace(Character) || Character < 32 || Character == 127) return false;
        return true;
    }

    bool OptionalString(const TSharedPtr<FJsonObject>& Object, const TCHAR* Field, FString& Out)
    {
        const TSharedPtr<FJsonValue> Value = Object->TryGetField(Field);
        if (!Value.IsValid() || Value->IsNull()) { Out.Empty(); return true; }
        if (Value->Type != EJson::String) return false;
        Out = Value->AsString();
        return Out.Len() <= 1024;
    }

    bool ParseStatus(const FString& Value, EHaybaMCPModelDiscoveryStatus& Out)
    {
        if (Value == TEXT("ok")) Out = EHaybaMCPModelDiscoveryStatus::Ok;
        else if (Value == TEXT("partial")) Out = EHaybaMCPModelDiscoveryStatus::Partial;
        else if (Value == TEXT("no_key")) Out = EHaybaMCPModelDiscoveryStatus::NoKey;
        else if (Value == TEXT("manual")) Out = EHaybaMCPModelDiscoveryStatus::Manual;
        else if (Value == TEXT("unavailable")) Out = EHaybaMCPModelDiscoveryStatus::Unavailable;
        else return false;
        return true;
    }

    bool ParseCapability(const TSharedPtr<FJsonObject>& Item, FHaybaMCPDiscoveredModel& Model)
    {
        const TSharedPtr<FJsonValue> Chat = Item->TryGetField(TEXT("chat_capable"));
        if (Chat.IsValid() && !Chat->IsNull())
        {
            if (Chat->Type != EJson::Boolean) return false;
            Model.ChatCapability = Chat->AsBool()
                ? EHaybaMCPModelChatCapability::Yes : EHaybaMCPModelChatCapability::No;
        }
        const TSharedPtr<FJsonValue> Tools = Item->TryGetField(TEXT("tool_use"));
        if (Tools.IsValid() && !Tools->IsNull())
        {
            if (Tools->Type != EJson::String) return false;
            const FString Value = Tools->AsString();
            if (Value == TEXT("yes")) Model.ToolUse = EHaybaMCPModelToolUse::Yes;
            else if (Value == TEXT("no")) Model.ToolUse = EHaybaMCPModelToolUse::No;
            else if (Value == TEXT("unknown")) Model.ToolUse = EHaybaMCPModelToolUse::Unknown;
            else if (Value == TEXT("conditional")) Model.ToolUse = EHaybaMCPModelToolUse::Conditional;
            else if (Value == TEXT("trained")) Model.ToolUse = EHaybaMCPModelToolUse::Trained;
            // An added sidecar capability must never be presented as proven tool use.
            else Model.ToolUse = EHaybaMCPModelToolUse::Unknown;
        }
        const TSharedPtr<FJsonValue> Efforts = Item->TryGetField(TEXT("reasoning_efforts"));
        if (Efforts.IsValid() && !Efforts->IsNull())
        {
            if (Efforts->Type != EJson::Array || Efforts->AsArray().Num() > 16) return false;
            for (const TSharedPtr<FJsonValue>& Effort : Efforts->AsArray())
            {
                if (!Effort.IsValid() || Effort->Type != EJson::String ||
                    Effort->AsString().IsEmpty() || Effort->AsString().Len() > 64) return false;
                Model.ReasoningEfforts.Add(Effort->AsString());
            }
        }
        return true;
    }

    // HTTP completion may be inside FHttpManager's request iteration. Defer
    // cleanup so cancelling or finishing discovery never mutates that iterator.
    // The sidecar's short TTL is the backstop if the editor is already closing.
    void QueueSettingsConfigCleanup(const FString& BaseURL, const FString& SessionId)
    {
        if (!GEditor || BaseURL.IsEmpty() || SessionId.IsEmpty()) return;
        GEditor->GetTimerManager()->SetTimerForNextTick([BaseURL, SessionId]()
        {
            TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
            Request->SetURL(BaseURL + TEXT("/chat/config?session_id=") +
                FGenericPlatformHttp::UrlEncode(SessionId));
            Request->SetVerb(TEXT("DELETE"));
            Request->SetTimeout(5.f);
            Request->ProcessRequest();
        });
    }
}

FHaybaMCPModelDiscoveryClient::FHaybaMCPModelDiscoveryClient()
{
}

FHaybaMCPModelDiscoveryClient::~FHaybaMCPModelDiscoveryClient()
{
    Cancel();
}

bool FHaybaMCPModelDiscoveryClient::TryCanonicalLoopbackBase(const FString& SidecarURL, FString& OutBase)
{
    OutBase.Empty();
    FString Url = SidecarURL.TrimStartAndEnd();
    if (!Url.StartsWith(TEXT("http://"), ESearchCase::IgnoreCase)) return false;
    Url.RightChopInline(7);
    if (Url.EndsWith(TEXT("/"))) Url.LeftChopInline(1);
    // A sidecar base is an origin, never a URL carrying credentials, a path,
    // query, fragment, escaped hostname, or an arbitrary DNS name.
    if (Url.IsEmpty() || Url.Contains(TEXT("/")) || Url.Contains(TEXT("\\")) ||
        Url.Contains(TEXT("@")) || Url.Contains(TEXT("?")) || Url.Contains(TEXT("#")) ||
        Url.Contains(TEXT("%"))) return false;
    for (const TCHAR Character : Url)
        if (FChar::IsWhitespace(Character) || Character < 32 || Character == 127) return false;

    FString Host, PortText;
    if (Url.StartsWith(TEXT("[::1]")))
    {
        Host = TEXT("[::1]");
        PortText = Url.Mid(Host.Len());
    }
    else if (!Url.Split(TEXT(":"), &Host, &PortText))
    {
        Host = Url;
        PortText.Empty();
    }
    else
    {
        PortText = TEXT(":") + PortText;
    }
    const bool bIpv6 = Host == TEXT("[::1]");
    if (!bIpv6 && !Host.Equals(TEXT("localhost"), ESearchCase::IgnoreCase) && Host != TEXT("127.0.0.1"))
        return false;
    if (!PortText.IsEmpty())
    {
        if (!PortText.RemoveFromStart(TEXT(":")) || PortText.IsEmpty()) return false;
        for (const TCHAR Character : PortText)
            if (Character < TEXT('0') || Character > TEXT('9')) return false;
        int32 Port = 0;
        if (!LexTryParseString(Port, *PortText) || Port < 1 || Port > 65535) return false;
        PortText = FString::Printf(TEXT(":%d"), Port);
    }
    OutBase = FString(TEXT("http://")) + (bIpv6 ? TEXT("[::1]") : TEXT("127.0.0.1")) + PortText;
    return true;
}

bool FHaybaMCPModelDiscoveryClient::TryParseModels(const FString& Json, const FString& ExpectedProvider,
    FHaybaMCPModelDiscoveryResult& OutResult)
{
    OutResult = FHaybaMCPModelDiscoveryResult();
    FHaybaMCPModelDiscoveryResult Parsed;
    if (Json.Len() > MaxResponseBytes) return false;
    TSharedPtr<FJsonObject> Root;
    if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Json), Root) || !Root.IsValid()) return false;
    FString Provider, Status;
    if (!Root->TryGetStringField(TEXT("provider"), Provider) || Provider != ExpectedProvider ||
        !Root->TryGetStringField(TEXT("status"), Status) || !ParseStatus(Status, Parsed.Status)) return false;
    const TArray<TSharedPtr<FJsonValue>>* Items = nullptr;
    if (!Root->TryGetArrayField(TEXT("models"), Items) || !Items || Items->Num() > MaxModels ||
        !Root->TryGetBoolField(TEXT("stale"), Parsed.bStale) ||
        !Root->TryGetBoolField(TEXT("cached"), Parsed.bCached) ||
        !Root->TryGetBoolField(TEXT("partial"), Parsed.bPartial) ||
        !Root->TryGetBoolField(TEXT("manual_entry_allowed"), Parsed.bManualEntryAllowed) ||
        !OptionalString(Root, TEXT("fetched_at"), Parsed.FetchedAt) ||
        !OptionalString(Root, TEXT("configured_model"), Parsed.ConfiguredModel) ||
        !OptionalString(Root, TEXT("default_model"), Parsed.DefaultModel) ||
        !OptionalString(Root, TEXT("reason"), Parsed.Reason) ||
        !OptionalString(Root, TEXT("note"), Parsed.Note)) return false;
    TSet<FString> Seen;
    for (const TSharedPtr<FJsonValue>& Value : *Items)
    {
        const TSharedPtr<FJsonObject> Item = Value.IsValid() ? Value->AsObject() : nullptr;
        FString Id;
        if (!Item.IsValid() || !Item->TryGetStringField(TEXT("id"), Id) || !SafeModelId(Id)) return false;
        if (Seen.Contains(Id)) continue;
        Seen.Add(Id);
        FString Name;
        if (!OptionalString(Item, TEXT("name"), Name)) return false;
        FHaybaMCPDiscoveredModel& Model = Parsed.Models.AddDefaulted_GetRef();
        Model.Id = Id;
        Model.Name = Name.IsEmpty() ? Id : Name;
        if (!ParseCapability(Item, Model)) return false;
    }
    Parsed.Provider = Provider;
    OutResult = MoveTemp(Parsed);
    return true;
}

void FHaybaMCPModelDiscoveryClient::Cancel()
{
    ++Generation;
    Completion = nullptr;
    if (ActiveRequest.IsValid())
    {
        ActiveRequest->OnProcessRequestComplete().Unbind();
        ActiveRequest->CancelRequest();
        ActiveRequest.Reset();
    }
    QueueSettingsConfigCleanup(BaseURL, SessionId);
    BaseURL.Empty();
    SessionId.Empty();
}

void FHaybaMCPModelDiscoveryClient::Finish(uint64 RequestGeneration, FHaybaMCPModelDiscoveryResult Result)
{
    if (RequestGeneration != Generation) return;
    ActiveRequest.Reset();
    QueueSettingsConfigCleanup(BaseURL, SessionId);
    BaseURL.Empty();
    SessionId.Empty();
    FCompletion Callback = MoveTemp(Completion);
    Completion = nullptr;
    if (Callback) Callback(MoveTemp(Result));
}

void FHaybaMCPModelDiscoveryClient::DiscoverSavedSettings(bool bRefresh, FCompletion OnComplete)
{
    Cancel();
    Completion = MoveTemp(OnComplete);
    const uint64 RequestGeneration = Generation;
    const FHaybaMCPSettings& Settings = FHaybaMCPSettings::Get();
    RequestedProvider = Settings.SelectedProviderId;
    FHaybaMCPModelDiscoveryResult Failure;
    Failure.Provider = RequestedProvider;
    if (!TryCanonicalLoopbackBase(Settings.SidecarURL, BaseURL))
    {
        Failure.Error = TEXT("Model discovery requires a local Hayba sidecar URL.");
        Finish(RequestGeneration, MoveTemp(Failure));
        return;
    }
    if (!FHaybaMCPSettings::FindProvider(RequestedProvider))
    {
        Failure.Error = TEXT("Choose a supported provider before listing models.");
        Finish(RequestGeneration, MoveTemp(Failure));
        return;
    }

    // One identifier per discovery attempt prevents a late DELETE from a
    // cancelled request revoking a newer configuration for this panel.
    SessionId = FString::Printf(TEXT("ue_settings_%s"), *FGuid::NewGuid().ToString(EGuidFormats::Digits));

    TSharedRef<FJsonObject> Body = MakeShared<FJsonObject>();
    Body->SetStringField(TEXT("session_id"), SessionId);
    Body->SetStringField(TEXT("provider"), RequestedProvider);
    Body->SetStringField(TEXT("model"), Settings.Model);
    Body->SetStringField(TEXT("base_url"), Settings.BaseURL);
    const FString Key = FHaybaMCPSettings::GetProviderKey(RequestedProvider);
    if (!Key.IsEmpty()) Body->SetStringField(TEXT("api_key"), Key);

    TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
    ActiveRequest = Request;
    Request->SetURL(BaseURL + TEXT("/chat/config"));
    Request->SetVerb(TEXT("POST"));
    Request->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
    Request->SetContentAsString(JsonToString(Body)); // contains the key; never log it
    Request->SetTimeout(10.f);
    TWeakPtr<FHaybaMCPModelDiscoveryClient> WeakSelf = AsShared();
    Request->OnProcessRequestComplete().BindLambda(
        [WeakSelf, RequestGeneration, bRefresh](FHttpRequestPtr, FHttpResponsePtr Response, bool bConnected)
        {
            const TSharedPtr<FHaybaMCPModelDiscoveryClient> Self = WeakSelf.Pin();
            if (!Self.IsValid() || RequestGeneration != Self->Generation) return;
            Self->ActiveRequest.Reset();
            if (!bConnected || !Response.IsValid() || Response->GetResponseCode() != 200)
            {
                FHaybaMCPModelDiscoveryResult Failure;
                Failure.Provider = Self->RequestedProvider;
                Failure.Error = TEXT("Could not configure the local model catalog.");
                Self->Finish(RequestGeneration, MoveTemp(Failure));
                return;
            }
            TSharedPtr<FJsonObject> Confirmation;
            FString ConfirmedProvider;
            bool bOk = false;
            if (Response->GetContent().Num() > 64 * 1024 || !FJsonSerializer::Deserialize(
                    TJsonReaderFactory<>::Create(Response->GetContentAsString()), Confirmation) ||
                !Confirmation.IsValid() || !Confirmation->TryGetBoolField(TEXT("ok"), bOk) || !bOk ||
                !Confirmation->TryGetStringField(TEXT("provider"), ConfirmedProvider) ||
                ConfirmedProvider != Self->RequestedProvider)
            {
                FHaybaMCPModelDiscoveryResult Failure;
                Failure.Provider = Self->RequestedProvider;
                Failure.Error = TEXT("The local sidecar did not confirm the model configuration.");
                Self->Finish(RequestGeneration, MoveTemp(Failure));
                return;
            }
            // HTTP completion runs inside FHttpManager's request iteration.
            // Starting GET there can invalidate that iterator; defer one tick.
            if (!GEditor)
            {
                FHaybaMCPModelDiscoveryResult Failure;
                Failure.Provider = Self->RequestedProvider;
                Failure.Error = TEXT("Editor is closing.");
                Self->Finish(RequestGeneration, MoveTemp(Failure));
                return;
            }
            GEditor->GetTimerManager()->SetTimerForNextTick([WeakSelf, RequestGeneration, bRefresh]()
            {
                if (const TSharedPtr<FHaybaMCPModelDiscoveryClient> Client = WeakSelf.Pin())
                    if (RequestGeneration == Client->Generation) Client->StartModelsGet(RequestGeneration, bRefresh);
            });
        });
    if (!Request->ProcessRequest())
    {
        Failure.Error = TEXT("Could not start the local model catalog request.");
        Finish(RequestGeneration, MoveTemp(Failure));
    }
}

void FHaybaMCPModelDiscoveryClient::StartModelsGet(uint64 RequestGeneration, bool bRefresh)
{
    if (RequestGeneration != Generation) return;
    const FString Url = BaseURL + TEXT("/chat/models?provider=") +
        FGenericPlatformHttp::UrlEncode(RequestedProvider) + TEXT("&session_id=") +
        FGenericPlatformHttp::UrlEncode(SessionId) + (bRefresh ? TEXT("&refresh=1") : TEXT(""));
    TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
    ActiveRequest = Request;
    Request->SetURL(Url);
    Request->SetVerb(TEXT("GET"));
    Request->SetTimeout(60.f);
    TWeakPtr<FHaybaMCPModelDiscoveryClient> WeakSelf = AsShared();
    Request->OnProcessRequestComplete().BindLambda(
        [WeakSelf, RequestGeneration](FHttpRequestPtr, FHttpResponsePtr Response, bool bConnected)
        {
            const TSharedPtr<FHaybaMCPModelDiscoveryClient> Self = WeakSelf.Pin();
            if (!Self.IsValid() || RequestGeneration != Self->Generation) return;
            FHaybaMCPModelDiscoveryResult Result;
            Result.Provider = Self->RequestedProvider;
            if (!bConnected || !Response.IsValid() || Response->GetResponseCode() != 200)
                Result.Error = TEXT("Could not reach the local model catalog.");
            else if (Response->GetContent().Num() > MaxResponseBytes ||
                !TryParseModels(Response->GetContentAsString(), Self->RequestedProvider, Result))
            {
                Result.Provider = Self->RequestedProvider;
                Result.Error = TEXT("The local model catalog returned an unexpected response.");
            }
            Self->Finish(RequestGeneration, MoveTemp(Result));
        });
    if (!Request->ProcessRequest())
    {
        FHaybaMCPModelDiscoveryResult Failure;
        Failure.Provider = RequestedProvider;
        Failure.Error = TEXT("Could not start the local model catalog request.");
        Finish(RequestGeneration, MoveTemp(Failure));
    }
}
