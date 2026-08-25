#include "HaybaMCPNetworkHandler.h"
#include "Json.h"
#include "Editor.h"
#include "EngineUtils.h"
#include "HaybaSceneQuery.h"
#include "Engine/Engine.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "Components/ActorComponent.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPNetwork, Log, All);

namespace
{
    static UWorld* EditorWorld()
    {
        return GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    }

    // Resolution order matters. Object name and path name are UNIQUE within a
    // level, so a first match on either is the only match. An actor LABEL is
    // not unique -- Unreal happily gives two actors the same one -- so a first
    // match on a label picks an arbitrary actor.
    //
    // This helper used to treat all three the same and return the first hit,
    // and `net_set_replication` (a mutation: SetReplicates, bAlwaysRelevant,
    // NetDormancy) resolved through it. On a duplicated label it changed the
    // replication of an arbitrary actor and reported success. docs/RELIABILITY
    // said the remaining first-match sites were "reads and UI" and that "the
    // destructive paths refuse"; this one was neither.
    static AActor* FindActorByPath(UWorld* World, const FString& PathOrName, FString& OutError)
    {
        OutError.Reset();
        if (!World) return nullptr;

        // Unique identifiers first: an exact hit here needs no disambiguation.
        for (TActorIterator<AActor> It(World); It; ++It)
        {
            AActor* A = *It;
            if (!A) continue;
            if (A->GetName() == PathOrName || A->GetPathName() == PathOrName)
                return A;
        }

        // Fall back to the label, which must be checked for ambiguity.
        const HaybaSceneQuery::FActorLookup Hit = HaybaSceneQuery::FindActor(World, PathOrName);
        if (Hit.IsAmbiguous())
        {
            OutError = HaybaSceneQuery::AmbiguousError(
                TEXT("net_set_replication"), PathOrName, Hit.Candidates);
            return nullptr;
        }
        return Hit.Actor;
    }

    static UActorComponent* FindComponentByPath(AActor* Actor, const FString& CompPath)
    {
        if (!Actor) return nullptr;
        for (UActorComponent* C : Actor->GetComponents())
        {
            if (!C) continue;
            if (C->GetName() == CompPath || C->GetPathName() == CompPath)
                return C;
        }
        return nullptr;
    }

    static ENetDormancy ParseDormancy(const FString& S, bool& bOk)
    {
        bOk = true;
        if (S.Equals(TEXT("Awake"), ESearchCase::IgnoreCase))      return DORM_Awake;
        if (S.Equals(TEXT("Initial"), ESearchCase::IgnoreCase))    return DORM_Initial;
        if (S.Equals(TEXT("DormantAll"), ESearchCase::IgnoreCase)) return DORM_DormantAll;
        bOk = false;
        return DORM_Awake;
    }
}

TArray<FString> FHaybaMCPNetworkHandler::GetCommands() const
{
    return {
        TEXT("net_debug"),
        TEXT("net_set_replication")
    };
}

