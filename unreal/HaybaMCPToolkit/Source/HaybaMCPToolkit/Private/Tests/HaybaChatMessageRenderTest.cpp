#include "Misc/AutomationTest.h"
#include "HaybaMCPChatPanel.h"
#include "Widgets/Text/SMultiLineEditableText.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Input/SButton.h"
#include "Layout/Geometry.h"
#include "HAL/PlatformProcess.h"
#include "HAL/PlatformTime.h"
#include "HaybaMCPActivityModel.h"
#include "Slate/SHaybaActivityCard.h"
#include "Framework/Application/SlateApplication.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/SWindow.h"
#include "Serialization/JsonSerializer.h"

#if WITH_DEV_AUTOMATION_TESTS
namespace
{
    void CollectSelectableText(const TSharedRef<SWidget>& Widget, TArray<TSharedPtr<SMultiLineEditableText>>& Out)
    {
        if (Widget->GetType() == TEXT("SMultiLineEditableText"))
            Out.Add(StaticCastSharedRef<SMultiLineEditableText>(Widget));
        else
        {
            FChildren* Children = Widget->GetChildren();
            for (int32 I = 0; Children && I < Children->Num(); ++I) CollectSelectableText(Children->GetChildAt(I), Out);
        }
    }

    int32 CountButtons(const TSharedRef<SWidget>& Widget)
    {
        int32 Count = Widget->GetType() == TEXT("SButton") ? 1 : 0;
        FChildren* Children = Widget->GetChildren();
        for (int32 I = 0; Children && I < Children->Num(); ++I) Count += CountButtons(Children->GetChildAt(I));
        return Count;
    }

    void CollectLabels(const TSharedRef<SWidget>& Widget, TArray<FString>& Out)
    {
        if (Widget->GetType() == TEXT("STextBlock"))
            Out.Add(StaticCastSharedRef<STextBlock>(Widget)->GetText().ToString());
        FChildren* Children = Widget->GetChildren();
        for (int32 I = 0; Children && I < Children->Num(); ++I) CollectLabels(Children->GetChildAt(I), Out);
    }

    TSharedPtr<SButton> FindButtonByLabel(const TSharedRef<SWidget>& Widget, const FString& Label)
    {
        if (Widget->GetType() == TEXT("SButton"))
        {
            TArray<FString> Labels;
            CollectLabels(Widget, Labels);
            if (Labels.Contains(Label)) return StaticCastSharedRef<SButton>(Widget);
        }
        FChildren* Children = Widget->GetChildren();
        for (int32 I = 0; Children && I < Children->Num(); ++I)
            if (TSharedPtr<SButton> Found = FindButtonByLabel(Children->GetChildAt(I), Label)) return Found;
        return nullptr;
    }

    TSharedPtr<SButton> FirstButton(const TSharedRef<SWidget>& Widget)
    {
        if (Widget->GetType() == TEXT("SButton")) return StaticCastSharedRef<SButton>(Widget);
        FChildren* Children = Widget->GetChildren();
        for (int32 I = 0; Children && I < Children->Num(); ++I)
            if (TSharedPtr<SButton> Found = FirstButton(Children->GetChildAt(I))) return Found;
        return nullptr;
    }

