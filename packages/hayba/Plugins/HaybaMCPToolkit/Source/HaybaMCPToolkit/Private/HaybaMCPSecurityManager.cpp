#include "HaybaMCPSecurityManager.h"
#include "HaybaMCPSettings.h"
#include "Misc/Paths.h"
#include "Misc/FileHelper.h"
#include "Misc/SecureHash.h"
#include "Misc/ScopeLock.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Policies/CondensedJsonPrintPolicy.h"

FHaybaMCPSecurityManager& FHaybaMCPSecurityManager::Get()
{
    static FHaybaMCPSecurityManager Instance;
    return Instance;
}

bool FHaybaMCPSecurityManager::ValidateRequest(const TSharedPtr<FJsonObject>& Request, FString& OutReason) const
{
    const FString& Token = FHaybaMCPSettings::Get().CapabilityToken;
    if (Token.IsEmpty())
    {
        // Auth disabled.
        return true;
    }

    if (!Request.IsValid())
    {
        OutReason = TEXT("Missing auth token");
        return false;
    }

    FString Provided;
    if (!Request->TryGetStringField(TEXT("auth"), Provided))
    {
        OutReason = TEXT("Missing auth token");
        return false;
    }

    if (!Provided.Equals(Token, ESearchCase::CaseSensitive))
    {
        OutReason = TEXT("Invalid auth token");
        return false;
    }

    return true;
}

FString FHaybaMCPSecurityManager::HashParams(const TSharedPtr<FJsonObject>& Params)
{
    if (!Params.IsValid())
    {
        return FString();
    }

    FString Serialized;
    TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
        TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Serialized);
    FJsonSerializer::Serialize(Params.ToSharedRef(), Writer);

    FTCHARToUTF8 Utf8(*Serialized);
    FSHAHash Hash;
    FSHA1::HashBuffer(reinterpret_cast<const uint8*>(Utf8.Get()), Utf8.Length(), Hash.Hash);
    return Hash.ToString();
}

void FHaybaMCPSecurityManager::Journal(const FHaybaJournalEntry& Entry)
{
    if (!FHaybaMCPSettings::Get().bEnableExecutionJournal)
    {
        return;
    }

    const FString LogPath = FPaths::ProjectSavedDir() / TEXT("hayba-execution.log");

    // Sanitize error message: strip tabs/newlines so each entry is exactly one line.
    FString SafeError = Entry.ErrorMessage;
    SafeError.ReplaceInline(TEXT("\t"), TEXT(" "));
    SafeError.ReplaceInline(TEXT("\r"), TEXT(" "));
    SafeError.ReplaceInline(TEXT("\n"), TEXT(" "));

    const FString Line = FString::Printf(
        TEXT("%s\t%s\t%s\t%lld\t%s\t%s\n"),
        *Entry.Timestamp.ToIso8601(),
        *Entry.Command,
        *Entry.ParamsHash,
        Entry.DurationMs,
        Entry.bOk ? TEXT("ok") : TEXT("err"),
        *SafeError);

    FScopeLock Lock(&JournalLock);
    FFileHelper::SaveStringToFile(
        Line,
        *LogPath,
        FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM,
        &IFileManager::Get(),
        FILEWRITE_Append);
}
