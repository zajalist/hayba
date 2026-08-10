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
#include "HaybaMCPParams.h"
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

    FGuid Guid(uint32 D)
    {
        return FGuid(0xA11CE000u + D, 0xBADC0DEu, 0xC001D00Du, D + 1u);
    }
}

// ── WidgetBlueprint variable-GUID invariant ──────────────────────────────

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaUIOpsVariableGuidReconciliationTest,
    "Hayba.MCP.UIOps.VariableGuidReconciliation",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaUIOpsVariableGuidReconciliationTest::RunTest(const FString&)
{
    using namespace HaybaUIOps;

    {
        const TMap<FName, FGuid> Before = {
            { TEXT("Root"), Guid(1) },
            { TEXT("Title"), Guid(2) },
        };
        const FVariableGuidReconciliation Plan =
            PlanVariableGuidReconciliation({ TEXT("Root"), TEXT("Title") }, Before);
        TestTrue(TEXT("a valid tree is accepted"), Plan.CanApply());
        TestFalse(TEXT("a valid tree is unchanged"), Plan.bChanged);
        TestEqual(TEXT("valid GUIDs are preserved"), Plan.Reconciled.FindRef(TEXT("Title")), Guid(2));
    }

    {
        const TMap<FName, FGuid> Before = {
            { TEXT("Root"), Guid(1) },
            { TEXT("Deleted"), Guid(3) },
        };
        const FVariableGuidReconciliation Plan =
            PlanVariableGuidReconciliation({ TEXT("Root"), TEXT("Added") }, Before);
        TestTrue(TEXT("missing and stale entries are repairable"), Plan.CanApply());
        TestTrue(TEXT("the repair changes the map"), Plan.bChanged);
        TestTrue(TEXT("the added source is classified missing"), Plan.Missing.Contains(TEXT("Added")));
        TestTrue(TEXT("the deleted source is classified stale"), Plan.Stale.Contains(TEXT("Deleted")));
        TestTrue(TEXT("the added source gets a valid GUID"), Plan.Reconciled.FindRef(TEXT("Added")).IsValid());
        TestFalse(TEXT("the deleted source no longer has a GUID"), Plan.Reconciled.Contains(TEXT("Deleted")));

        const FVariableGuidReconciliation Again =
            PlanVariableGuidReconciliation({ TEXT("Root"), TEXT("Added") }, Plan.Reconciled);
        TestFalse(TEXT("recovery is idempotent"), Again.bChanged);
    }

    {
        const TMap<FName, FGuid> Before = {
            { TEXT("Invalid"), FGuid() },
            { TEXT("A"), Guid(8) },
            { TEXT("B"), Guid(8) },
        };
        const FVariableGuidReconciliation Plan =
            PlanVariableGuidReconciliation({ TEXT("Invalid"), TEXT("A"), TEXT("B") }, Before);
        TestTrue(TEXT("invalid and colliding GUIDs are repairable"), Plan.CanApply());
        TestTrue(TEXT("the invalid GUID is classified"), Plan.Invalid.Contains(TEXT("Invalid")));
        TestEqual(TEXT("one duplicate GUID is reissued"), Plan.Colliding.Num(), 1);
        TestTrue(TEXT("all repaired GUIDs are valid"),
            Plan.Reconciled.FindRef(TEXT("Invalid")).IsValid()
            && Plan.Reconciled.FindRef(TEXT("A")).IsValid()
            && Plan.Reconciled.FindRef(TEXT("B")).IsValid());
        TestTrue(TEXT("colliding sources become unique"),
            Plan.Reconciled.FindRef(TEXT("A")) != Plan.Reconciled.FindRef(TEXT("B")));
    }

    {
        // Rename preserves identity because the handler moves the old GUID to
        // the final name before asking the whole-tree planner to validate it.
        TMap<FName, FGuid> AfterRename = { { TEXT("After"), Guid(11) } };
        const FVariableGuidReconciliation Plan =
            PlanVariableGuidReconciliation({ TEXT("After") }, AfterRename);
        TestFalse(TEXT("rename with a transferred GUID needs no repair"), Plan.bChanged);
        TestEqual(TEXT("rename preserves the GUID"), Plan.Reconciled.FindRef(TEXT("After")), Guid(11));
    }

    {
        // Replace with preservation keeps the old identity; replacement without
        // preservation deliberately starts with no entry and receives a new one.
        const FVariableGuidReconciliation Preserved =
            PlanVariableGuidReconciliation({ TEXT("Widget") }, { { TEXT("Widget"), Guid(12) } });
        const FVariableGuidReconciliation Reissued =
            PlanVariableGuidReconciliation({ TEXT("Widget") }, {});
        TestEqual(TEXT("replace can preserve identity"), Preserved.Reconciled.FindRef(TEXT("Widget")), Guid(12));
        TestTrue(TEXT("replace without preservation gets a GUID"), Reissued.Reconciled.FindRef(TEXT("Widget")).IsValid());
        TestTrue(TEXT("replace without preservation gets a different identity"),
            Reissued.Reconciled.FindRef(TEXT("Widget")) != Guid(12));
    }

    {
        const FVariableGuidReconciliation Removal =
            PlanVariableGuidReconciliation({ TEXT("Root") }, {
                { TEXT("Root"), Guid(1) },
                { TEXT("RemovedParent"), Guid(2) },
                { TEXT("RemovedChild"), Guid(3) },
            });
        TestEqual(TEXT("subtree removal purges every stale GUID"), Removal.Stale.Num(), 2);
        TestEqual(TEXT("only the live root remains"), Removal.Reconciled.Num(), 1);
    }

    {
        // bIsVariable controls generated member exposure, not this compiler map:
        // both toggle states present the same source set and must keep the GUID.
        const TMap<FName, FGuid> Before = { { TEXT("Label"), Guid(15) } };
        const FVariableGuidReconciliation ToggleOff =
            PlanVariableGuidReconciliation({ TEXT("Label") }, Before);
        const FVariableGuidReconciliation ToggleOn =
            PlanVariableGuidReconciliation({ TEXT("Label") }, ToggleOff.Reconciled);
        TestFalse(TEXT("variable off keeps the compiler GUID"), ToggleOff.bChanged);
        TestFalse(TEXT("variable on keeps the same compiler GUID"), ToggleOn.bChanged);
    }

    {
        const FVariableGuidReconciliation Duplicate =
            PlanVariableGuidReconciliation({ TEXT("Same"), TEXT("Same") }, {});
        TestFalse(TEXT("duplicate source names block compilation"), Duplicate.CanApply());
        TestTrue(TEXT("the duplicate is named"), Duplicate.DuplicateSourceNames.Contains(TEXT("Same")));
        TestTrue(TEXT("a blocked tree is not partially rewritten"), Duplicate.Reconciled.IsEmpty());
    }

    {
        const FVariableGuidReconciliation Scratch =
            PlanVariableGuidReconciliation({ TEXT("Root"), TEXT("TRASH_Old") }, {});
        TestFalse(TEXT("trash-name leakage blocks compilation"), Scratch.CanApply());
        TestTrue(TEXT("the scratch source is classified"), Scratch.ScratchSourceNames.Contains(TEXT("TRASH_Old")));
        TestTrue(TEXT("the error is actionable"), Scratch.BlockingReason().Contains(TEXT("temporary/trash")));
    }

    return true;
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

// ── ui_set_widget_properties: parse ─────────────────────────────────────────

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaUIOpsParseSetPropertiesTest,
    "Hayba.MCP.UIOps.ParseSetProperties",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaUIOpsParseSetPropertiesTest::RunTest(const FString&)
{
    using namespace HaybaUIOps;

    {
        FHaybaParamReader R(
            Json(TEXT(R"({"widget_blueprint_path":"/Game/W.W","widget_name":"Title","properties":{"Text":"hi"}})")),
            TEXT("ui_set_widget_properties"));
        const FSetPropertiesRequest Req = ParseSetProperties(R);
        TestFalse(TEXT("a well-formed request parses"), R.HasErrors());
        TestEqual(TEXT("path"), Req.BlueprintPath, FString(TEXT("/Game/W.W")));
        TestEqual(TEXT("widget"), Req.WidgetName, FString(TEXT("Title")));
        TestTrue(TEXT("properties come through"), Req.Properties.IsValid());
        TestFalse(TEXT("no slot payload was sent"), Req.Slot.IsSet());
    }

    {
        // Slot layout alone is a complete request — the widget properties object
        // is optional, and requiring it rejected every pure-layout call.
        FHaybaParamReader R(
            Json(TEXT(R"({"widget_blueprint_path":"/Game/W.W","widget_name":"Title","slot_layout":{"Padding":4}})")),
            TEXT("ui_set_widget_properties"));
        const FSetPropertiesRequest Req = ParseSetProperties(R);
        TestFalse(TEXT("slot-only is valid"), R.HasErrors());
        TestTrue(TEXT("and the spelling is carried to the reply"),
                 Req.Slot.Spelling == ESlotPropsSpelling::SlotLayout);
    }

    {
        // The case this seam exists for. An empty `properties` object is a
        // well-formed request that asks for nothing; it used to load the
        // blueprint, mark the package dirty and fail with an empty list of
        // rejected keys, which reads as "your property names are all wrong".
        FHaybaParamReader R(
            Json(TEXT(R"({"widget_blueprint_path":"/Game/W.W","widget_name":"Title","properties":{}})")),
            TEXT("ui_set_widget_properties"));
        ParseSetProperties(R);
        TestTrue(TEXT("an empty properties object is rejected before the editor"), R.HasErrors());
        TestTrue(TEXT("and the error says what to send"),
                 R.ErrorMessage().Contains(TEXT("properties")) && R.ErrorMessage().Contains(TEXT("slot_props")));
    }

    {
        FHaybaParamReader R(
            Json(TEXT(R"({"widget_blueprint_path":"/Game/W.W","widget_name":"Title"})")),
            TEXT("ui_set_widget_properties"));
        ParseSetProperties(R);
        TestTrue(TEXT("no payload at all is rejected"), R.HasErrors());
    }

    {
        FHaybaParamReader R(
            Json(TEXT(R"({"widget_blueprint_path":"/Game/W.W","widget_name":"Title","slot_props":{}})")),
            TEXT("ui_set_widget_properties"));
        ParseSetProperties(R);
        TestTrue(TEXT("an empty slot payload is nothing to apply either"), R.HasErrors());
    }

    {
        // Every problem in one message rather than one round trip per mistake:
        // the old handler returned on the first missing field.
        FHaybaParamReader R(Json(TEXT(R"({})")), TEXT("ui_set_widget_properties"));
        ParseSetProperties(R);
        const FString Msg = R.ErrorMessage();
        TestTrue(TEXT("names the command"), Msg.Contains(TEXT("ui_set_widget_properties")));
        TestTrue(TEXT("reports the missing blueprint path"), Msg.Contains(TEXT("widget_blueprint_path")));
        TestTrue(TEXT("and the missing widget name, together"), Msg.Contains(TEXT("widget_name")));
    }

    {
        // A null `properties` must not read as an empty object and slip past the
        // has-anything check as "present".
        FHaybaParamReader R(
            Json(TEXT(R"({"widget_blueprint_path":"/Game/W.W","widget_name":"Title","properties":null})")),
            TEXT("ui_set_widget_properties"));
        const FSetPropertiesRequest Req = ParseSetProperties(R);
        TestFalse(TEXT("null is not a properties object"), Req.Properties.IsValid());
        TestTrue(TEXT("so there is nothing to apply"), R.HasErrors());
    }

    return true;
}

// ── ui_set_widget_properties: shape ─────────────────────────────────────────

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaUIOpsShapeSetPropertiesTest,
    "Hayba.MCP.UIOps.ShapeSetProperties",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaUIOpsShapeSetPropertiesTest::RunTest(const FString&)
{
    using namespace HaybaUIOps;

    {
        FSetPropertiesResult Res;
        Res.WidgetName = TEXT("Title");
        Res.Succeeded = 2;
        const TSharedPtr<FJsonObject> Out = ShapeSetProperties(Res);

        FString Name;
        TestTrue(TEXT("the widget is named"), Out->TryGetStringField(TEXT("widget_name"), Name) && Name == TEXT("Title"));
        TestEqual(TEXT("counts are reported"), (int32)Out->GetNumberField(TEXT("succeeded")), 2);
        TestEqual(TEXT("including the zero"), (int32)Out->GetNumberField(TEXT("failed")), 0);
        // Empty lists are omitted rather than sent as [] — an absent key reads
        // as "nothing to say", an empty array invites a caller to look for one.
        TestFalse(TEXT("no empty failed_properties"), Out->HasField(TEXT("failed_properties")));
        TestFalse(TEXT("no empty warnings"), Out->HasField(TEXT("warnings")));
        TestFalse(TEXT("the documented spelling is not worth mentioning"),
                  Out->HasField(TEXT("slot_props_read_from")));
    }

    {
        // A deprecated spelling must be named, or a caller cannot tell being
        // right from being forgiven and never learns the documented name.
        FSetPropertiesResult Res;
        Res.WidgetName = TEXT("Title");
        Res.Succeeded = 1;
        Res.SlotSpelling = ESlotPropsSpelling::SlotLayout;
        const TSharedPtr<FJsonObject> Out = ShapeSetProperties(Res);
        FString From;
        TestTrue(TEXT("the spelling used is reported"),
                 Out->TryGetStringField(TEXT("slot_props_read_from"), From) && From == TEXT("slot_layout"));
    }

    {
        FSetPropertiesResult Res;
        Res.WidgetName = TEXT("Title");
        Res.Succeeded = 1;
        Res.Failed = 2;
        Res.FailedProps = { TEXT("Nope"), SlotKeyName(TEXT("Padding")) };
        Res.UnknownSlotProps = { TEXT("Padding") };
        Res.Warnings = { TEXT("Slot is a UCanvasPanelSlot") };
        const TSharedPtr<FJsonObject> Out = ShapeSetProperties(Res);

        const TArray<TSharedPtr<FJsonValue>>* Failed = nullptr;
        TestTrue(TEXT("rejected keys are listed"), Out->TryGetArrayField(TEXT("failed_properties"), Failed));
        TestEqual(TEXT("all of them"), Failed->Num(), 2);
        // A flat list mixing widget and slot keys would be ambiguous: a slot has
        // its own property namespace and "Padding" exists in both.
        TestEqual(TEXT("slot keys are prefixed so they cannot be confused with widget ones"),
                  (*Failed)[1]->AsString(), FString(TEXT("slot.Padding")));
        TestTrue(TEXT("unknown slot keys are called out separately"),
                 Out->HasField(TEXT("unknown_slot_props")));
        TestTrue(TEXT("warnings survive"), Out->HasField(TEXT("warnings")));
    }

    {
        FSetPropertiesResult Res;
        Res.WidgetName = TEXT("Title");
        Res.Failed = 1;
        Res.FailedProps = { TEXT("Nope") };
        TestTrue(TEXT("nothing applied is a failure, not an ok with zeroes"), Res.AppliedNothing());
        const FString Msg = NothingAppliedError(Res);
        TestTrue(TEXT("the error names the widget"), Msg.Contains(TEXT("Title")));
        TestTrue(TEXT("and the key that was rejected, so the caller can fix it"),
                 Msg.Contains(TEXT("Nope")));
    }

    return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
