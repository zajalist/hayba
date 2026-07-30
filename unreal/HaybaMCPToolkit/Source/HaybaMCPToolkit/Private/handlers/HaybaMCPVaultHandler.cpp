#include "HaybaMCPVaultHandler.h"
#include "HaybaMCPSettings.h"
#include "HaybaMCPSecurityManager.h"
#include "HaybaMCPDeveloperSettings.h"
#include "HaybaMCPParams.h"
#include "Json.h"

TArray<FString> FHaybaMCPVaultHandler::GetCommands() const
{
    return {
        TEXT("get_setting"),
        TEXT("copilot_key_status"),
        TEXT("copilot_get_key"),
        TEXT("copilot_key_set"),
        TEXT("copilot_key_clear"),
    };
}

FHaybaHandlerResult FHaybaMCPVaultHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params)
{
    if (!Params.IsValid()) return FHaybaHandlerResult::Err(TEXT("VaultHandler: missing params"));

    if (Cmd == TEXT("get_setting"))        return HandleGetSetting(Params);
    if (Cmd == TEXT("copilot_key_status")) return HandleKeyStatus(Params);
    if (Cmd == TEXT("copilot_get_key"))    return HandleGetKey(Params);
    if (Cmd == TEXT("copilot_key_set"))    return HandleKeySet(Params);
    if (Cmd == TEXT("copilot_key_clear"))  return HandleKeyClear(Params);

    return FHaybaHandlerResult::Err(FString::Printf(TEXT("VaultHandler: unknown command %s"), *Cmd));
}

// get_setting: allowlisted read of UHaybaMCPDeveloperSettings fields so the
// Node MCP server can pick up tokens (e.g. SketchfabApiToken) the user entered
// in Project Settings → Plugins → Hayba MCP Toolkit, without env vars.
FHaybaHandlerResult FHaybaMCPVaultHandler::HandleGetSetting(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader R(P, TEXT("get_setting"));
    const FString Key = R.RequiredString(TEXT("key"));
    if (R.HasErrors()) return FHaybaHandlerResult::Err(R.ErrorMessage());
    // Allowlist, not a general settings reader: an arbitrary field read would
    // expose every developer setting, including ones added later by someone who
    // never considered this command.
    static const TSet<FString> Allow = { TEXT("sketchfab_api_token") };
    if (!Allow.Contains(Key))
    {
        return FHaybaHandlerResult::Err(
            FString::Printf(TEXT("Setting '%s' is not exposed via get_setting"), *Key));
    }

    const UHaybaMCPDeveloperSettings* DS = GetDefault<UHaybaMCPDeveloperSettings>();
    FString Value;
    if (Key == TEXT("sketchfab_api_token")) Value = DS->SketchfabApiToken;

    TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
    Data->SetStringField(TEXT("key"), Key);
    if (Value.IsEmpty())
    {
        Data->SetField(TEXT("value"), MakeShared<FJsonValueNull>());
        Data->SetBoolField(TEXT("set"), false);
    }
    else
    {
        Data->SetStringField(TEXT("value"), Value);
        Data->SetBoolField(TEXT("set"), true);
    }
    return FHaybaHandlerResult::Ok(Data);
}

