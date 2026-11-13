#include "HaybaMCPChatPanel.h"
#include "HaybaMCPAgentClient.h"
#include "Async/Async.h"
#include "HttpModule.h"
#include "Interfaces/IHttpResponse.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Framework/Application/SlateApplication.h"
#include "Widgets/SWindow.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Input/SEditableTextBox.h"
#include "Widgets/Input/SButton.h"
#include "Editor.h"
#include "TimerManager.h"
#include "HAL/PlatformTime.h"

namespace
{
    bool Is3DProvider(const FString& Provider)
    {
        return Provider == TEXT("meshy") || Provider == TEXT("tripo") || Provider == TEXT("aholo") || Provider == TEXT("fal") || Provider == TEXT("worldlabs");
    }

    bool Safe3DUrl(const FString& Url)
    {
        return Url.StartsWith(TEXT("https://"), ESearchCase::IgnoreCase) && HaybaChatText::IsSafeWebLink(Url);
    }
}

void SHaybaMCPChatPanel::Configure3DProvider(const FString& Provider)
{
    if (!Is3DProvider(Provider) || !FSlateApplication::IsInitialized() || bGeneration3DBusy ||
        Generation3DJobs.ContainsByPredicate([&Provider](const FGeneration3DJob& Job)
            { return Job.Provider == Provider && (Job.Status == TEXT("queued") || Job.Status == TEXT("running")); })) return;
    const FString Generation = TranscriptGeneration;
    TSharedRef<SWindow> Window = SNew(SWindow).Title(FText::FromString(TEXT("Configure ") + Provider))
        .ClientSize(FVector2D(440, 158)).SupportsMinimize(false).SupportsMaximize(false);
    TSharedRef<SEditableTextBox> KeyInput = SNew(SEditableTextBox).IsPassword(true)
        .HintText(FText::FromString(TEXT("Paste provider API key")));
    TWeakPtr<SWindow> WeakWindow = Window;
    TWeakPtr<SHaybaMCPChatPanel> Weak = SharedThis(this);
    Window->SetContent(SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight().Padding(16, 12)
        [ SNew(STextBlock).Text(FText::FromString(TEXT("API key is stored in the native encrypted credential vault."))).AutoWrapText(true) ]
        + SVerticalBox::Slot().AutoHeight().Padding(16, 0)
        [ KeyInput ]
        + SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Right).Padding(16, 12)
        [ SNew(SHorizontalBox)
            + SHorizontalBox::Slot().AutoWidth().Padding(4, 0)
            [ SNew(SButton).Text(FText::FromString(TEXT("Cancel"))).OnClicked_Lambda([WeakWindow, KeyInput]()
                { KeyInput->SetText(FText::GetEmpty()); if (const auto Dialog = WeakWindow.Pin()) Dialog->RequestDestroyWindow(); return FReply::Handled(); }) ]
            + SHorizontalBox::Slot().AutoWidth()
            [ SNew(SButton).Text(FText::FromString(TEXT("Save and verify")))
                .IsEnabled_Lambda([KeyInput]() { return !KeyInput->GetText().IsEmpty() && KeyInput->GetText().ToString().Len() <= 4096; })
                .OnClicked_Lambda([Weak, WeakWindow, KeyInput, Provider, Generation]()
                {
                    if (const auto Self = Weak.Pin())
                    {
                        if (Self->TranscriptGeneration == Generation && Self->CanSend() && !Self->bInspectInFlight)
                        {
                            const FString Key = KeyInput->GetText().ToString().TrimStartAndEnd();
                            if (!Key.IsEmpty() && Key.Len() <= 4096)
                            {
                                ++Self->ConnectionGenerations.FindOrAdd(Provider);
                                FHaybaMCPSettings::SetProviderKey(TEXT("3d-") + Provider, Key);
                                Self->ConnectionStates.Add(Provider, TEXT("configured"));
                                Self->Check3DConnection(Provider);
                            }
                        }
                    }
                    KeyInput->SetText(FText::GetEmpty());
                    if (const auto Dialog = WeakWindow.Pin()) Dialog->RequestDestroyWindow();
                    return FReply::Handled();
                }) ] ]);
    Window->SetOnWindowClosed(FOnWindowClosed::CreateLambda([KeyInput](const TSharedRef<SWindow>&) { KeyInput->SetText(FText::GetEmpty()); }));
    FSlateApplication::Get().AddModalWindow(Window, FSlateApplication::Get().FindWidgetWindow(AsShared()));
}

