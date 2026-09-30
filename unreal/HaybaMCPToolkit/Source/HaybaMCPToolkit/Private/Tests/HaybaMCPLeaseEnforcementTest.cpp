// Hayba.MCP.Lease.* enforcement tests (T6 creates the pure cases; T6.2 the
// log case; T8 the router cases). See docs/adr/0010.
#include "Misc/AutomationTest.h"
#include "HaybaMCPEnforcementPolicy.h"

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

#endif // WITH_DEV_AUTOMATION_TESTS
