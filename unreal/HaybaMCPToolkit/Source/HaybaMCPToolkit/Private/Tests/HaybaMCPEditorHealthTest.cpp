// Hayba.MCP.Health.* and Hayba.MCP.Lease.WarningLimiter: sticky editor_unsafe (ADR-0011).
//
// Rule for every test in this file that can flip the health state: hold
// FHaybaEditorHealth::FScopedOverrideForTests for the whole fault, and assert
// that the REAL state is still healthy on exit (review item R-7). A headless
// `RunTests Hayba` runs every test in one process; one real fault would turn
// every later router test into editor_unsafe_restart_required.

#include "Misc/AutomationTest.h"
#include "HaybaMCPCommandSets.h"
#include "HaybaMCPHealthPolicy.h"
#include "HaybaMCPWarningLimiter.h"
#include "HaybaMCPEditorHealth.h"
#include "IPythonScriptPlugin.h"
#include "Misc/App.h"
#include "UObject/UObjectGlobals.h"
#include "HaybaMCPCommandHandler.h"
#include "HaybaMCPModule.h"
#include "Modules/ModuleManager.h"

#if WITH_DEV_AUTOMATION_TESTS

namespace
{
	constexpr uint32 AccessViolation = 0xC0000005u;

	// TestEqual has no enum-class overload, and "3 != 1" names no rule.
	FString CauseName(HaybaMCPHealth::ECause Cause) { return HaybaMCPHealth::LexCause(Cause); }
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaHealthClassifyCaughtFaultTest,
	"Hayba.MCP.Health.ClassifyCaughtFault",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaHealthClassifyCaughtFaultTest::RunTest(const FString&)
{
	using namespace HaybaMCPHealth;

	TestEqual(TEXT("a Python-site access violation is a python fault"),
		CauseName(ClassifyCaughtFault(EHaybaFaultSite::Python, AccessViolation, false, false)), FString(TEXT("python_native_fault")));
	TestEqual(TEXT("a dispatch access violation is a native fault"),
		CauseName(ClassifyCaughtFault(EHaybaFaultSite::Dispatch, AccessViolation, false, false)), FString(TEXT("native_fault")));
	TestEqual(TEXT("an inner-guard access violation is a native fault"),
		CauseName(ClassifyCaughtFault(EHaybaFaultSite::HandlerInner, AccessViolation, false, false)), FString(TEXT("native_fault")));
	TestEqual(TEXT("the reserved test-injection site classifies as native"),
		CauseName(ClassifyCaughtFault(EHaybaFaultSite::TestInjection, AccessViolation, false, false)), FString(TEXT("native_fault")));

	for (const uint32 Code : { 0x4000u, 0xC000u, 0x8000u })
	{
		TestTrue(*FString::Printf(TEXT("0x%X is an engine fatal code"), Code), IsEngineFatalCode(Code));
		TestEqual(*FString::Printf(TEXT("0x%X outranks the Python site and a stranded save"), Code),
			CauseName(ClassifyCaughtFault(EHaybaFaultSite::Python, Code, false, true)), FString(TEXT("engine_fatal_swallowed")));
	}
	TestFalse(TEXT("an access violation is not an engine fatal code"), IsEngineFatalCode(AccessViolation));
	TestEqual(TEXT("GIsCriticalError makes any fault an engine fatal"),
		CauseName(ClassifyCaughtFault(EHaybaFaultSite::Dispatch, AccessViolation, true, false)), FString(TEXT("engine_fatal_swallowed")));
	TestEqual(TEXT("a stranded save outranks the Python site"),
		CauseName(ClassifyCaughtFault(EHaybaFaultSite::Python, AccessViolation, false, true)), FString(TEXT("stranded_package_save")));

	TestEqual(TEXT("python -> HCR-NATIVE-002"), FString(FaultCodeFor(ECause::PythonNativeFault)), FString(TEXT("HCR-NATIVE-002")));
	TestEqual(TEXT("native -> HCR-NATIVE-003"), FString(FaultCodeFor(ECause::NativeFault)), FString(TEXT("HCR-NATIVE-003")));
	TestEqual(TEXT("stranded save -> HCR-NATIVE-004"), FString(FaultCodeFor(ECause::StrandedPackageSave)), FString(TEXT("HCR-NATIVE-004")));
	TestEqual(TEXT("engine fatal -> HCR-NATIVE-004"), FString(FaultCodeFor(ECause::EngineFatalSwallowed)), FString(TEXT("HCR-NATIVE-004")));
	TestEqual(TEXT("no fault has no code"), FString(FaultCodeFor(ECause::None)), FString());

	TestEqual(TEXT("engine fatal is the most severe"), CauseName(MoreSevere(ECause::NativeFault, ECause::EngineFatalSwallowed)), FString(TEXT("engine_fatal_swallowed")));
	TestEqual(TEXT("severity is symmetric"), CauseName(MoreSevere(ECause::StrandedPackageSave, ECause::PythonNativeFault)), FString(TEXT("stranded_package_save")));
	TestEqual(TEXT("any fault outranks none"), CauseName(MoreSevere(ECause::None, ECause::NativeFault)), FString(TEXT("native_fault")));
	TestTrue(TEXT("a stranded save is status-only"), IsStatusOnlyCause(ECause::StrandedPackageSave));
	TestTrue(TEXT("an engine fatal is status-only"), IsStatusOnlyCause(ECause::EngineFatalSwallowed));
	TestFalse(TEXT("a native fault keeps reads"), IsStatusOnlyCause(ECause::NativeFault));
	TestFalse(TEXT("a python fault keeps reads"), IsStatusOnlyCause(ECause::PythonNativeFault));

	TestEqual(TEXT("site dispatch"), FString(LexSite(EHaybaFaultSite::Dispatch)), FString(TEXT("dispatch")));
	TestEqual(TEXT("site python"), FString(LexSite(EHaybaFaultSite::Python)), FString(TEXT("python")));
	TestEqual(TEXT("site handler_inner"), FString(LexSite(EHaybaFaultSite::HandlerInner)), FString(TEXT("handler_inner")));
	TestEqual(TEXT("site test_injection"), FString(LexSite(EHaybaFaultSite::TestInjection)), FString(TEXT("test_injection")));

	// M4 and M8 grep this exact Error line, including "frame <n>)".
	TestEqual(TEXT("the fault Error line is pinned"),
		FormatFaultLine(ECause::PythonNativeFault, AccessViolation, TEXT("python_run"), TEXT("apply_look_129156"), TEXT("LANE4"),
			EHaybaFaultSite::Python, 886),
		FString(TEXT("[HCR-NATIVE-002] editor_unsafe: native fault 0xC0000005 contained in 'python_run' (id apply_look_129156, owner LANE4, site python, cause python_native_fault, frame 886). Fault contained; restart the editor before further work. Until restart Hayba refuses writes, Python, saves, compiles and PIE (editor_unsafe_restart_required); reads still answer.")));
	TestEqual(TEXT("a status-only cause changes the tail and a marker is named (R-15)"),
		FormatFaultLine(ECause::EngineFatalSwallowed, 0x4000u, TEXT("level_save"), TEXT("7"), TEXT("local"),
			EHaybaFaultSite::Dispatch, 12, TEXT("Fatal Python error")),
		FString(TEXT("[HCR-NATIVE-004] editor_unsafe: native fault 0x00004000 contained in 'level_save' (id 7, owner local, site dispatch, cause engine_fatal_swallowed, marker 'Fatal Python error', frame 12). Fault contained; restart the editor before further work. Until restart Hayba refuses writes, Python, saves, compiles and PIE (editor_unsafe_restart_required); only status commands answer.")));
	TestEqual(TEXT("the native_fault_contained text is pinned"),
		NativeFaultContainedMessage(TEXT("material_compile"), ECause::NativeFault, AccessViolation),
		FString(TEXT("native_fault_contained [HCR-NATIVE-003]: 'material_compile' raised native fault 0xC0000005 (native_fault); its outcome is unknown and it may have partly run. Fault contained; restart the editor before further work. Until restart Hayba refuses writes, Python, saves, compiles and PIE.")));
	TestEqual(TEXT("the native-fault notification text is pinned (plan A.2.10)"),
		NotificationTextFor(ECause::PythonNativeFault, TEXT("python_run")),
		FString(TEXT("Hayba contained a native fault in 'python_run'. Save now (File > Save All) and restart the editor. Do not compile, press Play or load a map before restarting.")));
	TestEqual(TEXT("the engine-fatal notification text is pinned (plan A.2.10)"),
		NotificationTextFor(ECause::StrandedPackageSave, TEXT("level_save")),
		FString(TEXT("Hayba contained an engine fatal error in 'level_save' during a package save. Do not save; restart the editor now. Saving in this state can crash the editor or write a corrupt package.")));

	// CPython corruption markers. The captured stdout and the bounded stderr
	// traceback are never scanned (R-15), and the traceback never carries
	// exception arguments. Exception text reaches this scan only through the
	// wrapper's exact-type SystemError hand-over (T1.3 Step 17), as
	// "SystemError: <message>".
	TestEqual(TEXT("unknown opcode is found in a traceback"),
		FString(FindPythonCorruptionMarker(TEXT("Traceback (most recent call last):\nSystemError: unknown opcode\n"))),
		FString(TEXT("SystemError: unknown opcode")));
	TestTrue(TEXT("bad argument to internal function is a marker"), IsPythonCorruptionMarker(TEXT("SystemError: bad argument to internal function")));
	TestTrue(TEXT("error return without exception set is a marker"), IsPythonCorruptionMarker(TEXT("SystemError: error return without exception set")));
	TestTrue(TEXT("Fatal Python error is a marker"), IsPythonCorruptionMarker(TEXT("Fatal Python error: _PyEval_EvalFrameDefault")));
	TestFalse(TEXT("an ordinary script error is not a marker"), IsPythonCorruptionMarker(TEXT("RuntimeError: boom")));
	TestFalse(TEXT("the bounded traceback form is not a marker"),
		IsPythonCorruptionMarker(TEXT("SystemError: <exception arguments omitted by bounded capture>")));
	TestFalse(TEXT("markers are case-sensitive"), IsPythonCorruptionMarker(TEXT("fatal python error")));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaHealthUnsafeGatePolicyTest,
	"Hayba.MCP.Health.UnsafeGatePolicy",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaHealthUnsafeGatePolicyTest::RunTest(const FString&)
{
	using namespace HaybaMCPHealth;

	for (const ECause Cause : { ECause::NativeFault, ECause::PythonNativeFault })
	{
		const FString Name = CauseName(Cause);
		for (const TCHAR* Cmd : { TEXT("ping"), TEXT("editor_get_state"), TEXT("lease_status"), TEXT("lease_release"),
			TEXT("ui_tool_stream"), TEXT("test_list"), TEXT("test_cancel"), TEXT("ui_memory_set"), TEXT("asset_get_info"),
			TEXT("blueprint_get_info"), TEXT("object_get_property"), TEXT("docs_search"), TEXT("wp_get_cells") })
		{
			TestTrue(*FString::Printf(TEXT("%s: %s still answers"), *Name, Cmd), IsCommandAllowedWhileUnsafe(Cmd, Cause));
		}
		for (const TCHAR* Cmd : { TEXT("python_run"), TEXT("editor_start_pie"), TEXT("editor_stop_pie"), TEXT("editor_pie_press_key"),
			TEXT("editor_pie_actor_list"), TEXT("blueprint_compile"), TEXT("material_compile"), TEXT("ui_save_widget"),
			TEXT("level_save"), TEXT("audio_asset_save"), TEXT("editor_save_all_and_quit"), TEXT("lease_acquire"),
			TEXT("lease_renew"), TEXT("lease_adopt"), TEXT("editor_batch"), TEXT("test_run"), TEXT("wait_for_idle"),
			TEXT("wait_for_shaders"), TEXT("editor_run_console_command"), TEXT("editor_live_compile"),
			TEXT("editor_capture_viewport"), TEXT("ui_render_widget_to_png"), TEXT("hayba_propose_plan"),
			TEXT("no_such_command"), TEXT("") })
		{
			TestFalse(*FString::Printf(TEXT("%s: '%s' is refused (fails closed)"), *Name, Cmd), IsCommandAllowedWhileUnsafe(Cmd, Cause));
		}
	}

	// HCR-NATIVE-004: object lookups are fatal, so only status commands answer.
	for (const ECause Cause : { ECause::StrandedPackageSave, ECause::EngineFatalSwallowed })
	{
		const FString Name = CauseName(Cause);
		for (const TCHAR* Cmd : { TEXT("blueprint_get_info"), TEXT("asset_get_info"), TEXT("object_get_property"),
			TEXT("test_list"), TEXT("ui_memory_set") })
		{
			TestFalse(*FString::Printf(TEXT("%s: %s is refused"), *Name, Cmd), IsCommandAllowedWhileUnsafe(Cmd, Cause));
		}
		for (const FString& Cmd : HaybaMCPCommandSets::StatusOnlyCommands())
		{
			TestTrue(*FString::Printf(TEXT("%s: status command %s answers"), *Name, *Cmd), IsCommandAllowedWhileUnsafe(Cmd, Cause));
		}
		TestEqual(*FString::Printf(TEXT("%s: the allowlist is exactly the status set"), *Name),
			CommandsAllowedWhileUnsafe(Cause).Num(), HaybaMCPCommandSets::StatusOnlyCommands().Num());
	}
	TestEqual(TEXT("the broad allowlist is status + 3 control-plane + 27 reads"),
		CommandsAllowedWhileUnsafe(ECause::NativeFault).Num(), 12 + 3 + 27);

	// The refusal text (spec T1 wire example), both tails, and the plan A.2.10 rule: never the word "token".
	const FString Refusal = UnsafeRefusalMessage(TEXT("editor_start_pie"), TEXT("2026-09-28T02:10:01Z"), TEXT("python_run"),
		ECause::PythonNativeFault, ECause::PythonNativeFault);
	TestEqual(TEXT("the unsafe refusal text is pinned"), Refusal,
		FString(TEXT("editor_unsafe_restart_required: 'editor_start_pie' was not run. A native fault was contained at 2026-09-28T02:10:01Z in 'python_run' (python_native_fault, HCR-NATIVE-002); the editor process can no longer be trusted. Fault contained; restart the editor before further work. Reads such as editor_get_state, ping and lease_status still answer.")));
	const FString StatusOnlyRefusal = UnsafeRefusalMessage(TEXT("blueprint_get_info"), TEXT("2026-09-28T02:10:01Z"), TEXT("python_run"),
		ECause::PythonNativeFault, ECause::StrandedPackageSave);
	TestTrue(TEXT("a later HCR-NATIVE-004 narrows the tail even though the record keeps the first fault"),
		StatusOnlyRefusal.EndsWith(TEXT("Only status commands such as editor_get_state, ping and lease_status answer.")));
	TestTrue(TEXT("the record still names the first fault"), StatusOnlyRefusal.Contains(TEXT("(python_native_fault, HCR-NATIVE-002)")));
	TestFalse(TEXT("no refusal text says token"), Refusal.Contains(TEXT("token")) || StatusOnlyRefusal.Contains(TEXT("token")));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaHealthAllowlistDriftTest,
	"Hayba.MCP.Health.AllowlistDrift",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaHealthAllowlistDriftTest::RunTest(const FString&)
{
	using namespace HaybaMCPCommandSets;
	using namespace HaybaMCPHealth;

	FHaybaMCPModule* Module = FModuleManager::GetModulePtr<FHaybaMCPModule>(TEXT("HaybaMCPToolkit"));
	if (!TestNotNull(TEXT("toolkit module is loaded"), Module)) return false;
	const TSharedPtr<FHaybaMCPCommandHandler> Router = Module->GetCommandHandler();
	if (!TestTrue(TEXT("command router exists"), Router.IsValid())) return false;

	const TSet<FString> Registered(Router->GetAllCommands());
	TSet<FString> Known = Registered;
	Known.Append(RouterInlineCommands());

	auto CheckKnown = [this, &Known](const TCHAR* SetName, const TSet<FString>& Set)
	{
		for (const FString& Cmd : Set)
		{
			TestTrue(*FString::Printf(TEXT("%s names a registered or router-inline command: %s"), SetName, *Cmd), Known.Contains(Cmd));
			TestFalse(*FString::Printf(TEXT("%s never names a native batch step: %s"), SetName, *Cmd),
				Cmd == TEXT("wp_region_load") || Cmd == TEXT("wp_region_unload"));
		}
	};
	CheckKnown(TEXT("StatusOnlyCommands"), StatusOnlyCommands());
	CheckKnown(TEXT("ControlPlaneCommands"), ControlPlaneCommands());
	CheckKnown(TEXT("PieObservationCommands"), PieObservationCommands());
	CheckKnown(TEXT("ReadCommands"), ReadCommands());
	CheckKnown(TEXT("UnsafeControlPlaneCommands"), UnsafeControlPlaneCommands());
	CheckKnown(TEXT("UnsafeReads"), UnsafeReads());

	for (const FString& Cmd : RouterInlineCommands())
	{
		TestFalse(*FString::Printf(TEXT("router-inline %s has no handler (the list is accurate)"), *Cmd), Registered.Contains(Cmd));
		// R-2: the lease gate runs before inline specials, so every inline command must be read-class (T8.2 builds Read from these sets).
		TestTrue(*FString::Printf(TEXT("router-inline %s is control plane (R-2)"), *Cmd), ControlPlaneCommands().Contains(Cmd));
	}

	for (const FString& Cmd : StatusOnlyCommands())
	{
		TestTrue(*FString::Printf(TEXT("status %s is control plane or read"), *Cmd),
			ControlPlaneCommands().Contains(Cmd) || ReadCommands().Contains(Cmd));
	}
	for (const FString& Cmd : UnsafeControlPlaneCommands())
	{
		TestTrue(*FString::Printf(TEXT("unsafe control-plane %s is control plane or read"), *Cmd),
			ControlPlaneCommands().Contains(Cmd) || ReadCommands().Contains(Cmd));
	}
	for (const FString& Cmd : UnsafeReads())
	{
		TestTrue(*FString::Printf(TEXT("unsafe read %s is in ReadCommands()"), *Cmd), ReadCommands().Contains(Cmd));
	}
	TestEqual(TEXT("control plane and reads are disjoint"), ControlPlaneCommands().Intersect(ReadCommands()).Num(), 0);
	TestEqual(TEXT("control plane and PIE observation are disjoint"), ControlPlaneCommands().Intersect(PieObservationCommands()).Num(), 0);
	TestEqual(TEXT("reads and PIE observation are disjoint"), ReadCommands().Intersect(PieObservationCommands()).Num(), 0);

	// The allowlist never admits Python, PIE, saves, compiles or batch/lease work.
	for (const FString& Cmd : CommandsAllowedWhileUnsafe(ECause::NativeFault))
	{
		const bool bForbidden = Cmd == TEXT("python_run") || Cmd.StartsWith(TEXT("editor_pie_"))
			|| Cmd == TEXT("editor_start_pie") || Cmd == TEXT("editor_stop_pie") || Cmd.Contains(TEXT("save"))
			|| Cmd.EndsWith(TEXT("_compile")) || Cmd == TEXT("editor_batch") || Cmd == TEXT("lease_acquire")
			|| Cmd == TEXT("lease_renew") || Cmd == TEXT("lease_adopt") || Cmd == TEXT("test_run")
			|| Cmd.StartsWith(TEXT("wait_for_")) || Cmd == TEXT("editor_run_console_command") || Cmd == TEXT("editor_live_compile");
		TestFalse(*FString::Printf(TEXT("the unsafe allowlist does not admit %s"), *Cmd), bForbidden);
	}

	// Sizes are pinned so an edit to a set is a deliberate, reviewed change.
	TestEqual(TEXT("12 status commands"), StatusOnlyCommands().Num(), 12);
	TestEqual(TEXT("18 control-plane commands"), ControlPlaneCommands().Num(), 18);
	TestEqual(TEXT("7 PIE observation commands"), PieObservationCommands().Num(), 7);
	TestEqual(TEXT("53 read commands"), ReadCommands().Num(), 53);
	TestEqual(TEXT("4 router-inline commands"), RouterInlineCommands().Num(), 4);
	TestEqual(TEXT("3 unsafe control-plane commands"), UnsafeControlPlaneCommands().Num(), 3);
	TestEqual(TEXT("27 unsafe reads"), UnsafeReads().Num(), 27);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaHealthEngineAssertCodeTest,
	"Hayba.MCP.Health.EngineAssertCodeIsEngineFatal",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaHealthEngineAssertCodeTest::RunTest(const FString&)
{
	using namespace HaybaMCPHealth;

	// Pure part (T1.1). T1.3 appends the injected engine_assert through the router.
	TestTrue(TEXT("appError's 0x4000 is engine fatal"), IsEngineFatalCode(0x4000u));
	TestEqual(TEXT("0x4000 caught by an inner guard is engine_fatal_swallowed"),
		CauseName(ClassifyCaughtFault(EHaybaFaultSite::HandlerInner, 0x4000u, false, false)), FString(TEXT("engine_fatal_swallowed")));
	TestEqual(TEXT("engine fatal reports HCR-NATIVE-004"), FString(FaultCodeFor(ECause::EngineFatalSwallowed)), FString(TEXT("HCR-NATIVE-004")));
	const TSet<FString> Allowed = CommandsAllowedWhileUnsafe(ECause::EngineFatalSwallowed);
	TestTrue(TEXT("engine fatal allows exactly the status set"),
		Allowed.Num() == HaybaMCPCommandSets::StatusOnlyCommands().Num()
		&& Allowed.Includes(HaybaMCPCommandSets::StatusOnlyCommands()));
	TestFalse(TEXT("engine fatal refuses blueprint_get_info"), Allowed.Contains(TEXT("blueprint_get_info")));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaLeaseWarningLimiterTest,
	"Hayba.MCP.Lease.WarningLimiter",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaLeaseWarningLimiterTest::RunTest(const FString&)
{
	double Now = 1000.0;
	FWarningLimiter Limiter([&Now]() { return Now; });

	TestEqual(TEXT("a per-connection owner collapses"), FWarningLimiter::CollapseOwner(TEXT("conn:900001")), FString(TEXT("conn:*")));
	TestEqual(TEXT("conn: with no digits is kept"), FWarningLimiter::CollapseOwner(TEXT("conn:")), FString(TEXT("conn:")));
	TestEqual(TEXT("conn: with a non-digit is kept"), FWarningLimiter::CollapseOwner(TEXT("conn:12a")), FString(TEXT("conn:12a")));
	TestEqual(TEXT("a named owner is kept"), FWarningLimiter::CollapseOwner(TEXT("LANE4")), FString(TEXT("LANE4")));
	const FString Key = FWarningLimiter::MakeKey(TEXT("gate"), TEXT("pie_active"), TEXT("conn:17"), TEXT("blueprint_add_node"));
	TestEqual(TEXT("the key format is pinned"), Key, FString(TEXT("gate|pie_active|conn:*|blueprint_add_node|")));
	TestEqual(TEXT("a separator inside a part cannot forge another key"),
		FWarningLimiter::MakeKey(TEXT("gate"), TEXT("x"), TEXT("a|b"), TEXT("c"), TEXT("d")), FString(TEXT("gate|x|a/b|c|d")));

	const FWarningLimiter::FHit First = Limiter.Note(Key);
	TestTrue(TEXT("the first hit logs"), First.bLog);
	TestEqual(TEXT("the first hit is repeat 1"), First.RepeatsInWindow, 1);
	TestEqual(TEXT("nothing was suppressed before the first hit"), First.SuppressedInPreviousWindow, 0);
	FWarningLimiter::FHit Hit;
	for (int32 I = 0; I < 49; ++I)
	{
		Now += 0.5;
		Hit = Limiter.Note(FWarningLimiter::MakeKey(TEXT("gate"), TEXT("pie_active"), FString::Printf(TEXT("conn:%d"), 100 + I), TEXT("blueprint_add_node")));
		TestFalse(*FString::Printf(TEXT("hit %d inside the window is suppressed, whatever the connection"), I + 2), Hit.bLog);
	}
	TestEqual(TEXT("repeats count every hit in the window"), Hit.RepeatsInWindow, 50);

	Now = 1030.0;
	const FWarningLimiter::FHit NextWindow = Limiter.Note(Key);
	TestTrue(TEXT("the first hit of the next window logs"), NextWindow.bLog);
	TestEqual(TEXT("it carries the previous window's suppressed count"), NextWindow.SuppressedInPreviousWindow, 49);
	TestEqual(TEXT("the next-window suffix is pinned (M2 greps it)"),
		FWarningLimiter::PreviousWindowSuffix(NextWindow.SuppressedInPreviousWindow), FString(TEXT(" (+49 identical in the previous 30 s)")));
	TestEqual(TEXT("no suffix when nothing was suppressed"), FWarningLimiter::PreviousWindowSuffix(0), FString());
	TestEqual(TEXT("the drained-line tail is pinned (M2 greps it)"),
		FWarningLimiter::RepeatedMoreTimes(12), FString(TEXT(" repeated 12 more times in 30 s")));

	// DrainExpired reports closed windows that suppressed something, then forgets them.
	double DrainNow = 0.0;
	FWarningLimiter Drain([&DrainNow]() { return DrainNow; });
	Drain.Note(TEXT("a")); Drain.Note(TEXT("a")); Drain.Note(TEXT("a"));
	Drain.Note(TEXT("quiet"));
	DrainNow = 31.0;
	const TArray<FWarningLimiter::FDrained> Drained = Drain.DrainExpired();
	TestEqual(TEXT("only the window that suppressed something is drained"), Drained.Num(), 1);
	if (Drained.Num() == 1)
	{
		TestEqual(TEXT("drained key"), Drained[0].Key, FString(TEXT("a")));
		TestEqual(TEXT("drained count"), Drained[0].Suppressed, 2);
	}
	TestEqual(TEXT("closed windows are forgotten, quiet ones too"), Drain.NumKeys(), 0);
	const FWarningLimiter::FHit AfterDrain = Drain.Note(TEXT("a"));
	TestTrue(TEXT("a drained key logs again"), AfterDrain.bLog);
	TestEqual(TEXT("a drained count is never reported twice"), AfterDrain.SuppressedInPreviousWindow, 0);

	// Overflow: at capacity, new keys share "<overflow>" so the map stays bounded.
	double SmallNow = 0.0;
	FWarningLimiter Small([&SmallNow]() { return SmallNow; }, 30.0, 4);
	Small.Note(TEXT("k1")); Small.Note(TEXT("k2")); Small.Note(TEXT("k3"));
	TestEqual(TEXT("three keys fit"), Small.NumKeys(), 3);
	TestTrue(TEXT("the first overflowing key logs once"), Small.Note(TEXT("k4")).bLog);
	TestFalse(TEXT("a second overflowing key shares the overflow window"), Small.Note(TEXT("k5")).bLog);
	TestEqual(TEXT("the map never exceeds MaxKeys"), Small.NumKeys(), 4);
	SmallNow = 31.0;
	const TArray<FWarningLimiter::FDrained> Overflowed = Small.DrainExpired();
	TestTrue(TEXT("the overflow window drains with its count"),
		Overflowed.ContainsByPredicate([](const FWarningLimiter::FDrained& D) { return D.Key == TEXT("<overflow>") && D.Suppressed == 1; }));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaHealthUserNotifiedOnceTest,
	"Hayba.MCP.Health.UserNotifiedOnce",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaHealthUserNotifiedOnceTest::RunTest(const FString&)
{
	// The "editor_unsafe: user notified … frame <n>" line is Log verbosity, which the
	// automation framework does not capture; Step 12 greps the log for it instead (M8).
	AddExpectedErrorPlain(TEXT("editor_unsafe: native fault"), EAutomationExpectedErrorFlags::Contains, 3);
	{
		FHaybaEditorHealth::FScopedOverrideForTests Override;
		const FString Cmd = TEXT("python_run"), Id = TEXT("notify-1"), Owner = TEXT("hayba-test-notify");
		FHaybaEditorHealth::FScopedDispatchNote Note(Cmd, Id, Owner);

		FHaybaEditorHealth::RecordCaughtFault(EHaybaFaultSite::Python, AccessViolation);
		TestEqual(TEXT("nothing is posted synchronously inside the faulting stack"), Override.NotificationCount(), 0);
		FHaybaEditorHealth::RecordCaughtFault(EHaybaFaultSite::HandlerInner, AccessViolation);
		TestEqual(TEXT("one Error line per fault"), Override.FaultErrorLineCount(), 2);

		TestTrue(TEXT("the first fault scheduled one next-tick notification"), Override.FlushPendingNotification());
		TestFalse(TEXT("a second fault schedules nothing more"), Override.FlushPendingNotification());
		// R-4: headless runs are -unattended; the test seam must still be reached first.
		AddInfo(FString::Printf(TEXT("FApp::IsUnattended() = %d"), FApp::IsUnattended() ? 1 : 0));
		TestEqual(TEXT("raised exactly once"), Override.NotificationCount(), 1);
		TestEqual(TEXT("cause-specific text of the FIRST fault"), Override.LastNotificationText(),
			FString(TEXT("Hayba contained a native fault in 'python_run'. Save now (File > Save All) and restart the editor. Do not compile, press Play or load a map before restarting.")));
	}
	{
		FHaybaEditorHealth::FScopedOverrideForTests Override;
		const FString Cmd = TEXT("level_save"), Id = TEXT("notify-2"), Owner = TEXT("hayba-test-notify");
		FHaybaEditorHealth::FScopedDispatchNote Note(Cmd, Id, Owner);
		FHaybaEditorHealth::RecordCaughtFault(EHaybaFaultSite::Dispatch, 0x4000u);
		TestTrue(TEXT("the engine-fatal fault scheduled a notification"), Override.FlushPendingNotification());
		TestEqual(TEXT("engine-fatal text tells the user not to save"), Override.LastNotificationText(),
			FString(TEXT("Hayba contained an engine fatal error in 'level_save' during a package save. Do not save; restart the editor now. Saving in this state can crash the editor or write a corrupt package.")));
	}
	TestFalse(TEXT("the real editor health is untouched (R-7)"), FHaybaEditorHealth::IsUnsafe());
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaHealthPythonFaultUnhooksPreGcTest,
	"Hayba.MCP.Health.PythonFaultUnhooksPreGc",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaHealthPythonFaultUnhooksPreGcTest::RunTest(const FString&)
{
	AddExpectedErrorPlain(TEXT("editor_unsafe: native fault"), EAutomationExpectedErrorFlags::Contains, 4);
	{
		FHaybaEditorHealth::FScopedOverrideForTests Override;
		FHaybaEditorHealth::RecordCaughtFault(EHaybaFaultSite::Python, AccessViolation);
		TestEqual(TEXT("a python fault unhooks once"), Override.PreGcUnhookCount(), 1);
		FHaybaEditorHealth::RecordCaughtFault(EHaybaFaultSite::Python, AccessViolation);
		TestEqual(TEXT("a second python fault does not unhook again"), Override.PreGcUnhookCount(), 1);
		TestTrue(TEXT("python is unhealthy"), FHaybaEditorHealth::IsPythonUnhealthy());
	}
	{
		FHaybaEditorHealth::FScopedOverrideForTests Override;
		FHaybaEditorHealth::RecordCaughtFault(EHaybaFaultSite::Dispatch, AccessViolation);
		TestEqual(TEXT("a native fault never unhooks Python"), Override.PreGcUnhookCount(), 0);
		TestFalse(TEXT("a native fault does not mark python unhealthy"), FHaybaEditorHealth::IsPythonUnhealthy());
		TestTrue(TEXT("but the editor is unsafe"), FHaybaEditorHealth::IsUnsafe());
	}
	{
		FHaybaEditorHealth::FScopedOverrideForTests Override;
		FHaybaEditorHealth::RecordPythonCorruption(TEXT("SystemError: unknown opcode"));
		TestEqual(TEXT("a corruption marker is a python fault and unhooks"), Override.PreGcUnhookCount(), 1);
		TestEqual(TEXT("a corruption marker reports HCR-NATIVE-002"),
			FHaybaEditorHealth::Snapshot().FaultCode, FString(TEXT("HCR-NATIVE-002")));
		TestEqual(TEXT("a corruption marker has no exception code"),
			static_cast<int64>(FHaybaEditorHealth::Snapshot().ExceptionCode), static_cast<int64>(0));
	}
	if (IPythonScriptPlugin* Python = IPythonScriptPlugin::Get())
	{
		TestTrue(TEXT("the seam never touched the real pre-GC binding"),
			FCoreUObjectDelegates::GetPreGarbageCollectDelegate().IsBoundToObject(Python));
	}
	TestFalse(TEXT("the real editor health is untouched (R-7)"), FHaybaEditorHealth::IsUnsafe());
	return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
