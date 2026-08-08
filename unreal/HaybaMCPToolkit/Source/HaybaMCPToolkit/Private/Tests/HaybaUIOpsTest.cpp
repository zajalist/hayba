// Slot-payload naming, tested without an editor.
//
// Three spellings of the same payload have shipped in three layers, and for a
// while only one was read — so the typed slot tool's own payload fell on the
// floor and ui_set_widget_properties answered "no properties provided" to
// requests that were entirely correct. Tolerance was added inline, in the
// middle of a function that also walks the widget tree and calls PostEditChange,
// where nothing could test it.
//
// Resolution is pure. It belongs here.

#include "Misc/AutomationTest.h"
#include "HaybaUIOps.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

#if WITH_DEV_AUTOMATION_TESTS

namespace
{
    TSharedPtr<FJsonObject> Json(const FString& Text)
    {
        TSharedPtr<FJsonObject> Obj;
        const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Text);
        FJsonSerializer::Deserialize(Reader, Obj);
        return Obj;
    }
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaUIOpsResolveSlotPropsTest,
    "Hayba.MCP.UIOps.ResolveSlotProps",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaUIOpsResolveSlotPropsTest::RunTest(const FString&)
{
    using namespace HaybaUIOps;

    {
        const FSlotPropsPayload R = ResolveSlotProps(Json(TEXT(R"({"slot_props":{"a":1}})")));
        TestTrue(TEXT("slot_props is found"), R.IsSet());
        TestTrue(TEXT("and reported as the public spelling"), R.Spelling == ESlotPropsSpelling::SlotProps);
    }

    {
        const FSlotPropsPayload R = ResolveSlotProps(Json(TEXT(R"({"slot_properties":{"a":1}})")));
        TestTrue(TEXT("the early handler spelling is accepted"), R.IsSet());
        TestTrue(TEXT("and named"), R.Spelling == ESlotPropsSpelling::SlotProperties);
    }

    {
        // The one that broke: the typed slot tool sends this name.
        const FSlotPropsPayload R = ResolveSlotProps(Json(TEXT(R"({"slot_layout":{"a":1}})")));
        TestTrue(TEXT("the typed slot tool's spelling is accepted"), R.IsSet());
        TestTrue(TEXT("and named"), R.Spelling == ESlotPropsSpelling::SlotLayout);
    }

    {
        // Precedence: a caller sending several gets the documented one, so
        // tolerance never silently changes which payload is applied.
        const FSlotPropsPayload R = ResolveSlotProps(
            Json(TEXT(R"({"slot_layout":{"which":"layout"},"slot_props":{"which":"props"}})")));
        TestTrue(TEXT("public schema wins"), R.Spelling == ESlotPropsSpelling::SlotProps);
        FString Which;
        TestTrue(TEXT("and it is that object that comes back"),
                 R.Object->TryGetStringField(TEXT("which"), Which) && Which == TEXT("props"));
    }

    {
        const FSlotPropsPayload R = ResolveSlotProps(Json(TEXT(R"({"properties":{"a":1}})")));
        TestFalse(TEXT("widget properties are not slot properties"), R.IsSet());
        TestTrue(TEXT("and nothing is claimed"), R.Spelling == ESlotPropsSpelling::None);
    }

    {
        // An explicit null or a non-object must not read as present, or the
        // handler proceeds to apply nothing and reports having applied it.
        const FSlotPropsPayload R = ResolveSlotProps(Json(TEXT(R"({"slot_props":null})")));
        TestFalse(TEXT("a null payload is not a payload"), R.IsSet());
    }

    {
        const FSlotPropsPayload R = ResolveSlotProps(nullptr);
        TestFalse(TEXT("a null params object is handled"), R.IsSet());
    }

    TestEqual(TEXT("spelling names round-trip"),
              FString(SpellingName(ESlotPropsSpelling::SlotLayout)), FString(TEXT("slot_layout")));
    TestEqual(TEXT("None has no name"),
              FString(SpellingName(ESlotPropsSpelling::None)), FString());

    return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
