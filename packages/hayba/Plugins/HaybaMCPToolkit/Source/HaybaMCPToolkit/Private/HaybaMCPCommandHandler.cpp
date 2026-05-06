#include "HaybaMCPCommandHandler.h"
#include "IHaybaMCPHandler.h"
#include "HaybaMCPSecurityManager.h"
#include "Json.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPCmd, Log, All);

// Helper: serialize FJsonObject to compact string
static FString JsonToString(const TSharedRef<FJsonObject>& Obj)
{
    FString Output;
    TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
        TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Output);
    FJsonSerializer::Serialize(Obj, Writer);
    return Output;
}

FHaybaMCPCommandHandler::FHaybaMCPCommandHandler() {}
FHaybaMCPCommandHandler::~FHaybaMCPCommandHandler() {}

void FHaybaMCPCommandHandler::RegisterHandler(TSharedRef<IHaybaMCPHandler> Handler)
{
    Handlers.Add(Handler);
    for (const FString& Cmd : Handler->GetCommands())
    {
        CommandToHandler.Add(Cmd, Handler);
    }
    UE_LOG(LogHaybaMCPCmd, Log, TEXT("Registered handler '%s' with %d commands"),
        *Handler->GetDomain(), Handler->GetCommands().Num());
}

TArray<FString> FHaybaMCPCommandHandler::GetAllCommands() const
{
    TArray<FString> Out;
    CommandToHandler.GenerateKeyArray(Out);
    return Out;
}

FString FHaybaMCPCommandHandler::ProcessCommand(const FString& CommandJson)
{
    TSharedPtr<FJsonObject> Parsed;
    TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(CommandJson);
    if (!FJsonSerializer::Deserialize(Reader, Parsed) || !Parsed.IsValid())
    {
        UE_LOG(LogHaybaMCPCmd, Warning, TEXT("Failed to parse command JSON"));
        return MakeErrorResponse(TEXT(""), TEXT("Invalid JSON"));
    }

    const FString Cmd = Parsed->GetStringField(TEXT("cmd"));
    const FString Id = Parsed->GetStringField(TEXT("id"));
    TSharedPtr<FJsonObject> Params = Parsed->GetObjectField(TEXT("params"));
    if (!Params.IsValid()) Params = MakeShared<FJsonObject>();

    UE_LOG(LogHaybaMCPCmd, Log, TEXT("Processing command: %s (id: %s)"), *Cmd, *Id);

    // Auth gate
    FString AuthReason;
    if (!FHaybaMCPSecurityManager::Get().ValidateRequest(Parsed, AuthReason))
    {
        return MakeErrorResponse(Id, AuthReason);
    }

    auto* Found = CommandToHandler.Find(Cmd);
    if (!Found)
    {
        FHaybaJournalEntry E{ FDateTime::UtcNow(), Cmd,
            FHaybaMCPSecurityManager::HashParams(Params), 0, false,
            TEXT("Unknown command") };
        FHaybaMCPSecurityManager::Get().Journal(E);
        return MakeErrorResponse(Id, FString::Printf(TEXT("Unknown command: %s"), *Cmd));
    }

    const double Start = FPlatformTime::Seconds();
    const FString Response = (*Found)->Handle(Cmd, Params, Id);
    const int64 DurMs = (int64)((FPlatformTime::Seconds() - Start) * 1000.0);

    // Heuristic: parse response back to detect ok flag for journaling
    bool bOk = true;
    FString ErrMsg;
    {
        TSharedPtr<FJsonObject> RespObj;
        TSharedRef<TJsonReader<>> RespReader = TJsonReaderFactory<>::Create(Response);
        if (FJsonSerializer::Deserialize(RespReader, RespObj) && RespObj.IsValid())
        {
            RespObj->TryGetBoolField(TEXT("ok"), bOk);
            RespObj->TryGetStringField(TEXT("error"), ErrMsg);
        }
    }
    FHaybaJournalEntry E{ FDateTime::UtcNow(), Cmd,
        FHaybaMCPSecurityManager::HashParams(Params), DurMs, bOk, ErrMsg };
    FHaybaMCPSecurityManager::Get().Journal(E);

    return Response;
}

FString FHaybaMCPCommandHandler::MakeOkResponse(const FString& Id, const TSharedPtr<FJsonObject>& Data)
{
    TSharedRef<FJsonObject> Response = MakeShareable(new FJsonObject());
    Response->SetStringField(TEXT("id"), Id);
    Response->SetBoolField(TEXT("ok"), true);
    Response->SetObjectField(TEXT("data"), Data.IsValid() ? Data.ToSharedRef() : MakeShareable(new FJsonObject()));
    return JsonToString(Response);
}

FString FHaybaMCPCommandHandler::MakeErrorResponse(const FString& Id, const FString& ErrorMessage)
{
    TSharedRef<FJsonObject> Response = MakeShareable(new FJsonObject());
    Response->SetStringField(TEXT("id"), Id);
    Response->SetBoolField(TEXT("ok"), false);
    Response->SetStringField(TEXT("error"), ErrorMessage);
    return JsonToString(Response);
}