FHaybaHandlerResult FHaybaMCPNetworkHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& P)
{
    if (Cmd == TEXT("net_debug"))
    {
        if (!P.IsValid())
            return FHaybaHandlerResult::Err(TEXT("net_debug: missing params"));

        bool bEnabled = false;
        if (!P->TryGetBoolField(TEXT("enabled"), bEnabled))
            return FHaybaHandlerResult::Err(TEXT("net_debug: missing enabled"));

        UWorld* World = EditorWorld();

        TArray<FString> Channels;
        const TArray<TSharedPtr<FJsonValue>>* ChanArr = nullptr;
        if (P->TryGetArrayField(TEXT("channels"), ChanArr) && ChanArr)
        {
            for (const TSharedPtr<FJsonValue>& V : *ChanArr)
            {
                if (V.IsValid()) Channels.Add(V->AsString());
            }
        }
        if (Channels.Num() == 0)
        {
            Channels.Add(TEXT("all"));
        }

        if (GEngine)
        {
            if (bEnabled)
            {
                GEngine->Exec(World, TEXT("net.PacketHandler.LogStats 1"));
                GEngine->Exec(World, TEXT("stat net"));
            }
            else
            {
                GEngine->Exec(World, TEXT("net.PacketHandler.LogStats 0"));
                GEngine->Exec(World, TEXT("stat none"));
            }
        }

        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetBoolField(TEXT("enabled"), bEnabled);
        TArray<TSharedPtr<FJsonValue>> Applied;
        for (const FString& C : Channels)
            Applied.Add(MakeShared<FJsonValueString>(C));
        Out->SetArrayField(TEXT("channels_applied"), Applied);
        return FHaybaHandlerResult::Ok(Out);
    }

    if (Cmd == TEXT("net_set_replication"))
    {
        if (!P.IsValid())
            return FHaybaHandlerResult::Err(TEXT("net_set_replication: missing params"));

        UWorld* World = EditorWorld();
        if (!World)
            return FHaybaHandlerResult::Err(TEXT("net_set_replication: no editor world"));

        FString ActorPath;
        if (!P->TryGetStringField(TEXT("actor_path"), ActorPath) || ActorPath.IsEmpty())
            return FHaybaHandlerResult::Err(TEXT("net_set_replication: missing actor_path"));

        bool bReplicate = false;
        if (!P->TryGetBoolField(TEXT("replicate"), bReplicate))
            return FHaybaHandlerResult::Err(TEXT("net_set_replication: missing replicate"));

        FString LookupError;
        AActor* Actor = FindActorByPath(World, ActorPath, LookupError);
        if (!LookupError.IsEmpty())
            return FHaybaHandlerResult::Err(LookupError);
        if (!Actor)
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("net_set_replication: actor not found: %s"), *ActorPath));

        // Validate EVERYTHING before writing anything. net_dormancy used to be
        // parsed after SetReplicates and bAlwaysRelevant had already been
        // applied, so a misspelled dormancy returned an error on an actor whose
        // replication had just been changed — the caller reads a failure and
        // reasonably concludes nothing happened.
        bool bAlwaysRelevant = false;
        const bool bHasAlwaysRelevant = P->TryGetBoolField(TEXT("always_relevant"), bAlwaysRelevant);

        FString DormancyStr;
        const bool bHasDormancy = P->TryGetStringField(TEXT("net_dormancy"), DormancyStr) && !DormancyStr.IsEmpty();
        ENetDormancy Dormancy = ENetDormancy::DORM_Never;
        if (bHasDormancy)
        {
            bool bOk = false;
            Dormancy = ParseDormancy(DormancyStr, bOk);
            if (!bOk)
                return FHaybaHandlerResult::Err(FString::Printf(TEXT("net_set_replication: invalid net_dormancy '%s'"), *DormancyStr));
        }

        // Past this line the request is known-good and the writes begin.
        Actor->SetReplicates(bReplicate);
        if (bHasAlwaysRelevant)
        {
            Actor->bAlwaysRelevant = bAlwaysRelevant;
        }
        if (bHasDormancy)
        {
            Actor->NetDormancy = Dormancy;
        }

        TArray<FString> AppliedComponents;
        TArray<FString> MissingComponents;
        const TArray<TSharedPtr<FJsonValue>>* CompArr = nullptr;
        if (P->TryGetArrayField(TEXT("replicated_components"), CompArr) && CompArr)
        {
            for (const TSharedPtr<FJsonValue>& V : *CompArr)
            {
                if (!V.IsValid()) continue;
                const FString CompPath = V->AsString();
                if (UActorComponent* C = FindComponentByPath(Actor, CompPath))
                {
                    C->SetIsReplicated(true);
                    C->MarkPackageDirty();
                    AppliedComponents.Add(C->GetName());
                }
                else
                {
                    MissingComponents.Add(CompPath);
                }
            }
        }

        Actor->MarkPackageDirty();

        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("actor"), Actor->GetPathName());
        Out->SetBoolField(TEXT("replicates"), Actor->GetIsReplicated());
        if (bHasAlwaysRelevant)
            Out->SetBoolField(TEXT("always_relevant"), Actor->bAlwaysRelevant);
        if (bHasDormancy)
            Out->SetStringField(TEXT("net_dormancy"), DormancyStr);

        TArray<TSharedPtr<FJsonValue>> AppliedJson;
        for (const FString& S : AppliedComponents)
            AppliedJson.Add(MakeShared<FJsonValueString>(S));
        Out->SetArrayField(TEXT("replicated_components"), AppliedJson);

        if (MissingComponents.Num() > 0)
        {
            TArray<TSharedPtr<FJsonValue>> MissingJson;
            for (const FString& S : MissingComponents)
                MissingJson.Add(MakeShared<FJsonValueString>(S));
            Out->SetArrayField(TEXT("missing_components"), MissingJson);
        }

        return FHaybaHandlerResult::Ok(Out);
    }

    return FHaybaHandlerResult::Err(FString::Printf(TEXT("NetworkHandler: unknown command %s"), *Cmd));
}