FHaybaHandlerResult FHaybaMCPVaultHandler::HandleKeyStatus(const TSharedPtr<FJsonObject>& P)
{
    // Reports only whether a key is configured and its last 4 — never the key.
    auto Emit = [](const FString& ProviderId) -> TSharedPtr<FJsonObject>
    {
        TSharedPtr<FJsonObject> O = MakeShared<FJsonObject>();
        O->SetStringField(TEXT("provider"), ProviderId);
        const FString Last4 = FHaybaMCPSettings::GetProviderKeyLast4(ProviderId);
        O->SetBoolField(TEXT("configured"), !Last4.IsEmpty());
        if (Last4.IsEmpty()) O->SetField(TEXT("last4"), MakeShared<FJsonValueNull>());
        else                 O->SetStringField(TEXT("last4"), Last4);
        return O;
    };

    FString Provider;
    P->TryGetStringField(TEXT("provider"), Provider);
    if (!Provider.IsEmpty())
    {
        return FHaybaHandlerResult::Ok(Emit(Provider));
    }

    // No provider given → report the whole catalog.
    TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
    TArray<TSharedPtr<FJsonValue>> Arr;
    for (const FHaybaProviderInfo& Prov : FHaybaMCPSettings::GetProviderCatalog())
        Arr.Add(MakeShared<FJsonValueObject>(Emit(FString(Prov.Id))));
    Data->SetArrayField(TEXT("providers"), Arr);
    return FHaybaHandlerResult::Ok(Data);
}

FHaybaHandlerResult FHaybaMCPVaultHandler::HandleGetKey(const TSharedPtr<FJsonObject>& P)
{
    // FAIL CLOSED: this is the only command that returns a plaintext key.
    // ValidateRequest fails OPEN when no capability token is configured (a
    // usability default), which would let any local process read the decrypted
    // key unauthenticated. Refuse unless auth is actually configured —
    // regardless of the global fail-open posture.
    if (!FHaybaMCPSecurityManager::Get().IsAuthConfigured())
    {
        return FHaybaHandlerResult::Err(TEXT("copilot_get_key requires a configured capability token (set one in Hayba settings); refusing to return a decrypted key without authentication"));
    }

    FString Provider;
    P->TryGetStringField(TEXT("provider"), Provider);
    if (Provider.IsEmpty()) Provider = FHaybaMCPSettings::Get().SelectedProviderId;

    const FString Key = FHaybaMCPSettings::GetProviderKey(Provider);
    TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
    Data->SetStringField(TEXT("provider"), Provider);
    Data->SetBoolField(TEXT("set"), !Key.IsEmpty());
    if (Key.IsEmpty()) Data->SetField(TEXT("key"), MakeShared<FJsonValueNull>());
    else               Data->SetStringField(TEXT("key"), Key);
    return FHaybaHandlerResult::Ok(Data);
}

FHaybaHandlerResult FHaybaMCPVaultHandler::HandleKeySet(const TSharedPtr<FJsonObject>& P)
{
    // Both fields are reported together: the old shape told a caller who
    // omitted both about `provider`, and only mentioned `api_key` after they
    // had fixed the first and sent again.
    FHaybaParamReader R(P, TEXT("copilot_key_set"));
    const FString Provider = R.RequiredString(TEXT("provider"));
    const FString Key      = R.RequiredString(TEXT("api_key"));
    if (R.HasErrors()) return FHaybaHandlerResult::Err(R.ErrorMessage());

    FHaybaMCPSettings::SetProviderKey(Provider, Key);

    TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
    Data->SetStringField(TEXT("provider"), Provider);
    Data->SetBoolField(TEXT("ok"), true);
    // Echo the masked last-4 only — never the raw key.
    Data->SetStringField(TEXT("key_last4"), FHaybaMCPSettings::GetProviderKeyLast4(Provider));
    return FHaybaHandlerResult::Ok(Data);
}

FHaybaHandlerResult FHaybaMCPVaultHandler::HandleKeyClear(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader R(P, TEXT("copilot_key_clear"));
    const FString Provider = R.RequiredString(TEXT("provider"));
    if (R.HasErrors()) return FHaybaHandlerResult::Err(R.ErrorMessage());

    const bool bHad = FHaybaMCPSettings::HasProviderKey(Provider);
    FHaybaMCPSettings::ClearProviderKey(Provider);

    TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
    Data->SetStringField(TEXT("provider"), Provider);
    Data->SetBoolField(TEXT("ok"), true);
    Data->SetBoolField(TEXT("cleared"), bHad);
    return FHaybaHandlerResult::Ok(Data);
}