    TSharedRef<FJsonObject> ActivityEvent(const TCHAR* Source)
    {
        TSharedPtr<FJsonObject> Object;
        check(FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Source), Object));
        return Object.ToSharedRef();
    }
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaChatMessageGrammarTest, "Hayba.Chat.Messages.DisplayGrammar",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaChatMessageGrammarTest::RunTest(const FString&)
{
    using namespace HaybaChatText;
    const auto Blocks = Parse(TEXT("## Inspection\n\nLoaded geometry only.\nCoverage is partial.\n\n- Keep actors editable.\n2. Check the result.\n\n```cpp\nif (Count < 4) { Inspect(); }\n```\n\n[Docs](https://dev.epicgames.com/documentation/)\n\n<script>approve()</script>\n[Approve](javascript:run())\n\n[Asset](/Game/Example.Example)"));
    TestEqual(TEXT("eight display blocks"), Blocks.Num(), 8);
    if (Blocks.Num() != 8) return false;
    TestTrue(TEXT("heading has hierarchy"), Blocks[0].Kind == EBlock::Heading);
    TestEqual(TEXT("paragraph keeps line boundaries"), Blocks[1].Text, FString(TEXT("Loaded geometry only.\nCoverage is partial.")));
    TestTrue(TEXT("unordered list"), Blocks[2].Kind == EBlock::ListItem);
    TestEqual(TEXT("ordered marker retained"), Blocks[3].Label, FString(TEXT("2.")));
    TestTrue(TEXT("code block"), Blocks[4].Kind == EBlock::Code);
    TestEqual(TEXT("copyable code excludes fences and preserves newline"), Blocks[4].Text, FString(TEXT("if (Count < 4) { Inspect(); }\n")));
    TestTrue(TEXT("HTTPS navigation"), Blocks[5].Kind == EBlock::Link);
    TestTrue(TEXT("HTML and action-looking markup remain plain text"), Blocks[6].Kind == EBlock::Paragraph);
    TestTrue(TEXT("unsafe markup retained verbatim"), Blocks[6].Text.Contains(TEXT("[Approve](javascript:run())")));
    TestTrue(TEXT("asset reference is display navigation only"), Blocks[7].Kind == EBlock::Link);
    const auto Partial = Parse(TEXT("```json\n{\"ok\": fal"));
    TestEqual(TEXT("unfinished streamed fence remains one code block"), Partial.Num(), 1);
    TestEqual(TEXT("unfinished code loses no text"), Partial[0].Text, FString(TEXT("{\"ok\": fal")));
    const auto EmptyCode = Parse(TEXT("```\n```"));
    TestEqual(TEXT("empty code retained"), EmptyCode.Num(), 1);
    for (const FString& Unsafe : TArray<FString>{TEXT("javascript:alert(1)"), TEXT("file:///tmp/a"), TEXT("https://user@host.example/"),
        TEXT("https://host.example\\evil"), TEXT("https://host.example/\nrun"), TEXT("https://host.example\""),
        TEXT("https://localhost/"), TEXT("https://127.0.0.1/"), TEXT("https://host..example/"), TEXT("https://host.example:44/")})
        TestFalse(*FString::Printf(TEXT("refuses %s"), *Unsafe), IsSafeWebLink(Unsafe));
    TestTrue(TEXT("normal HTTPS docs link allowed"), IsSafeWebLink(TEXT("https://dev.epicgames.com/documentation/en-us/?a=1#example")));
    const TSharedRef<SHaybaChatMessageBody> LinkBody = SNew(SHaybaChatMessageBody);
    LinkBody->SetMessageText(TEXT("[Read the docs](https://dev.epicgames.com/documentation/)"));
    TArray<FString> LinkLabels;
    CollectLabels(LinkBody, LinkLabels);
    TestTrue(TEXT("link action visibly names its destination host"),
        LinkLabels.ContainsByPredicate([](const FString& Label) { return Label.Contains(TEXT("dev.epicgames.com")); }));
    TestFalse(TEXT("subobject commands refused"), IsSafeAssetReference(TEXT("/Game/Example.Example:Execute")));
    TestFalse(TEXT("parent traversal refused"), IsSafeAssetReference(TEXT("/Game/../Example.Example")));
    TestFalse(TEXT("private filesystem path refused"), IsSafeAssetReference(TEXT("C:/Example/Example.asset")));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaChatMessageStreamingTest, "Hayba.Chat.Messages.StreamSelection",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaChatMessageStreamingTest::RunTest(const FString&)
{
    const TSharedRef<SHaybaChatMessageBody> Body = SNew(SHaybaChatMessageBody);
    Body->SetMessageText(TEXT("Stable paragraph.\n\nStreaming"));
    TArray<TSharedPtr<SMultiLineEditableText>> Before;
    CollectSelectableText(Body, Before);
    if (!TestEqual(TEXT("two initial selectable blocks"), Before.Num(), 2)) return false;
    Before[1]->SelectText(FTextLocation(0, 0), FTextLocation(0, 6));
    Body->SetMessageText(TEXT("Stable paragraph.\n\nStreaming more text.\n\n- Next step"));
    TArray<TSharedPtr<SMultiLineEditableText>> After;
    CollectSelectableText(Body, After);
    if (!TestEqual(TEXT("append adds exactly one block"), After.Num(), 3)) return false;
    TestTrue(TEXT("completed paragraph widget retained"), Before[0] == After[0]);
    TestTrue(TEXT("active paragraph widget retained"), Before[1] == After[1]);
    TestEqual(TEXT("selection survives append"), After[1]->GetSelectedText().ToString(), FString(TEXT("Stream")));
    Body->SetMessageText(TEXT("Stable paragraph.\n\nStreaming more text.\n\n- Next step"));
    TArray<TSharedPtr<SMultiLineEditableText>> Replay;
    CollectSelectableText(Body, Replay);
    TestEqual(TEXT("same projection does not duplicate blocks"), Replay.Num(), 3);
    TestTrue(TEXT("replay retains selected widget"), Replay[1] == Before[1]);

    const TSharedRef<SHaybaChatMessageBody> Delimiter = SNew(SHaybaChatMessageBody);
    Delimiter->SetMessageText(TEXT("``"));
    TArray<TSharedPtr<SMultiLineEditableText>> Partial;
    CollectSelectableText(Delimiter, Partial);
    Partial[0]->SelectText(FTextLocation(0, 0), FTextLocation(0, 2));
    Delimiter->SetMessageText(TEXT("```cpp\nint Value = 1;"));
    TestEqual(TEXT("grammar promotion cannot destroy selection"), Partial[0]->GetSelectedText().ToString(), FString(TEXT("``")));
    Partial[0]->ClearSelection();
    Delimiter->Tick(FGeometry(), 0.0, 0.f);
    TArray<TSharedPtr<SMultiLineEditableText>> Promoted;
    CollectSelectableText(Delimiter, Promoted);
    TestEqual(TEXT("deferred promotion keeps all incoming text"), Promoted[0]->GetText().ToString(), FString(TEXT("int Value = 1;")));
    TestEqual(TEXT("code offers one copy action"), CountButtons(Delimiter), 1);

    // Selecting an unchanged earlier block must not freeze a coalesced delta in
    // the active block. This also covers the final delta arriving before done.
    const TSharedRef<SHaybaChatMessageBody> SelectedLongReply = SNew(SHaybaChatMessageBody);
    const FString LongParagraph = FString::ChrN(4200, 'x');
    const FString InitialLongReply = TEXT("Keep this selection.\n\n") + LongParagraph;
    SelectedLongReply->SetMessageText(InitialLongReply);
    TArray<TSharedPtr<SMultiLineEditableText>> SelectedBefore;
    CollectSelectableText(SelectedLongReply, SelectedBefore);
    if (!TestEqual(TEXT("long reply has two selectable blocks"), SelectedBefore.Num(), 2)) return false;
    SelectedBefore[0]->SelectText(FTextLocation(0, 0), FTextLocation(0, 4));
    const FString FinalLongReply = InitialLongReply + TEXT(" final delta");
    SelectedLongReply->SetMessageText(FinalLongReply);
    FPlatformProcess::Sleep(0.06f);
    SelectedLongReply->Tick(FGeometry(), 0.0, 0.f);
    TArray<TSharedPtr<SMultiLineEditableText>> SelectedAfter;
    CollectSelectableText(SelectedLongReply, SelectedAfter);
    if (!TestEqual(TEXT("coalesced reply still has two blocks"), SelectedAfter.Num(), 2)) return false;
    TestTrue(TEXT("selected block retains widget identity"), SelectedAfter[0] == SelectedBefore[0]);
    TestEqual(TEXT("earlier selection survives coalesced delta"), SelectedAfter[0]->GetSelectedText().ToString(), FString(TEXT("Keep")));
    TestEqual(TEXT("active block receives final coalesced delta while earlier text is selected"),
        SelectedAfter[1]->GetText().ToString(), LongParagraph + TEXT(" final delta"));

    // A busy SSE burst must retain its final text even when intermediate
    // layouts are coalesced for editor responsiveness.
    const TSharedRef<SHaybaChatMessageBody> LongReply = SNew(SHaybaChatMessageBody);
    FString Stream;
    const double StartedAt = FPlatformTime::Seconds();
    for (int32 I = 0; I < 800; ++I)
    {
        Stream += TEXT("The loaded scene is under review; budgets and source evidence remain explicit. ");
        LongReply->SetMessageText(Stream);
    }
    FPlatformProcess::Sleep(0.06f);
    LongReply->Tick(FGeometry(), 0.0, 0.f);
    TArray<TSharedPtr<SMultiLineEditableText>> Final;
    CollectSelectableText(LongReply, Final);
    if (!TestEqual(TEXT("long stream remains one selectable paragraph"), Final.Num(), 1)) return false;
    TestTrue(TEXT("coalescing loses no final SSE text"), Final[0]->GetText().ToString() == Stream);
    AddInfo(FString::Printf(TEXT("Long message burst and final layout: %.1f ms"),
        (FPlatformTime::Seconds() - StartedAt) * 1000.0));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaChatMessageInertMarkupTest, "Hayba.Chat.Messages.InertMarkup",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaChatMessageInertMarkupTest::RunTest(const FString&)
{
    const FString Markup = TEXT("<a href=\"javascript:approve()\">Approve</a>\n<img src=\"file:///x\">\n[Run](unreal:execute)\n![Image](https://example.com/image.png)\nApprove next command");
    const TSharedRef<SHaybaChatMessageBody> Body = SNew(SHaybaChatMessageBody);
    Body->SetMessageText(Markup);
    TArray<TSharedPtr<SMultiLineEditableText>> Text;
    CollectSelectableText(Body, Text);
    if (!TestEqual(TEXT("malicious markup stays one literal block"), Text.Num(), 1)) return false;
    TestEqual(TEXT("markup preserved as selectable text"), Text[0]->GetText().ToString(), Markup);
    TestEqual(TEXT("prose creates no approval, image or execution action"), CountButtons(Body), 0);
    const TSharedRef<SHaybaChatMessageBody> User = SNew(SHaybaChatMessageBody).PlainText(true);
    User->SetMessageText(TEXT("[Docs](https://example.com/)\n```cpp\ncode"));
    TestEqual(TEXT("user input never becomes an action"), CountButtons(User), 0);
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaChatActivityFocusTest, "Hayba.Chat.Messages.ActivityFocus",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaChatActivityFocusTest::RunTest(const FString&)
{
    FHaybaActivityModel Model;
    TestTrue(TEXT("activity starts"), Model.ApplyEvent(*ActivityEvent(TEXT(R"({"type":"activity_started","activityId":"focus-a1","title":"Inspect world"})"))));
    TestTrue(TEXT("first step starts"), Model.ApplyEvent(*ActivityEvent(TEXT(R"({"type":"activity_step","activityId":"focus-a1","step":{"status":"running","id":"one","name":"first_step","input":{}}})"))));
    auto MakeCard = [&Model]() -> TSharedRef<SHaybaActivityCard>
    {
        return SNew(SHaybaActivityCard).ActivityModel(&Model).ActivityId(TEXT("focus-a1"))
            .InitiallyExpanded(true).OnCancel(FSimpleDelegate::CreateLambda([]() {}));
    };
    TSharedPtr<SBox> ActivitySlot;
    TSharedRef<SWindow> Window = SNew(SWindow).ClientSize(FVector2D(480, 360))
        [ SAssignNew(ActivitySlot, SBox) [ MakeCard() ] ];
    FSlateApplication::Get().AddWindow(Window);
    FSlateApplication::Get().Tick();
    TSharedPtr<SButton> FirstCancel = FindButtonByLabel(ActivitySlot.ToSharedRef(), TEXT("Cancel"));
    if (TestTrue(TEXT("running card has Cancel"), FirstCancel.IsValid()))
    {
        FSlateApplication::Get().SetKeyboardFocus(FirstCancel, EFocusCause::SetDirectly);
        TestTrue(TEXT("Cancel receives keyboard focus"), FSlateApplication::Get().GetKeyboardFocusedWidget() == FirstCancel);
        TestTrue(TEXT("next step updates model"), Model.ApplyEvent(*ActivityEvent(TEXT(R"({"type":"activity_step","activityId":"focus-a1","step":{"status":"running","id":"two","name":"second_step","input":{}}})"))));
        HaybaChatFocus::ReplaceActivityContent(ActivitySlot.ToSharedRef(), MakeCard());
        TSharedPtr<SButton> RefreshedCancel = FindButtonByLabel(ActivitySlot.ToSharedRef(), TEXT("Cancel"));
        TestTrue(TEXT("Cancel remains keyboard focused after the same activity updates"),
            RefreshedCancel.IsValid() && FSlateApplication::Get().GetKeyboardFocusedWidget() == RefreshedCancel);
        TArray<FString> Labels;
        CollectLabels(ActivitySlot.ToSharedRef(), Labels);
        TestTrue(TEXT("expanded card shows the new step"), Labels.ContainsByPredicate([](const FString& Label)
        { return Label.Contains(TEXT("second_step")); }));
        TestTrue(TEXT("activity completes"), Model.ApplyEvent(*ActivityEvent(TEXT(R"({"type":"activity_completed","activityId":"focus-a1","outcome":"succeeded","reason":"end_turn","usage":{"inputTokens":3}})"))));
        HaybaChatFocus::ReplaceActivityContent(ActivitySlot.ToSharedRef(), MakeCard());
        TestEqual(TEXT("completed card removes Cancel"), CountButtons(ActivitySlot.ToSharedRef()), 1);
        TestTrue(TEXT("removed action returns focus to activity header"),
            FSlateApplication::Get().GetKeyboardFocusedWidget() == FirstButton(ActivitySlot.ToSharedRef()));
    }
    FSlateApplication::Get().RequestDestroyWindow(Window);
    FSlateApplication::Get().Tick();
    return true;
}
#endif
