// Hayba.MCP.Lease.* enforcement tests (T6 creates the pure cases; T6.2 the
// log case; T8 the router cases). See docs/adr/0010.
#include "Misc/AutomationTest.h"
#include "HaybaMCPEnforcementPolicy.h"
#include "HaybaMCPLeaseManager.h"
#include "HaybaMCPDeveloperSettings.h"
#include "Tests/HaybaMCPLeaseTestUtil.h"
#include "Misc/ScopeExit.h"
#include "HaybaMCPSettings.h"
#include "HaybaMCPEditorState.h"
#include "HaybaMCPEditorStatePolicy.h"

#if WITH_DEV_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPLeaseEnforcementDecisionTest,
	"Hayba.MCP.Lease.EnforcementDecision",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPLeaseEnforcementDecisionTest::RunTest(const FString& Parameters)
{
	using namespace HaybaMCPEnforcement;
	using HaybaMCPAccess::EAccessClass;

	// The mode x class x reason table of spec T6, written out literally.
	struct FRow { EMode Mode; bool bWrite; EReason Given; EVerdict Verdict; EReason Reason; const TCHAR* Code; };
	const FRow Rows[] = {
		{ EMode::Off,               false, EReason::Held,         EVerdict::Allow,  EReason::None,         TEXT("") },
		{ EMode::Off,               true,  EReason::Held,         EVerdict::Allow,  EReason::None,         TEXT("") },
		{ EMode::Off,               true,  EReason::LeaseUnknown, EVerdict::Allow,  EReason::None,         TEXT("") },
		{ EMode::Off,               true,  EReason::OwnerMissing, EVerdict::Allow,  EReason::None,         TEXT("") },

		{ EMode::Advisory,          false, EReason::None,         EVerdict::Allow,  EReason::None,         TEXT("") },
		{ EMode::Advisory,          false, EReason::Held,         EVerdict::Warn,   EReason::Held,         TEXT("lease_conflict") },
		{ EMode::Advisory,          false, EReason::LeaseUnknown, EVerdict::Warn,   EReason::LeaseUnknown, TEXT("lease_conflict") },
		{ EMode::Advisory,          false, EReason::OwnerMissing, EVerdict::Allow,  EReason::None,         TEXT("") },
		{ EMode::Advisory,          true,  EReason::None,         EVerdict::Allow,  EReason::None,         TEXT("") },
		{ EMode::Advisory,          true,  EReason::Held,         EVerdict::Warn,   EReason::Held,         TEXT("lease_conflict") },
		{ EMode::Advisory,          true,  EReason::LeaseUnknown, EVerdict::Warn,   EReason::LeaseUnknown, TEXT("lease_conflict") },
		{ EMode::Advisory,          true,  EReason::OwnerMissing, EVerdict::Warn,   EReason::OwnerMissing, TEXT("owner_required") },

		{ EMode::EnforcedForWrites, false, EReason::None,         EVerdict::Allow,  EReason::None,         TEXT("") },
		{ EMode::EnforcedForWrites, false, EReason::Held,         EVerdict::Allow,  EReason::None,         TEXT("") },
		{ EMode::EnforcedForWrites, false, EReason::LeaseUnknown, EVerdict::Warn,   EReason::LeaseUnknown, TEXT("lease_conflict") },
		{ EMode::EnforcedForWrites, false, EReason::OwnerMissing, EVerdict::Allow,  EReason::None,         TEXT("") },
		{ EMode::EnforcedForWrites, true,  EReason::None,         EVerdict::Allow,  EReason::None,         TEXT("") },
		{ EMode::EnforcedForWrites, true,  EReason::Held,         EVerdict::Refuse, EReason::Held,         TEXT("lease_conflict") },
		{ EMode::EnforcedForWrites, true,  EReason::LeaseUnknown, EVerdict::Refuse, EReason::LeaseUnknown, TEXT("lease_conflict") },
		{ EMode::EnforcedForWrites, true,  EReason::OwnerMissing, EVerdict::Refuse, EReason::OwnerMissing, TEXT("owner_required") },

		{ EMode::Enforced,          false, EReason::None,         EVerdict::Allow,  EReason::None,         TEXT("") },
		{ EMode::Enforced,          false, EReason::Held,         EVerdict::Allow,  EReason::None,         TEXT("") },
		{ EMode::Enforced,          false, EReason::LeaseUnknown, EVerdict::Refuse, EReason::LeaseUnknown, TEXT("lease_conflict") },
		{ EMode::Enforced,          false, EReason::OwnerMissing, EVerdict::Allow,  EReason::None,         TEXT("") },
		{ EMode::Enforced,          true,  EReason::None,         EVerdict::Allow,  EReason::None,         TEXT("") },
		{ EMode::Enforced,          true,  EReason::Held,         EVerdict::Refuse, EReason::Held,         TEXT("lease_conflict") },
		{ EMode::Enforced,          true,  EReason::LeaseUnknown, EVerdict::Refuse, EReason::LeaseUnknown, TEXT("lease_conflict") },
		{ EMode::Enforced,          true,  EReason::OwnerMissing, EVerdict::Refuse, EReason::OwnerMissing, TEXT("owner_required") },
	};

	auto MakeFacts = [](EMode Mode, EAccessClass Class, EReason Given)
	{
		FFacts F;
		F.Mode = Mode;
		F.Class = Class;
		F.bOwnerFromEnvelope = Given != EReason::OwnerMissing;
		F.Handle = Given == EReason::LeaseUnknown ? EHandle::Unknown : EHandle::None;
		F.bInProcess = false;
		F.bHeldConflict = Given == EReason::Held;
		F.OtherActiveOwners = Given == EReason::OwnerMissing ? 2 : 0;
		return F;
	};

	const EAccessClass WriteClasses[] = { EAccessClass::WriteScoped, EAccessClass::WriteWorld, EAccessClass::Global };
	for (const FRow& Row : Rows)
	{
		TArray<EAccessClass> Classes;
		if (Row.bWrite) Classes.Append(WriteClasses, UE_ARRAY_COUNT(WriteClasses));
		else Classes.Add(EAccessClass::Read);
		for (const EAccessClass Class : Classes)
		{
			const FDecision D = Decide(MakeFacts(Row.Mode, Class, Row.Given));
			const FString What = FString::Printf(TEXT("%s / %s / given '%s'"),
				LexMode(Row.Mode), HaybaMCPAccess::LexAccessClass(Class), LexReason(Row.Given));
			TestEqual(*(What + TEXT(": verdict")), static_cast<int32>(D.Verdict), static_cast<int32>(Row.Verdict));
			TestEqual(*(What + TEXT(": reason")), FString(LexReason(D.Reason)), FString(LexReason(Row.Reason)));
			TestEqual(*(What + TEXT(": code")), D.Code, FString(Row.Code));
		}
	}

	// Precedence: OwnerMissing > LeaseUnknown > Held.
	FFacts All;
	All.Mode = EMode::EnforcedForWrites;
	All.Class = EAccessClass::WriteScoped;
	All.bOwnerFromEnvelope = false;
	All.Handle = EHandle::Unknown;
	All.bInProcess = false;
	All.bHeldConflict = true;
	All.OtherActiveOwners = 1;
	TestEqual(TEXT("an unidentified write reports owner_missing first"),
		FString(LexReason(Decide(All).Reason)), FString(TEXT("owner_missing")));
	All.bOwnerFromEnvelope = true;
	TestEqual(TEXT("a dead handle outranks a held conflict"),
		FString(LexReason(Decide(All).Reason)), FString(TEXT("lease_unknown")));
	All.Handle = EHandle::None;
	TestEqual(TEXT("a held conflict alone"), FString(LexReason(Decide(All).Reason)), FString(TEXT("held")));

	// Who counts as identified.
	FFacts Anon;
	Anon.Mode = EMode::EnforcedForWrites;
	Anon.Class = EAccessClass::WriteScoped;
	Anon.bOwnerFromEnvelope = false;
	Anon.Handle = EHandle::None;
	Anon.bInProcess = false;
	Anon.bHeldConflict = false;
	Anon.OtherActiveOwners = 1;
	TestEqual(TEXT("an owner-less write with others present is refused"),
		static_cast<int32>(Decide(Anon).Verdict), static_cast<int32>(EVerdict::Refuse));
	FFacts InProcess = Anon;
	InProcess.bInProcess = true;
	TestEqual(TEXT("an in-process caller is identified"),
		static_cast<int32>(Decide(InProcess).Verdict), static_cast<int32>(EVerdict::Allow));
	FFacts ByHandle = Anon;
	ByHandle.Handle = EHandle::Valid;
	TestEqual(TEXT("a valid handle identifies the caller"),
		static_cast<int32>(Decide(ByHandle).Verdict), static_cast<int32>(EVerdict::Allow));
	FFacts Alone = Anon;
	Alone.OtherActiveOwners = 0;
	TestEqual(TEXT("an owner-less write with nobody else present runs"),
		static_cast<int32>(Decide(Alone).Verdict), static_cast<int32>(EVerdict::Allow));

	// Wire names.
	TestEqual(TEXT("off"), FString(LexMode(EMode::Off)), FString(TEXT("off")));
	TestEqual(TEXT("advisory"), FString(LexMode(EMode::Advisory)), FString(TEXT("advisory")));
	TestEqual(TEXT("enforced_for_writes"), FString(LexMode(EMode::EnforcedForWrites)), FString(TEXT("enforced_for_writes")));
	TestEqual(TEXT("enforced"), FString(LexMode(EMode::Enforced)), FString(TEXT("enforced")));

	// SanitizeOwner: trim, control characters become '?', cap 128.
	TestEqual(TEXT("trimmed"), SanitizeOwner(TEXT("  agent-7  ")), FString(TEXT("agent-7")));
	TestEqual(TEXT("control characters become '?'"), SanitizeOwner(TEXT("lane\n3\x01")), FString(TEXT("lane?3?")));
	TestEqual(TEXT("DEL is a control character"), SanitizeOwner(TEXT("\t\x7F\t")), FString(TEXT("?")));
	TestEqual(TEXT("bounded"), SanitizeOwner(FString::ChrN(500, TEXT('a'))).Len(), MaxOwnerChars);
	TestEqual(TEXT("blank stays blank"), SanitizeOwner(TEXT("   ")), FString());
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPLeaseOwnerPresenceTest,
	"Hayba.MCP.Lease.OwnerPresence",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPLeaseOwnerPresenceTest::RunTest(const FString& Parameters)
{
	using namespace HaybaMCPEnforcement;
	double Now = 1000.0;
	FOwnerPresence Presence([&Now]() { return Now; }, 60.0, 3);

	Presence.Note(TEXT("lane-b"), 0);
	Presence.Note(TEXT("lane-a"), 900001);
	Presence.Note(FString(), 900002);
	TestEqual(TEXT("an empty owner is never noted"), Presence.NumTracked(), 2);
	TestEqual(TEXT("active owners are sorted"),
		Presence.ActiveOwners(), TArray<FString>{ TEXT("lane-a"), TEXT("lane-b") });
	TestEqual(TEXT("the caller is excluded"),
		Presence.ActiveOwners(TEXT("lane-a")), TArray<FString>{ TEXT("lane-b") });

	Now += 61.0;
	TestEqual(TEXT("an owner with an open connection stays active; a quiet one lapses"),
		Presence.ActiveOwners(), TArray<FString>{ TEXT("lane-a") });

	Presence.Note(TEXT("lane-a"), 900001);
	Presence.OnConnectionClosed(900001);
	TestEqual(TEXT("closing its connection leaves it active for the seen window"),
		Presence.ActiveOwners(), TArray<FString>{ TEXT("lane-a") });
	Now += 61.0;
	TestEqual(TEXT("and then it lapses"), Presence.ActiveOwners(), TArray<FString>());

	// Capacity: at most MaxOwners entries; inactive owners go first.
	Presence.Note(TEXT("lane-c"), 900003);
	Presence.Note(TEXT("lane-d"), 900004);
	TestEqual(TEXT("bounded at MaxOwners"), Presence.NumTracked(), 3);
	TestEqual(TEXT("the oldest lapsed owner made room; lapsed owners are not listed"),
		Presence.ActiveOwners(), TArray<FString>{ TEXT("lane-c"), TEXT("lane-d") });

	Presence.Forget(TEXT("lane-c"));
	TestEqual(TEXT("Forget removes an owner at once"),
		Presence.ActiveOwners(), TArray<FString>{ TEXT("lane-d") });

	Presence.Reset();
	TestEqual(TEXT("Reset forgets everyone"), Presence.NumTracked(), 0);
	TestEqual(TEXT("and nobody is active"), Presence.ActiveOwners().Num(), 0);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPLeaseProcessingLogOwnerTest,
	"Hayba.MCP.Lease.ProcessingLogOwner",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPLeaseProcessingLogOwnerTest::RunTest(const FString& Parameters)
{
	using namespace HaybaMCPLeaseTest;
	FScopedCleanPresence CleanPresence;
	const TSharedPtr<FHaybaMCPCommandHandler> R = Router();
	if (!TestTrue(TEXT("command router exists"), R.IsValid())) return false;
	FHaybaMCPLeaseManager& Leases = FHaybaMCPLeaseManager::Get();
	UHaybaMCPDeveloperSettings* Dev = GetMutableDefault<UHaybaMCPDeveloperSettings>();
	const EHaybaMCPLeaseEnforcement ModeWas = Dev->LeaseEnforcement;
	const FString Holder = UniqueOwner(TEXT("holder"));
	const FString Caller = UniqueOwner(TEXT("caller"));
	double Advanced = 0.0;
	ON_SCOPE_EXIT
	{
		Leases.AdvanceClockForTests(-Advanced);
		Dev->LeaseEnforcement = ModeWas;
		Leases.ForgetOwnerForTests(Holder);
		Leases.ForgetOwnerForTests(Caller);
		for (int32 Conn = 900600; Conn <= 900660; ++Conn) R->NotifyConnectionClosed(Conn);
	};
	Dev->LeaseEnforcement = EHaybaMCPLeaseEnforcement::Advisory;

	// 1. The Processing command line names the caller and classifies the handle.
	const FString HolderLease = AcquireId(*R, 900654, Holder,
		TEXT("{\"resources\":[\"global\"],\"bind_connection\":false,\"label\":\"log-owner\"}"));
	TestFalse(TEXT("holder lease granted"), HolderLease.IsEmpty());
	FLogCapture InvalidLeaseLog(TEXT("LogHaybaMCPLease"));
	auto WarningRepeats = [this](const TSharedPtr<FJsonObject>& Reply)
	{
		const TSharedPtr<FJsonObject>* Warning = nullptr;
		double Repeats = -1.0;
		if (!TestTrue(TEXT("the reply carries a lease warning"),
			Reply.IsValid() && Reply->TryGetObjectField(TEXT("lease_warning"), Warning) && Warning && Warning->IsValid())
			|| !TestTrue(TEXT("the warning carries its repeat count"),
				(*Warning)->TryGetNumberField(TEXT("repeats_in_window"), Repeats)))
		{
			return -1;
		}
		return static_cast<int32>(Repeats);
	};
	{
		FLogCapture Cmd(TEXT("LogHaybaMCPCmd"));
		Send(*R, 900650, Caller, TEXT("ping"), nullptr);
		Send(*R, 900651, FString(), TEXT("ping"), nullptr);
		Send(*R, 0, FString(), TEXT("ping"), nullptr);
		const TSharedPtr<FJsonObject> MarkerFirst = Send(*R, 900652, Caller, TEXT("ping"), nullptr, TEXT("[REDACTED:token]"));
		const TSharedPtr<FJsonObject> UnknownFirst = Send(*R, 900653, Caller, TEXT("ping"), nullptr, TEXT("ls_999999_000000000000"));
		// Different diagnostics for the same owner/command are separate windows.
		// Keep replies alive while extracting fields from their lease_warning.
		TestEqual(TEXT("the marker starts its own warning window"), WarningRepeats(MarkerFirst), 1);
		TestEqual(TEXT("the unknown handle starts its own warning window"), WarningRepeats(UnknownFirst), 1);
		const TSharedPtr<FJsonObject> MarkerRepeat = Send(*R, 900657, Caller, TEXT("ping"), nullptr, TEXT("[REDACTED:token]"));
		const TSharedPtr<FJsonObject> UnknownRepeat = Send(*R, 900658, Caller, TEXT("ping"), nullptr, TEXT("ls_999999_000000000000"));
		const TSharedPtr<FJsonObject> UnknownAgain = Send(*R, 900659, Caller, TEXT("ping"), nullptr, TEXT("ls_999999_000000000000"));
		TestEqual(TEXT("a marker repetition stays in its own window"), WarningRepeats(MarkerRepeat), 2);
		TestEqual(TEXT("an unknown repetition stays in its own window"), WarningRepeats(UnknownRepeat), 2);
		TestEqual(TEXT("a second unknown repetition leaves the marker count alone"), WarningRepeats(UnknownAgain), 3);
		Send(*R, 900655, Caller, TEXT("ping"), nullptr, HolderLease);
		Send(*R, 900656, Holder, TEXT("ping"), nullptr, HolderLease);
		R->ProcessBatchStep(Envelope(Caller, TEXT("ping"), nullptr), TEXT("hayba-test-job-6f2a91c0"), true);
		Cmd.Flush();

		TestEqual(TEXT("an envelope owner"),
			Cmd.Count(FString::Printf(TEXT("owner: %s, via: envelope, conn: 900650, lease: none)"), *Caller)), 1);
		TestEqual(TEXT("a per-connection owner"),
			Cmd.Count(TEXT("owner: conn:900651, via: conn, conn: 900651, lease: none)")), 1);
		TestEqual(TEXT("an in-process owner"),
			Cmd.Count(TEXT("owner: local, via: local, conn: 0, lease: none)")), 1);
		TestEqual(TEXT("a marker is classified, not printed"), Cmd.Count(TEXT("conn: 900652, lease: redacted)")), 1);
		TestEqual(TEXT("an unknown handle"), Cmd.Count(TEXT("conn: 900653, lease: unknown)")), 1);
		TestEqual(TEXT("a valid handle acts as its lease's owner"),
			Cmd.Count(FString::Printf(TEXT("owner: %s, via: lease, conn: 900655, lease: valid)"), *Holder)), 1);
		TestEqual(TEXT("a valid handle still supplies an identical envelope owner"),
			Cmd.Count(FString::Printf(TEXT("owner: %s, via: lease, conn: 900656, lease: valid)"), *Holder)), 1);
		TestEqual(TEXT("a batch step names its job"), Cmd.Count(TEXT(", batch: hayba-te)")), 1);
		TestEqual(TEXT("the handle itself never reaches the log"),
			Cmd.Count(HolderLease) + Cmd.Count(TEXT("ls_999999_000000000000")) + Cmd.Count(TEXT("[REDACTED:token]")), 0);
	}

	InvalidLeaseLog.Flush();
	TestEqual(TEXT("the marker diagnostic logs its first occurrence only"),
		InvalidLeaseLog.Count(TEXT("[advisory] lease_conflict: 'ping': the envelope's lease is a redaction marker"), ELogVerbosity::Warning), 1);
	TestEqual(TEXT("the unknown diagnostic logs its first occurrence only"),
		InvalidLeaseLog.Count(TEXT("[advisory] lease_conflict: 'ping': the envelope's lease_id is unknown or expired"), ELogVerbosity::Warning), 1);

	// 2. 50 identical advisory conflicts from per-call connections: one Warning,
	//    then one drained line with the other 49 (R-9, R-18).
	{
		FLogCapture LeaseLog(TEXT("LogHaybaMCPLease"));
		const TSharedPtr<FJsonObject> Params = Json(
			TEXT("{\"path\":\"/Game/__HaybaTest__/BP_LogOwner\",\"node_type\":\"call_function\",\"function_name\":\"PrintString\"}"));
		int32 FirstRepeats = -1;
		int32 LastRepeats = -1;
		for (int32 I = 0; I < 50; ++I)
		{
			FHaybaMCPRequestContext Ctx;
			Ctx.ConnId = 900600 + I;
			Ctx.Owner = FString::Printf(TEXT("conn:%d"), Ctx.ConnId);
			// Named per-call owners. The conn:* collapse is what is under test,
			// and a named owner keeps the reason "held" once T8's owner_required
			// rule exists (an unnamed one would be owner_missing while Holder and
			// Caller are present).
			Ctx.bOwnerFromEnvelope = true;
			FHaybaMCPLeaseManager::FScope Scope(Ctx);
			const FHaybaMCPLeaseManager::FVerdict Verdict = Leases.CheckCommand(TEXT("blueprint_add_node"), Params);
			TestFalse(TEXT("advisory never refuses"), Verdict.bRefuse);
			double Repeats = -1.0;
			if (TestTrue(TEXT("the warning rides on the context"), Ctx.LeaseWarning.IsValid())
				&& Ctx.LeaseWarning->TryGetNumberField(TEXT("repeats_in_window"), Repeats))
			{
				if (I == 0) FirstRepeats = static_cast<int32>(Repeats);
				LastRepeats = static_cast<int32>(Repeats);
			}
		}
		LeaseLog.Flush();
		TestEqual(TEXT("50 identical conflicts log one Warning"),
			LeaseLog.Count(FString::Printf(
				TEXT("[advisory] lease_conflict: 'blueprint_add_node' (write_scoped) conflicts with a lease held by '%s'"),
				*Holder), ELogVerbosity::Warning), 1);
		TestEqual(TEXT("repeats_in_window counts every hit"), LastRepeats - FirstRepeats, 49);

		Leases.AdvanceClockForTests(31.0);
		Advanced += 31.0;
		Leases.DrainLeaseWarnings();
		LeaseLog.Flush();
		TestEqual(TEXT("the closed window is drained with its count"),
			LeaseLog.Count(FString::Printf(
				TEXT("[advisory] lease_conflict/held repeated 49 more times in 30 s: owner='conn:*' cmd='blueprint_add_node' holder='%s'"),
				*Holder), ELogVerbosity::Warning), 1);
	}
	InvalidLeaseLog.Flush();
	TestEqual(TEXT("the marker drains its own suppressed repetition"),
		InvalidLeaseLog.Count(FString::Printf(
			TEXT("[advisory] lease_conflict/lease_handle_redacted repeated 1 more times in 30 s: owner='%s' cmd='ping' holder='' conflict=''"),
			*Caller), ELogVerbosity::Warning), 1);
	TestEqual(TEXT("the unknown handle drains its own suppressed repetitions"),
		InvalidLeaseLog.Count(FString::Printf(
			TEXT("[advisory] lease_conflict/lease_unknown repeated 2 more times in 30 s: owner='%s' cmd='ping' holder='' conflict=''"),
			*Caller), ELogVerbosity::Warning), 1);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPLeaseEnforcedForWritesTwoOwnersTest,
	"Hayba.MCP.Lease.EnforcedForWritesTwoOwners",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPLeaseEnforcedForWritesTwoOwnersTest::RunTest(const FString& Parameters)
{
	using namespace HaybaMCPLeaseTest;
	const TSharedPtr<FHaybaMCPCommandHandler> R = Router();
	if (!TestTrue(TEXT("command router exists"), R.IsValid())) return false;
	FHaybaMCPLeaseManager& Leases = FHaybaMCPLeaseManager::Get();
	FHaybaMCPSettings& Settings = FHaybaMCPSettings::Get();
	UHaybaMCPDeveloperSettings* Dev = GetMutableDefault<UHaybaMCPDeveloperSettings>();
	const EHaybaMCPLeaseEnforcement ModeWas = Dev->LeaseEnforcement;
	const bool bPlanWas = Settings.bPlanModeEnabled;
	// Nobody is present when this test starts, so A and B are the only other owners
	// the owner-less write can meet, and owner_required names both. Without it the
	// owners of earlier tests (fake connections that never close) would fill the 8
	// names the refusal shows, in sorted order, and A might not be one of them.
	FScopedCleanPresence CleanPresence;
	const FString A = UniqueOwner(TEXT("a"));
	const FString B = UniqueOwner(TEXT("b"));
	constexpr int32 ConnA = 900701;
	constexpr int32 ConnB = 900702;
	constexpr int32 ConnC = 900703;
	ON_SCOPE_EXIT
	{
		Dev->LeaseEnforcement = ModeWas;
		Settings.bPlanModeEnabled = bPlanWas;
		Leases.ForgetOwnerForTests(A);
		Leases.ForgetOwnerForTests(B);
		R->NotifyConnectionClosed(ConnA);
		R->NotifyConnectionClosed(ConnB);
		R->NotifyConnectionClosed(ConnC);
	};
	// R-26: set the mode explicitly; a DefaultHaybaMCP.ini must not decide this test.
	Dev->LeaseEnforcement = EHaybaMCPLeaseEnforcement::EnforcedForWrites;
	Settings.bPlanModeEnabled = false;

	auto WriteParams = [](const TCHAR* Asset)
	{
		return Json(FString::Printf(
			TEXT("{\"path\":\"/Game/__HaybaTest__/%s\",\"node_type\":\"call_function\",\"function_name\":\"PrintString\"}"), Asset));
	};
	auto ObjectOf = [](const TSharedPtr<FJsonObject>& Reply, const TCHAR* Key)
	{
		const TSharedPtr<FJsonObject>* Out = nullptr;
		return Reply.IsValid() && Reply->TryGetObjectField(Key, Out) && Out ? *Out : TSharedPtr<FJsonObject>(MakeShared<FJsonObject>());
	};
	auto StringOf = [](const TSharedPtr<FJsonObject>& Object, const TCHAR* Key)
	{
		FString Out;
		if (Object.IsValid()) Object->TryGetStringField(Key, Out);
		return Out;
	};
	auto IsLeaseRefusal = [](const FString& Code)
	{
		return Code == TEXT("lease_conflict") || Code == TEXT("owner_required");
	};

	// ping names the mode, live (the T8 rollback path).
	auto Caps = [&R, &ObjectOf]() { return ObjectOf(DataOf(Send(*R, 0, FString(), TEXT("ping"), nullptr)), TEXT("capabilities")); };
	TestEqual(TEXT("ping names the mode"), StringOf(Caps(), TEXT("lease_enforcement")), FString(TEXT("enforced_for_writes")));
	bool bOwnerRequired = false;
	Caps()->TryGetBoolField(TEXT("owner_required"), bOwnerRequired);
	TestTrue(TEXT("ping advertises owner_required"), bOwnerRequired);
	Dev->LeaseEnforcement = EHaybaMCPLeaseEnforcement::Advisory;
	TestEqual(TEXT("switching to Advisory shows at once"), StringOf(Caps(), TEXT("lease_enforcement")), FString(TEXT("advisory")));
	Dev->LeaseEnforcement = EHaybaMCPLeaseEnforcement::EnforcedForWrites;

	// A holds global X; B is connected under its own name.
	const FString AGlobal = AcquireId(*R, ConnA, A,
		TEXT("{\"resources\":[\"global\"],\"bind_connection\":false,\"label\":\"two-owners\"}"));
	if (!TestFalse(TEXT("A holds global X"), AGlobal.IsEmpty())) return false;
	Send(*R, ConnB, B, TEXT("ping"), nullptr);

	const TSharedPtr<FJsonObject> BWrite = Send(*R, ConnB, B, TEXT("blueprint_add_node"), WriteParams(TEXT("BP_TwoOwnersA")));
	const TSharedPtr<FJsonObject> BLease = ObjectOf(BWrite, TEXT("lease"));
	TestEqual(TEXT("B's write is refused"), CodeOf(BWrite), FString(TEXT("lease_conflict")));
	TestEqual(TEXT("under enforced_for_writes"), StringOf(BLease, TEXT("enforcement")), FString(TEXT("enforced_for_writes")));
	TestEqual(TEXT("because A holds it"), StringOf(BLease, TEXT("reason")), FString(TEXT("held")));
	TestEqual(TEXT("names the holder"), StringOf(BLease, TEXT("holder_owner")), A);
	TestFalse(TEXT("never a handle in the detail"), BLease->HasField(TEXT("lease_id")) || BLease->HasField(TEXT("token")));
	TestEqual(TEXT("a held conflict is retryable"), StringOf(ObjectOf(BWrite, TEXT("advisory")), TEXT("state")), FString(TEXT("retryable_failure")));
	TestEqual(TEXT("nothing ran"), StringOf(ObjectOf(BWrite, TEXT("advisory")), TEXT("mutation_status")), FString(TEXT("not_started")));

	const TSharedPtr<FJsonObject> BRead = Send(*R, ConnB, B, TEXT("blueprint_inspect_graph"),
		Json(TEXT("{\"path\":\"/Game/__HaybaTest__/BP_TwoOwnersA\"}")));
	TestFalse(TEXT("B's read is never refused by the lease gate"), IsLeaseRefusal(CodeOf(BRead)));

	const TSharedPtr<FJsonObject> Anon = Send(*R, ConnC, FString(), TEXT("blueprint_add_node"), WriteParams(TEXT("BP_TwoOwnersA")));
	TestEqual(TEXT("an owner-less write is owner_required"), CodeOf(Anon), FString(TEXT("owner_required")));
	TestTrue(TEXT("it names A"), StringOf(Anon, TEXT("error")).Contains(A));
	TestTrue(TEXT("it counts exactly the two owners that are present"),
		StringOf(Anon, TEXT("error")).Contains(TEXT("while 2 other agents are connected")));
	TestEqual(TEXT("reason owner_missing"), StringOf(ObjectOf(Anon, TEXT("lease")), TEXT("reason")), FString(TEXT("owner_missing")));
	{
		// Membership, not position: other_owners is sorted, and nothing promises A is first.
		TSet<FString> Named;
		const TArray<TSharedPtr<FJsonValue>>* OthersJson = nullptr;
		const TSharedPtr<FJsonObject> AnonLease = ObjectOf(Anon, TEXT("lease"));
		if (AnonLease->TryGetArrayField(TEXT("other_owners"), OthersJson) && OthersJson)
		{
			for (const TSharedPtr<FJsonValue>& Value : *OthersJson) Named.Add(Value->AsString());
		}
		TestTrue(TEXT("other_owners holds A"), Named.Contains(A));
		TestTrue(TEXT("other_owners holds B"), Named.Contains(B));
		TestEqual(TEXT("other_owners holds nobody else"), Named.Num(), 2);
	}
	TestEqual(TEXT("input_rejected"), StringOf(ObjectOf(Anon, TEXT("advisory")), TEXT("state")), FString(TEXT("input_rejected")));

	const TSharedPtr<FJsonObject> AWrite = Send(*R, ConnA, A, TEXT("blueprint_add_node"), WriteParams(TEXT("BP_TwoOwnersA")));
	TestFalse(TEXT("A's own write passes the lease gate"), IsLeaseRefusal(CodeOf(AWrite)));

	const TSharedPtr<FJsonObject> Status = DataOf(Send(*R, ConnB, B, TEXT("lease_status"), nullptr));
	TestEqual(TEXT("lease_status names the mode"), StringOf(Status, TEXT("enforcement")), FString(TEXT("enforced_for_writes")));
	TArray<FString> Active;
	const TArray<TSharedPtr<FJsonValue>>* ActiveJson = nullptr;
	if (Status->TryGetArrayField(TEXT("active_owners"), ActiveJson) && ActiveJson)
	{
		for (const TSharedPtr<FJsonValue>& Value : *ActiveJson) Active.Add(Value->AsString());
	}
	TestTrue(TEXT("active_owners lists A and B"), Active.Contains(A) && Active.Contains(B));

	Send(*R, ConnA, A, TEXT("lease_release"), Json(TEXT("{\"all\":true}")));
	TestFalse(TEXT("after A releases, B's write is not refused"),
		IsLeaseRefusal(CodeOf(Send(*R, ConnB, B, TEXT("blueprint_add_node"), WriteParams(TEXT("BP_TwoOwnersA"))))));

	// R13: a lease taken during the PIE never deadlocks the PIE's owner.
	{
		HaybaMCPState::FPieState Forced;
		Forced.Kind = HaybaMCPState::EPieKind::Agent;
		Forced.Phase = HaybaMCPState::EPiePhase::Running;
		Forced.Owner = A;
		FHaybaMCPEditorState::FScopedPieOverride Pie(Forced);
		TestEqual(TEXT("lease_acquire is PIE-safe"),
			StringOf(DataOf(Send(*R, ConnB, B, TEXT("lease_acquire"),
				Json(TEXT("{\"resources\":[\"global\"],\"bind_connection\":false,\"label\":\"during-pie\"}")))), TEXT("status")),
			FString(TEXT("granted")));
		const FString Press = CodeOf(Send(*R, ConnA, A, TEXT("editor_pie_press_key"), Json(TEXT("{\"key\":\"SpaceBar\"}"))));
		TestFalse(TEXT("the PIE owner's drive command skips the lease gate"), IsLeaseRefusal(Press) || Press == TEXT("pie_active"));
		const FString Stop = CodeOf(Send(*R, ConnA, A, TEXT("editor_stop_pie"), nullptr));
		TestFalse(TEXT("the PIE owner's stop skips the lease gate"), IsLeaseRefusal(Stop) || Stop == TEXT("pie_active"));
		Send(*R, ConnB, B, TEXT("lease_release"), Json(TEXT("{\"all\":true}")));
	}

	// Slot 3 learns the new mode: another owner's asset build refuses a compile.
	{
		const FString Build = AcquireId(*R, ConnA, A,
			TEXT("{\"resources\":[\"asset:/Game/__HaybaTest__/BP_TwoOwnersBusy\"],\"bind_connection\":false,\"label\":\"build:t8\"}"));
		TestFalse(TEXT("A holds the build lease"), Build.IsEmpty());
		TestEqual(TEXT("B's compile of A's build is asset_busy under enforced_for_writes"),
			CodeOf(Send(*R, ConnB, B, TEXT("blueprint_compile"),
				Json(TEXT("{\"path\":\"/Game/__HaybaTest__/BP_TwoOwnersBusy\",\"save\":false}")))),
			FString(TEXT("asset_busy")));
		Send(*R, ConnA, A, TEXT("lease_release"), Json(TEXT("{\"all\":true}")));
	}
	return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
