// Blueprint rules that decide things, tested without an editor.
//
// Both were found by calling the commands against a live editor while writing
// their descriptions, and both had the same shape: the command answered ok for
// work that had gone somewhere the caller did not intend.

#include "Misc/AutomationTest.h"
#include "HaybaBlueprintOps.h"

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
    FHaybaBlueprintOpsTypeSpecTest,
    "Hayba.MCP.BlueprintOps.ParseTypeSpec",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaBlueprintOpsTypeSpecTest::RunTest(const FString&)
{
    using namespace HaybaBlueprintOps;

    {
        // The spellings blueprint_add_variable always accepted keep working.
        const FTypeSpec F = ParseTypeSpec(TEXT("Float"));
        TestTrue(TEXT("float parses"), F.IsValid());
        TestTrue(TEXT("float is a real"), F.Kind == ETypeKind::Real);
        TestFalse(TEXT("a scalar is not an array"), F.bArray);
        TestTrue(TEXT("text parses"), ParseTypeSpec(TEXT("text")).Kind == ETypeKind::Text);
        TestTrue(TEXT("fname parses"), ParseTypeSpec(TEXT("fname")).Kind == ETypeKind::Name);
        TestTrue(TEXT("boolean parses"), ParseTypeSpec(TEXT("boolean")).Kind == ETypeKind::Bool);
        TestTrue(TEXT("integer parses"), ParseTypeSpec(TEXT("integer")).Kind == ETypeKind::Int);
    }

    {
        // The sidecar has long promised "vector"; the handler refused it. A
        // shorthand must name the engine struct, not a guess.
        const FTypeSpec V = ParseTypeSpec(TEXT("vector"));
        TestTrue(TEXT("vector is a struct"), V.Kind == ETypeKind::Struct);
        TestEqual(TEXT("the engine Vector"), V.ObjectPath, FString(TEXT("/Script/CoreUObject.Vector")));
        TestEqual(TEXT("rotator"), ParseTypeSpec(TEXT("Rotator")).ObjectPath, FString(TEXT("/Script/CoreUObject.Rotator")));
        TestEqual(TEXT("transform"), ParseTypeSpec(TEXT("transform")).ObjectPath, FString(TEXT("/Script/CoreUObject.Transform")));
        TestEqual(TEXT("linear_color"), ParseTypeSpec(TEXT("linear_color")).ObjectPath, FString(TEXT("/Script/CoreUObject.LinearColor")));
    }

    {
        // References carry the path the handler must resolve; parsing never loads.
        const FTypeSpec O = ParseTypeSpec(TEXT("object:/Script/Engine.SplineComponent"));
        TestTrue(TEXT("object reference"), O.Kind == ETypeKind::Object);
        TestEqual(TEXT("keeps its class path"), O.ObjectPath, FString(TEXT("/Script/Engine.SplineComponent")));
        TestTrue(TEXT("class reference"), ParseTypeSpec(TEXT("class:/Script/UMG.UserWidget")).Kind == ETypeKind::Class);
        TestTrue(TEXT("soft object"), ParseTypeSpec(TEXT("soft_object:/Script/Engine.StaticMesh")).Kind == ETypeKind::SoftObject);
        TestTrue(TEXT("soft class"), ParseTypeSpec(TEXT("soft_class:/Script/Engine.Actor")).Kind == ETypeKind::SoftClass);
        TestTrue(TEXT("named struct"), ParseTypeSpec(TEXT("struct:/Script/CoreUObject.Vector2D")).Kind == ETypeKind::Struct);
        TestTrue(TEXT("enum"), ParseTypeSpec(TEXT("enum:/Script/Engine.ECollisionChannel")).Kind == ETypeKind::Enum);
    }

    {
        // One level of array around any single type.
        const FTypeSpec A = ParseTypeSpec(TEXT("array<text>"));
        TestTrue(TEXT("array of text parses"), A.IsValid());
        TestTrue(TEXT("is an array"), A.bArray);
        TestTrue(TEXT("of text"), A.Kind == ETypeKind::Text);
        const FTypeSpec R = ParseTypeSpec(TEXT(" Array< object:/Game/UI/WBP_X.WBP_X_C > "));
        TestTrue(TEXT("whitespace and case around the wrapper are tolerated"), R.bArray && R.Kind == ETypeKind::Object);
        TestEqual(TEXT("the inner path survives"), R.ObjectPath, FString(TEXT("/Game/UI/WBP_X.WBP_X_C")));
    }

    {
        // Refused with a reason — never silently turned into something else.
        for (const TCHAR* Bad : { TEXT(""), TEXT("vector3"), TEXT("array<array<int>>"), TEXT("object:"), TEXT("array<int") })
        {
            const FTypeSpec S = ParseTypeSpec(Bad);
            TestFalse(FString::Printf(TEXT("'%s' is refused"), Bad), S.IsValid());
            TestFalse(FString::Printf(TEXT("'%s' says why"), Bad), S.Error.IsEmpty());
        }
    }

    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaBlueprintOpsEventNameTest,
    "Hayba.MCP.BlueprintOps.CanonicalEventFunctionName",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaBlueprintOpsEventNameTest::RunTest(const FString&)
{
    using namespace HaybaBlueprintOps;

    // Callers write the name the node shows; the engine looks up the UFunction.
    // "BeginPlay" failing with "no overridable event" sends them hunting for a
    // parent-class problem that does not exist.
    TestEqual(TEXT("BeginPlay"), CanonicalEventFunctionName(TEXT("BeginPlay")), FString(TEXT("ReceiveBeginPlay")));
    TestEqual(TEXT("node title form"), CanonicalEventFunctionName(TEXT("Event BeginPlay")), FString(TEXT("ReceiveBeginPlay")));
    TestEqual(TEXT("case-insensitive"), CanonicalEventFunctionName(TEXT("tick")), FString(TEXT("ReceiveTick")));
    TestEqual(TEXT("EndPlay"), CanonicalEventFunctionName(TEXT("EndPlay")), FString(TEXT("ReceiveEndPlay")));
    TestEqual(TEXT("overlap"), CanonicalEventFunctionName(TEXT("ActorBeginOverlap")), FString(TEXT("ReceiveActorBeginOverlap")));
    TestEqual(TEXT("widget events are already function names"), CanonicalEventFunctionName(TEXT("Construct")), FString(TEXT("Construct")));
    TestEqual(TEXT("the real name passes through"), CanonicalEventFunctionName(TEXT("ReceiveBeginPlay")), FString(TEXT("ReceiveBeginPlay")));
    TestEqual(TEXT("prefix stripped for any event"), CanonicalEventFunctionName(TEXT("Event Construct")), FString(TEXT("Construct")));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaBlueprintOpsParamNamesTest,
    "Hayba.MCP.BlueprintOps.ParamNamesProblem",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaBlueprintOpsParamNamesTest::RunTest(const FString&)
{
    using namespace HaybaBlueprintOps;

    TestTrue(TEXT("distinct names are fine"), ParamNamesProblem({ TEXT("Distance"), TEXT("Zone") }).IsEmpty());
    TestTrue(TEXT("no params is fine"), ParamNamesProblem({}).IsEmpty());

    // The editor would silently rename the second to "A_0", so the caller's
    // wiring by name would land on a pin they never asked for.
    const FString Dup = ParamNamesProblem({ TEXT("A"), TEXT("a") });
    TestTrue(TEXT("a case-only duplicate is refused"), Dup.Contains(TEXT("duplicate")));
    TestFalse(TEXT("an empty name is refused"), ParamNamesProblem({ TEXT("") }).IsEmpty());
    // Exec and self pins already use these names on every node.
    for (const TCHAR* Reserved : { TEXT("execute"), TEXT("then"), TEXT("self") })
        TestFalse(FString::Printf(TEXT("'%s' is reserved"), Reserved), ParamNamesProblem({ Reserved }).IsEmpty());
    return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
