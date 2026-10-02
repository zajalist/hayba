#include "HaybaMCPChatSessionStore.h"

#include "HaybaMCPWizardState.h"
#include "HaybaMCPSecretRedaction.h"

#include "Dom/JsonObject.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformProcess.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Misc/SecureHash.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

namespace HaybaChatSessions
{
namespace
{
    constexpr int32 SchemaVersion = 1;

    HaybaMCPSecretRedaction::FLimits ChatRedactionLimits()
    {
        HaybaMCPSecretRedaction::FLimits Limits;
        Limits.MaxArrayItems = 2048;
        Limits.MaxTotalStringChars = 8 * 1024 * 1024;
        return Limits;
    }

    /** A session id becomes a filename, so it has to be one. Ids are generated
     *  as GUIDs, but a session restored from an older build (or hand-edited
     *  file) could carry anything, and a `..` or a slash here would write
     *  outside the store. */
    bool IsSafeId(const FString& Id)
    {
        if (Id.IsEmpty() || Id.Len() > 64) return false;
        for (const TCHAR C : Id)
        {
            const bool bOk = FChar::IsAlnum(C) || C == TEXT('-') || C == TEXT('_');
            if (!bOk) return false;
        }
        return true;
    }

    FString PathFor(const FString& Id)
    {
        return FPaths::Combine(Directory(), Id + TEXT(".json"));
    }

    FString LegacyDirectory()
    {
        return FPaths::ConvertRelativePathToFull(
            FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("HaybaMCP"), TEXT("chat-sessions")));
    }

    bool WriteObject(const FString& File, const TSharedRef<FJsonObject>& Obj)
    {
        FString Out;
        TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Out);
        if (!FJsonSerializer::Serialize(Obj, Writer)) return false;

        IFileManager::Get().MakeDirectory(*FPaths::GetPath(File), /*Tree*/ true);
        const FString Temp = File + TEXT(".tmp");
        if (!FFileHelper::SaveStringToFile(Out, *Temp)) return false;
        if (!IFileManager::Get().Move(*File, *Temp, /*bReplace*/ true))
        {
            IFileManager::Get().Delete(*Temp, false, true, true);
            return false;
        }
        return true;
    }

    TSharedPtr<FJsonObject> ReadObject(const FString& File)
    {
        constexpr int64 MaxSessionFileBytes = 16 * 1024 * 1024;
        const int64 Size = IFileManager::Get().FileSize(*File);
        if (Size < 0 || Size > MaxSessionFileBytes) return nullptr;
        FString Text;
        if (!FFileHelper::LoadFileToString(Text, *File)) return nullptr;

        TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Text);
        TSharedPtr<FJsonObject> Obj;
        if (!FJsonSerializer::Deserialize(Reader, Obj) || !Obj.IsValid()) return nullptr;

        // Older builds wrote raw conversation text. Scrub it as it is read,
        // before it can enter the menu or a restored panel, and rewrite the
        // file so recognized credentials do not linger on disk.
        const HaybaMCPSecretRedaction::FResult Safe = HaybaMCPSecretRedaction::Redact(Obj, ChatRedactionLimits());
        // Never replace an existing transcript with a clipped version. An
        // oversized legacy file remains for explicit recovery instead of
        // silently losing part of the conversation during migration.
        if (!Safe.Value.IsValid() || Safe.Summary.bTruncated) return nullptr;
        if (Safe.Summary.bApplied && !WriteObject(File, Safe.Value.ToSharedRef()))
        {
            return nullptr;
        }
        return Safe.Value;
    }

    void MigrateLegacySessions()
    {
        // A Save can run on the editor thread. Bound each pass; further saves
        // and Recent opens continue where the preceding pass left off.
        constexpr int32 MaxFilesPerPass = 64;
        static int32 NextFileOffset = 0;
        TArray<FString> Files;
        IFileManager::Get().FindFiles(Files, *(LegacyDirectory() / TEXT("*.json")), true, false);
        if (Files.IsEmpty()) { NextFileOffset = 0; return; }
        Files.Sort();
        const int32 Count = FMath::Min(MaxFilesPerPass, Files.Num());
        for (int32 Index = 0; Index < Count; ++Index)
        {
            const FString& Name = Files[(NextFileOffset + Index) % Files.Num()];
            const FString Id = FPaths::GetBaseFilename(Name);
            if (!IsSafeId(Id)) continue;
            const FString OldFile = LegacyDirectory() / Name;
            const FString NewFile = PathFor(Id);
            TSharedPtr<FJsonObject> Old = ReadObject(OldFile);
            if (!Old.IsValid()) continue;
            FString StoredId;
            if (!Old->TryGetStringField(TEXT("sessionId"), StoredId) || StoredId != Id) continue;

            // Keep a newer per-user copy if both locations exist. Migration
            // only removes the project copy once a usable destination exists.
            TSharedPtr<FJsonObject> Current = ReadObject(NewFile);
            FString OldDate, CurrentDate;
            Old->TryGetStringField(TEXT("savedAt"), OldDate);
            if (Current.IsValid()) Current->TryGetStringField(TEXT("savedAt"), CurrentDate);
            const bool bWriteOld = !Current.IsValid() || OldDate > CurrentDate;
            if (bWriteOld && !WriteObject(NewFile, Old.ToSharedRef())) continue;
            IFileManager::Get().Delete(*OldFile, false, true, true);
        }
        NextFileOffset = (NextFileOffset + Count) % Files.Num();
    }
}

