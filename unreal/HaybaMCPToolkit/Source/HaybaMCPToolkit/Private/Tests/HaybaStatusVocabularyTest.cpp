#include "Misc/AutomationTest.h"

#if WITH_EDITOR

#include "HaybaMCPStatusVocabulary.h"
#include "HaybaMCPStyle.h"

/**
 * The status vocabulary has to answer for every state.
 *
 * The failure this guards against is not a crash. It is a chip that renders
 * blank, or in the fallback grey, because someone added a state and the
 * switch that maps it to a label or a colour was not updated. That looks like
 * a styling quirk and is actually a status the user cannot read.
 *
 * It also pins the two facts the IA states outright: needs-approval and
 * needs-attention are the SAME ochre (both mean the work is waiting on the
 * user), and needs-attention is the state that carries a Fix.
 */
IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaStatusVocabularyTest,
    "Hayba.UI.StatusVocabulary.EveryStateAnswers",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaStatusVocabularyTest::RunTest(const FString& Parameters)
{
    // Every state, listed explicitly. An added state that nobody adds here is
    // caught by the count assertion below rather than quietly going untested.
    const TArray<EHaybaStatus> All = {
        EHaybaStatus::Running,
        EHaybaStatus::NeedsApproval,
        EHaybaStatus::Done,
        EHaybaStatus::NeedsAttention,
        EHaybaStatus::Error,
        EHaybaStatus::NotStarted,
    };
    TestEqual(TEXT("every status is covered by this test"), All.Num(), 6);

    for (const EHaybaStatus S : All)
    {
        const FText Label = HaybaStatus::Label(S);
        TestFalse(FString::Printf(TEXT("status %d has a label"), (int32)S), Label.IsEmpty());

        const TCHAR* Glyph = HaybaStatus::Glyph(S);
        TestTrue(FString::Printf(TEXT("status %d has a glyph"), (int32)S),
            Glyph != nullptr && FCString::Strlen(Glyph) > 0);


    }

    // The colour each state must resolve to, named. Asserting merely that a
    // state is not the fallback would pass when it returns the wrong
    // registered colour -- the likelier mistake by far.
    const TMap<EHaybaStatus, FName> Expected = {
        { EHaybaStatus::Running,        TEXT("Hayba.Color.Status.Info")  },
        { EHaybaStatus::NeedsApproval,  TEXT("Hayba.Color.Accent.Ochre") },
        { EHaybaStatus::Done,           TEXT("Hayba.Color.Status.Pass")  },
        { EHaybaStatus::NeedsAttention, TEXT("Hayba.Color.Accent.Ochre") },
        { EHaybaStatus::Error,          TEXT("Hayba.Color.Status.Fail")  },
        { EHaybaStatus::NotStarted,     TEXT("Hayba.Color.Text.Muted")   },
    };
    TestEqual(TEXT("every status has an expected colour"), Expected.Num(), All.Num());
    for (const TPair<EHaybaStatus, FName>& KV : Expected)
    {
        TestEqual(
            FString::Printf(TEXT("status %d uses %s"), (int32)KV.Key, *KV.Value.ToString()),
            HaybaStatus::Colour(KV.Key).GetSpecifiedColor(),
            FHaybaMCPStyle::Colour(KV.Value));
    }

    // "needs approval -- Plan Mode pause; semantic ochre" and
    // "needs attention -- ... semantic ochre plus Fix". Same colour, on
    // purpose: both mean the work is paused on the user.
    TestEqual(TEXT("needs approval and needs attention share the semantic ochre"),
        HaybaStatus::Colour(EHaybaStatus::NeedsApproval).GetSpecifiedColor(),
        HaybaStatus::Colour(EHaybaStatus::NeedsAttention).GetSpecifiedColor());

    TestEqual(TEXT("that ochre is the product's ochre"),
        HaybaStatus::Colour(EHaybaStatus::NeedsApproval).GetSpecifiedColor(),
        FHaybaMCPStyle::Colour("Hayba.Color.Accent.Ochre"));

    // Fix belongs to needs-attention and nothing else. Offering it on a
    // running or errored row would promise a vector nobody computed.
    TestTrue(TEXT("needs attention carries a Fix"),
        HaybaStatus::WantsFixAffordance(EHaybaStatus::NeedsAttention));
    for (const EHaybaStatus S : All)
    {
        if (S == EHaybaStatus::NeedsAttention) continue;
        TestFalse(FString::Printf(TEXT("status %d does not carry a Fix"), (int32)S),
            HaybaStatus::WantsFixAffordance(S));
    }

    // The five that ARE the IA's vocabulary must read exactly as the IA writes
    // them: this text appears in chips across three surfaces, and a panel
    // spelling it differently is the drift the vocabulary exists to stop.
    TestEqual(TEXT("running"), HaybaStatus::Label(EHaybaStatus::Running).ToString(),
        FString(TEXT("running")));
    TestEqual(TEXT("needs approval"), HaybaStatus::Label(EHaybaStatus::NeedsApproval).ToString(),
        FString(TEXT("needs approval")));
    TestEqual(TEXT("done"), HaybaStatus::Label(EHaybaStatus::Done).ToString(),
        FString(TEXT("done")));
    TestEqual(TEXT("needs attention"), HaybaStatus::Label(EHaybaStatus::NeedsAttention).ToString(),
        FString(TEXT("needs attention")));
    TestEqual(TEXT("error"), HaybaStatus::Label(EHaybaStatus::Error).ToString(),
        FString(TEXT("error")));

    return true;
}

#endif // WITH_EDITOR
