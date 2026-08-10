#include "Misc/AutomationTest.h"
#include "HaybaPIERuntimeOps.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include <limits>

#if WITH_DEV_AUTOMATION_TESTS

namespace
{
    TSharedPtr<FJsonObject> RuntimeJson(const FString& Text)
    {
        TSharedPtr<FJsonObject> Object;
        const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Text);
        FJsonSerializer::Deserialize(Reader, Object);
        return Object;
    }

    HaybaPIERuntimeOps::FWorldCandidate Candidate(
        int32 PIEInstance,
        const TCHAR* Name,
        bool bPlayWorld,
        bool bHasViewport)
    {
        HaybaPIERuntimeOps::FWorldCandidate Out;
        Out.PIEInstance = PIEInstance;
        Out.WorldName = Name;
        Out.bIsPlayWorld = bPlayWorld;
        Out.bHasViewport = bHasViewport;
        return Out;
    }
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaPIERuntimeParseTest,
    "Hayba.MCP.PIE.RuntimeInspection.Parse",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaPIERuntimeParseTest::RunTest(const FString&)
{
    {
        FHaybaParamReader Reader(RuntimeJson(TEXT(R"({"name_filter":"Road"})")), TEXT("editor_pie_actor_list"));
        const HaybaPIERuntimeOps::FListRequest Request = HaybaPIERuntimeOps::ParseList(Reader);
        TestFalse(TEXT("ordinary list request parses"), Reader.HasErrors());
        TestEqual(TEXT("offset defaults to zero"), Request.Offset, 0);
        TestEqual(TEXT("limit defaults to the response-builder ceiling"), Request.Limit, 50);
        TestFalse(TEXT("world selection remains optional"), Request.World.PIEInstance.IsSet());
    }
    {
        FHaybaParamReader Reader(RuntimeJson(TEXT(R"({"offset":-1,"limit":201,"pie_instance":1.5})")), TEXT("editor_pie_actor_list"));
        HaybaPIERuntimeOps::ParseList(Reader);
        TestTrue(TEXT("negative, over-cap and fractional numbers are rejected"), Reader.HasErrors());
        const FString Message = Reader.ErrorMessage();
        TestTrue(TEXT("all bad fields are reported together"),
            Message.Contains(TEXT("offset")) && Message.Contains(TEXT("limit")) && Message.Contains(TEXT("pie_instance")));
    }
    {
        FHaybaParamReader WrongTypes(
            RuntimeJson(TEXT(R"({"class_filter":42,"name_filter":false,"tag":[],"offset":"1","limit":true,"pie_instance":"0"})")),
            TEXT("editor_pie_actor_list"));
        const HaybaPIERuntimeOps::FListRequest Request = HaybaPIERuntimeOps::ParseList(WrongTypes);
        TestTrue(TEXT("list rejects UE JSON scalar coercions"), WrongTypes.HasErrors());
        const FString Message = WrongTypes.ErrorMessage();
        TestTrue(TEXT("list reports every wrong-typed field together"),
            Message.Contains(TEXT("class_filter"))
            && Message.Contains(TEXT("name_filter"))
            && Message.Contains(TEXT("tag"))
            && Message.Contains(TEXT("offset"))
            && Message.Contains(TEXT("limit"))
            && Message.Contains(TEXT("pie_instance")));
        TestEqual(TEXT("wrong offset type cannot poison its safe default"), Request.Offset, 0);
        TestEqual(TEXT("wrong limit type cannot poison its safe default"), Request.Limit, 50);
        TestFalse(TEXT("wrong PIE selector type remains unset"), Request.World.PIEInstance.IsSet());
    }
    {
        const FString LongFilter = FString::ChrN(HaybaPIERuntimeOps::MaxFilterLength + 1, TEXT('x'));
        TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
        Params->SetStringField(TEXT("class_filter"), LongFilter);
        FHaybaParamReader Reader(Params, TEXT("editor_pie_actor_list"));
        HaybaPIERuntimeOps::ParseList(Reader);
        TestTrue(TEXT("unbounded filter input is rejected before an actor scan"), Reader.HasErrors());
    }
    {
        FHaybaParamReader Missing(RuntimeJson(TEXT(R"({})")), TEXT("editor_pie_actor_inspect"));
        HaybaPIERuntimeOps::ParseInspect(Missing);
        TestTrue(TEXT("inspect requires an actor reference"), Missing.HasErrors());

        FHaybaParamReader Ambiguous(
            RuntimeJson(TEXT(R"({"actor_id":"Road_1","actor_label":"Road"})")),
            TEXT("editor_pie_actor_inspect"));
        HaybaPIERuntimeOps::ParseInspect(Ambiguous);
        TestTrue(TEXT("inspect rejects ambiguous reference forms"), Ambiguous.HasErrors());

        FHaybaParamReader WrongTypes(
            RuntimeJson(TEXT(R"({"actor_id":7,"component_filter":{},"component_offset":"0","component_limit":false})")),
            TEXT("editor_pie_actor_inspect"));
        const HaybaPIERuntimeOps::FInspectRequest WrongRequest = HaybaPIERuntimeOps::ParseInspect(WrongTypes);
        const FString WrongMessage = WrongTypes.ErrorMessage();
        TestTrue(TEXT("inspect rejects all wrong wire types"), WrongTypes.HasErrors());
        TestTrue(TEXT("inspect reports all wrong wire types together"),
            WrongMessage.Contains(TEXT("actor_id"))
            && WrongMessage.Contains(TEXT("component_filter"))
            && WrongMessage.Contains(TEXT("component_offset"))
            && WrongMessage.Contains(TEXT("component_limit")));
        TestFalse(TEXT("malformed-but-present actor does not produce a false missing-reference diagnostic"),
            WrongMessage.Contains(TEXT("pass exactly one")));
        TestEqual(TEXT("wrong component offset uses safe default"), WrongRequest.ComponentOffset, 0);
        TestEqual(TEXT("wrong component limit uses safe default"), WrongRequest.ComponentLimit, 50);

        FHaybaParamReader NullReference(
            RuntimeJson(TEXT(R"({"actor_path":null})")),
            TEXT("editor_pie_actor_inspect"));
        HaybaPIERuntimeOps::ParseInspect(NullReference);
        TestTrue(TEXT("null is not accepted as an actor reference string"),
            NullReference.ErrorMessage().Contains(TEXT("actor_path")));
        TestFalse(TEXT("null actor reference is reported as malformed rather than absent"),
            NullReference.ErrorMessage().Contains(TEXT("pass exactly one")));
    }
    {
        FHaybaParamReader Valid(
            RuntimeJson(TEXT(R"({"actor_path":"/Game/UEDPIE_0_Map.Map:PersistentLevel.Road_1","component_limit":50})")),
            TEXT("editor_pie_actor_inspect"));
        const HaybaPIERuntimeOps::FInspectRequest Request = HaybaPIERuntimeOps::ParseInspect(Valid);
        TestFalse(TEXT("full path plus capped component page parses"), Valid.HasErrors());
        TestEqual(TEXT("max component page is accepted"), Request.ComponentLimit, HaybaPIERuntimeOps::MaxComponents);
    }
    {
        FHaybaParamReader CrossTarget(
            RuntimeJson(TEXT(R"({"actor_id":"Road_1","world_location":[0,0,0]})")),
            TEXT("editor_pie_project_world"));
        HaybaPIERuntimeOps::ParseProject(CrossTarget);
        TestTrue(TEXT("projection rejects two target sources"), CrossTarget.HasErrors());

        FHaybaParamReader OrphanComponent(
            RuntimeJson(TEXT(R"({"world_location":[0,0,0],"component_name":"Spline"})")),
            TEXT("editor_pie_project_world"));
        HaybaPIERuntimeOps::ParseProject(OrphanComponent);
        TestTrue(TEXT("component name cannot escape the selected actor"), OrphanComponent.HasErrors());

        FHaybaParamReader ShortVector(
            RuntimeJson(TEXT(R"({"world_location":[0,0]})")),
            TEXT("editor_pie_project_world"));
        HaybaPIERuntimeOps::ParseProject(ShortVector);
        TestTrue(TEXT("malformed world position is not silently replaced by the origin"), ShortVector.HasErrors());

        FHaybaParamReader WrongTypes(
            RuntimeJson(TEXT(R"({"world_location":[0,"one",2],"trace_visibility":"yes"})")),
            TEXT("editor_pie_project_world"));
        HaybaPIERuntimeOps::ParseProject(WrongTypes);
        TestTrue(TEXT("hostile direct-wire scalar/vector types fail closed"), WrongTypes.HasErrors());
        TestTrue(TEXT("both wrong types are reported"),
            WrongTypes.ErrorMessage().Contains(TEXT("world_location"))
            && WrongTypes.ErrorMessage().Contains(TEXT("trace_visibility")));
        TestFalse(TEXT("malformed explicit location does not invent a missing actor error"),
            WrongTypes.ErrorMessage().Contains(TEXT("pass exactly one")));

        FHaybaParamReader CoercibleScalars(
            RuntimeJson(TEXT(R"({"actor_id":1,"component_name":null,"sample":false,"player_index":"0","trace_visibility":1})")),
            TEXT("editor_pie_project_world"));
        const HaybaPIERuntimeOps::FProjectRequest CoercibleRequest = HaybaPIERuntimeOps::ParseProject(CoercibleScalars);
        const FString CoercibleMessage = CoercibleScalars.ErrorMessage();
        TestTrue(TEXT("projection rejects values that UE's JSON DOM can coerce"), CoercibleScalars.HasErrors());
        TestTrue(TEXT("projection names every rejected coercible scalar"),
            CoercibleMessage.Contains(TEXT("actor_id"))
            && CoercibleMessage.Contains(TEXT("component_name"))
            && CoercibleMessage.Contains(TEXT("sample"))
            && CoercibleMessage.Contains(TEXT("player_index"))
            && CoercibleMessage.Contains(TEXT("trace_visibility")));
        TestFalse(TEXT("malformed-but-present projection actor is not reported missing"),
            CoercibleMessage.Contains(TEXT("pass exactly one")));
        TestEqual(TEXT("wrong player index type uses safe default"), CoercibleRequest.PlayerIndex, 0);
        TestTrue(TEXT("wrong trace flag type uses safe default"), CoercibleRequest.bTraceVisibility);

        const TCHAR* MalformedVectors[] = {
            TEXT(R"({"world_location":null})"),
            TEXT(R"({"world_location":"0,0,0"})"),
            TEXT(R"({"world_location":{}})"),
            TEXT(R"({"world_location":[0,true,2]})"),
            TEXT(R"({"world_location":[0,null,2]})"),
            TEXT(R"({"world_location":[0,[],2]})"),
            TEXT(R"({"world_location":[0,{},2]})"),
            TEXT(R"({"world_location":[0,1,2,3]})")
        };
        for (const TCHAR* Json : MalformedVectors)
        {
            FHaybaParamReader Malformed(RuntimeJson(Json), TEXT("editor_pie_project_world"));
            HaybaPIERuntimeOps::ParseProject(Malformed);
            TestTrue(TEXT("every malformed vector shape fails closed"), Malformed.HasErrors());
            TestTrue(TEXT("every malformed vector diagnostic names world_location"),
                Malformed.ErrorMessage().Contains(TEXT("world_location")));
            TestFalse(TEXT("malformed vector shape does not cascade into a missing actor diagnostic"),
                Malformed.ErrorMessage().Contains(TEXT("pass exactly one")));
        }

        TSharedPtr<FJsonObject> NonFiniteParams = MakeShared<FJsonObject>();
        TArray<TSharedPtr<FJsonValue>> NonFiniteVector;
        NonFiniteVector.Add(MakeShared<FJsonValueNumber>(0.0));
        NonFiniteVector.Add(MakeShared<FJsonValueNumber>(std::numeric_limits<double>::infinity()));
        NonFiniteVector.Add(MakeShared<FJsonValueNumber>(2.0));
        NonFiniteParams->SetArrayField(TEXT("world_location"), MoveTemp(NonFiniteVector));
        FHaybaParamReader NonFinite(NonFiniteParams, TEXT("editor_pie_project_world"));
        HaybaPIERuntimeOps::ParseProject(NonFinite);
        TestTrue(TEXT("programmatic non-finite vector values fail closed"), NonFinite.HasErrors());
        TestTrue(TEXT("non-finite vector diagnostic names world_location"),
            NonFinite.ErrorMessage().Contains(TEXT("world_location")));

        FHaybaParamReader ExtremeCoordinate(
            RuntimeJson(TEXT(R"({"world_location":[1e308,0,0]})")),
            TEXT("editor_pie_project_world"));
        HaybaPIERuntimeOps::ParseProject(ExtremeCoordinate);
        TestTrue(TEXT("finite-but-dangerous projection coordinates are bounded"), ExtremeCoordinate.HasErrors());

        FHaybaParamReader ComponentPivot(
            RuntimeJson(TEXT(R"({"actor_id":"Road_1","component_name":"Spline","sample":"component_location"})")),
            TEXT("editor_pie_project_world"));
        const HaybaPIERuntimeOps::FProjectRequest PivotRequest = HaybaPIERuntimeOps::ParseProject(ComponentPivot);
        TestFalse(TEXT("component pivot is an explicit valid sample"), ComponentPivot.HasErrors());
        TestEqual(TEXT("component sample survives native parsing"), PivotRequest.Sample, FString(TEXT("component_location")));

        FHaybaParamReader StrictValid(
            RuntimeJson(TEXT(R"({"world_location":[0,-1,2.5],"player_index":16,"trace_visibility":false})")),
            TEXT("editor_pie_project_world"));
        const HaybaPIERuntimeOps::FProjectRequest StrictValidRequest = HaybaPIERuntimeOps::ParseProject(StrictValid);
        TestFalse(TEXT("strict parsing still accepts correctly typed boundary values"), StrictValid.HasErrors());
        TestEqual(TEXT("maximum player index remains valid"), StrictValidRequest.PlayerIndex, 16);
        TestFalse(TEXT("literal false remains a valid trace flag"), StrictValidRequest.bTraceVisibility);

        FHaybaParamReader BadComponentSample(
            RuntimeJson(TEXT(R"({"actor_id":"Road_1","component_name":"Spline","sample":"actor_location"})")),
            TEXT("editor_pie_project_world"));
        HaybaPIERuntimeOps::ParseProject(BadComponentSample);
        TestTrue(TEXT("actor pivot cannot masquerade as a component sample"), BadComponentSample.HasErrors());
    }
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaPIERuntimeWorldSelectionTest,
    "Hayba.MCP.PIE.RuntimeInspection.WorldSelection",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaPIERuntimeWorldSelectionTest::RunTest(const FString&)
{
    using namespace HaybaPIERuntimeOps;

    {
        const FWorldSelection Selection = SelectWorld({}, {}, false);
        TestFalse(TEXT("zero worlds never fabricates a target"), Selection.IsValid());
        TestTrue(TEXT("zero-world error tells caller to start PIE"), Selection.Error.Contains(TEXT("start PIE")));
    }
    {
        TArray<FWorldCandidate> Worlds{Candidate(0, TEXT("WarRoom"), true, true)};
        const FWorldSelection Selection = SelectWorld(Worlds, {}, true);
        TestTrue(TEXT("sole viewport world is selected"), Selection.IsValid());
        TestEqual(TEXT("sole world index"), Selection.CandidateIndex, 0);
        TestFalse(TEXT("sole world is not reported ambiguous"), Selection.bWasAmbiguous);
    }
    {
        TArray<FWorldCandidate> Worlds{
            Candidate(0, TEXT("Server"), true, false),
            Candidate(1, TEXT("Client"), false, true)};
        const FWorldSelection Selection = SelectWorld(Worlds, {}, true);
        TestTrue(TEXT("projection selects the only world that can produce coordinates"), Selection.IsValid());
        TestEqual(TEXT("client viewport chosen"), Selection.CandidateIndex, 1);
        TestEqual(TEXT("selection reason is evidence"), Selection.Reason, FString(TEXT("only_eligible_world")));
    }
    {
        TArray<FWorldCandidate> Worlds{
            Candidate(0, TEXT("ClientA"), true, true),
            Candidate(1, TEXT("ClientB"), false, true)};
        const FWorldSelection Ambiguous = SelectWorld(Worlds, {}, true);
        TestFalse(TEXT("active PlayWorld does not override explicit selection for two viewport clients"), Ambiguous.IsValid());
        TestTrue(TEXT("multi-client failure asks for pie_instance"), Ambiguous.Error.Contains(TEXT("pie_instance")));

        const FWorldSelection Explicit = SelectWorld(Worlds, TOptional<int32>(1), true);
        TestTrue(TEXT("explicit client resolves multi-client session"), Explicit.IsValid());
        TestEqual(TEXT("explicit client index"), Explicit.CandidateIndex, 1);
        TestEqual(TEXT("explicit reason is reported"), Explicit.Reason, FString(TEXT("explicit_pie_instance")));
        TestTrue(TEXT("explicit choice still reports that multiple worlds exist"), Explicit.bWasAmbiguous);
    }
    {
        TArray<FWorldCandidate> Worlds{
            Candidate(1, TEXT("StaleClient"), false, true),
            Candidate(1, TEXT("CurrentClient"), true, true)};
        const FWorldSelection Duplicate = SelectWorld(Worlds, TOptional<int32>(1), true);
        TestFalse(TEXT("duplicate PIE instance identifiers fail closed"), Duplicate.IsValid());
        TestTrue(TEXT("duplicate instance error is explicit"), Duplicate.Error.Contains(TEXT("duplicated")));
    }
    {
        TArray<FWorldCandidate> Worlds{
            Candidate(0, TEXT("Server"), false, false),
            Candidate(1, TEXT("Client"), true, true)};
        const FWorldSelection Inspect = SelectWorld(Worlds, {}, false);
        TestTrue(TEXT("inspection uses the one active PlayWorld deterministically"), Inspect.IsValid());
        TestEqual(TEXT("active PlayWorld chosen"), Inspect.CandidateIndex, 1);

        const FWorldSelection ServerProjection = SelectWorld(Worlds, TOptional<int32>(0), true);
        TestFalse(TEXT("explicit server without viewport cannot claim clickable coordinates"), ServerProjection.IsValid());
        TestTrue(TEXT("viewport absence is explicit"), ServerProjection.Error.Contains(TEXT("no game viewport")));
    }
    {
        TArray<FWorldCandidate> Worlds{
            Candidate(0, TEXT("A"), false, true),
            Candidate(1, TEXT("B"), false, true)};
        for (int32 Iteration = 0; Iteration < 100; ++Iteration)
        {
            const FWorldSelection Selection = SelectWorld(Worlds, TOptional<int32>(1), true);
            TestTrue(TEXT("repeated explicit selection remains valid"), Selection.IsValid());
            TestEqual(TEXT("repeated explicit selection remains stable"), Selection.CandidateIndex, 1);
        }
    }
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaPIERuntimeBoundariesTest,
    "Hayba.MCP.PIE.RuntimeInspection.Boundaries",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaPIERuntimeBoundariesTest::RunTest(const FString&)
{
    using namespace HaybaPIERuntimeOps;

    {
        const FPageWindow Middle = ComputePage(9900, 50, MaxRetainedActorMatches);
        TestEqual(TEXT("middle page starts at requested offset"), Middle.Start, 9900);
        TestEqual(TEXT("middle page ends at 9950"), Middle.End, 9950);
        TestTrue(TEXT("middle retained page has another page"), Middle.bHasMore);
        TestTrue(TEXT("middle page publishes progress"), Middle.NextOffset.IsSet());
        TestEqual(TEXT("next offset advances"), *Middle.NextOffset, 9950);

        const FPageWindow Boundary = ComputePage(MaxListOffset, 50, MaxRetainedActorMatches);
        TestEqual(TEXT("last legal offset returns the final retained actor"), Boundary.End - Boundary.Start, 1);
        TestFalse(TEXT("retention boundary never advertises an unreachable next page"), Boundary.bHasMore);
        TestFalse(TEXT("retention boundary omits next_offset"), Boundary.NextOffset.IsSet());
    }
    {
        const double NaN = std::numeric_limits<double>::quiet_NaN();
        TestTrue(TEXT("ordinary vector is finite"), IsFiniteVector(FVector(1.0, 2.0, 3.0)));
        TestFalse(TEXT("NaN vector is identified for safe JSON shaping"), IsFiniteVector(FVector(NaN, 0.0, 0.0)));
        TestFalse(TEXT("infinite rotation is identified for safe JSON shaping"),
            IsFiniteRotator(FRotator(0.0, std::numeric_limits<double>::infinity(), 0.0)));
    }
    {
        TestEqual(TEXT("UE 5.8 ProbeOnly is represented"),
            CollisionEnabledName(ECollisionEnabled::ProbeOnly), FString(TEXT("probe_only")));
        TestEqual(TEXT("UE 5.8 QueryAndProbe is represented"),
            CollisionEnabledName(ECollisionEnabled::QueryAndProbe), FString(TEXT("query_and_probe")));
    }
    return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
