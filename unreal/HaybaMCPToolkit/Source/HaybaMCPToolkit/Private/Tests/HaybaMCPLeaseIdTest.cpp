// Lease ids (docs/adr/0010, "Lease ids"). The handle a client sends back must
// survive both redaction layers byte for byte, never reveal the session salt,
// and never be derivable from another holder's id. T4 (postmortem I-5).
#include "Misc/AutomationTest.h"

#if WITH_DEV_AUTOMATION_TESTS

#include "HaybaMCPLeasePolicy.h"
#include "HaybaMCPLeaseManager.h"
#include "HaybaMCPSecretRedaction.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Misc/SecureHash.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

namespace HaybaLeaseIdTest
{
	HaybaMCPLease::FRequest Request(FAutomationTestBase& Test, const FString& Owner, const FString& Resource)
	{
		HaybaMCPLease::FRequest R;
		R.Owner = Owner;
		HaybaMCPAccess::FClaim Claim;
		Claim.bExclusive = true;
		FString Error;
		Test.TestTrue(*FString::Printf(TEXT("'%s' parses"), *Resource),
			HaybaMCPAccess::ParseResource(Resource, Claim.Resource, Error));
		R.Claims.Add(Claim);
		return R;
	}

	FString Serialize(const TSharedPtr<FJsonObject>& Object)
	{
		FString Out;
		const TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
			TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Out);
		FJsonSerializer::Serialize(Object.ToSharedRef(), Writer);
		return Out;
	}

	TSharedPtr<FJsonObject> Parse(const FString& Text)
	{
		TSharedPtr<FJsonObject> Out;
		const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Text);
		FJsonSerializer::Deserialize(Reader, Out);
		return Out.IsValid() ? Out : MakeShared<FJsonObject>();
	}

	/** <Prefix>_<digits>_<12 lower hex>. */
	bool IsWellFormed(const FString& Id, const TCHAR* Prefix)
	{
		TArray<FString> Parts;
		Id.ParseIntoArray(Parts, TEXT("_"), /*InCullEmpty=*/false);
		if (Parts.Num() != 3 || Parts[0] != Prefix || Parts[1].IsEmpty() || !Parts[1].IsNumeric() || Parts[2].Len() != 12)
		{
			return false;
		}
		for (const TCHAR C : Parts[2])
		{
			if (!FChar::IsDigit(C) && !(C >= TEXT('a') && C <= TEXT('f')))
			{
				return false;
			}
		}
		return true;
	}

	/**
	 * Every reply shape the lease code emits with an id in it, as the router
	 * serializes it (spec §4.3). The texts are copies of the handler's, so a
	 * reworded hint that grows a `token:` shows up here too.
	 */
	TArray<TSharedPtr<FJsonObject>> EmittedShapes(const FString& LeaseId, const FString& Ticket)
	{
		TArray<TSharedPtr<FJsonObject>> Out;
		Out.Add(Parse(FString::Printf(TEXT(R"({"id":"t1","ok":true,"data":{"owner":"owner-a","lane":"interactive","status":"granted","lease_id":"%s","expires_in_s":120,"bound_to_connection":true,"resources":[{"resource":"asset:/game/__haybatest__/id0","mode":"exclusive"}],"next":"Send this lease_id as the envelope 'lease' field (or keep the same owner), renew with lease_renew {lease_id} before it lapses, and lease_release {lease_id} when done. It is bound to this connection and ends when the connection closes; the editor drops a connection idle for 5 s, so a client that opens one connection per call should pass bind_connection:false or keep one socket open."}})"), *LeaseId)));
		Out.Add(Parse(FString::Printf(TEXT(R"({"id":"t2","ok":true,"data":{"owner":"owner-b","lane":"interactive","status":"queued","ticket":"%s","position":1,"holder_owner":"owner-a","eta_s":120,"conflict":"asset:/game/__haybatest__/id0","poll_after_s":10,"ticket_ttl_s":30,"next":"Not granted yet; nothing is blocked. Call lease_acquire again with this ticket (same resources not required) within ticket_ttl_s, or the place in the queue is dropped."}})"), *Ticket)));
		Out.Add(Parse(FString::Printf(TEXT(R"({"id":"t3","ok":true,"data":{"lease_id":"%s","renewed":true,"expires_in_s":120,"deprecation":"'token' was renamed to lease_id; send lease_id"}})"), *LeaseId)));
		Out.Add(Parse(FString::Printf(TEXT(R"({"id":"t4","ok":true,"data":{"lease_id":"%s","released":true,"deprecation":"'token' was renamed to lease_id; send lease_id"}})"), *LeaseId)));
		Out.Add(Parse(FString::Printf(TEXT(R"({"id":"t5","ok":true,"data":{"ticket":"%s","released":true}})"), *Ticket)));
		Out.Add(Parse(FString::Printf(TEXT(R"({"id":"t6","ok":true,"data":{"enforcement":"advisory","caller_owner":"owner-a","current_world":"/Game/Maps/Valley","lease_count":1,"waiter_count":1,"leases":[{"owner":"owner-a","mine":true,"lease_id":"%s","label":"editor_gate:owner-a","resources":[{"resource":"global","mode":"exclusive"}],"lane":"long","held_s":3,"expires_in_s":117,"bound_to_connection":false}],"waiters":[{"owner":"owner-a","ticket":"%s","resources":[],"lane":"interactive","waited_s":1,"bypassed":0,"aged":false}]}})"), *LeaseId, *Ticket)));
		Out.Add(Parse(TEXT(R"({"id":"t7","ok":true,"data":{},"lease_warning":{"enforcement":"advisory","command":"level_save","access_class":"write_world","caller_owner":"owner-a","lease_id_error":"unknown_or_expired","hint":"Call lease_acquire for the resources this command needs; it answers granted or queued (with position and ETA) and never blocks. lease_status shows every holder."}})")));
		Out.Add(Parse(TEXT(R"({"id":"t8","ok":false,"error":"lease_conflict: 'level_save': the envelope's lease is a redaction marker, not a lease_id; run lease_acquire again and send the lease_id it returns","code":"lease_conflict","lease":{"enforcement":"enforced","command":"level_save","access_class":"write_world","caller_owner":"owner-a","lease_id_error":"redaction_marker","hint":"Call lease_acquire for the resources this command needs; it answers granted or queued (with position and ETA) and never blocks. lease_status shows every holder."}})")));
		return Out;
	}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPLeaseIdFormatTest,
	"Hayba.MCP.Lease.IdFormat",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPLeaseIdFormatTest::RunTest(const FString& Parameters)
{
	namespace LIT = HaybaLeaseIdTest;
	using namespace HaybaMCPLease;
	double Now = 1000.0;

	{
		FTable Unsalted([&Now]() { return Now; });
		const FAcquireResult A = Unsalted.Acquire(LIT::Request(*this, TEXT("a"), TEXT("world:/Game/V")));
		const FAcquireResult B = Unsalted.Acquire(LIT::Request(*this, TEXT("b"), TEXT("world:/Game/V")));
		TestEqual(TEXT("empty salt (pure tests): a lease is ls_<seq>"), A.Token, FString(TEXT("ls_1")));
		TestEqual(TEXT("empty salt: a queued ticket is lq_<seq>"), B.Token, FString(TEXT("lq_2")));
	}

	// Known answers: HMAC-SHA1(key = salt, "<prefix>:<seq>"), first 12 lower hex.
	const FString Salt = TEXT("0123456789abcdef0123456789abcdef");
	FTable Table([&Now]() { return Now; }, FTuning(), Salt);
	const FAcquireResult A = Table.Acquire(LIT::Request(*this, TEXT("a"), TEXT("world:/Game/V")));
	const FAcquireResult B = Table.Acquire(LIT::Request(*this, TEXT("b"), TEXT("world:/Game/V")));
	const FAcquireResult C = Table.Acquire(LIT::Request(*this, TEXT("c"), TEXT("world:/Game/Other")));
	TestEqual(TEXT("A is granted"), A.Status, EStatus::Granted);
	TestEqual(TEXT("B queues behind A"), B.Status, EStatus::Queued);
	TestEqual(TEXT("C is granted"), C.Status, EStatus::Granted);
	TestEqual(TEXT("A = ls_1_<HMAC(salt, \"ls:1\")>"), A.Token, FString(TEXT("ls_1_aad6bc3c3546")));
	TestEqual(TEXT("B = lq_2_<HMAC(salt, \"lq:2\")>"), B.Token, FString(TEXT("lq_2_b4086670970d")));
	TestEqual(TEXT("C = ls_3_<HMAC(salt, \"ls:3\")>"), C.Token, FString(TEXT("ls_3_3bdaaae185a4")));

	const FString Allowed = TEXT("abcdefghijklmnopqrstuvwxyz0123456789_");
	for (const FString& Id : { A.Token, B.Token, C.Token })
	{
		TestFalse(*FString::Printf(TEXT("%s never contains the salt"), *Id), Id.Contains(Salt));
		bool bOnlyAllowed = true;
		for (const TCHAR Ch : Id)
		{
			int32 Index = INDEX_NONE;
			bOnlyAllowed &= Allowed.FindChar(Ch, Index);
		}
		TestTrue(*FString::Printf(TEXT("%s uses only [a-z0-9_]"), *Id), bOnlyAllowed);
	}
	TestTrue(TEXT("lease ids are ls_<seq>_<mac12>"), LIT::IsWellFormed(A.Token, TEXT("ls")) && LIT::IsWellFormed(C.Token, TEXT("ls")));
	TestTrue(TEXT("tickets are lq_<seq>_<mac12>"), LIT::IsWellFormed(B.Token, TEXT("lq")));

	FTable Other([&Now]() { return Now; }, FTuning(), TEXT("fedcba9876543210fedcba9876543210"));
	const FAcquireResult OtherA = Other.Acquire(LIT::Request(*this, TEXT("a"), TEXT("world:/Game/V")));
	TestEqual(TEXT("another session's salt gives another mac for the same seq"), OtherA.Token, FString(TEXT("ls_1_6af2db44d00b")));
	TestTrue(TEXT("an id resolves in its own table"), Table.FindLease(A.Token) != nullptr);
	TestNull(TEXT("an id of one session names nothing in another"), Other.FindLease(A.Token));

	// The live manager is salted: its ids carry a mac.
	FHaybaMCPLeaseManager& Manager = FHaybaMCPLeaseManager::Get();
	const FString Owner = TEXT("hayba-test-") + FGuid::NewGuid().ToString(EGuidFormats::Digits).Left(8).ToLower();
	const FAcquireResult Live = Manager.Table().Acquire(LIT::Request(*this, Owner,
		FString::Printf(TEXT("asset:/Game/__HaybaTest__/IdFormat_%s"), *Owner.Right(8))));
	TestTrue(TEXT("the manager's salt is set: live ids are ls_<seq>_<mac12>"), LIT::IsWellFormed(Live.Token, TEXT("ls")));
	FString Error;
	Manager.Table().Release(Live.Token, Owner, Error);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPLeaseIdParamTest,
	"Hayba.MCP.Lease.IdParam",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPLeaseIdParamTest::RunTest(const FString& Parameters)
{
	using namespace HaybaMCPLease;
	const FString Id = TEXT("ls_1_aad6bc3c3546");
	const FString OtherId = TEXT("ls_2_b30995e71074");
	const FString Marker = TEXT("[REDACTED:token]");

	auto Expect = [this](const TCHAR* What, const FIdParam& Got, EIdParam Kind, const FString& Value, bool bFromAlias)
	{
		TestEqual(*FString::Printf(TEXT("%s: kind"), What), Got.Kind, Kind);
		TestEqual(*FString::Printf(TEXT("%s: value"), What), Got.Value, Value);
		TestEqual(*FString::Printf(TEXT("%s: from alias"), What), Got.bFromAlias, bFromAlias);
	};
	Expect(TEXT("neither"), ResolveIdParam(FString(), FString()), EIdParam::None, FString(), false);
	Expect(TEXT("canonical only"), ResolveIdParam(Id, FString()), EIdParam::Value, Id, false);
	Expect(TEXT("alias fills an empty canonical"), ResolveIdParam(FString(), Id), EIdParam::Value, Id, true);
	Expect(TEXT("the same value twice is not ambiguous"), ResolveIdParam(Id, Id), EIdParam::Value, Id, false);
	Expect(TEXT("two different values"), ResolveIdParam(Id, OtherId), EIdParam::Ambiguous, FString(), false);
	Expect(TEXT("a marker under the canonical param"), ResolveIdParam(Marker, FString()), EIdParam::RedactionMarker, Marker, false);
	Expect(TEXT("a marker under the alias"), ResolveIdParam(FString(), Marker), EIdParam::RedactionMarker, Marker, true);
	Expect(TEXT("whitespace is trimmed"), ResolveIdParam(TEXT("  ls_1_aad6bc3c3546  "), FString()), EIdParam::Value, Id, false);

	TestTrue(TEXT("[REDACTED:token] is a marker"), IsRedactionMarker(Marker));
	TestTrue(TEXT("any [REDACTED:<category>] is a marker"), IsRedactionMarker(TEXT("[REDACTED:credential]")));
	TestFalse(TEXT("a lease id is not a marker"), IsRedactionMarker(Id));
	TestFalse(TEXT("empty is not a marker"), IsRedactionMarker(FString()));
	TestFalse(TEXT("the word alone is not a marker"), IsRedactionMarker(TEXT("REDACTED")));

	// R-9: once per key, and the set is capped.
	FOncePerKey Notes(512);
	TestTrue(TEXT("first sight of a key"), Notes.First(TEXT("lease_renew|token|conn:*")));
	TestFalse(TEXT("a repeat is not first"), Notes.First(TEXT("lease_renew|token|conn:*")));
	for (int32 I = 0; I < 600; ++I)
	{
		Notes.First(FString::Printf(TEXT("lease_renew|token|owner-%d"), I));
	}
	TestEqual(TEXT("the set is capped at 512 keys"), Notes.Num(), 512);
	TestFalse(TEXT("a full set reports nothing new"), Notes.First(TEXT("lease_release|token|late-owner")));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPLeaseIdSurvivesRedactionTest,
	"Hayba.MCP.Lease.IdSurvivesRedaction",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPLeaseIdSurvivesRedactionTest::RunTest(const FString& Parameters)
{
	namespace LIT = HaybaLeaseIdTest;
	using namespace HaybaMCPLease;

	TArray<FRequest> Grants;
	for (int32 I = 0; I < 4; ++I)
	{
		Grants.Add(LIT::Request(*this, TEXT("owner-a"), FString::Printf(TEXT("asset:/Game/__HaybaTest__/Id%d"), I)));
	}
	const FRequest Blocked = LIT::Request(*this, TEXT("owner-b"), TEXT("asset:/Game/__HaybaTest__/Id0"));

	int32 Checked = 0;
	int32 Changed = 0;
	for (int32 SaltIndex = 0; SaltIndex < 256; ++SaltIndex)
	{
		const FString Salt = FMD5::HashAnsiString(*FString::Printf(TEXT("hayba-lease-salt-%d"), SaltIndex));
		double Now = 1000.0;
		FTable Table([&Now]() { return Now; }, FTuning(), Salt);
		TArray<FString> LeaseIds;
		for (const FRequest& Grant : Grants)
		{
			LeaseIds.Add(Table.Acquire(Grant).Token);
		}
		const FString Ticket = Table.Acquire(Blocked).Token;
		if (!TestTrue(TEXT("the fifth request queues as lq_5_<mac12>"), LIT::IsWellFormed(Ticket, TEXT("lq"))))
		{
			return false;
		}
		for (const FString& LeaseId : LeaseIds)
		{
			if (!TestTrue(*FString::Printf(TEXT("%s is ls_<seq>_<mac12>"), *LeaseId), LIT::IsWellFormed(LeaseId, TEXT("ls"))))
			{
				return false;
			}
			for (const TSharedPtr<FJsonObject>& Shape : LIT::EmittedShapes(LeaseId, Ticket))
			{
				++Checked;
				const FString Before = LIT::Serialize(Shape);
				const TSharedPtr<FJsonObject> After = HaybaMCPSecretRedaction::RedactFinalEnvelope(Shape);
				if (LIT::Serialize(After) != Before || After->HasField(TEXT("_meta")))
				{
					if (Changed++ == 0)
					{
						AddError(FString::Printf(TEXT("RedactFinalEnvelope changed %s into %s"), *Before, *LIT::Serialize(After)));
					}
				}
			}
		}
	}
	TestEqual(TEXT("every emitted shape passed RedactFinalEnvelope byte for byte, with no _meta"), Changed, 0);
	TestEqual(TEXT("256 salts x 4 ids x 8 shapes were checked"), Checked, 256 * 4 * 8);

	// Negative control: the redactor still erases the old key.
	const TSharedPtr<FJsonObject> Old = LIT::Parse(TEXT(R"({"id":"t9","ok":true,"data":{"token":"ls_1_aad6bc3c3546"}})"));
	const TSharedPtr<FJsonObject> Redacted = HaybaMCPSecretRedaction::RedactFinalEnvelope(Old);
	TestFalse(TEXT("negative control: a value under 'token' is still erased"),
		LIT::Serialize(Redacted).Contains(TEXT("ls_1_aad6bc3c3546")));
	TestTrue(TEXT("negative control: the redaction is reported in _meta"), Redacted->HasField(TEXT("_meta")));
	return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
