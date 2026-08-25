#pragma once

#include "CoreMinimal.h"

struct FHaybaMCPWizardSession;

/**
 * Disk persistence for chat sessions.
 *
 * The IA says Chat "sessions persist and can be reopened; a new session is
 * explicit", and calls this out as correcting "the current non-persistent chat
 * assumption". Until now the Recent menu said "coming soon" -- honest, but the
 * IA bans that phrasing precisely because it pretends a future screen instead
 * of shipping the thing.
 *
 * One session is one JSON file under Saved/HaybaMCP/chat-sessions. A file per
 * session rather than one index file: a half-written index loses every
 * conversation, a half-written session file loses one, and the listing can be
 * rebuilt by reading the directory.
 *
 * The interface is deliberately three calls. Everything about the on-disk
 * shape -- naming, ordering, truncation, tolerating a corrupt file -- stays
 * inside.
 */
namespace HaybaChatSessions
{
    /** Enough to render a Recent entry without loading the conversation. */
    struct FSummary
    {
        FString   SessionId;
        FString   Goal;
        FDateTime SavedAt;
        int32     MessageCount = 0;
    };

    /** Write (or overwrite) one session. Returns false if nothing was stored;
     *  a session with no messages is deliberately not persisted, so opening
     *  Chat and closing it again does not litter the list with empties. */
    bool Save(const FHaybaMCPWizardSession& Session);

    /** Newest first. Skips unreadable files rather than failing the listing:
     *  one corrupt session must not hide the rest. */
    TArray<FSummary> List(int32 MaxCount = 20);

    /** Load one session by id. False if it is missing or unparseable. */
    bool Load(const FString& SessionId, FHaybaMCPWizardSession& OutSession);

    /** Where the files live. Exposed for diagnostics and tests. */
    FString Directory();
}
