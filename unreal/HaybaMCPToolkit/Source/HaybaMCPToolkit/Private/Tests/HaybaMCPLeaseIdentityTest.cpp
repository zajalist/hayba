// Hayba.MCP.Lease identity tests (P0 T9): owner-first caller resolution,
// reserved owners, lease binding and lease_adopt. Router cases go through
// FHaybaMCPCommandHandler::ProcessCommand, so every reply passes JsonToString and
// RedactFinalEnvelope. Owners are unique (hayba-test-<guid8>), connections are
// fake (>= 900000) and assets never exist (/Game/__HaybaTest__/...).

#include "Misc/AutomationTest.h"
#include "HaybaMCPAccessPolicy.h"
#include "HaybaMCPCommandHandler.h"
#include "HaybaMCPDeveloperSettings.h"
#include "HaybaMCPEditorHealth.h"
#include "HaybaMCPLeaseManager.h"
#include "HaybaMCPLeasePolicy.h"
#include "HaybaMCPModule.h"
#include "HaybaMCPSettings.h"
#include "Tests/HaybaMCPLatentTest.h"
#include "Tests/HaybaMCPLeaseTestUtil.h"
#include "Dom/JsonObject.h"
#include "Misc/Guid.h"
#include "Misc/ScopeExit.h"
#include "Modules/ModuleManager.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

#if WITH_DEV_AUTOMATION_TESTS

// A named namespace, so a unity build cannot collide these helpers with another test file's.
namespace HaybaIdentityTest
{
	FString Tag()
	{
		return FGuid::NewGuid().ToString(EGuidFormats::Digits).Left(8).ToLower();
	}

	FHaybaMCPCommandHandler* Router()
	{
		FHaybaMCPModule* Module = FModuleManager::GetModulePtr<FHaybaMCPModule>(TEXT("HaybaMCPToolkit"));
		return Module ? Module->GetCommandHandler().Get() : nullptr;
	}

	TSharedPtr<FJsonObject> Params(const TArray<TPair<FString, FString>>& Fields)
	{
		TSharedPtr<FJsonObject> P = MakeShared<FJsonObject>();
		for (const TPair<FString, FString>& F : Fields) P->SetStringField(F.Key, F.Value);
		return P;
	}

