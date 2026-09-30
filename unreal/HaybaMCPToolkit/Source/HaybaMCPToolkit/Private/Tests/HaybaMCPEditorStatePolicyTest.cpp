#include "Misc/AutomationTest.h"
#include "HaybaMCPEditorStatePolicy.h"
#include "HaybaMCPEditorState.h"
#include "HaybaMCPEditorHealth.h"
#include "Misc/ScopeExit.h"

#if WITH_DEV_AUTOMATION_TESTS

// Pure editor-state policy (docs/adr/0012): the PIE rule, the PIE verdict, the
// PIE tracker and its backstop, and the user-Play decision. No GEditor, no
// clock. Runtime checks (hooks, authorizer registration) live beside them only
// where a test name is shared (UserPlayDecision, extended in T2.2 and T10.1).

namespace
{
	using namespace HaybaMCPState;

	FPieState MakePie(EPieKind Kind, EPiePhase Phase, const FString& Owner = FString(), double Since = 0.0)
	{
		FPieState S;
		S.Kind = Kind;
		S.Phase = Phase;
		S.Owner = Owner;
		S.Since = Since;
		return S;
	}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPStatePieRuleTest,
	"Hayba.MCP.State.PieRule",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPStatePieRuleTest::RunTest(const FString& Parameters)
{
	for (const TCHAR* Cmd : { TEXT("ping"), TEXT("editor_get_state"), TEXT("batch_status"), TEXT("get_setting"),
		TEXT("hayba_propose_plan"), TEXT("ui_tool_stream"), TEXT("editor_stream_log"), TEXT("editor_pie_actor_list"),
		TEXT("editor_pie_screenshot"), TEXT("docs_search"), TEXT("asset_search"), TEXT("asset_browse"),
		TEXT("actor_list"), TEXT("blueprint_get_info"), TEXT("test_list"), TEXT("test_cancel"), TEXT("build_status") })
	{
		TestEqual(*FString::Printf(TEXT("%s is PIE-safe"), Cmd), PieRuleFor(Cmd), EPieRule::Safe);
	}
	for (const TCHAR* Cmd : { TEXT("lease_acquire"), TEXT("lease_renew"), TEXT("lease_release"), TEXT("lease_status"), TEXT("lease_adopt") })
	{
		TestEqual(*FString::Printf(TEXT("%s is PIE-safe by its lease_ prefix"), Cmd), PieRuleFor(Cmd), EPieRule::Safe);
	}

	TestEqual(TEXT("exactly eight PIE-owner commands"), PieOwnerCommands().Num(), 8);
	for (const FString& Cmd : PieOwnerCommands())
	{
		TestEqual(*FString::Printf(TEXT("%s is a PIE-owner command"), *Cmd), PieRuleFor(Cmd), EPieRule::PieOwner);
		TestFalse(*FString::Printf(TEXT("%s is in no read, control or observation set"), *Cmd),
			HaybaMCPCommandSets::ControlPlaneCommands().Contains(Cmd)
			|| HaybaMCPCommandSets::ReadCommands().Contains(Cmd)
			|| HaybaMCPCommandSets::PieObservationCommands().Contains(Cmd));
	}

	for (const TCHAR* Cmd : { TEXT("blueprint_add_node"), TEXT("python_run"), TEXT("editor_start_pie"), TEXT("editor_batch"),
		TEXT("level_save"), TEXT("material_set_param"), TEXT("asset_delete"), TEXT("wp_region_load"), TEXT("hayba_made_up_command") })
	{
		TestEqual(*FString::Printf(TEXT("%s is refused during PIE (the rule fails closed)"), Cmd), PieRuleFor(Cmd), EPieRule::Refuse);
	}

	TestEqual(TEXT("safe wire name"), FString(LexPieRule(EPieRule::Safe)), FString(TEXT("safe")));
	TestEqual(TEXT("pie_owner wire name"), FString(LexPieRule(EPieRule::PieOwner)), FString(TEXT("pie_owner")));
	TestEqual(TEXT("refuse wire name"), FString(LexPieRule(EPieRule::Refuse)), FString(TEXT("refuse")));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPStatePieVerdictTest,
	"Hayba.MCP.State.PieVerdict",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPStatePieVerdictTest::RunTest(const FString& Parameters)
{
	const FPieState NoPie;
	const FPieState UserPie = MakePie(EPieKind::User, EPiePhase::Running, FString(), 100.0);
	const FPieState AgentPie = MakePie(EPieKind::Agent, EPiePhase::Running, TEXT("lane-a"), 100.0);
	const FPieState QueuedAgentPie = MakePie(EPieKind::Agent, EPiePhase::Queued, TEXT("lane-a"), 100.0);

	// No session: nothing is refused and nothing skips the lease gate.
	{
		const FPieVerdict Write = CheckPie(NoPie, TEXT("blueprint_add_node"), TEXT("lane-b"));
		TestTrue(TEXT("no PIE allows a write"), Write.bAllow);
		TestFalse(TEXT("no PIE authorizes nothing as a PIE command"), Write.bAuthorizedAsPie);
		const FPieVerdict IdleStop = CheckPie(NoPie, TEXT("editor_stop_pie"), TEXT("lane-b"));
		TestTrue(TEXT("stop with no PIE is allowed"), IdleStop.bAllow);
		TestFalse(TEXT("stop with no PIE still takes the lease gate"), IdleStop.bAuthorizedAsPie);
	}

	// The user's PIE: reads run; writes, drives and stops do not.
	TestTrue(TEXT("a read runs during the user's PIE"), CheckPie(UserPie, TEXT("actor_list"), TEXT("lane-b")).bAllow);
	TestFalse(TEXT("a write is refused during the user's PIE"), CheckPie(UserPie, TEXT("blueprint_add_node"), TEXT("lane-b")).bAllow);
	TestFalse(TEXT("nobody drives the user's PIE"), CheckPie(UserPie, TEXT("editor_pie_press_key"), TEXT("lane-b")).bAllow);
	TestFalse(TEXT("nobody stops the user's PIE"), CheckPie(UserPie, TEXT("editor_stop_pie"), TEXT("lane-b")).bAllow);
	TestFalse(TEXT("an empty caller owner does not match the user's empty owner"), CheckPie(UserPie, TEXT("editor_pie_press_key"), FString()).bAllow);

	// An agent's PIE, running or queued: its owner drives, anyone stops, nobody edits.
	for (const FPieState& Agent : { AgentPie, QueuedAgentPie })
	{
		const FPieVerdict OwnerDrive = CheckPie(Agent, TEXT("editor_pie_press_key"), TEXT("lane-a"));
		TestTrue(TEXT("the owner drives its PIE"), OwnerDrive.bAllow && OwnerDrive.bAuthorizedAsPie);
		const FPieVerdict ForeignDrive = CheckPie(Agent, TEXT("editor_pie_press_key"), TEXT("lane-b"));
		TestFalse(TEXT("another owner does not drive it"), ForeignDrive.bAllow);
		TestEqual(TEXT("the refusal names the PIE-owner rule"), ForeignDrive.Rule, EPieRule::PieOwner);
		const FPieVerdict OwnerStop = CheckPie(Agent, TEXT("editor_stop_pie"), TEXT("lane-a"));
		TestTrue(TEXT("the owner stops its PIE"), OwnerStop.bAllow && OwnerStop.bAuthorizedAsPie && !OwnerStop.bNonOwnerStop);
		const FPieVerdict ForeignStop = CheckPie(Agent, TEXT("editor_stop_pie"), TEXT("conn:900002"));
		TestTrue(TEXT("any caller stops an agent PIE"), ForeignStop.bAllow && ForeignStop.bAuthorizedAsPie);
		TestTrue(TEXT("a foreign stop is flagged for the Warning"), ForeignStop.bNonOwnerStop);
		TestFalse(TEXT("the owner cannot edit during its own PIE"), CheckPie(Agent, TEXT("blueprint_add_node"), TEXT("lane-a")).bAllow);
		const FPieVerdict Observe = CheckPie(Agent, TEXT("editor_pie_actor_list"), TEXT("lane-b"));
		TestTrue(TEXT("anyone observes"), Observe.bAllow);
		TestFalse(TEXT("observation needs no lease-gate skip"), Observe.bAuthorizedAsPie);
	}

	// Refusal texts: explicit, and never the word token.
	const FString Refused = FormatPieActiveMessage(UserPie, TEXT("blueprint_add_node"), EPieRule::Refuse, 112.0);
	TestTrue(TEXT("names the command, phase, owner and age"),
		Refused.StartsWith(TEXT("pie_active: 'blueprint_add_node' was not run: a play session is running (user, 12 s).")));
	TestTrue(TEXT("says when to retry"), Refused.Contains(TEXT("retry when editor_get_state.pie is \"none\"")));
	const FString UserDrive = FormatPieActiveMessage(UserPie, TEXT("editor_stop_pie"), EPieRule::PieOwner, 112.0);
	TestTrue(TEXT("the user's PIE is untouchable"), UserDrive.Contains(TEXT("never drives or stops the user's PIE")));
	const FString AgentDrive = FormatPieActiveMessage(AgentPie, TEXT("editor_pie_press_key"), EPieRule::PieOwner, 112.0);
	TestTrue(TEXT("names the owner"), AgentDrive.Contains(TEXT("belongs to 'lane-a'")));
	for (const FString& Text : { Refused, UserDrive, AgentDrive })
	{
		TestFalse(TEXT("no refusal text says token"), Text.Contains(TEXT("token"), ESearchCase::IgnoreCase));
	}

	TestEqual(TEXT("none"), LexPie(NoPie), FString(TEXT("none")));
	TestEqual(TEXT("user"), LexPie(UserPie), FString(TEXT("user")));
	TestEqual(TEXT("an agent names its owner"), LexPie(AgentPie), FString(TEXT("agent:lane-a")));
	TestEqual(TEXT("queued"), FString(LexPiePhase(EPiePhase::Queued)), FString(TEXT("queued")));
	TestEqual(TEXT("starting"), FString(LexPiePhase(EPiePhase::Starting)), FString(TEXT("starting")));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPStatePieTrackerTest,
	"Hayba.MCP.State.PieTracker",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPStatePieTrackerTest::RunTest(const FString& Parameters)
{
	// An editor_start_pie within 5 s makes the session the agent's.
	{
		FPieTracker T;
		T.NoteAgentRequest(TEXT("lane-a"), 100.0);
		T.OnPreBegin(false, 104.9);
		TestEqual(TEXT("attributed to the agent"), T.State().Kind, EPieKind::Agent);
		TestEqual(TEXT("owner recorded"), T.State().Owner, FString(TEXT("lane-a")));
		TestEqual(TEXT("starting until BeginPIE"), T.State().Phase, EPiePhase::Starting);
		TestEqual(TEXT("since is PreBeginPIE"), T.State().Since, 104.9);
		T.OnBegin(false, 105.0);
		TestEqual(TEXT("running"), T.State().Phase, EPiePhase::Running);
		T.OnEnd(110.0);
		TestEqual(TEXT("ended"), T.State().Kind, EPieKind::None);
		TestEqual(TEXT("one end"), T.EndSerial(), 1);
	}
	// A request older than the window: the user's session.
	{
		FPieTracker T;
		T.NoteAgentRequest(TEXT("lane-a"), 100.0);
		T.OnPreBegin(false, 105.1);
		TestEqual(TEXT("too old: the user's"), T.State().Kind, EPieKind::User);
		TestTrue(TEXT("user sessions carry no owner"), T.State().Owner.IsEmpty());
	}
	// No request: the user's Play button, then a Simulate switch.
	{
		FPieTracker T;
		T.OnPreBegin(true, 50.0);
		TestEqual(TEXT("the user's"), T.State().Kind, EPieKind::User);
		TestTrue(TEXT("simulate recorded"), T.State().bSimulating);
		T.OnBegin(true, 50.1);
		T.OnSwitchSimulate(false);
		TestFalse(TEXT("switched to play"), T.State().bSimulating);
	}
	// The errored-Blueprint dialog refused: EndPIE then CancelPIE for one session.
	{
		FPieTracker T;
		T.OnPreBegin(false, 10.0);
		T.OnBegin(false, 10.1);
		T.OnEnd(11.0);
		T.OnEnd(11.0);
		TestEqual(TEXT("two end broadcasts count once"), T.EndSerial(), 1);
	}
	// R-13: an authorizer veto is PreBeginPIE then the engine's CancelPIE, with no BeginPIE.
	{
		FPieTracker T;
		T.NoteAgentRequest(TEXT("lane-a"), 20.0);
		T.OnPreBegin(false, 20.5);
		T.OnEnd(20.6);
		TestEqual(TEXT("a vetoed session ends exactly once"), T.EndSerial(), 1);
		TestEqual(TEXT("and leaves no session"), T.State().Kind, EPieKind::None);
	}
	// A queued request cancelled before PreBeginPIE: no session, attribution dropped.
	{
		FPieTracker T;
		T.NoteAgentRequest(TEXT("lane-a"), 30.0);
		TestTrue(TEXT("pending while queued"), T.HasPendingAgentRequest(30.5));
		T.OnEnd(30.6);
		TestEqual(TEXT("no session ended"), T.EndSerial(), 0);
		TestFalse(TEXT("the cancelled request cannot claim a later Play"), T.HasPendingAgentRequest(31.0));
		T.OnPreBegin(false, 31.0);
		TestEqual(TEXT("so the next Play is the user's"), T.State().Kind, EPieKind::User);
	}
	// BeginPIE without PreBeginPIE (a missed hook) still records a running session.
	{
		FPieTracker T;
		T.OnBegin(false, 40.0);
		TestEqual(TEXT("recorded"), T.State().Kind, EPieKind::User);
		TestEqual(TEXT("running"), T.State().Phase, EPiePhase::Running);
	}
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPStateResolvePieBackstopTest,
	"Hayba.MCP.State.ResolvePieBackstop",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPStateResolvePieBackstopTest::RunTest(const FString& Parameters)
{
	const FPieTracker Idle;
	TestEqual(TEXT("no world and no request: none"), ResolvePie(Idle, false, false, 10.0).Kind, EPieKind::None);
	const FPieState MissedBegin = ResolvePie(Idle, true, false, 10.0);
	TestEqual(TEXT("a play world the hooks missed is the user's"), MissedBegin.Kind, EPieKind::User);
	TestEqual(TEXT("and running"), MissedBegin.Phase, EPiePhase::Running);
	const FPieState QueuedUser = ResolvePie(Idle, false, true, 10.0);
	TestEqual(TEXT("a queued request counts as PIE"), QueuedUser.Kind, EPieKind::User);
	TestEqual(TEXT("queued"), QueuedUser.Phase, EPiePhase::Queued);

	FPieTracker Requested;
	Requested.NoteAgentRequest(TEXT("lane-a"), 100.0);
	const FPieState QueuedAgent = ResolvePie(Requested, false, true, 100.2);
	TestEqual(TEXT("an agent's queued request is the agent's"), QueuedAgent.Kind, EPieKind::Agent);
	TestEqual(TEXT("owned"), QueuedAgent.Owner, FString(TEXT("lane-a")));
	TestEqual(TEXT("queued phase"), QueuedAgent.Phase, EPiePhase::Queued);
	TestEqual(TEXT("a stale request is not"), ResolvePie(Requested, false, true, 106.0).Kind, EPieKind::User);
	TestEqual(TEXT("a request with nothing queued is no PIE"), ResolvePie(Requested, false, false, 100.2).Kind, EPieKind::None);

	FPieTracker Starting;
	Starting.OnPreBegin(false, 5.0);
	TestEqual(TEXT("starting while the engine still holds the request"), ResolvePie(Starting, false, true, 5.1).Phase, EPiePhase::Starting);

	FPieTracker Running;
	Running.NoteAgentRequest(TEXT("lane-a"), 1.0);
	Running.OnPreBegin(false, 1.5);
	Running.OnBegin(false, 1.6);
	TestEqual(TEXT("the tracker wins while the world exists"), ResolvePie(Running, true, false, 9.0).Owner, FString(TEXT("lane-a")));
	TestEqual(TEXT("a missed end hook cannot keep a session alive"), ResolvePie(Running, false, false, 9.0).Kind, EPieKind::None);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPStateUserPlayDecisionTest,
	"Hayba.MCP.State.UserPlayDecision",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPStateUserPlayDecisionTest::RunTest(const FString& Parameters)
{
	const TArray<FBusyAsset> NoBusy;
	TArray<FBusyAsset> Busy;
	FBusyAsset Building;
	Building.Asset = TEXT("asset:/game/__haybatest__/bp_busy");
	Building.Owner = TEXT("builder");
	Busy.Add(Building);

	// Unsafe: deny, no override, in every mode, for every kind, even on a second press.
	for (EPlayRequestKind Kind : { EPlayRequestKind::User, EPlayRequestKind::Agent })
	{
		for (int32 Mode : { 0, 1, 2 })
		{
			const FPlayDecision Unsafe = DecideUserPlay(Busy, Kind, Mode, /*bUnsafe=*/true, /*LastVetoAt=*/99.0, /*Now=*/100.0);
			TestTrue(TEXT("unsafe denies Play"), Unsafe.bDeny);
			TestFalse(TEXT("a second press within 10 s does not override the unsafe veto"), Unsafe.bOverrideAccepted);
			TestFalse(TEXT("unsafe is never notify-only"), Unsafe.bNotifyOnly);
			TestEqual(TEXT("the unsafe veto text"), Unsafe.Reason, FString(UnsafePlayVetoText));
		}
	}

	const FPlayDecision Healthy = DecideUserPlay(NoBusy, EPlayRequestKind::User, 1, /*bUnsafe=*/false, -1.0, 100.0);
	TestFalse(TEXT("a healthy editor with no build allows Play"), Healthy.bDeny);
	TestFalse(TEXT("and does not notify"), Healthy.bNotifyOnly);
	TestFalse(TEXT("the veto text never says token"), FString(UnsafePlayVetoText).Contains(TEXT("token"), ESearchCase::IgnoreCase));
	TestEqual(TEXT("the double-press window is 10 s"), PlayVetoOverrideWindowSeconds, 10.0);
	// Runtime: Startup registers the authorizer; Shutdown removes it.
	{
		FHaybaMCPEditorState& State = FHaybaMCPEditorState::Get();
		TestTrue(TEXT("the authorizer is registered at module startup"), State.IsAuthorizerRegistered());
		State.Shutdown();
		ON_SCOPE_EXIT
		{
			FHaybaMCPEditorState::Get().Startup();
		};
		TestFalse(TEXT("unregistered after Shutdown"), State.IsAuthorizerRegistered());
		TestFalse(TEXT("hooks unbound after Shutdown"), State.AreHooksBound());
		State.Startup();
		TestTrue(TEXT("registered again after Startup"), State.IsAuthorizerRegistered());
	}
	// Runtime: while unsafe, the authorizer's decision is the unsafe veto, with no override.
	{
		FHaybaEditorHealth::FScopedOverrideForTests Health;
		AddExpectedMessagePlain(TEXT("editor_unsafe: native fault"), ELogVerbosity::Error, EAutomationExpectedMessageFlags::Contains, 1);
		FHaybaEditorHealth::RecordCaughtFault(EHaybaFaultSite::TestInjection, 0xC0000005u);
		const FPlayDecision Veto = FHaybaMCPEditorState::Get().EvaluateUserPlayRequest(FPlatformTime::Seconds());
		TestTrue(TEXT("Play is denied while unsafe"), Veto.bDeny);
		TestFalse(TEXT("no override while unsafe"), Veto.bOverrideAccepted);
		TestEqual(TEXT("with the unsafe veto text"), Veto.Reason, FString(UnsafePlayVetoText));
		TestEqual(TEXT("the fault logged its Error line once"), Health.FaultErrorLineCount(), 1);
	}
	TestFalse(TEXT("the health override left a clean process"), FHaybaEditorHealth::IsUnsafe());
	TestFalse(TEXT("a healthy editor allows Play"), FHaybaMCPEditorState::Get().EvaluateUserPlayRequest(FPlatformTime::Seconds()).bDeny);
	return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
