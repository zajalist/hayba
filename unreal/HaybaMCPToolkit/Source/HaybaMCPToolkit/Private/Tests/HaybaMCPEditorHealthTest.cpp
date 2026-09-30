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
#include "HaybaMCPLeaseManager.h"
#include "HaybaMCPLeasePolicy.h"
#include "handlers/HaybaMCPBatchHandler.h"
#include "HaybaMCPSettings.h"
#include "Editor.h"
#include "Misc/Guid.h"
#include "Misc/ScopeExit.h"
#include "Policies/CondensedJsonPrintPolicy.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
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

namespace HaybaHealthTest
{
	TSharedPtr<FHaybaMCPCommandHandler> Router(FAutomationTestBase& Test)
	{
		FHaybaMCPModule* Module = FModuleManager::GetModulePtr<FHaybaMCPModule>(TEXT("HaybaMCPToolkit"));
		if (!Test.TestNotNull(TEXT("toolkit module is loaded"), Module)) return nullptr;
		return Module->GetCommandHandler();
	}

	FString TestOwner()
	{
		return FString::Printf(TEXT("hayba-test-%s"), *FGuid::NewGuid().ToString(EGuidFormats::Digits).Left(8).ToLower());
	}

	/** A params object with one string field. */
	TSharedPtr<FJsonObject> Params(const TCHAR* Key, const FString& Value)
	{
		TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
		Out->SetStringField(Key, Value);
		return Out;
	}

	/** test_inject_native_fault params. */
	TSharedPtr<FJsonObject> Fault(const TCHAR* Kind, const TCHAR* Site)
	{
		TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
		Out->SetStringField(TEXT("kind"), Kind);
		Out->SetStringField(TEXT("site"), Site);
		return Out;
	}