	TSharedPtr<FJsonObject> Send(const FString& Cmd, const TSharedPtr<FJsonObject>& InParams, int32 ConnId,
		const FString& Owner = FString(), const FString& Lease = FString())
	{
		TSharedRef<FJsonObject> Envelope = MakeShared<FJsonObject>();
		Envelope->SetStringField(TEXT("cmd"), Cmd);
		Envelope->SetStringField(TEXT("id"), TEXT("t9-") + Tag());
		Envelope->SetObjectField(TEXT("params"), InParams.IsValid() ? InParams : MakeShared<FJsonObject>());
		if (!Owner.IsEmpty()) Envelope->SetStringField(TEXT("owner"), Owner);
		if (!Lease.IsEmpty()) Envelope->SetStringField(TEXT("lease"), Lease);
		const FString& Auth = FHaybaMCPSettings::Get().CapabilityToken;
		if (!Auth.IsEmpty()) Envelope->SetStringField(TEXT("auth"), Auth);
		FString Json;
		const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Json);
		FJsonSerializer::Serialize(Envelope, Writer);
		FHaybaMCPCommandHandler* R = Router();
		if (!R) return nullptr;
		const FString Reply = R->ProcessCommand(Json, ConnId);
		TSharedPtr<FJsonObject> Out;
		FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Reply), Out);
		return Out;
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
		return (Parent.IsValid() && Parent->TryGetObjectField(Field, Out) && Out) ? *Out : nullptr;
	}

	bool Ok(const TSharedPtr<FJsonObject>& Reply)
	{
		bool bOk = false;
		return Reply.IsValid() && Reply->TryGetBoolField(TEXT("ok"), bOk) && bOk;
	}

	/** Grants a 60 s lease on one resource, or fails the test; returns its lease_id. */
	FString Acquire(FAutomationTestBase& Test, int32 ConnId, const FString& Owner, const FString& Resource, bool bBind)
	{
		TSharedPtr<FJsonObject> P = MakeShared<FJsonObject>();
		P->SetArrayField(TEXT("resources"), { MakeShared<FJsonValueString>(Resource) });
		P->SetBoolField(TEXT("bind_connection"), bBind);
		P->SetNumberField(TEXT("ttl_s"), 60);
		const FString Id = Str(Obj(Send(TEXT("lease_acquire"), P, ConnId, Owner), TEXT("data")), TEXT("lease_id"));
		Test.TestTrue(*FString::Printf(TEXT("lease_acquire granted to '%s' on %d"), *Owner, ConnId), Id.StartsWith(TEXT("ls_")));
		return Id;
	}

	/** The enforcement mode under test, and Plan Mode off; both restored at scope exit. */
	struct FScopedGateSettings
	{
		UHaybaMCPDeveloperSettings* Dev = GetMutableDefault<UHaybaMCPDeveloperSettings>();
		EHaybaMCPLeaseEnforcement OldMode = Dev->LeaseEnforcement;
		bool bOldPlan = FHaybaMCPSettings::Get().bPlanModeEnabled;
		explicit FScopedGateSettings(EHaybaMCPLeaseEnforcement Mode)
		{
			Dev->LeaseEnforcement = Mode;
			FHaybaMCPSettings::Get().bPlanModeEnabled = false;
		}
		~FScopedGateSettings()
		{
			Dev->LeaseEnforcement = OldMode;
			FHaybaMCPSettings::Get().bPlanModeEnabled = bOldPlan;
		}
	};

	/** Release every lease of these owners, then close these connections (drops adoptions and presence). */
	void Forget(const TArray<FString>& Owners, const TArray<int32>& Conns)
	{
		FHaybaMCPLeaseManager& M = FHaybaMCPLeaseManager::Get();
		for (const FString& O : Owners) M.Table().ReleaseOwner(O);
		if (FHaybaMCPCommandHandler* R = Router())
		{
			for (int32 C : Conns) R->NotifyConnectionClosed(C);
		}
	}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPLeaseResolveCallerTest,
	"Hayba.MCP.Lease.ResolveCaller",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPLeaseResolveCallerTest::RunTest(const FString& Parameters)
{
	using namespace HaybaIdentityTest;
	FHaybaMCPLeaseManager& M = FHaybaMCPLeaseManager::Get();
	const FString T = Tag();
	const FString Seven = TEXT("hayba-test-") + T + TEXT("-7");
	const FString Eight = TEXT("hayba-test-") + T + TEXT("-8");
	const FString Nine = TEXT("hayba-test-") + T + TEXT("-9");
	ON_SCOPE_EXIT
	{
		M.Table().ReleaseOwner(Seven);
		for (int32 C : { 900201, 900202, 900203, 900204 }) M.OnConnectionClosed(C);
	};

	FCallerResolution R = FHaybaMCPLeaseManager::ResolveCaller(TEXT("  ") + Seven + TEXT(" "), 900201, FString());
	TestEqual(TEXT("the envelope owner wins and is trimmed"), R.Owner, Seven);
	TestEqual(TEXT("via envelope"), R.Via, FString(TEXT("envelope")));
	TestTrue(TEXT("no lease named"), R.LeaseRef == ELeaseRef::None);
	R = FHaybaMCPLeaseManager::ResolveCaller(FString(), 900201, FString());
	TestEqual(TEXT("no owner: one owner per connection"), R.Owner, FString(TEXT("conn:900201")));
	TestEqual(TEXT("via conn"), R.Via, FString(TEXT("conn")));
	R = FHaybaMCPLeaseManager::ResolveCaller(FString(), 0, FString());
	TestEqual(TEXT("no owner in-process: local"), R.Owner, FString(TEXT("local")));
	TestEqual(TEXT("via local"), R.Via, FString(TEXT("local")));

	// Reserved owners: conn:<n> only from connection n, local only in-process.
	R = FHaybaMCPLeaseManager::ResolveCaller(TEXT("conn:900201"), 900201, FString());
	TestFalse(TEXT("a connection may name itself"), R.bReservedViolation);
	TestEqual(TEXT("...and is judged as itself"), R.Owner, FString(TEXT("conn:900201")));
	R = FHaybaMCPLeaseManager::ResolveCaller(TEXT("conn:900201"), 900202, FString());
	TestTrue(TEXT("another connection's owner is a violation"), R.bReservedViolation);
	TestEqual(TEXT("a violator is judged as itself"), R.Owner, FString(TEXT("conn:900202")));
	TestTrue(TEXT("local from a connection is a violation"),
		FHaybaMCPLeaseManager::ResolveCaller(TEXT("local"), 900202, FString()).bReservedViolation);
	TestFalse(TEXT("local in-process is fine"),
		FHaybaMCPLeaseManager::ResolveCaller(TEXT("local"), 0, FString()).bReservedViolation);
	TestTrue(TEXT("any conn: prefix is reserved"),
		FHaybaMCPLeaseManager::ResolveCaller(TEXT("conn:abc"), 900202, FString()).bReservedViolation);
	TestTrue(TEXT("conn:<n> from in-process is a violation"),
		FHaybaMCPLeaseManager::ResolveCaller(TEXT("conn:900201"), 0, FString()).bReservedViolation);

	// Adoption is second in precedence, after the envelope owner.
	FString Error;
	TestTrue(TEXT("adopt 900203 as Eight"), M.AdoptConnection(900203, Eight, Error));
	R = FHaybaMCPLeaseManager::ResolveCaller(FString(), 900203, FString());
	TestEqual(TEXT("an adopted connection acts as its owner"), R.Owner, Eight);
	TestEqual(TEXT("via adopted"), R.Via, FString(TEXT("adopted")));
	TestEqual(TEXT("the envelope owner still wins"), FHaybaMCPLeaseManager::ResolveCaller(Nine, 900203, FString()).Owner, Nine);
	TestTrue(TEXT("re-adopting by the same owner is idempotent"), M.AdoptConnection(900203, Eight, Error));
	TestFalse(TEXT("another owner cannot take an adopted connection"), M.AdoptConnection(900203, Nine, Error));
	TestTrue(TEXT("...[connection_already_adopted]"), Error.Contains(TEXT("[connection_already_adopted]")));
	TestFalse(TEXT("in-process cannot adopt"), M.AdoptConnection(0, Eight, Error));
	TestTrue(TEXT("...[adopt_needs_connection]"), Error.Contains(TEXT("[adopt_needs_connection]")));
	TestFalse(TEXT("a reserved owner cannot be adopted"), M.AdoptConnection(900204, TEXT("local"), Error));
	TestTrue(TEXT("...[owner_reserved]"), Error.Contains(TEXT("[owner_reserved]")));
	TestEqual(TEXT("ConnectionOwner reports the adoption"), M.ConnectionOwner(900203), Eight);
	M.OnConnectionClosed(900203);
	TestTrue(TEXT("a closed connection forgets its adoption"), M.ConnectionOwner(900203).IsEmpty());

	// The envelope lease no longer sets the caller; it is only classified.
	HaybaMCPLease::FRequest Req;
	Req.Owner = Seven;
	HaybaMCPAccess::FClaim Claim;
	Claim.bExclusive = true;
	TestTrue(TEXT("the test resource parses"),
		HaybaMCPAccess::ParseResource(TEXT("asset:/Game/__HaybaTest__/BP_Resolve_") + T, Claim.Resource, Error));
	Req.Claims.Add(Claim);
	const HaybaMCPLease::FAcquireResult Grant = M.Table().Acquire(Req);
	if (!TestTrue(TEXT("the test lease is granted"), Grant.Status == HaybaMCPLease::EStatus::Granted)) return false;
	const FString LeaseId = Grant.Token;

	R = FHaybaMCPLeaseManager::ResolveCaller(Seven, 900201, LeaseId);
	TestTrue(TEXT("the caller's own lease is Bound"), R.LeaseRef == ELeaseRef::Bound);
	TestEqual(TEXT("LeaseId is kept"), R.LeaseId, LeaseId);
	R = FHaybaMCPLeaseManager::ResolveCaller(Nine, 900201, LeaseId);
	TestTrue(TEXT("another owner's lease is NotBound"), R.LeaseRef == ELeaseRef::NotBound);
	TestEqual(TEXT("NotBound keeps the caller"), R.Owner, Nine);
	TestEqual(TEXT("NotBound names the lease owner"), R.NamedLeaseOwner, Seven);
	R = FHaybaMCPLeaseManager::ResolveCaller(FString(), 900201, LeaseId);
	TestEqual(TEXT("a lease alone does not confer identity"), R.Owner, FString(TEXT("conn:900201")));
	TestTrue(TEXT("...it is NotBound"), R.LeaseRef == ELeaseRef::NotBound);
	TestTrue(TEXT("a dead id is Unknown"),
		FHaybaMCPLeaseManager::ResolveCaller(Seven, 900201, TEXT("ls_424242_000000000000")).LeaseRef == ELeaseRef::Unknown);
	R = FHaybaMCPLeaseManager::ResolveCaller(Seven, 900201, TEXT("[REDACTED:lease]"));
	TestTrue(TEXT("a marker is Redacted"), R.LeaseRef == ELeaseRef::Redacted);
	TestTrue(TEXT("a marker is never kept as an id"), R.LeaseId.IsEmpty());

	// Batch steps act as the batch owner, even when it is conn:<n> (R-27).
	R = FHaybaMCPLeaseManager::ResolveBatchCaller(TEXT("conn:900001"), FString());
	TestEqual(TEXT("the batch owner is kept"), R.Owner, FString(TEXT("conn:900001")));
	TestEqual(TEXT("via batch"), R.Via, FString(TEXT("batch")));
	TestFalse(TEXT("a batch owner is never a reserved violation"), R.bReservedViolation);
	TestFalse(TEXT("a conn:<n> batch owner is not identified"), FHaybaMCPLeaseManager::IsIdentifiedCaller(R));
	TestTrue(TEXT("a named batch owner is identified"),
		FHaybaMCPLeaseManager::IsIdentifiedCaller(FHaybaMCPLeaseManager::ResolveBatchCaller(Seven, FString())));
	TestTrue(TEXT("an envelope owner is identified"),
		FHaybaMCPLeaseManager::IsIdentifiedCaller(FHaybaMCPLeaseManager::ResolveCaller(Seven, 900201, FString())));
	TestFalse(TEXT("conn:<n> is not identified"),
		FHaybaMCPLeaseManager::IsIdentifiedCaller(FHaybaMCPLeaseManager::ResolveCaller(FString(), 900201, FString())));
	TestEqual(TEXT("the log names not_bound"), FString(LexLeaseRef(ELeaseRef::NotBound)), FString(TEXT("not_bound")));
	TestEqual(TEXT("the log keeps valid for a bound lease (T6 format)"), FString(LexLeaseRef(ELeaseRef::Bound)), FString(TEXT("valid")));
	return true;
}

#endif