FString Directory()
{
    // Per-user settings avoids shipping chat transcripts when a project is
    // copied, archived, or placed under source control. The project hash keeps
    // unrelated projects separate without putting paths in directory names.
    const FString ProjectKey = FMD5::HashAnsiString(
        *FPaths::ConvertRelativePathToFull(FPaths::ProjectDir()));
    return FPaths::ConvertRelativePathToFull(
        FPaths::Combine(FPlatformProcess::UserSettingsDir(), TEXT("HaybaMCP"),
            TEXT("chat-sessions"), ProjectKey));
}

bool Save(const FHaybaMCPWizardSession& Session)
{
    MigrateLegacySessions();
    // An empty conversation is not a session. Persisting it would fill Recent
    // with entries that reopen to a blank panel.
    if (Session.Messages.Num() == 0) return false;
    if (!IsSafeId(Session.SessionId)) return false;

    TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
    Root->SetNumberField(TEXT("schema"), SchemaVersion);
    Root->SetStringField(TEXT("sessionId"), Session.SessionId);
    Root->SetStringField(TEXT("goal"), Session.Goal);
    Root->SetStringField(TEXT("savedAt"), FDateTime::UtcNow().ToIso8601());

    TArray<TSharedPtr<FJsonValue>> Msgs;
    Msgs.Reserve(Session.Messages.Num());
    for (const FHaybaMCPChatMessage& M : Session.Messages)
    {
        TSharedRef<FJsonObject> J = MakeShared<FJsonObject>();
        J->SetBoolField(TEXT("fromUser"), M.bFromUser);
        J->SetStringField(TEXT("text"), M.Text);
        J->SetStringField(TEXT("timestamp"), M.Timestamp.ToIso8601());
        // AttachedGraph is deliberately NOT persisted. It is a live graph the
        // action buttons operate on; restoring one from disk would show
        // Preview/Create against a graph whose assets may no longer exist.
        // Reopening a session restores the conversation, not its pending
        // actions -- and bShowActions stays false on load to match.
        Msgs.Add(MakeShared<FJsonValueObject>(J));
    }
    Root->SetArrayField(TEXT("messages"), Msgs);

    // Redact at the disk boundary. Chat text remains unchanged in the live
    // panel; known credential shapes are masked only in the saved transcript.
    const HaybaMCPSecretRedaction::FResult Safe = HaybaMCPSecretRedaction::Redact(Root, ChatRedactionLimits());
    // Refuse to write an incomplete transcript. The caller shows a persistent
    // save warning instead of treating a clipped file as a successful save.
    return Safe.Value.IsValid() && !Safe.Summary.bTruncated
        && WriteObject(PathFor(Session.SessionId), Safe.Value.ToSharedRef());
}

