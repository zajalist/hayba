#include "Misc/AutomationTest.h"

#if WITH_EDITOR

#include "HaybaMCPChatSessionStore.h"
#include "HaybaMCPWizardState.h"

#include "HAL/FileManager.h"
#include "Misc/Guid.h"
#include "Misc/Paths.h"

/**
 * Round-trip the chat session store.
 *
 * Chat persistence is the kind of feature that looks finished the moment the
 * menu stops saying "coming soon". What actually matters is that a session
 * written today can be read back, that the listing survives a corrupt file,
 * and that the two states which are easy to conflate -- an empty session and a
 * missing one -- stay distinct.
 */
IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaChatSessionStoreTest,
    "Hayba.Chat.SessionStore.RoundTrip",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaChatSessionStoreTest::RunTest(const FString& Parameters)
{
    // Unique ids so a run never collides with a real conversation, or with a
    // previous run of this test.
    const FString Id = TEXT("test_") + FGuid::NewGuid().ToString(EGuidFormats::Digits).Left(16);

    FHaybaMCPWizardSession S;
    S.SessionId = Id;
    S.Goal = TEXT("Place three crates along the north wall");

    {
        FHaybaMCPChatMessage M;
        M.bFromUser = true;
        M.Text = TEXT("Place three crates along the north wall");
        M.bShowActions = false;
        S.Messages.Add(M);
    }
    {
        FHaybaMCPChatMessage M;
        M.bFromUser = false;
        M.Text = TEXT("Placed three crates.");
        // Actions are live UI state. They must not come back on load, because
        // the graph they act on is deliberately not persisted.
        M.bShowActions = true;
        S.Messages.Add(M);
    }

    TestTrue(TEXT("a session with messages is saved"), HaybaChatSessions::Save(S));

    FHaybaMCPWizardSession Loaded;
    if (TestTrue(TEXT("the saved session loads back"), HaybaChatSessions::Load(Id, Loaded)))
    {
        TestEqual(TEXT("the id survives"), Loaded.SessionId, Id);
        TestEqual(TEXT("the goal survives"), Loaded.Goal, S.Goal);
        TestEqual(TEXT("every message survives"), Loaded.Messages.Num(), 2);
        if (Loaded.Messages.Num() == 2)
        {
            TestTrue(TEXT("the user message is still the user's"), Loaded.Messages[0].bFromUser);
            TestFalse(TEXT("the reply is still the assistant's"), Loaded.Messages[1].bFromUser);
            TestEqual(TEXT("text survives verbatim"),
                Loaded.Messages[1].Text, FString(TEXT("Placed three crates.")));
            // Restoring these would offer Preview/Create against a graph that
            // was never written to disk.
            TestFalse(TEXT("actions do not come back"), Loaded.Messages[1].bShowActions);
        }
        // A reopened session is never mid-request, whatever it was doing when
        // the editor closed; otherwise the composer stays disabled forever.
        TestFalse(TEXT("a loaded session is not waiting on the AI"), Loaded.bWaitingForAI);
    }

    // An empty conversation is not a session. Persisting it would fill the
    // Recent menu with entries that reopen to a blank panel.
    {
        FHaybaMCPWizardSession Empty;
        Empty.SessionId = Id + TEXT("_empty");
        TestFalse(TEXT("an empty session is not persisted"), HaybaChatSessions::Save(Empty));
        FHaybaMCPWizardSession Back;
        TestFalse(TEXT("and cannot be loaded"),
            HaybaChatSessions::Load(Empty.SessionId, Back));
    }

    // An id becomes a filename. A traversal here would write outside the store.
    {
        FHaybaMCPWizardSession Evil;
        Evil.SessionId = TEXT("../../escape");
        Evil.Messages.Add(FHaybaMCPChatMessage{});
        TestFalse(TEXT("a traversing id is refused on save"), HaybaChatSessions::Save(Evil));
        FHaybaMCPWizardSession Back;
        TestFalse(TEXT("and on load"), HaybaChatSessions::Load(Evil.SessionId, Back));
    }

    // The listing must survive a file it cannot parse. One bad session hiding
    // every other conversation is the failure that turns a small problem into
    // a total loss.
    {
        const FString Junk = HaybaChatSessions::Directory()
            / (TEXT("test_corrupt_") + FGuid::NewGuid().ToString(EGuidFormats::Digits).Left(8) + TEXT(".json"));
        FFileHelper::SaveStringToFile(TEXT("{not json at all"), *Junk);

        const TArray<HaybaChatSessions::FSummary> Listed = HaybaChatSessions::List(100);
        bool bFoundOurs = false;
        for (const HaybaChatSessions::FSummary& Sum : Listed)
        {
            if (Sum.SessionId == Id)
            {
                bFoundOurs = true;
                TestEqual(TEXT("the summary counts the messages"), Sum.MessageCount, 2);
                TestEqual(TEXT("the summary carries the goal"), Sum.Goal, S.Goal);
            }
        }
        TestTrue(TEXT("a corrupt file does not hide the readable ones"), bFoundOurs);

        IFileManager::Get().Delete(*Junk, false, true, true);
    }

    // Leave nothing behind: this test writes into the user's real store.
    IFileManager::Get().Delete(
        *(HaybaChatSessions::Directory() / (Id + TEXT(".json"))), false, true, true);

    return true;
}

#endif // WITH_EDITOR
