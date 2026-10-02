// Lease ids (docs/adr/0010, "Lease ids"). The handle a client sends back must
// survive both redaction layers byte for byte, never reveal the session salt,
// and never be derivable from another holder's id.
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
#include "HaybaMCPCommandHandler.h"
#include "HaybaMCPModule.h"
#include "HaybaMCPSettings.h"
#include "HaybaMCPDeveloperSettings.h"
#include "Modules/ModuleManager.h"
#include "Misc/ScopeExit.h"
#include "Tests/HaybaMCPLatentTest.h"

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

namespace HaybaLeaseWireTest
{
	constexpr int32 TestConnId = 900401;

	FString UniqueOwner()
	{
		return TEXT("hayba-test-") + FGuid::NewGuid().ToString(EGuidFormats::Digits).Left(8).ToLower();
	}

	TSharedPtr<FHaybaMCPCommandHandler> Router(FAutomationTestBase& Test)
	{
		FHaybaMCPModule* Module = FModuleManager::GetModulePtr<FHaybaMCPModule>(TEXT("HaybaMCPToolkit"));
		if (!Test.TestNotNull(TEXT("toolkit module is loaded"), Module))
		{
			return nullptr;
		}
		const TSharedPtr<FHaybaMCPCommandHandler> Handler = Module->GetCommandHandler();
		Test.TestTrue(TEXT("command router exists"), Handler.IsValid());
		return Handler;
	}

	/** One request through ProcessCommand, so the reply really passes
	 *  JsonToString -> RedactFinalEnvelope. */
	TSharedPtr<FJsonObject> Send(FHaybaMCPCommandHandler& Router, const FString& Owner, const FString& Cmd,
		const FString& ParamsJson, const FString& EnvelopeLease = FString(), FString* OutRaw = nullptr)
	{
		TSharedPtr<FJsonObject> Envelope = MakeShared<FJsonObject>();
		Envelope->SetStringField(TEXT("cmd"), Cmd);
		Envelope->SetStringField(TEXT("id"), TEXT("lease-wire-") + FGuid::NewGuid().ToString(EGuidFormats::Digits).Left(8));
		Envelope->SetObjectField(TEXT("params"), HaybaLeaseIdTest::Parse(ParamsJson));
		if (!Owner.IsEmpty()) Envelope->SetStringField(TEXT("owner"), Owner);
		if (!EnvelopeLease.IsEmpty()) Envelope->SetStringField(TEXT("lease"), EnvelopeLease);
		const FString& Auth = FHaybaMCPSettings::Get().CapabilityToken;
		if (!Auth.IsEmpty()) Envelope->SetStringField(TEXT("auth"), Auth);
		const FString Raw = Router.ProcessCommand(HaybaLeaseIdTest::Serialize(Envelope), TestConnId);
		if (OutRaw) *OutRaw = Raw;
		return HaybaLeaseIdTest::Parse(Raw);
	}

	TSharedPtr<FJsonObject> Field(const TSharedPtr<FJsonObject>& Object, const TCHAR* Name)
	{
		const TSharedPtr<FJsonObject>* Out = nullptr;
		return Object.IsValid() && Object->TryGetObjectField(Name, Out) && Out && Out->IsValid()
			? *Out : MakeShared<FJsonObject>();
	}

	FString Str(const TSharedPtr<FJsonObject>& Object, const TCHAR* Name)
	{
		FString Value;
		if (Object.IsValid()) Object->TryGetStringField(Name, Value);
		return Value;
	}