void SHaybaMCPChatPanel::Request3D(const FString& Provider, const FString& Path, const TSharedRef<FJsonObject>& Body,
    TFunction<void(TSharedPtr<FJsonObject>, FString)> Completion)
{
    FString Base;
    if (!Is3DProvider(Provider) || !FHaybaMCPModelDiscoveryClient::TryCanonicalLoopbackBase(FHaybaMCPSettings::Get().SidecarURL, Base))
    { Completion(nullptr, TEXT("Generation connections require a local Hayba sidecar.")); return; }
    const uint32 CredentialGeneration = ConnectionGenerations.FindOrAdd(Provider);
    const auto Complete = MakeShared<TFunction<void(TSharedPtr<FJsonObject>, FString)>>(MoveTemp(Completion));
    TWeakPtr<SHaybaMCPChatPanel> Weak = SharedThis(this);
    const auto Identity = FHttpModule::Get().CreateRequest();
    const FString HealthUrl = Base / TEXT("api/health");
    Identity->SetURL(HealthUrl); Identity->SetVerb(TEXT("GET")); Identity->SetTimeout(5.f);
    Identity->OnProcessRequestComplete().BindLambda([Weak, Provider, Base, Path, Body, Complete, HealthUrl, CredentialGeneration](FHttpRequestPtr Req, FHttpResponsePtr Response, bool bConnected)
    {
        AsyncTask(ENamedThreads::GameThread, [Weak, Provider, Base, Path, Body, Complete, HealthUrl, CredentialGeneration, Req, Response, bConnected]()
        {
            const auto Self = Weak.Pin();
            if (!Self) return;
            TSharedPtr<FJsonObject> Health;
            const bool bCompatible = bConnected && Req && Response && Req->GetEffectiveURL() == HealthUrl &&
                Response->GetResponseCode() == 200 && Response->GetContent().Num() <= 4096 &&
                FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Response->GetContentAsString()), Health) &&
                Health && FHaybaMCPAgentClient::HasCompatibleSidecarIdentity(*Health);
            if (!bCompatible || !GEditor)
            { (*Complete)(nullptr, TEXT("The local sidecar did not confirm a compatible Hayba identity. No provider key was sent.")); return; }
            // Defer nested HTTP creation until the HTTP manager finishes its iteration.
            GEditor->GetTimerManager()->SetTimerForNextTick([Weak, Provider, Base, Path, Body, Complete, CredentialGeneration]()
            {
                const auto Current = Weak.Pin();
                if (!Current) return;
                if (Current->ConnectionGenerations.FindRef(Provider) != CredentialGeneration)
                { (*Complete)(nullptr, TEXT("Provider configuration changed. Retry the request.")); return; }
                const FString Key = FHaybaMCPSettings::GetProviderKey(TEXT("3d-") + Provider);
                if (Key.IsEmpty()) { (*Complete)(nullptr, TEXT("Configure the provider API key first.")); return; }
                auto Payload = MakeShared<FJsonObject>();
                Payload->Values = Body->Values;
                Payload->SetStringField(TEXT("provider"), Provider);
                Payload->SetStringField(TEXT("api_key"), Key);
                FString Json;
                FJsonSerializer::Serialize(Payload, TJsonWriterFactory<>::Create(&Json));
                const auto Request = FHttpModule::Get().CreateRequest();
                const FString Url = Base / Path;
                Request->SetURL(Url); Request->SetVerb(TEXT("POST")); Request->SetTimeout(45.f);
                Request->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
                Request->SetContentAsString(Json); // Native memory only; never bridge or log this body.
                Request->OnProcessRequestComplete().BindLambda([Weak, Complete, Url](FHttpRequestPtr Sent, FHttpResponsePtr Result, bool bOk)
                {
                    AsyncTask(ENamedThreads::GameThread, [Weak, Complete, Url, Sent, Result, bOk]()
                    {
                        if (!Weak.IsValid()) return;
                        TSharedPtr<FJsonObject> Parsed;
                        if (!bOk || !Sent || !Result || Sent->GetEffectiveURL() != Url || Result->GetResponseCode() < 200 ||
                            Result->GetResponseCode() >= 300 || Result->GetContent().Num() > 64 * 1024 ||
                            !FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Result->GetContentAsString()), Parsed) || !Parsed)
                        {
                            (*Complete)(nullptr, FString::Printf(TEXT("Generation request failed (HTTP %d). Check your key, provider credits and sidecar connection."), Result ? Result->GetResponseCode() : 0));
                            return;
                        }
                        (*Complete)(Parsed, FString());
                    });
                });
                if (!Request->ProcessRequest()) (*Complete)(nullptr, TEXT("Could not start the local generation request."));
            });
        });
    });
    if (!Identity->ProcessRequest()) (*Complete)(nullptr, TEXT("Could not check the local sidecar identity."));
}

