#include "HaybaMCPSecurityManager.h"
#include "HaybaMCPSettings.h"
#include "Misc/Paths.h"
#include "Misc/FileHelper.h"
#include "Misc/SecureHash.h"
#include "Misc/ScopeLock.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Policies/CondensedJsonPrintPolicy.h"
#include "HAL/FileManager.h"
#include "Algo/Sort.h"

namespace
{
    static void WriteSortedJson(const TSharedRef<FJsonValue>& V,
                                TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>& W)
    {
        switch (V->Type)
        {
        case EJson::Object:
        {
            const TSharedPtr<FJsonObject>& Obj = V->AsObject();
            W.WriteObjectStart();
            if (Obj.IsValid())
            {
                TArray<FString> Keys;
                for (const auto& Pair : Obj->Values) { Keys.Add(FString(*Pair.Key)); }
                Keys.Sort();
                for (const FString& Key : Keys)
                {
                    const TSharedPtr<FJsonValue> Child = Obj->Values.FindRef(UE::FSharedString(*Key));
                    if (!Child.IsValid())
                    {
                        W.WriteNull(Key);
                        continue;
                    }
                    W.WriteIdentifierPrefix(Key);
                    WriteSortedJson(Child.ToSharedRef(), W);
                }
            }
            W.WriteObjectEnd();
            break;
        }
        case EJson::Array:
        {
            W.WriteArrayStart();
            for (const TSharedPtr<FJsonValue>& Item : V->AsArray())
            {
                if (Item.IsValid())
                {
                    WriteSortedJson(Item.ToSharedRef(), W);
                }
                else
                {
                    W.WriteNull();
                }
            }
            W.WriteArrayEnd();
            break;
        }
        case EJson::String:
            W.WriteValue(V->AsString());
            break;
        case EJson::Number:
            W.WriteValue(V->AsNumber());
            break;
        case EJson::Boolean:
            W.WriteValue(V->AsBool());
            break;
        case EJson::Null:
        default:
            W.WriteNull();
            break;
        }
    }
}

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

bool FHaybaMCPSecurityManager::IsAuthConfigured() const
{
    return !FHaybaMCPSettings::Get().CapabilityToken.IsEmpty();
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

    // Walk the JSON object with keys emitted in sorted order so the hash is
    // deterministic regardless of FJsonObject's hash-keyed TMap iteration order.
    Writer->WriteObjectStart();
    {
        TArray<FString> Keys;
        for (const auto& Pair : Params->Values) { Keys.Add(FString(*Pair.Key)); }
        Keys.Sort();
        for (const FString& Key : Keys)
        {
            const TSharedPtr<FJsonValue> Child = Params->Values.FindRef(UE::FSharedString(*Key));
            if (!Child.IsValid())
            {
                Writer->WriteNull(Key);
                continue;
            }
            Writer->WriteIdentifierPrefix(Key);
            WriteSortedJson(Child.ToSharedRef(), Writer.Get());
        }
    }
    Writer->WriteObjectEnd();
    Writer->Close();

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

    const FString JournalPath = FPaths::ProjectSavedDir() / TEXT("hayba-execution.log");

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

    // Ensure Saved/ exists — first run on a fresh project may not have created it yet.
    const FString SavedDir = FPaths::ProjectSavedDir();
    IFileManager::Get().MakeDirectory(*SavedDir, /*Tree=*/true);

    const bool bWrote = FFileHelper::SaveStringToFile(
        Line,
        *JournalPath,
        FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM,
        &IFileManager::Get(),
        FILEWRITE_Append);
    if (!bWrote)
    {
        UE_LOG(LogTemp, Warning, TEXT("Hayba journal write failed: %s"), *JournalPath);
    }
}