	bool Bool(const TSharedPtr<FJsonObject>& Object, const TCHAR* Name)
	{
		bool bValue = false;
		if (Object.IsValid()) Object->TryGetBoolField(Name, bValue);
		return bValue;
	}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPLeaseWireRoundTripTest,
	"Hayba.MCP.Lease.WireRoundTrip",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPLeaseWireRoundTripTest::RunTest(const FString& Parameters)
{
	namespace LIT = HaybaLeaseIdTest;
	namespace W = HaybaLeaseWireTest;
	const TSharedPtr<FHaybaMCPCommandHandler> R = W::Router(*this);
	if (!R.IsValid()) return false;

	UHaybaMCPDeveloperSettings* Dev = GetMutableDefault<UHaybaMCPDeveloperSettings>();
	const EHaybaMCPLeaseEnforcement WasMode = Dev->LeaseEnforcement;
	FHaybaMCPSettings& Settings = FHaybaMCPSettings::Get();
	const bool bWasPlanMode = Settings.bPlanModeEnabled;
	Dev->LeaseEnforcement = EHaybaMCPLeaseEnforcement::Advisory;   // the gate detail rides on lease_warning
	Settings.bPlanModeEnabled = false;
	const FString Owner = W::UniqueOwner();
	FString LeaseId;
	FString BoundId;
	ON_SCOPE_EXIT
	{
		Dev->LeaseEnforcement = WasMode;
		FHaybaMCPSettings::Get().bPlanModeEnabled = bWasPlanMode;
		FString Ignored;
		FHaybaMCPLeaseManager::Get().Table().Release(LeaseId, Owner, Ignored);
		FHaybaMCPLeaseManager::Get().Table().Release(BoundId, Owner, Ignored);
		FHaybaMCPLeaseManager::Get().ForgetOwnerForTests(Owner);
		R->NotifyConnectionClosed(W::TestConnId);
	};
	// One deprecation line for this owner, however often it sends `token` (R-9).
	AddExpectedMessagePlain(
		FString::Printf(TEXT("lease_renew: deprecated param 'token' from owner '%s'; send lease_id"), *Owner),
		ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, 1);
	// The two gate probes below run under Advisory, which logs each problem once.
	AddExpectedMessagePlain(
		TEXT("[advisory] lease_conflict: 'ping': the envelope's lease is a redaction marker, not a lease_id"),
		ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, 1);
	AddExpectedMessagePlain(
		TEXT("[advisory] lease_conflict: 'ping': the envelope's lease_id is unknown or expired"),
		ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, 1);

	TArray<FString> RawReplies;
	auto Call = [&](const FString& Cmd, const FString& ParamsJson, const FString& EnvelopeLease = FString())
	{
		FString Raw;
		const TSharedPtr<FJsonObject> Reply = W::Send(*R, Owner, Cmd, ParamsJson, EnvelopeLease, &Raw);
		RawReplies.Add(Raw);
		return Reply;
	};
	auto ExpectRefused = [&](const TCHAR* What, const TSharedPtr<FJsonObject>& Reply, const TCHAR* Code)
	{
		TestFalse(*FString::Printf(TEXT("%s: refused"), What), W::Bool(Reply, TEXT("ok")));
		const FString Error = W::Str(Reply, TEXT("error"));
		TestTrue(*FString::Printf(TEXT("%s: %s in '%s'"), What, Code, *Error), Error.Contains(Code));
		TestFalse(*FString::Printf(TEXT("%s: no refusal text contains token"), What), Error.Contains(TEXT("token")));
	};

	// The host handshake.
	TestTrue(TEXT("ping: capabilities.lease_id"),
		W::Bool(W::Field(W::Field(Call(TEXT("ping"), TEXT("{}")), TEXT("data")), TEXT("capabilities")), TEXT("lease_id")));

	// acquire: lease_id, never token.
	const FString Asset = FString::Printf(TEXT("asset:/Game/__HaybaTest__/LeaseWire_%s"), *Owner.Right(8));
	const TSharedPtr<FJsonObject> Acquired = W::Field(Call(TEXT("lease_acquire"),
		FString::Printf(TEXT(R"({"resources":["%s"],"bind_connection":false,"ttl_s":60})"), *Asset)), TEXT("data"));
	LeaseId = W::Str(Acquired, TEXT("lease_id"));
	TestEqual(TEXT("acquire: granted"), W::Str(Acquired, TEXT("status")), FString(TEXT("granted")));
	TestTrue(TEXT("acquire: lease_id is ls_<seq>_<mac12>"), LIT::IsWellFormed(LeaseId, TEXT("ls")));
	TestFalse(TEXT("acquire: no token field"), Acquired->HasField(TEXT("token")));
	TestTrue(TEXT("acquire (unbound): next gives per-call guidance"), W::Str(Acquired, TEXT("next")).Contains(TEXT("bind_connection:false")));

	// A bound lease tells per-call raw clients how not to lose it (R-9).
	const TSharedPtr<FJsonObject> Bound = W::Field(Call(TEXT("lease_acquire"),
		FString::Printf(TEXT(R"({"resources":["%s_bound"],"ttl_s":60})"), *Asset)), TEXT("data"));
	BoundId = W::Str(Bound, TEXT("lease_id"));
	TestTrue(TEXT("acquire (bound): next tells per-call clients to pass bind_connection:false"),
		W::Str(Bound, TEXT("next")).Contains(TEXT("bind_connection:false")));

	// renew by lease_id.
	const TSharedPtr<FJsonObject> Renewed = Call(TEXT("lease_renew"), FString::Printf(TEXT(R"({"lease_id":"%s","ttl_s":60})"), *LeaseId));
	TestTrue(TEXT("renew by lease_id: ok"), W::Bool(Renewed, TEXT("ok")));
	TestEqual(TEXT("renew by lease_id: echoes lease_id"), W::Str(W::Field(Renewed, TEXT("data")), TEXT("lease_id")), LeaseId);
	TestFalse(TEXT("renew by lease_id: no deprecation"), W::Field(Renewed, TEXT("data"))->HasField(TEXT("deprecation")));

	// renew by the deprecated alias, twice: both work, both say so, one log line.
	for (int32 Attempt = 0; Attempt < 2; ++Attempt)
	{
		const TSharedPtr<FJsonObject> ByAlias = Call(TEXT("lease_renew"), FString::Printf(TEXT(R"({"token":"%s"})"), *LeaseId));
		const TSharedPtr<FJsonObject> Data = W::Field(ByAlias, TEXT("data"));
		TestTrue(TEXT("renew by token: ok"), W::Bool(ByAlias, TEXT("ok")));
		TestEqual(TEXT("renew by token: replies lease_id"), W::Str(Data, TEXT("lease_id")), LeaseId);
		TestEqual(TEXT("renew by token: deprecation"), W::Str(Data, TEXT("deprecation")), FString(TEXT("'token' was renamed to lease_id; send lease_id")));
		TestFalse(TEXT("renew by token: never echoes token"), Data->HasField(TEXT("token")));
	}

	ExpectRefused(TEXT("renew with two different ids"),
		Call(TEXT("lease_renew"), FString::Printf(TEXT(R"({"lease_id":"%s","token":"ls_999999_000000000000"})"), *LeaseId)),
		TEXT("[lease_id_ambiguous]"));
	ExpectRefused(TEXT("renew with a marker under lease_id"),
		Call(TEXT("lease_renew"), TEXT(R"({"lease_id":"[REDACTED:token]"})")), TEXT("[lease_id_redacted]"));
	// T7 (R6): no id renews every lease the caller holds.
	const TSharedPtr<FJsonObject> ByOwner = Call(TEXT("lease_renew"), TEXT("{}"));
	TestTrue(TEXT("renew with no id renews by owner"), W::Bool(ByOwner, TEXT("ok")));
	TestTrue(TEXT("renew by owner renewed the caller's leases"),
		W::Field(ByOwner, TEXT("data"))->GetNumberField(TEXT("renewed")) >= 1.0);

	// status: the owner sees its lease_id, nobody sees a token.
	bool bListed = false;
	const TArray<TSharedPtr<FJsonValue>>* Leases = nullptr;
	// Hold the reply: Leases points into it.
	const TSharedPtr<FJsonObject> StatusData = W::Field(Call(TEXT("lease_status"), TEXT("{}")), TEXT("data"));
	if (StatusData->TryGetArrayField(TEXT("leases"), Leases) && Leases)
	{
		for (const TSharedPtr<FJsonValue>& Value : *Leases)
		{
			const TSharedPtr<FJsonObject> Entry = Value->AsObject();
			TestFalse(TEXT("status: no entry has a token field"), Entry->HasField(TEXT("token")));
			bListed |= W::Str(Entry, TEXT("lease_id")) == LeaseId;
		}
	}
	TestTrue(TEXT("status: the caller's lease is listed by lease_id"), bListed);

	// status as another owner: it sees that the leases exist, never their ids.
	// Coordination ids remain private to the owning caller; a foreign
	// envelope lease never changes the owner-first identity (T9).
	const FString Other = W::UniqueOwner();
	ON_SCOPE_EXIT { FHaybaMCPLeaseManager::Get().ForgetOwnerForTests(Other); };
	FString OtherRaw;
	int32 SeenOfOwner = 0;
	const TArray<TSharedPtr<FJsonValue>>* OtherLeases = nullptr;
	const TSharedPtr<FJsonObject> OtherData = W::Field(W::Send(*R, Other, TEXT("lease_status"), TEXT("{}"), FString(), &OtherRaw), TEXT("data"));
	if (OtherData->TryGetArrayField(TEXT("leases"), OtherLeases) && OtherLeases)
	{
		for (const TSharedPtr<FJsonValue>& Value : *OtherLeases)
		{
			const TSharedPtr<FJsonObject> Entry = Value->AsObject();
			if (W::Str(Entry, TEXT("owner")) != Owner) continue;
			++SeenOfOwner;
			TestFalse(TEXT("status as another owner: mine is false"), W::Bool(Entry, TEXT("mine")));
			TestFalse(TEXT("status as another owner: no lease_id field"), Entry->HasField(TEXT("lease_id")));
			TestFalse(TEXT("status as another owner: no token field"), Entry->HasField(TEXT("token")));
		}
	}
	TestEqual(TEXT("status as another owner: both of the holder's leases are listed"), SeenOfOwner, 2);
	TestFalse(TEXT("status as another owner: the reply holds neither id anywhere"),
		OtherRaw.Contains(LeaseId) || OtherRaw.Contains(BoundId));
	RawReplies.Add(OtherRaw);

	// The gate: a marker, and an unknown id, in the envelope.
	TestEqual(TEXT("gate: an envelope marker gives lease_id_error redaction_marker"),
		W::Str(W::Field(Call(TEXT("ping"), TEXT("{}"), TEXT("[REDACTED:token]")), TEXT("lease_warning")), TEXT("lease_id_error")),
		FString(TEXT("redaction_marker")));
	TestEqual(TEXT("gate: an unknown envelope lease_id gives lease_id_error unknown_or_expired"),
		W::Str(W::Field(Call(TEXT("ping"), TEXT("{}"), TEXT("ls_999999_000000000000")), TEXT("lease_warning")), TEXT("lease_id_error")),
		FString(TEXT("unknown_or_expired")));

	// release, then release again.
	const TSharedPtr<FJsonObject> Released = Call(TEXT("lease_release"), FString::Printf(TEXT(R"({"lease_id":"%s"})"), *LeaseId));
	TestTrue(TEXT("release: ok"), W::Bool(Released, TEXT("ok")));
	TestEqual(TEXT("release: echoes lease_id"), W::Str(W::Field(Released, TEXT("data")), TEXT("lease_id")), LeaseId);
	TestTrue(TEXT("release: released"), W::Bool(W::Field(Released, TEXT("data")), TEXT("released")));
	ExpectRefused(TEXT("second release"),
		Call(TEXT("lease_release"), FString::Printf(TEXT(R"({"lease_id":"%s"})"), *LeaseId)), TEXT("[lease_id_unknown]"));
	ExpectRefused(TEXT("release with nothing named"), Call(TEXT("lease_release"), TEXT("{}")), TEXT("[bad_request]"));
	ExpectRefused(TEXT("release with a lease_id and a ticket"),
		Call(TEXT("lease_release"), FString::Printf(TEXT(R"({"lease_id":"%s","ticket":"lq_1_000000000000"})"), *BoundId)),
		TEXT("[bad_request]"));

	// No reply was secret-shaped, so nothing was redacted.
	for (const FString& Raw : RawReplies)
	{
		TestFalse(TEXT("no reply has a token key"), Raw.Contains(TEXT("\"token\":")));
		TestFalse(TEXT("no reply was redacted"), Raw.Contains(TEXT("hayba/security_redaction")));
	}
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPBatchWireRoundTripTest,
	"Hayba.MCP.Batch.WireRoundTrip",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPBatchWireRoundTripTest::RunTest(const FString& Parameters)
{
	namespace LIT = HaybaLeaseIdTest;
	namespace W = HaybaLeaseWireTest;
	const TSharedPtr<FHaybaMCPCommandHandler> R = W::Router(*this);
	if (!R.IsValid()) return false;

	struct FState
	{
		FString Owner;
		FString LeaseId;
		FString JobId;
		FString Status;
		bool bPlanModeWas = true;
	};
	const TSharedRef<FState> S = MakeShared<FState>();
	S->Owner = W::UniqueOwner();
	S->bPlanModeWas = FHaybaMCPSettings::Get().bPlanModeEnabled;
	FHaybaMCPSettings::Get().bPlanModeEnabled = false;   // editor_batch is plan-gated; the last latent command restores it
	const auto Cleanup = [S]()
	{
		FString Ignored;
		FHaybaMCPLeaseManager::Get().Table().Release(S->LeaseId, S->Owner, Ignored);
		FHaybaMCPSettings::Get().bPlanModeEnabled = S->bPlanModeWas;
	};

	S->LeaseId = W::Str(W::Field(W::Send(*R, S->Owner, TEXT("lease_acquire"),
		FString::Printf(TEXT(R"({"resources":["asset:/Game/__HaybaTest__/BatchWire_%s"],"bind_connection":false,"ttl_s":60})"),
			*S->Owner.Right(8))), TEXT("data")), TEXT("lease_id"));
	if (!TestTrue(TEXT("the batch's lease is granted with a lease_id"), LIT::IsWellFormed(S->LeaseId, TEXT("ls"))))
	{
		Cleanup();
		return false;
	}

	// A marker is refused only where the command's own lease_id param holds
	// it; in the envelope it counts as absent (R5).
	{
		UHaybaMCPDeveloperSettings* Dev = GetMutableDefault<UHaybaMCPDeveloperSettings>();
		const EHaybaMCPLeaseEnforcement WasMode = Dev->LeaseEnforcement;
		Dev->LeaseEnforcement = EHaybaMCPLeaseEnforcement::Advisory;   // the envelope marker reaches the handler
		ON_SCOPE_EXIT { Dev->LeaseEnforcement = WasMode; };
		AddExpectedMessagePlain(
			TEXT("[advisory] lease_conflict: 'editor_batch': the envelope's lease is a redaction marker, not a lease_id"),
			ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, 1);
		const TCHAR* const Steps = TEXT(R"("steps":[{"cmd":"ping","fence_after":"none"}])");
		auto ExpectRefused = [this](const TCHAR* What, const TSharedPtr<FJsonObject>& Reply, const TCHAR* Code)
		{
			TestFalse(*FString::Printf(TEXT("%s: refused"), What), W::Bool(Reply, TEXT("ok")));
			const FString Error = W::Str(Reply, TEXT("error"));
			TestTrue(*FString::Printf(TEXT("%s: %s in '%s'"), What, Code, *Error), Error.Contains(Code));
			TestFalse(*FString::Printf(TEXT("%s: no refusal text contains token"), What), Error.Contains(TEXT("token")));
		};
		ExpectRefused(TEXT("editor_batch with only an envelope marker answers as if no lease were sent"),
			W::Send(*R, S->Owner, TEXT("editor_batch"), FString::Printf(TEXT("{%s}"), Steps), TEXT("[REDACTED:token]")),
			TEXT("[lease_id_required]"));
		ExpectRefused(TEXT("editor_batch with a marker in its lease_id param"),
			W::Send(*R, S->Owner, TEXT("editor_batch"), FString::Printf(TEXT(R"({"lease_id":"[REDACTED:token]",%s})"), Steps)),
			TEXT("[lease_id_redacted]"));
	}

	// A batch can use the returned lease id directly.
	const TSharedPtr<FJsonObject> Started = W::Send(*R, S->Owner, TEXT("editor_batch"),
		FString::Printf(TEXT(R"({"lease_id":"%s","steps":[{"cmd":"ping","fence_after":"none"}]})"), *S->LeaseId));
	S->JobId = W::Str(W::Field(Started, TEXT("data")), TEXT("job_id"));
	if (!TestTrue(FString::Printf(TEXT("editor_batch {lease_id} starts (%s)"), *W::Str(Started, TEXT("error"))),
		W::Bool(Started, TEXT("ok")) && !S->JobId.IsEmpty()))
	{
		Cleanup();
		return false;
	}

	ADD_LATENT_AUTOMATION_COMMAND(FHaybaWaitUntilLatentCommand(this, TEXT("editor_batch reaches a final status"),
		[R, S]()
		{
			S->Status = W::Str(W::Field(W::Send(*R, S->Owner, TEXT("batch_status"),
				FString::Printf(TEXT(R"({"job_id":"%s"})"), *S->JobId)), TEXT("data")), TEXT("status"));
			return !S->Status.IsEmpty() && S->Status != TEXT("running");
		},
		10.0));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S, Cleanup]()
	{
		TestEqual(TEXT("editor_batch {lease_id, steps:[ping]} succeeded"), S->Status, FString(TEXT("succeeded")));
		Cleanup();
		return true;
	}));
	return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
