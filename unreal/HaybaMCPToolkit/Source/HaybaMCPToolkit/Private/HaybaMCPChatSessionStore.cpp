#include "HaybaMCPChatSessionStore.h"

#include "HaybaMCPWizardState.h"

#include "Dom/JsonObject.h"
#include "HAL/FileManager.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

namespace HaybaChatSessions
{
namespace
{
    constexpr int32 SchemaVersion = 1;

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

    TSharedPtr<FJsonObject> ReadObject(const FString& File)
    {
        FString Text;
        if (!FFileHelper::LoadFileToString(Text, *File)) return nullptr;

        TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Text);
        TSharedPtr<FJsonObject> Obj;
        if (!FJsonSerializer::Deserialize(Reader, Obj) || !Obj.IsValid()) return nullptr;
        return Obj;
    }
}

FString Directory()
{
    return FPaths::ConvertRelativePathToFull(
        FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("HaybaMCP"), TEXT("chat-sessions")));
}

bool Save(const FHaybaMCPWizardSession& Session)
{
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

    FString Out;
    TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Out);
    if (!FJsonSerializer::Serialize(Root, Writer)) return false;

    IFileManager::Get().MakeDirectory(*Directory(), /*Tree*/ true);

    // Write beside, then move. A crash mid-write would otherwise leave a
    // truncated file that parses as nothing, silently losing the conversation
    // the user was having when it happened.
    const FString Final = PathFor(Session.SessionId);
    const FString Temp  = Final + TEXT(".tmp");
    if (!FFileHelper::SaveStringToFile(Out, *Temp)) return false;
    if (!IFileManager::Get().Move(*Final, *Temp, /*bReplace*/ true))
    {
        IFileManager::Get().Delete(*Temp, false, true, true);
        return false;
    }
    return true;
}

TArray<FSummary> List(int32 MaxCount)
{
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

        if (S.SessionId.IsEmpty()) continue;
        Out.Add(MoveTemp(S));
    }

    Out.Sort([](const FSummary& A, const FSummary& B) { return A.SavedAt > B.SavedAt; });
    if (MaxCount > 0 && Out.Num() > MaxCount) Out.SetNum(MaxCount);
    return Out;
}

bool Load(const FString& SessionId, FHaybaMCPWizardSession& OutSession)
{
    if (!IsSafeId(SessionId)) return false;

    TSharedPtr<FJsonObject> Obj = ReadObject(PathFor(SessionId));
    if (!Obj.IsValid()) return false;

    FHaybaMCPWizardSession Loaded;
    Obj->TryGetStringField(TEXT("sessionId"), Loaded.SessionId);
    Obj->TryGetStringField(TEXT("goal"), Loaded.Goal);
    if (Loaded.SessionId.IsEmpty()) return false;

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