TArray<FSummary> List(int32 MaxCount)
{
    MigrateLegacySessions();
    TArray<FSummary> Out;

    TArray<FString> Files;
    IFileManager::Get().FindFiles(Files, *(Directory() / TEXT("*.json")), true, false);

    for (const FString& Name : Files)
    {
        TSharedPtr<FJsonObject> Obj = ReadObject(Directory() / Name);
        // Skip, do not fail. One corrupt file must not hide every other
        // conversation the user has had.
        if (!Obj.IsValid()) continue;

        FSummary S;
        Obj->TryGetStringField(TEXT("sessionId"), S.SessionId);
        Obj->TryGetStringField(TEXT("goal"), S.Goal);

        FString Saved;
        if (Obj->TryGetStringField(TEXT("savedAt"), Saved))
        {
            // A timestamp that fails to parse leaves SavedAt at its zero value,
            // which sorts the entry last rather than dropping it.
            FDateTime::ParseIso8601(*Saved, S.SavedAt);
        }

        const TArray<TSharedPtr<FJsonValue>>* Msgs = nullptr;
        if (Obj->TryGetArrayField(TEXT("messages"), Msgs) && Msgs)
        {
            S.MessageCount = Msgs->Num();
        }

        if (!IsSafeId(S.SessionId)) continue;
        Out.Add(MoveTemp(S));
    }

    Out.Sort([](const FSummary& A, const FSummary& B) { return A.SavedAt > B.SavedAt; });
    if (MaxCount > 0 && Out.Num() > MaxCount) Out.SetNum(MaxCount);
    return Out;
}

bool Load(const FString& SessionId, FHaybaMCPWizardSession& OutSession)
{
    if (!IsSafeId(SessionId)) return false;
    MigrateLegacySessions();

    TSharedPtr<FJsonObject> Obj = ReadObject(PathFor(SessionId));
    if (!Obj.IsValid()) return false;

    FHaybaMCPWizardSession Loaded;
    Obj->TryGetStringField(TEXT("sessionId"), Loaded.SessionId);
    Obj->TryGetStringField(TEXT("goal"), Loaded.Goal);
    if (Loaded.SessionId != SessionId) return false;

    const TArray<TSharedPtr<FJsonValue>>* Msgs = nullptr;
    if (Obj->TryGetArrayField(TEXT("messages"), Msgs) && Msgs)
    {
        for (const TSharedPtr<FJsonValue>& V : *Msgs)
        {
            const TSharedPtr<FJsonObject>* J = nullptr;
            if (!V.IsValid() || !V->TryGetObject(J) || !J || !J->IsValid()) continue;

            FHaybaMCPChatMessage M;
            M.bFromUser = false;
            (*J)->TryGetBoolField(TEXT("fromUser"), M.bFromUser);
            (*J)->TryGetStringField(TEXT("text"), M.Text);

            FString Ts;
            if ((*J)->TryGetStringField(TEXT("timestamp"), Ts))
            {
                FDateTime::ParseIso8601(*Ts, M.Timestamp);
            }

            // No restored message offers actions: the graph they would act on
            // was not persisted, so the buttons would have nothing to do.
            M.bShowActions = false;
            Loaded.Messages.Add(MoveTemp(M));
        }
    }

    // A reopened session is not mid-request, whatever it was doing when the
    // editor closed. Leaving this true would leave the composer disabled
    // forever, waiting for a response nobody is going to send.
    Loaded.bWaitingForAI = false;

    OutSession = MoveTemp(Loaded);
    return true;
}

} // namespace HaybaChatSessions