	FString Envelope(const FString& Cmd, const FString& Owner, const TSharedPtr<FJsonObject>& InParams)
	{
		static int32 Seq = 0;
		TSharedRef<FJsonObject> E = MakeShared<FJsonObject>();
		E->SetStringField(TEXT("id"), FString::Printf(TEXT("health-%d"), ++Seq));
		E->SetStringField(TEXT("cmd"), Cmd);
		E->SetStringField(TEXT("owner"), Owner);
		E->SetObjectField(TEXT("params"), InParams.IsValid() ? InParams.ToSharedRef() : MakeShared<FJsonObject>());
		const FString& Auth = FHaybaMCPSettings::Get().CapabilityToken;
		if (!Auth.IsEmpty()) E->SetStringField(TEXT("auth"), Auth);
		FString Out;
		const TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
			TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Out);
		FJsonSerializer::Serialize(E, Writer);
		return Out;
	}

	TSharedPtr<FJsonObject> Parse(const FString& Text)
	{
		TSharedPtr<FJsonObject> Out;
		const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Text);
		FJsonSerializer::Deserialize(Reader, Out);
		return Out.IsValid() ? Out : MakeShared<FJsonObject>();
	}

	TSharedPtr<FJsonObject> Send(FHaybaMCPCommandHandler& R, const FString& Cmd, const FString& Owner,
		const TSharedPtr<FJsonObject>& InParams = nullptr, int32 ConnId = 0)
	{
		const FString Json = Envelope(Cmd, Owner, InParams);
		return Parse(ConnId == 0 ? R.ProcessCommand(Json) : R.ProcessCommand(Json, ConnId));
	}

	FString Str(const TSharedPtr<FJsonObject>& Obj, const TCHAR* Field)
	{
		FString Out;
		if (Obj.IsValid()) Obj->TryGetStringField(Field, Out);
		return Out;
	}

	TSharedPtr<FJsonObject> Obj(const TSharedPtr<FJsonObject>& Parent, const TCHAR* Field)
	{
		const TSharedPtr<FJsonObject>* Out = nullptr;
		return Parent.IsValid() && Parent->TryGetObjectField(Field, Out) && Out ? *Out : MakeShared<FJsonObject>();
	}

	bool Bool(const TSharedPtr<FJsonObject>& Parent, const TCHAR* Field)
	{
		bool bOut = false;
		return Parent.IsValid() && Parent->TryGetBoolField(Field, bOut) && bOut;
	}
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
	TestEqual(TEXT("71 read commands"), ReadCommands().Num(), 71);
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

	// Router part (T1.3): an injected 0x4000 narrows the gate to status commands.
	using namespace HaybaHealthTest;
	const TSharedPtr<FHaybaMCPCommandHandler> R = Router(*this);
	if (!R.IsValid()) return false;
	AddExpectedErrorPlain(TEXT("editor_unsafe: native fault"), EAutomationExpectedErrorFlags::Contains, 1);
	AddExpectedErrorPlain(TEXT("first refusal since the native fault"), EAutomationExpectedErrorFlags::Contains, 1);
	// Later refusals are Warnings through the process-wide 30 s limiter; their
	// count depends on earlier tests, so they are ignored rather than counted.
	AddExpectedMessagePlain(TEXT("editor_unsafe_restart_required: refused '"), ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, -1);
	{
		FHaybaEditorHealth::FScopedOverrideForTests Override;
		const FString Owner = TestOwner();
		const TSharedPtr<FJsonObject> Faulted = Send(*R, TEXT("test_inject_native_fault"), Owner, Fault(TEXT("engine_assert"), TEXT("handler_inner")));
		TestEqual(TEXT("an injected engine assert answers native_fault_contained"), Str(Faulted, TEXT("code")), FString(TEXT("native_fault_contained")));
		TestTrue(TEXT("it names HCR-NATIVE-004"), Str(Faulted, TEXT("error")).Contains(TEXT("[HCR-NATIVE-004]")));
		TestEqual(TEXT("cause engine_fatal_swallowed"), Str(Obj(Faulted, TEXT("editor_health")), TEXT("cause")), FString(TEXT("engine_fatal_swallowed")));
		TestEqual(TEXT("exception code 0x00004000"), Str(Obj(Faulted, TEXT("editor_health")), TEXT("exception_code")), FString(TEXT("0x00004000")));
		TestEqual(TEXT("data.policy_code is HCR-NATIVE-004 (spec 4.2)"), Str(Obj(Faulted, TEXT("data")), TEXT("policy_code")), FString(TEXT("HCR-NATIVE-004")));
		TestTrue(TEXT("the handler's own data survives next to the policy code"), Bool(Obj(Faulted, TEXT("data")), TEXT("inner_guard_caught")));
		for (const TCHAR* Cmd : { TEXT("blueprint_get_info"), TEXT("asset_get_info"), TEXT("object_get_property"), TEXT("test_list") })
		{
			const TSharedPtr<FJsonObject> Reply = Send(*R, Cmd, Owner);
			TestEqual(*FString::Printf(TEXT("%s is refused after an engine fatal"), Cmd), Str(Reply, TEXT("code")), FString(TEXT("editor_unsafe_restart_required")));
			TestTrue(*FString::Printf(TEXT("%s names the status-only tail"), Cmd),
				Str(Reply, TEXT("error")).EndsWith(TEXT("Only status commands such as editor_get_state, ping and lease_status answer.")));
		}
		TestTrue(TEXT("ping still answers"), Bool(Send(*R, TEXT("ping"), Owner), TEXT("ok")));
		const TSharedPtr<FJsonObject> State = Send(*R, TEXT("editor_get_state"), Owner);
		TestTrue(TEXT("editor_get_state still answers"), Bool(State, TEXT("ok")));
		TestEqual(TEXT("the dirty walk is skipped"), Str(Obj(State, TEXT("data")), TEXT("dirty_packages_skipped")), FString(TEXT("editor_unsafe")));
		TestFalse(TEXT("no dirty package list after a status-only cause"), Obj(State, TEXT("data"))->HasField(TEXT("dirty_packages")));
		TestTrue(TEXT("the notification was scheduled"), Override.FlushPendingNotification());
		TestTrue(TEXT("it tells the user not to save"), Override.LastNotificationText().Contains(TEXT("Do not save; restart the editor now.")));
	}
	TestFalse(TEXT("the real editor health is untouched (R-7)"), FHaybaEditorHealth::IsUnsafe());
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
	// The pre-GC unhook Warning logs under the override too: one python fault.
	AddExpectedMessagePlain(TEXT("editor_unsafe: Python unhooked from the pre-GC delegate"), ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, 1);
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
	// One unhook Warning per override that saw a python fault (blocks 1 and 3).
	AddExpectedMessagePlain(TEXT("editor_unsafe: Python unhooked from the pre-GC delegate"), ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, 2);
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

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaHealthDispatchFaultIsStickyTest,
	"Hayba.MCP.Health.DispatchFaultIsSticky",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaHealthDispatchFaultIsStickyTest::RunTest(const FString&)
{
	using namespace HaybaHealthTest;
	const TSharedPtr<FHaybaMCPCommandHandler> R = Router(*this);
	if (!R.IsValid()) return false;
	// 1 injected fault + 2 nested-note faults below; one first-refusal Error line.
	AddExpectedErrorPlain(TEXT("editor_unsafe: native fault"), EAutomationExpectedErrorFlags::Contains, 3);
	AddExpectedErrorPlain(TEXT("first refusal since the native fault"), EAutomationExpectedErrorFlags::Contains, 1);
	// Later refusals are Warnings through the process-wide 30 s limiter; their
	// count depends on earlier tests, so they are ignored rather than counted.
	AddExpectedMessagePlain(TEXT("editor_unsafe_restart_required: refused '"), ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, -1);
	{
		FHaybaEditorHealth::FScopedOverrideForTests Override;
		const FString Owner = TestOwner();

		const TSharedPtr<FJsonObject> Faulted = Send(*R, TEXT("test_inject_native_fault"), Owner, Fault(TEXT("access_violation"), TEXT("dispatch")));
		TestEqual(TEXT("the faulting command answers native_fault_contained"), Str(Faulted, TEXT("code")), FString(TEXT("native_fault_contained")));
		TestTrue(TEXT("it names HCR-NATIVE-003"), Str(Faulted, TEXT("error")).Contains(TEXT("[HCR-NATIVE-003]")));
		TestEqual(TEXT("its advisory requires a restart"), Str(Obj(Faulted, TEXT("advisory")), TEXT("session_health")), FString(TEXT("restart_required")));
		TestEqual(TEXT("its outcome is unknown"), Str(Obj(Faulted, TEXT("advisory")), TEXT("mutation_status")), FString(TEXT("unknown")));
		// The handler never returned, so the router builds data itself (spec 4.2).
		TestEqual(TEXT("data.policy_code is HCR-NATIVE-003"), Str(Obj(Faulted, TEXT("data")), TEXT("policy_code")), FString(TEXT("HCR-NATIVE-003")));
		TestEqual(TEXT("data.mutation_status is unknown"), Str(Obj(Faulted, TEXT("data")), TEXT("mutation_status")), FString(TEXT("unknown")));
		TestTrue(TEXT("data.may_have_executed is true"), Bool(Obj(Faulted, TEXT("data")), TEXT("may_have_executed")));
		TestFalse(TEXT("data.ok is false"), Bool(Obj(Faulted, TEXT("data")), TEXT("ok")));
		TestTrue(TEXT("the editor is unsafe"), FHaybaEditorHealth::IsUnsafe());
		TestFalse(TEXT("a dispatch fault is not a python fault"), FHaybaEditorHealth::IsPythonUnhealthy());
		TestEqual(TEXT("exactly one Error line for the fault"), Override.FaultErrorLineCount(), 1);
		const FHaybaEditorHealth::FSnapshot H = FHaybaEditorHealth::Snapshot();
		TestEqual(TEXT("the record names the command"), H.FaultedCommand, FString(TEXT("test_inject_native_fault")));
		TestEqual(TEXT("the record names the owner"), H.FaultedOwner, Owner);
		TestEqual(TEXT("HCR-NATIVE-003"), H.FaultCode, FString(TEXT("HCR-NATIVE-003")));
		TestEqual(TEXT("site dispatch"), FString(HaybaMCPHealth::LexSite(H.Site)), FString(TEXT("dispatch")));
		TestEqual(TEXT("exception code"), static_cast<int64>(H.ExceptionCode), static_cast<int64>(AccessViolation));

		const TCHAR* Refused[] = { TEXT("python_run"), TEXT("editor_start_pie"), TEXT("blueprint_compile"), TEXT("ui_save_widget"),
			TEXT("audio_asset_save"), TEXT("level_save"), TEXT("editor_batch"), TEXT("lease_acquire") };
		for (const TCHAR* Cmd : Refused)
		{
			const TSharedPtr<FJsonObject> Reply = Send(*R, Cmd, Owner);
			const FString Error = Str(Reply, TEXT("error"));
			const TSharedPtr<FJsonObject> Advisory = Obj(Reply, TEXT("advisory"));
			TestEqual(*FString::Printf(TEXT("%s is refused while unsafe"), Cmd), Str(Reply, TEXT("code")), FString(TEXT("editor_unsafe_restart_required")));
			TestTrue(*FString::Printf(TEXT("%s: says it was not run"), Cmd), Error.Contains(FString::Printf(TEXT("'%s' was not run"), Cmd)));
			TestTrue(*FString::Printf(TEXT("%s: reads still answer"), Cmd), Error.EndsWith(TEXT("Reads such as editor_get_state, ping and lease_status still answer.")));
			TestFalse(*FString::Printf(TEXT("%s: no refusal text says token"), Cmd), Error.Contains(TEXT("token")));
			TestEqual(*FString::Printf(TEXT("%s: policy_blocked"), Cmd), Str(Advisory, TEXT("state")), FString(TEXT("policy_blocked")));
			TestEqual(*FString::Printf(TEXT("%s: not_started"), Cmd), Str(Advisory, TEXT("mutation_status")), FString(TEXT("not_started")));
			TestEqual(*FString::Printf(TEXT("%s: restart_required"), Cmd), Str(Advisory, TEXT("session_health")), FString(TEXT("restart_required")));
			TestTrue(*FString::Printf(TEXT("%s: carries editor_health"), Cmd), Bool(Obj(Reply, TEXT("editor_health")), TEXT("editor_unsafe")));
		}
		TestFalse(TEXT("the refused editor_start_pie queued no PIE request"), GEditor && GEditor->IsPlaySessionRequestQueued());
		TestEqual(TEXT("every refusal is counted"), FHaybaEditorHealth::Snapshot().RefusedCount, 8);

		const TSharedPtr<FJsonObject> Ping = Send(*R, TEXT("ping"), Owner);
		TestTrue(TEXT("ping answers"), Bool(Ping, TEXT("ok")));
		TestTrue(TEXT("ping reports editor_unsafe"), Bool(Obj(Ping, TEXT("data")), TEXT("editor_unsafe")));
		TestTrue(TEXT("ping advertises the capability"), Bool(Obj(Obj(Ping, TEXT("data")), TEXT("capabilities")), TEXT("editor_health")));
		TestEqual(TEXT("ping health names the cause"), Str(Obj(Obj(Ping, TEXT("data")), TEXT("health")), TEXT("cause")), FString(TEXT("native_fault")));
		const TSharedPtr<FJsonObject> State = Send(*R, TEXT("editor_get_state"), Owner);
		TestTrue(TEXT("editor_get_state answers"), Bool(State, TEXT("ok")));
		TestTrue(TEXT("editor_get_state reports editor_unsafe"), Bool(Obj(State, TEXT("data")), TEXT("editor_unsafe")));
		TestTrue(TEXT("a native fault keeps the dirty walk"), Obj(State, TEXT("data"))->HasField(TEXT("dirty_packages")));
		TestTrue(TEXT("lease_status answers"), Bool(Send(*R, TEXT("lease_status"), Owner), TEXT("ok")));
	}
	{
		// R-8: a fault under nested dispatch notes is blamed on the innermost command…
		FHaybaEditorHealth::FScopedOverrideForTests Nested;
		const FString Outer = TEXT("outer_cmd"), Inner = TEXT("inner_cmd"), Id = TEXT("nested-1"), Owner = TEXT("hayba-test-nested");
		FHaybaEditorHealth::FScopedDispatchNote OuterNote(Outer, Id, Owner);
		{
			FHaybaEditorHealth::FScopedDispatchNote InnerNote(Inner, Id, Owner);
			FHaybaEditorHealth::RecordCaughtFault(EHaybaFaultSite::HandlerInner, AccessViolation);
		}
		TestEqual(TEXT("the inner command is blamed"), FHaybaEditorHealth::Snapshot().FaultedCommand, Inner);
	}
	{
		// …and a closed inner note restores the outer one.
		FHaybaEditorHealth::FScopedOverrideForTests Restored;
		const FString Outer = TEXT("outer_cmd"), Inner = TEXT("inner_cmd"), Id = TEXT("nested-2"), Owner = TEXT("hayba-test-nested");
		FHaybaEditorHealth::FScopedDispatchNote OuterNote(Outer, Id, Owner);
		{
			FHaybaEditorHealth::FScopedDispatchNote InnerNote(Inner, Id, Owner);
		}
		FHaybaEditorHealth::RecordCaughtFault(EHaybaFaultSite::HandlerInner, AccessViolation);
		TestEqual(TEXT("the outer command is blamed once the inner note closed"), FHaybaEditorHealth::Snapshot().FaultedCommand, Outer);
	}
	TestFalse(TEXT("the real editor health is untouched (R-7)"), FHaybaEditorHealth::IsUnsafe());
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaHealthInnerGuardOkResultTest,
	"Hayba.MCP.Health.InnerGuardOkResultIsForcedToFault",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaHealthInnerGuardOkResultTest::RunTest(const FString&)
{
	using namespace HaybaHealthTest;
	const TSharedPtr<FHaybaMCPCommandHandler> R = Router(*this);
	if (!R.IsValid()) return false;
	AddExpectedErrorPlain(TEXT("editor_unsafe: native fault"), EAutomationExpectedErrorFlags::Contains, 1);
	{
		FHaybaEditorHealth::FScopedOverrideForTests Override;
		// The handler catches its own fault (HaybaSeh::RunGuarded, like material_compile) and still returns Ok.
		const TSharedPtr<FJsonObject> Reply = Send(*R, TEXT("test_inject_native_fault"), TestOwner(), Fault(TEXT("access_violation"), TEXT("handler_inner")));
		TestFalse(TEXT("an Ok result after an inner fault is not ok"), Bool(Reply, TEXT("ok")));
		TestEqual(TEXT("it is forced to native_fault_contained"), Str(Reply, TEXT("code")), FString(TEXT("native_fault_contained")));
		const TSharedPtr<FJsonObject> Data = Obj(Reply, TEXT("data"));
		TestTrue(TEXT("the handler's data survives"), Bool(Data, TEXT("inner_guard_caught")) && Bool(Data, TEXT("handler_returned_ok")));
		TestFalse(TEXT("but its ok:true is overruled"), Bool(Data, TEXT("ok")));
		TestEqual(TEXT("data.policy_code is HCR-NATIVE-003"), Str(Data, TEXT("policy_code")), FString(TEXT("HCR-NATIVE-003")));
		TestEqual(TEXT("site handler_inner"), Str(Obj(Reply, TEXT("editor_health")), TEXT("site")), FString(TEXT("handler_inner")));
		TestEqual(TEXT("cause native_fault"), Str(Obj(Reply, TEXT("editor_health")), TEXT("cause")), FString(TEXT("native_fault")));
		TestEqual(TEXT("session_suspect"), Str(Obj(Reply, TEXT("advisory")), TEXT("state")), FString(TEXT("session_suspect")));
		TestEqual(TEXT("restart_required"), Str(Obj(Reply, TEXT("advisory")), TEXT("session_health")), FString(TEXT("restart_required")));
		TestTrue(TEXT("may have mutated"), Bool(Obj(Reply, TEXT("advisory")), TEXT("may_have_mutated")));
		TestTrue(TEXT("the editor is unsafe"), FHaybaEditorHealth::IsUnsafe());
		TestEqual(TEXT("one fault recorded"), FHaybaEditorHealth::Snapshot().FaultCount, 1);
	}
	TestFalse(TEXT("the real editor health is untouched (R-7)"), FHaybaEditorHealth::IsUnsafe());
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaHealthFaultInjectionIsGuardedTest,
	"Hayba.MCP.Health.FaultInjectionIsGuarded",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaHealthFaultInjectionIsGuardedTest::RunTest(const FString&)
{
	using namespace HaybaHealthTest;
	using HaybaMCPHealth::IsNativeFaultInjectionAllowed;

	// The no-override refusal is proven on the pure guard, never by a real injection
	// attempt: if that guard were broken the whole headless run would be poisoned (R-7).
	TestFalse(TEXT("refused without the health override"), IsNativeFaultInjectionAllowed(false, 0, true));
	TestFalse(TEXT("refused from a TCP connection"), IsNativeFaultInjectionAllowed(true, 900001, true));
	TestFalse(TEXT("refused outside automation"), IsNativeFaultInjectionAllowed(true, 0, false));
	TestFalse(TEXT("refused with no request context"), IsNativeFaultInjectionAllowed(true, -1, true));
	TestTrue(TEXT("allowed only when all three hold"), IsNativeFaultInjectionAllowed(true, 0, true));

	const TSharedPtr<FHaybaMCPCommandHandler> R = Router(*this);
	if (!R.IsValid()) return false;
	AddExpectedErrorPlain(TEXT("editor_unsafe: native fault"), EAutomationExpectedErrorFlags::Contains, 1);
	{
		FHaybaEditorHealth::FScopedOverrideForTests Override;
		const FString Owner = TestOwner();
		const TSharedPtr<FJsonObject> FromTcp = Send(*R, TEXT("test_inject_native_fault"), Owner, Fault(TEXT("access_violation"), TEXT("dispatch")), 900001);
		TestFalse(TEXT("a TCP connection cannot inject"), Bool(FromTcp, TEXT("ok")));
		TestTrue(TEXT("the refusal says nothing was injected"), Str(FromTcp, TEXT("error")).Contains(TEXT("Nothing was injected")));
		TestFalse(TEXT("still healthy after the TCP attempt"), FHaybaEditorHealth::IsUnsafe());
		{
			TGuardValue<bool> NotTesting(GIsAutomationTesting, false);
			const TSharedPtr<FJsonObject> Outside = Send(*R, TEXT("test_inject_native_fault"), Owner, Fault(TEXT("access_violation"), TEXT("dispatch")));
			TestFalse(TEXT("outside an automation run cannot inject"), Bool(Outside, TEXT("ok")));
		}
		TestFalse(TEXT("still healthy outside automation"), FHaybaEditorHealth::IsUnsafe());
		const TSharedPtr<FJsonObject> Bad = Send(*R, TEXT("test_inject_native_fault"), Owner, Fault(TEXT("stack_overflow"), TEXT("dispatch")));
		TestFalse(TEXT("an unknown kind is rejected"), Bool(Bad, TEXT("ok")));
		// Positive control: the refusals above are not vacuous.
		const TSharedPtr<FJsonObject> Allowed = Send(*R, TEXT("test_inject_native_fault"), Owner, Fault(TEXT("access_violation"), TEXT("dispatch")));
		TestEqual(TEXT("with all guards the fault is injected"), Str(Allowed, TEXT("code")), FString(TEXT("native_fault_contained")));
	}
	TestFalse(TEXT("the real editor health is untouched (R-7)"), FHaybaEditorHealth::IsUnsafe());
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaHealthPythonGuardFaultTest,
	"Hayba.MCP.Health.PythonGuardFaultSetsPythonUnhealthy",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaHealthPythonGuardFaultTest::RunTest(const FString&)
{
	using namespace HaybaHealthTest;
	const TSharedPtr<FHaybaMCPCommandHandler> R = Router(*this);
	if (!R.IsValid()) return false;
	// Three faults: the injected Python-site fault, the raised SystemError and the LogPython marker.
	AddExpectedErrorPlain(TEXT("editor_unsafe: native fault"), EAutomationExpectedErrorFlags::Contains, 3);
	// The LogPython Error line the script emits on purpose, and our Error lines that name the marker.
	AddExpectedErrorPlain(TEXT("SystemError: unknown opcode"), EAutomationExpectedErrorFlags::Contains, 0);
	// Each of the three overrides unhooks Python from pre-GC once, at Warning.
	AddExpectedMessagePlain(TEXT("editor_unsafe: Python unhooked from the pre-GC delegate"), ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, 3);
	// python_run is Plan-gated; the gate is not what this test is about.
	TGuardValue<bool> PlanOff(FHaybaMCPSettings::Get().bPlanModeEnabled, false);
	{
		FHaybaEditorHealth::FScopedOverrideForTests Override;
		const TSharedPtr<FJsonObject> Reply = Send(*R, TEXT("test_inject_native_fault"), TestOwner(), Fault(TEXT("access_violation"), TEXT("python")));
		TestEqual(TEXT("a Python-site fault answers native_fault_contained"), Str(Reply, TEXT("code")), FString(TEXT("native_fault_contained")));
		TestTrue(TEXT("it names HCR-NATIVE-002"), Str(Reply, TEXT("error")).Contains(TEXT("[HCR-NATIVE-002]")));
		TestTrue(TEXT("python is unhealthy"), FHaybaEditorHealth::IsPythonUnhealthy());
		TestEqual(TEXT("cause python_native_fault"), Str(Obj(Reply, TEXT("editor_health")), TEXT("cause")), FString(TEXT("python_native_fault")));
		TestEqual(TEXT("site python"), Str(Obj(Reply, TEXT("editor_health")), TEXT("site")), FString(TEXT("python")));
		TestEqual(TEXT("Python was unhooked from pre-GC once"), Override.PreGcUnhookCount(), 1);
		TestEqual(TEXT("data.policy_code is HCR-NATIVE-002"), Str(Obj(Reply, TEXT("data")), TEXT("policy_code")), FString(TEXT("HCR-NATIVE-002")));
	}
	{
		// R-15: what a script can write or subclass never counts. None of these marks the editor unsafe.
		FHaybaEditorHealth::FScopedOverrideForTests Override;
		const FString Owner = TestOwner();
		const TSharedPtr<FJsonObject> Printed = Send(*R, TEXT("python_run"), Owner, Params(TEXT("script"), TEXT("print('SystemError: unknown opcode')")));
		TestTrue(TEXT("a marker on stdout is just output"), Bool(Printed, TEXT("ok")));
		TestFalse(TEXT("stdout never marks the editor unsafe"), FHaybaEditorHealth::IsUnsafe());
		// A subclass can override attribute access, so its arguments are never read.
		const TSharedPtr<FJsonObject> Subclass = Send(*R, TEXT("python_run"), Owner, Params(TEXT("script"),
			TEXT("class Fake(SystemError):\n    pass\nraise Fake('unknown opcode')")));
		TestNotEqual(TEXT("a subclass of SystemError is an ordinary script error"), Str(Subclass, TEXT("code")), FString(TEXT("native_fault_contained")));
		TestFalse(TEXT("a subclass never marks the editor unsafe"), FHaybaEditorHealth::IsUnsafe());
		const TSharedPtr<FJsonObject> OtherType = Send(*R, TEXT("python_run"), Owner, Params(TEXT("script"),
			TEXT("raise RuntimeError('SystemError: unknown opcode')")));
		TestNotEqual(TEXT("another exception type that quotes a marker is ordinary"), Str(OtherType, TEXT("code")), FString(TEXT("native_fault_contained")));
		const TSharedPtr<FJsonObject> Plain = Send(*R, TEXT("python_run"), Owner, Params(TEXT("script"), TEXT("raise SystemError('boom')")));
		TestNotEqual(TEXT("a SystemError without a marker is ordinary"), Str(Plain, TEXT("code")), FString(TEXT("native_fault_contained")));
		TestFalse(TEXT("the bounded traceback never marks the editor unsafe"), FHaybaEditorHealth::IsUnsafe());
		TestEqual(TEXT("no fault was recorded"), FHaybaEditorHealth::Snapshot().FaultCount, 0);
	}
	{
		// The I-6 signature: CPython raises the exact built-in SystemError while the
		// user script runs, and the wrapper's except block catches it. No SEH catch.
		FHaybaEditorHealth::FScopedOverrideForTests Override;
		const TSharedPtr<FJsonObject> Raised = Send(*R, TEXT("python_run"), TestOwner(), Params(TEXT("script"), TEXT("raise SystemError('unknown opcode')")));
		TestEqual(TEXT("an exact SystemError with a marker answers native_fault_contained"), Str(Raised, TEXT("code")), FString(TEXT("native_fault_contained")));
		TestTrue(TEXT("it names HCR-NATIVE-002"), Str(Raised, TEXT("error")).Contains(TEXT("[HCR-NATIVE-002]")));
		TestEqual(TEXT("matched rule"), Str(Obj(Raised, TEXT("data")), TEXT("matched_rule")), FString(TEXT("cpython_corruption_marker")));
		TestEqual(TEXT("data.policy_code is HCR-NATIVE-002"), Str(Obj(Raised, TEXT("data")), TEXT("policy_code")), FString(TEXT("HCR-NATIVE-002")));
		TestTrue(TEXT("the exception path sets python_unhealthy"), FHaybaEditorHealth::IsPythonUnhealthy());
		TestEqual(TEXT("no SEH exception code"), static_cast<int64>(FHaybaEditorHealth::Snapshot().ExceptionCode), static_cast<int64>(0));
		TestEqual(TEXT("Python was unhooked from pre-GC once"), Override.PreGcUnhookCount(), 1);
	}
	{
		FHaybaEditorHealth::FScopedOverrideForTests Override;
		const FString Owner = TestOwner();
		// A LogPython Error line with a marker, and no SEH catch.
		const TSharedPtr<FJsonObject> Corrupt = Send(*R, TEXT("python_run"), Owner,
			Params(TEXT("script"), TEXT("import unreal\nunreal.log_error('SystemError: unknown opcode')")));
		TestEqual(TEXT("a corruption marker answers native_fault_contained"), Str(Corrupt, TEXT("code")), FString(TEXT("native_fault_contained")));
		TestTrue(TEXT("it names HCR-NATIVE-002"), Str(Corrupt, TEXT("error")).Contains(TEXT("[HCR-NATIVE-002]")));
		TestEqual(TEXT("matched rule"), Str(Obj(Corrupt, TEXT("data")), TEXT("matched_rule")), FString(TEXT("cpython_corruption_marker")));
		TestTrue(TEXT("the marker path sets python_unhealthy"), FHaybaEditorHealth::IsPythonUnhealthy());
		TestEqual(TEXT("no SEH exception code"), static_cast<int64>(FHaybaEditorHealth::Snapshot().ExceptionCode), static_cast<int64>(0));
	}
	TestFalse(TEXT("the real editor health is untouched (R-7)"), FHaybaEditorHealth::IsUnsafe());
	return true;
}

namespace HaybaHealthTest
{
	/** A global X lease for Owner, straight from the table (release it in ON_SCOPE_EXIT). */
	FString AcquireGlobalLease(FAutomationTestBase& Test, const FString& Owner)
	{
		HaybaMCPLease::FRequest Request;
		Request.Owner = Owner;
		HaybaMCPAccess::FClaim Claim;
		FString Error;
		Test.TestTrue(TEXT("'global' parses"), HaybaMCPAccess::ParseResource(TEXT("global"), Claim.Resource, Error));
		Claim.bExclusive = true;
		Request.Claims.Add(Claim);
		Request.TtlSeconds = 60.0;
		Request.Label = TEXT("hayba-test batch");
		const HaybaMCPLease::FAcquireResult Result = FHaybaMCPLeaseManager::Get().Table().Acquire(Request);
		Test.TestTrue(TEXT("the test lease is granted"), Result.Status == HaybaMCPLease::EStatus::Granted);
		return Result.Token;
	}

	TSharedPtr<FJsonObject> Step(const TCHAR* Cmd, const TCHAR* Fence, const TSharedPtr<FJsonObject>& StepParams = nullptr)
	{
		TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
		Out->SetStringField(TEXT("cmd"), Cmd);
		Out->SetStringField(TEXT("fence_after"), Fence);
		if (StepParams.IsValid()) Out->SetObjectField(TEXT("params"), StepParams.ToSharedRef());
		return Out;
	}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaHealthBatchStepRefusedTest,
	"Hayba.MCP.Health.BatchStepRefusedWhileUnsafe",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaHealthBatchStepRefusedTest::RunTest(const FString&)
{
	using namespace HaybaHealthTest;
	const TSharedPtr<FHaybaMCPCommandHandler> R = Router(*this);
	if (!R.IsValid()) return false;
	AddExpectedErrorPlain(TEXT("editor_unsafe: native fault"), EAutomationExpectedErrorFlags::Contains, 1);
	AddExpectedErrorPlain(TEXT("first refusal since the native fault"), EAutomationExpectedErrorFlags::Contains, 1);
	{
		FHaybaEditorHealth::FScopedOverrideForTests Override;
		const FString Owner = TestOwner();
		Send(*R, TEXT("test_inject_native_fault"), Owner, Fault(TEXT("access_violation"), TEXT("dispatch")));
		TestTrue(TEXT("the editor is unsafe"), FHaybaEditorHealth::IsUnsafe());

		// A new batch never starts.
		TSharedPtr<FJsonObject> BatchParams = MakeShared<FJsonObject>();
		BatchParams->SetStringField(TEXT("lease"), TEXT("ls_1"));
		BatchParams->SetArrayField(TEXT("steps"), { MakeShared<FJsonValueObject>(Step(TEXT("ping"), TEXT("none"))) });
		TestEqual(TEXT("editor_batch is refused"), Str(Send(*R, TEXT("editor_batch"), Owner, BatchParams), TEXT("code")),
			FString(TEXT("editor_unsafe_restart_required")));

		// A routed batch step takes slot 1 like any other request.
		const TSharedPtr<FJsonObject> Routed = Parse(R->ProcessBatchStep(
			Envelope(TEXT("python_run"), Owner, Params(TEXT("script"), TEXT("print(1)"))), TEXT("job-health-test"), false));
		TestEqual(TEXT("a routed python_run step is refused"), Str(Routed, TEXT("code")), FString(TEXT("editor_unsafe_restart_required")));

		// The native region steps check IsUnsafe() before anything else (defence in depth).
		TSharedPtr<FJsonObject> Bounds = MakeShared<FJsonObject>();
		Bounds->SetNumberField(TEXT("min_x"), 0); Bounds->SetNumberField(TEXT("min_y"), 0);
		Bounds->SetNumberField(TEXT("max_x"), 100); Bounds->SetNumberField(TEXT("max_y"), 100);
		TestTrue(TEXT("wp_region_load refuses while unsafe"),
			HaybaMCPBatchTestHooks::RunRegionStepForTests(TEXT("wp_region_load"), Bounds)
				.StartsWith(TEXT("[editor_unsafe_restart_required] wp_region_load was not run")));
		TestTrue(TEXT("wp_region_unload refuses while unsafe"),
			HaybaMCPBatchTestHooks::RunRegionStepForTests(TEXT("wp_region_unload"), MakeShared<FJsonObject>())
				.StartsWith(TEXT("[editor_unsafe_restart_required] wp_region_unload was not run")));
	}
	TestFalse(TEXT("the real editor health is untouched (R-7)"), FHaybaEditorHealth::IsUnsafe());
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaHealthBatchPumpStopsTest,
	"Hayba.MCP.Health.BatchPumpStopsWhileUnsafe",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaHealthBatchPumpStopsTest::RunTest(const FString&)
{
	using namespace HaybaHealthTest;
	const TSharedPtr<FHaybaMCPCommandHandler> R = Router(*this);
	if (!R.IsValid()) return false;
	AddExpectedErrorPlain(TEXT("editor_unsafe: native fault"), EAutomationExpectedErrorFlags::Contains, 1);
	// The Warning FinalizeUnsafe logs. It must count the region the batch still holds.
	AddExpectedErrorPlain(TEXT("editor unsafe; 1 region(s) left loaded, the restart discards them"), EAutomationExpectedErrorFlags::Contains, 1);
	TGuardValue<bool> PlanOff(FHaybaMCPSettings::Get().bPlanModeEnabled, false);   // editor_batch is Plan-gated
	{
		FHaybaEditorHealth::FScopedOverrideForTests Override;
		const FString Owner = TestOwner();
		const FString Token = AcquireGlobalLease(*this, Owner);
		FString JobId;
		ON_SCOPE_EXIT
		{
			// Never leave a registered pump behind a failed assertion.
			for (int32 I = 0; I < 8 && !JobId.IsEmpty() && HaybaMCPBatchTestHooks::PumpOnceForTests(JobId); ++I) {}
			HaybaMCPBatchTestHooks::ReleaseFakeLoadedRegions();
			FString Ignored;
			FHaybaMCPLeaseManager::Get().Table().Release(Token, Owner, Ignored);
		};

		// The spec's shape, [region load, faulting step, region unload] with a gc fence.
		// The region is injected instead of loaded (see the Decision above).
		TSharedPtr<FJsonObject> UnloadParams = MakeShared<FJsonObject>();
		UnloadParams->SetStringField(TEXT("name"), TEXT("fake_region"));
		TSharedPtr<FJsonObject> BatchParams = MakeShared<FJsonObject>();
		BatchParams->SetStringField(TEXT("lease"), Token);
		BatchParams->SetArrayField(TEXT("steps"), {
			MakeShared<FJsonValueObject>(Step(TEXT("ping"), TEXT("none"))),
			MakeShared<FJsonValueObject>(Step(TEXT("test_inject_native_fault"), TEXT("gc"), Fault(TEXT("access_violation"), TEXT("dispatch")))),
			MakeShared<FJsonValueObject>(Step(TEXT("wp_region_unload"), TEXT("gc"), UnloadParams)) });
		const TSharedPtr<FJsonObject> Started = Send(*R, TEXT("editor_batch"), Owner, BatchParams);
		JobId = Str(Obj(Started, TEXT("data")), TEXT("job_id"));
		if (!TestFalse(TEXT("the batch started"), JobId.IsEmpty())) return false;
		if (!TestTrue(TEXT("the batch holds one region that counts as loaded"),
			HaybaMCPBatchTestHooks::InjectFakeLoadedRegion(JobId, TEXT("fake_region")))) return false;

		HaybaMCPBatchTestHooks::BeginRecording();
		for (int32 I = 0; I < 10 && !FHaybaEditorHealth::IsUnsafe(); ++I)
		{
			TestTrue(TEXT("the job is pumped"), HaybaMCPBatchTestHooks::PumpOnceForTests(JobId));
		}
		TestTrue(TEXT("the injected step faulted"), FHaybaEditorHealth::IsUnsafe());
		TestEqual(TEXT("R-8: the fault is blamed on the step, not on editor_batch"),
			FHaybaEditorHealth::Snapshot().FaultedCommand, FString(TEXT("test_inject_native_fault")));
		TestTrue(TEXT("the next pump finds the job and finalizes it"), HaybaMCPBatchTestHooks::PumpOnceForTests(JobId));
		TestFalse(TEXT("the job is no longer active"), HaybaMCPBatchTestHooks::PumpOnceForTests(JobId));
		const TArray<FString> Actions = HaybaMCPBatchTestHooks::EndRecording();

		TestEqual(TEXT("exactly the two steps before the fault ran; wp_region_unload never did"),
			Actions.FilterByPredicate([](const FString& A) { return A == TEXT("RunStep"); }).Num(), 2);
		// These can fail: with a loaded region, a pump without the unsafe preamble
		// goes to cleanup and records UnloadAll and ReleaseAll, and the cleanup
		// fence that follows an unload records CollectGarbage.
		for (const TCHAR* Forbidden : { TEXT("CollectGarbage"), TEXT("UnloadAll"), TEXT("ReleaseAll"), TEXT("ReleaseEditorLoaderAdapter") })
		{
			TestFalse(*FString::Printf(TEXT("no %s after the fault"), Forbidden), Actions.Contains(Forbidden));
		}

		TSharedPtr<FJsonObject> StatusParams = MakeShared<FJsonObject>();
		StatusParams->SetStringField(TEXT("job_id"), JobId);
		const TSharedPtr<FJsonObject> Status = Obj(Send(*R, TEXT("batch_status"), Owner, StatusParams), TEXT("data"));
		TestEqual(TEXT("the job failed"), Str(Status, TEXT("status")), FString(TEXT("failed")));
		TestEqual(TEXT("with the unsafe code"), Str(Status, TEXT("code")), FString(TEXT("editor_unsafe_restart_required")));
		double LeftLoaded = -1.0;
		Status->TryGetNumberField(TEXT("regions_left_loaded"), LeftLoaded);
		TestEqual(TEXT("the region was left loaded for the restart to discard"), static_cast<int32>(LeftLoaded), 1);
		TestTrue(TEXT("the error says so"), Str(Status, TEXT("error")).Contains(TEXT("1 World Partition region(s) stay loaded")));
		TestNull(TEXT("the batch's lease-table entry was released"), FHaybaMCPLeaseManager::Get().Table().FindLease(Token));
	}
	TestFalse(TEXT("the real editor health is untouched (R-7)"), FHaybaEditorHealth::IsUnsafe());
	return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
