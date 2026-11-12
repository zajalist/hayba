// Blueprint rules that decide things, tested without an editor.
//
// Both were found by calling the commands against a live editor while writing
// their descriptions, and both had the same shape: the command answered ok for
// work that had gone somewhere the caller did not intend.

#include "Misc/AutomationTest.h"
#include "HaybaBlueprintOps.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

#if WITH_DEV_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaBlueprintOpsResolvePackageTest,
    "Hayba.MCP.BlueprintOps.ResolvePackage",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaBlueprintOpsResolvePackageTest::RunTest(const FString&)
{
    using namespace HaybaBlueprintOps;

    {
        // The documented usage: package_path IS the intended asset path.
        const FResolvedPackage R = ResolvePackage(TEXT("/Game/UI/BP_Menu"), TEXT("BP_Menu"));
        TestEqual(TEXT("lands where the caller said"), R.PackageName, FString(TEXT("/Game/UI/BP_Menu")));
        TestFalse(TEXT("nothing surprising to report"), R.bTrailingIsNotName);
        TestTrue(TEXT("so no note"), PackagePathNote(R, TEXT("/Game/UI/BP_Menu")).IsEmpty());
    }

    {
        // The trap. A caller reading the parameter name passes a FOLDER, and the
        // asset is created one directory up from where they meant. This put a
        // probe asset at the content root twice in one afternoon.
        const FResolvedPackage R = ResolvePackage(TEXT("/Game/Temp"), TEXT("BP_Probe"));
        TestEqual(TEXT("the trailing component is discarded, not treated as a folder"),
                  R.PackageName, FString(TEXT("/Game/BP_Probe")));
        TestTrue(TEXT("and that is flagged"), R.bTrailingIsNotName);

        const FString Note = PackagePathNote(R, TEXT("/Game/Temp"));
        TestFalse(TEXT("a note is produced"), Note.IsEmpty());
        TestTrue(TEXT("naming where it actually went"), Note.Contains(TEXT("/Game/BP_Probe")));
        TestTrue(TEXT("and how to get what was meant"), Note.Contains(TEXT("/Game/Temp/<name>")));
    }

    {
        // Case should not decide whether the caller gets a warning.
        const FResolvedPackage R = ResolvePackage(TEXT("/Game/UI/bp_menu"), TEXT("BP_Menu"));
        TestFalse(TEXT("trailing matches the name case-insensitively"), R.bTrailingIsNotName);
    }

    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaBlueprintOpsFunctionNameTest,
    "Hayba.MCP.BlueprintOps.FunctionNameConflict",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaBlueprintOpsFunctionNameTest::RunTest(const FString&)
{
    using namespace HaybaBlueprintOps;

    const TArray<FString> Existing = { TEXT("EventGraph"), TEXT("ProbeFunc"), TEXT("ConstructionScript") };

    {
        TestTrue(TEXT("a free name is free"),
                 FunctionNameConflict(Existing, TEXT("NewThing")).IsEmpty());
    }

    {
        // The bug this exists for: adding a duplicate compiled to "Found more
        // than one function with the same name", left the blueprint broken, and
        // still answered ok.
        const FString Err = FunctionNameConflict(Existing, TEXT("ProbeFunc"));
        TestFalse(TEXT("a taken name is refused"), Err.IsEmpty());
        TestTrue(TEXT("the message names the collision"), Err.Contains(TEXT("ProbeFunc")));
        TestTrue(TEXT("and says nothing was changed, because nothing was"),
                 Err.Contains(TEXT("nothing was changed")));
    }

    {
        // FName comparison is case-insensitive, so "probefunc" collides too —
        // letting it through would produce the same broken blueprint by a route
        // the check appeared to cover.
        TestFalse(TEXT("case does not create a second slot"),
                  FunctionNameConflict(Existing, TEXT("probefunc")).IsEmpty());
    }

    {
        TestTrue(TEXT("no graphs, no conflict"),
                 FunctionNameConflict({}, TEXT("Anything")).IsEmpty());
    }

    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaBlueprintOpsBatchTranslateTest,
    "Hayba.MCP.BlueprintOps.BatchTranslate",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaBlueprintOpsBatchTranslateTest::RunTest(const FString&)
{
    using namespace HaybaBlueprintOps;
    auto Op = [](const FString& Json)
    {
        TSharedPtr<FJsonObject> Obj;
        FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Json), Obj);
        return Obj;
    };
    const FString Guid = FGuid::NewGuid().ToString();
    TMap<FString, FString> Refs = { { TEXT("print"), Guid } };

    {
        // connect with refs and no pins: exec wiring is the common case.
        const FBatchStep S = TranslateBatchOp(Op(TEXT("{\"op\":\"connect\",\"from_node\":\"print\",\"to_node\":\"print\"}")),
            TEXT("/Game/BP_X"), TEXT("EventGraph"), Refs);
        TestTrue(TEXT("no error"), S.Error.IsEmpty());
        TestEqual(TEXT("maps to the single command"), S.Command, FString(TEXT("blueprint_connect_nodes")));
        TestEqual(TEXT("ref replaced by GUID"), S.Params->GetStringField(TEXT("from_node")), Guid);
        TestEqual(TEXT("exec out default"), S.Params->GetStringField(TEXT("from_pin")), FString(TEXT("then")));
        TestEqual(TEXT("exec in default"), S.Params->GetStringField(TEXT("to_pin")), FString(TEXT("execute")));
        TestEqual(TEXT("batch path wins"), S.Params->GetStringField(TEXT("path")), FString(TEXT("/Game/BP_X")));
        TestEqual(TEXT("default graph applied"), S.Params->GetStringField(TEXT("graph_name")), FString(TEXT("EventGraph")));
        TestFalse(TEXT("op key is not forwarded"), S.Params->HasField(TEXT("op")));
    }
    {
        // A name that no earlier op created must stop the batch, not reach the handler.
        const FBatchStep S = TranslateBatchOp(Op(TEXT("{\"op\":\"set_pin\",\"node_id\":\"nope\",\"pin_name\":\"A\",\"value\":\"1\"}")),
            TEXT("/Game/BP_X"), FString(), Refs);
        TestFalse(TEXT("unknown ref is an error"), S.Error.IsEmpty());
        TestTrue(TEXT("no command"), S.Command.IsEmpty());
    }
    {
        // A literal GUID from an earlier call passes through untouched.
        const FBatchStep S = TranslateBatchOp(Op(FString::Printf(TEXT("{\"op\":\"remove\",\"node_ids\":[\"%s\",\"print\"]}"), *FGuid::NewGuid().ToString())),
            TEXT("/Game/BP_X"), FString(), Refs);
        TestTrue(TEXT("GUIDs and refs mix"), S.Error.IsEmpty());
        TestEqual(TEXT("second id resolved"), S.Params->GetArrayField(TEXT("node_ids"))[1]->AsString(), Guid);
    }
    {
        // move takes one node inline; the command takes a list.
        const FBatchStep S = TranslateBatchOp(Op(TEXT("{\"op\":\"move\",\"node_id\":\"print\",\"x\":10,\"y\":20}")),
            TEXT("/Game/BP_X"), FString(), Refs);
        TestTrue(TEXT("inline move accepted"), S.Error.IsEmpty());
        const TArray<TSharedPtr<FJsonValue>>& Moves = S.Params->GetArrayField(TEXT("moves"));
        TestEqual(TEXT("one move"), Moves.Num(), 1);
        TestEqual(TEXT("move resolved"), Moves[0]->AsObject()->GetStringField(TEXT("node_id")), Guid);
        TestFalse(TEXT("inline fields folded away"), S.Params->HasField(TEXT("x")));
    }
    {
        TestFalse(TEXT("duplicate ref refused"), TranslateBatchOp(Op(TEXT("{\"op\":\"add_node\",\"ref\":\"print\"}")),
            TEXT("/Game/BP_X"), FString(), Refs).Error.IsEmpty());
        TestFalse(TEXT("GUID-shaped ref refused"), TranslateBatchOp(Op(FString::Printf(TEXT("{\"op\":\"add_node\",\"ref\":\"%s\"}"), *Guid)),
            TEXT("/Game/BP_X"), FString(), Refs).Error.IsEmpty());
        TestFalse(TEXT("unknown op refused"), TranslateBatchOp(Op(TEXT("{\"op\":\"compile\"}")),
            TEXT("/Game/BP_X"), FString(), Refs).Error.IsEmpty());
    }
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaBlueprintOpsCommentBoxTest,
    "Hayba.MCP.BlueprintOps.CommentBox",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaBlueprintOpsCommentBoxTest::RunTest(const FString&)
{
    using namespace HaybaBlueprintOps;
    const FNodeBox Known = EstimateNodeBox(0, 0, 300, 120, 5, 1, 1, 3, 3);
    TestEqual(TEXT("known width wins"), Known.W, 300);
    TestEqual(TEXT("known height wins"), Known.H, 120);

    const FNodeBox Guessed = EstimateNodeBox(0, 0, 0, 0, 40, 4, 1, 10, 12);
    TestTrue(TEXT("long title widens"), Guessed.W >= 40 * 7);
    TestEqual(TEXT("height grows with the taller pin column"), Guessed.H, 40 + 26 * 4);

    const FNodeBox C = CommentAround({ { 100, 100, 200, 80 }, { 400, 300, 100, 50 } }, 40, 36);
    TestEqual(TEXT("left edge padded"), C.X, 60);
    TestEqual(TEXT("top edge padded plus title band"), C.Y, 100 - 40 - 36);
    TestEqual(TEXT("spans both nodes"), C.W, (500 - 100) + 80);
    TestEqual(TEXT("height spans both nodes"), C.H, (350 - 100) + 80 + 36);
    TestEqual(TEXT("empty input gives an empty box, never a crash"), CommentAround({}, 40, 36).W, 0);
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaBlueprintOpsCommentLayoutTest,
    "Hayba.MCP.BlueprintOps.CommentLayout",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaBlueprintOpsCommentLayoutTest::RunTest(const FString&)
{
    using namespace HaybaBlueprintOps;
    {
        // An outer comment, an inner comment inside it, a node that starts inside the inner
        // box but spills out of it (the clipping bug), and a loose node.
        const TArray<FNodeBox> Items = {
            { 0, 0, 1000, 800 },   // 0 outer comment
            { 100, 100, 300, 200 },// 1 inner comment
            { 150, 150, 500, 300 },// 2 node: starts inside 1, overflows it
            { 2000, 0, 200, 100 }, // 3 loose node
        };
        const TArray<int32> Owners = AssignOwners(Items, { true, true, false, false });
        TestEqual(TEXT("inner nests in outer"), Owners[1], 0);
        TestEqual(TEXT("a spilling node still belongs to the innermost box it starts in"), Owners[2], 1);
        TestEqual(TEXT("loose node has no owner"), Owners[3], INDEX_NONE);
        TestEqual(TEXT("outer is top level"), Owners[0], INDEX_NONE);

        const FNodeBox Fitted = CommentAround({ Items[2] }, 40, 36);
        TestTrue(TEXT("fitting around the real size encloses the node"), Encloses(Fitted, Items[2]));
    }
    {
        // Equal-sized comments never own each other, so ownership cannot cycle.
        const TArray<int32> Owners = AssignOwners({ { 0, 0, 100, 100 }, { 0, 0, 100, 100 } }, { true, true });
        TestEqual(TEXT("no self-nesting a"), Owners[0], INDEX_NONE);
        TestEqual(TEXT("no self-nesting b"), Owners[1], INDEX_NONE);
    }
    {
        TArray<FNodeBox> Boxes = { { 0, 0, 200, 100 }, { 50, 50, 200, 100 }, { 0, 120, 200, 100 } };
        const int32 Moved = PushApart(Boxes, { false, true, true }, 20);
        TestEqual(TEXT("overlapping movable box drops below the fixed one"), Boxes[1].Y, 120);
        TestEqual(TEXT("and the next one drops below that"), Boxes[2].Y, 240);
        TestEqual(TEXT("both reported"), Moved, 2);
        TestEqual(TEXT("columns keep their X"), Boxes[1].X, 50);
        TestEqual(TEXT("fixed box never moves"), Boxes[0].Y, 0);
    }
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaBlueprintOpsPinTypeSpecTest,
    "Hayba.MCP.BlueprintOps.PinTypeSpec",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaBlueprintOpsPinTypeSpecTest::RunTest(const FString&)
{
    using namespace HaybaBlueprintOps;
    FPinTypeSpec S;
    FString Error;
    TestTrue(TEXT("alias parses"), ParsePinTypeSpec(TEXT("Double"), S, Error) && S.Kind == TEXT("float"));
    TestTrue(TEXT("object path splits at the first colon"),
        ParsePinTypeSpec(TEXT("object:/Script/Engine.Actor"), S, Error) && S.Kind == TEXT("object") && S.ObjectPath == TEXT("/Script/Engine.Actor"));
    TestTrue(TEXT("struct path"), ParsePinTypeSpec(TEXT("struct:/Game/Data/S_Item.S_Item"), S, Error) && S.Kind == TEXT("struct"));
    TestFalse(TEXT("a simple type takes no path"), ParsePinTypeSpec(TEXT("int:/Game/X"), S, Error));
    TestFalse(TEXT("a path must be absolute"), ParsePinTypeSpec(TEXT("object:Actor"), S, Error));
    TestFalse(TEXT("unknown type refused"), ParsePinTypeSpec(TEXT("quaternion"), S, Error));
    TestTrue(TEXT("and the error lists what is accepted"), Error.Contains(TEXT("linear_color")));
    return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