void SHaybaMCPChatPanel::Check3DConnection(const FString& Provider)
{
    if (!Is3DProvider(Provider) || ConnectionStates.FindRef(Provider) == TEXT("checking")) return;
    ConnectionStates.Add(Provider, TEXT("checking")); ConnectionMessages.Remove(Provider); bTranscriptDirty = true;
    const uint32 Generation = ConnectionGenerations.FindOrAdd(Provider);
    TWeakPtr<SHaybaMCPChatPanel> Weak = SharedThis(this);
    Request3D(Provider, TEXT("chat/generation/connection"), MakeShared<FJsonObject>(), [Weak, Provider, Generation](TSharedPtr<FJsonObject> Result, FString Error)
    {
        if (const auto Self = Weak.Pin())
        {
            if (Self->ConnectionGenerations.FindRef(Provider) != Generation) return;
            bool bVerified = false; FString ReturnedProvider, Status;
            if (Result) Result->TryGetStringField(TEXT("provider"), ReturnedProvider);
            const bool bOk = Result && Result->TryGetBoolField(TEXT("verified"), bVerified) && bVerified &&
                ReturnedProvider == Provider;
            const bool bConfigured = !bOk && Result && Provider == TEXT("fal") && ReturnedProvider == Provider &&
                Result->TryGetStringField(TEXT("status"), Status) && Status == TEXT("configured") && !bVerified;
            Self->ConnectionStates.Add(Provider, bOk ? TEXT("verified") : bConfigured ? TEXT("configured") : TEXT("error"));
            Self->ConnectionMessages.Add(Provider, bOk ? TEXT("Provider accepted your key.") : bConfigured
                ? TEXT("Key saved. This provider requires a paid request to verify it.") : Error.IsEmpty() ? TEXT("The provider did not verify this key.") : Error);
            Self->bTranscriptDirty = true;
        }
    });
}

void SHaybaMCPChatPanel::Start3DGeneration(const FJsonObject& Event)
{
    const FString Provider = Event.GetStringField(TEXT("value"));
    if (!Is3DProvider(Provider) || bGeneration3DBusy || Generation3DJobs.Num() >= 32) return;
    auto Body = MakeShared<FJsonObject>();
    FString Prompt, Image, Preview;
    Event.TryGetStringField(TEXT("prompt"), Prompt); Event.TryGetStringField(TEXT("image_url"), Image);
    Event.TryGetStringField(TEXT("preview_task_id"), Preview);
    const FString Kind = Provider == TEXT("fal") ? TEXT("video") : Provider == TEXT("worldlabs") ? TEXT("splat") : TEXT("model");
    FString RequestedKind;
    if (Event.TryGetStringField(TEXT("kind"), RequestedKind) && RequestedKind != Kind) return;
    if (Kind != TEXT("model") && (!Image.IsEmpty() || !Preview.IsEmpty() || Event.HasField(TEXT("style")))) return;
    if ((Prompt.TrimStartAndEnd().IsEmpty() && Image.IsEmpty() && Preview.IsEmpty()) || (!Image.IsEmpty() && !Safe3DUrl(Image)))
    { Generation3DError = TEXT("Enter a prompt or a public HTTPS reference image."); bTranscriptDirty = true; return; }
    // Refinement is only available for a preview produced in this tab; never auto-start a billed refine.
    if (!Preview.IsEmpty() && !Generation3DJobs.ContainsByPredicate([&Provider, &Preview](const FGeneration3DJob& Job)
        { return Provider == TEXT("meshy") && Job.Provider == Provider && Job.TaskId == Preview && Job.Phase == TEXT("preview") && Job.Status == TEXT("succeeded"); })) return;
    for (const FString& Field : { FString(TEXT("prompt")), FString(TEXT("model")), FString(TEXT("style")), FString(TEXT("image_url")), FString(TEXT("preview_task_id")) })
    { FString Value; if (Event.TryGetStringField(Field, Value) && !Value.IsEmpty()) Body->SetStringField(Field, Value); }
    FGeneration3DJob Job;
    Job.Id = FGuid::NewGuid().ToString(EGuidFormats::Digits); Job.Provider = Provider; Job.Prompt = Prompt; Job.Kind = Kind;
    Job.Status = TEXT("queued"); Job.StartedAt = FPlatformTime::Seconds(); Job.bRequestInFlight = true;
    const FString Id = Job.Id;
    Generation3DJobs.Add(MoveTemp(Job));
    bGeneration3DBusy = true; Generation3DError.Empty(); bTranscriptDirty = true;
    TWeakPtr<SHaybaMCPChatPanel> Weak = SharedThis(this);
    Request3D(Provider, TEXT("chat/generation/tasks"), Body, [Weak, Id](TSharedPtr<FJsonObject> Result, FString Error)
    {
        if (const auto Self = Weak.Pin()) Self->Apply3DResult(Id, Result, Error);
    });
}

void SHaybaMCPChatPanel::Apply3DResult(const FString& Id, const TSharedPtr<FJsonObject>& Result, const FString& Error)
{
    FGeneration3DJob* Job = Generation3DJobs.FindByPredicate([&Id](const FGeneration3DJob& Item) { return Item.Id == Id; });
    if (!Job) return;
    Job->bRequestInFlight = false; Job->NextPollAt = FPlatformTime::Seconds() + 4;
    bTranscriptDirty = true;
    const auto UpdateBusy = [this]()
    {
        bGeneration3DBusy = Generation3DJobs.ContainsByPredicate([](const FGeneration3DJob& Item)
            { return Item.Status == TEXT("queued") || Item.Status == TEXT("running"); });
    };
    FString Provider, TaskId, Status, Kind;
    if (!Result || !Error.IsEmpty() || !Result->TryGetStringField(TEXT("provider"), Provider) || Provider != Job->Provider ||
        !Result->TryGetStringField(TEXT("task_id"), TaskId) || TaskId.IsEmpty() || TaskId.Len() > 512 ||
        (!Job->TaskId.IsEmpty() && TaskId != Job->TaskId) || (Result->TryGetStringField(TEXT("kind"), Kind) && Kind != Job->Kind) || !Result->TryGetStringField(TEXT("status"), Status) ||
        (Status != TEXT("queued") && Status != TEXT("running") && Status != TEXT("succeeded") && Status != TEXT("failed") && Status != TEXT("cancelled")))
    {
        Job->Status = TEXT("failed"); Job->Error = Error.IsEmpty() ? TEXT("The sidecar returned an invalid generation task.") : Error;
        Generation3DError = Job->Error;
        UpdateBusy();
        return;
    }
    Job->TaskId = TaskId; Job->Status = Status;
    Job->bProgressKnown = Result->TryGetNumberField(TEXT("progress"), Job->Progress) && FMath::IsFinite(Job->Progress);
    Job->Progress = FMath::Clamp(Job->Progress, 0.0, 100.0);
    FString Url;
    if (Result->TryGetStringField(TEXT("model_url"), Url) && Safe3DUrl(Url)) Job->ModelUrl = Url;
    if (Result->TryGetStringField(TEXT("result_url"), Url) && Safe3DUrl(Url)) Job->ResultUrl = Url;
    if (Job->ResultUrl.IsEmpty()) Job->ResultUrl = Job->ModelUrl;
    if (Result->TryGetStringField(TEXT("thumbnail_url"), Url) && Safe3DUrl(Url)) Job->ThumbnailUrl = Url;
    Result->TryGetStringField(TEXT("phase"), Job->Phase);
    if (Job->Status == TEXT("failed")) Job->Error = TEXT("Provider generation failed. Check the provider task and credits.");
    UpdateBusy();
}

void SHaybaMCPChatPanel::Refresh3DJob(const FString& Id)
{
    FGeneration3DJob* Job = Generation3DJobs.FindByPredicate([&Id](const FGeneration3DJob& Item) { return Item.Id == Id; });
    if (!Job || Job->TaskId.IsEmpty() || Job->bRequestInFlight ||
        (Job->Status != TEXT("queued") && Job->Status != TEXT("running"))) return;
    if (FPlatformTime::Seconds() - Job->StartedAt > 600)
    {
        Job->Status = TEXT("failed"); Job->Error = TEXT("Polling stopped after 10 minutes. Check the task on the provider website; it may still finish there.");
        bGeneration3DBusy = false;
        bTranscriptDirty = true; return;
    }
    auto Body = MakeShared<FJsonObject>(); Body->SetStringField(TEXT("task_id"), Job->TaskId);
    if (!Job->Phase.IsEmpty()) Body->SetStringField(TEXT("phase"), Job->Phase);
    Job->bRequestInFlight = true;
    TWeakPtr<SHaybaMCPChatPanel> Weak = SharedThis(this);
    Request3D(Job->Provider, TEXT("chat/generation/tasks/status"), Body, [Weak, Id](TSharedPtr<FJsonObject> Result, FString Error)
        { if (const auto Self = Weak.Pin()) Self->Apply3DResult(Id, Result, Error); });
}

void SHaybaMCPChatPanel::Tick3DJobs(double Time)
{
    TArray<FString> Due;
    for (const FGeneration3DJob& Job : Generation3DJobs)
        if ((Job.Status == TEXT("queued") || Job.Status == TEXT("running")) && !Job.bRequestInFlight && Time >= Job.NextPollAt) Due.Add(Job.Id);
    for (const FString& Id : Due) Refresh3DJob(Id);
}
