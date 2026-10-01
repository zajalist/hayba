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
#include "HaybaMCPEditorState.h"
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
		FHaybaEditorHealth::FScopedOverrideForTests Health;
		FHaybaMCPEditorState::FScopedPieOverride Pie{ HaybaMCPState::FPieState() };
		HaybaMCPLeaseTest::FScopedCleanPresence CleanPresence;
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

	/** The exact safe missing-asset handler result, rather than an unrelated gate refusal. */
	void MissingBlueprint(FAutomationTestBase& Test, const TSharedPtr<FJsonObject>& Reply, const FString& Path)
	{
		Test.TestFalse(TEXT("missing blueprint is a handler failure"), Ok(Reply));
		Test.TestEqual(TEXT("missing blueprint has no top-level gate code"), Str(Reply, TEXT("code")), FString());
		Test.TestEqual(TEXT("the expected handler reports the missing test asset"), Str(Reply, TEXT("error")),
			FString::Printf(TEXT("blueprint_add_node: no blueprint at '%s'. Accepted forms: '/Game/Dir/WBP_Name', ")
				TEXT("'/Game/Dir/WBP_Name.WBP_Name', or the class path '/Game/Dir/WBP_Name.WBP_Name_C' ")
				TEXT("(the '_C' is stripped for you). Note the asset must have been SAVED at least once \u2014 ")
				TEXT("a freshly created, never-saved blueprint cannot be loaded by path."), *Path));
		const TSharedPtr<FJsonObject> Advisory = Obj(Reply, TEXT("advisory"));
		Test.TestEqual(TEXT("legacy missing-asset outcome stays conservative"), Str(Advisory, TEXT("state")), FString(TEXT("unknown_outcome")));
		Test.TestEqual(TEXT("legacy handler has no mutation proof"), Str(Advisory, TEXT("mutation_status")), FString(TEXT("unknown")));
		Test.TestEqual(TEXT("advisory identifies the handler failure"), Str(Advisory, TEXT("code")), FString(TEXT("unclassified_handler_failure")));
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

	TestTrue(TEXT("adopt another connection for the generation reset"), M.AdoptConnection(900204, Nine, Error));
	M.ForgetAllAdoptions();
	TestTrue(TEXT("a new TCP generation forgets every adoption"), M.ConnectionOwner(900204).IsEmpty());

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

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPLeaseReservedOwnerTest,
	"Hayba.MCP.Lease.ReservedOwner",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPLeaseReservedOwnerTest::RunTest(const FString& Parameters)
{
	using namespace HaybaIdentityTest;
	if (!TestNotNull(TEXT("the router exists"), Router())) return false;
	if (!TestFalse(TEXT("the editor is not unsafe (R-7)"), FHaybaEditorHealth::IsUnsafe())) return false;
	const TSharedRef<FScopedGateSettings> Gate = MakeShared<FScopedGateSettings>(EHaybaMCPLeaseEnforcement::EnforcedForWrites);
	// The editor_batch below has no owner. Under EnforcedForWrites an owner-less
	// write is refused with owner_required while any identified owner is present,
	// and earlier router tests leave owners present on fake connections that never
	// close. Start with nobody present, so the result does not depend on test order.
	// Nothing before the batch names an identified owner: a refused claim never
	// reaches the presence hunk, and conn:<n> and local never count.
	const FString Watcher = TEXT("hayba-test-") + Tag() + TEXT("-watch");

	// Slot 0 refuses a claimed owner that is not the caller's, before anything runs.
	TSharedPtr<FJsonObject> R = Send(TEXT("ping"), nullptr, 900302, TEXT("conn:900301"));
	TestEqual(TEXT("conn:<other> is refused"), Str(R, TEXT("code")), FString(TEXT("owner_reserved")));
	TestEqual(TEXT("claimed_owner is reported"), Str(Obj(R, TEXT("owner")), TEXT("claimed_owner")), FString(TEXT("conn:900301")));
	TestEqual(TEXT("caller_owner is the real caller"), Str(Obj(R, TEXT("owner")), TEXT("caller_owner")), FString(TEXT("conn:900302")));
	TestEqual(TEXT("input_rejected"), Str(Obj(R, TEXT("advisory")), TEXT("state")), FString(TEXT("input_rejected")));
	TestEqual(TEXT("not_started"), Str(Obj(R, TEXT("advisory")), TEXT("mutation_status")), FString(TEXT("not_started")));
	TestTrue(TEXT("the error starts with its code"), Str(R, TEXT("error")).StartsWith(TEXT("owner_reserved:")));
	TestFalse(TEXT("the refusal never says token"), Str(R, TEXT("error")).Contains(TEXT("token")));
	TestEqual(TEXT("local from a connection is refused"),
		Str(Send(TEXT("ping"), nullptr, 900302, TEXT("local")), TEXT("code")), FString(TEXT("owner_reserved")));
	TestTrue(TEXT("a connection may name itself"), Ok(Send(TEXT("ping"), nullptr, 900302, TEXT("conn:900302"))));
	TestTrue(TEXT("local in-process is accepted"), Ok(Send(TEXT("ping"), nullptr, 0, TEXT("local"))));

	// R-27: a batch owned by conn:900001 keeps running its steps after 900001 closes.
	const FString LeaseId = Acquire(*this, 900001, FString(), TEXT("asset:/Game/__HaybaTest__/Batch_") + Tag(), /*bBind=*/false);
	if (LeaseId.IsEmpty())
	{
		Forget({ TEXT("conn:900001") }, { 900001, 900302, 900303 });
		return false;
	}
	TSharedPtr<FJsonObject> Batch = MakeShared<FJsonObject>();
	Batch->SetStringField(TEXT("lease_id"), LeaseId);
	TArray<TSharedPtr<FJsonValue>> Steps;
	for (int32 I = 0; I < 2; ++I)
	{
		TSharedPtr<FJsonObject> Step = MakeShared<FJsonObject>();
		Step->SetStringField(TEXT("cmd"), TEXT("ping"));
		Step->SetStringField(TEXT("fence_after"), TEXT("none"));
		Steps.Add(MakeShared<FJsonValueObject>(Step));
	}
	Batch->SetArrayField(TEXT("steps"), Steps);
	const TSharedPtr<FJsonObject> Started = Send(TEXT("editor_batch"), Batch, 900001);
	TestTrue(TEXT("the owner-less batch was accepted while nobody else is present"), Ok(Started));
	const FString JobId = Str(Obj(Started, TEXT("data")), TEXT("job_id"));
	TestEqual(TEXT("the batch owner is the connection's"), Str(Obj(Started, TEXT("data")), TEXT("owner")), FString(TEXT("conn:900001")));
	if (!TestFalse(TEXT("editor_batch started"), JobId.IsEmpty()))
	{
		Forget({ TEXT("conn:900001") }, { 900001, 900302, 900303 });
		return false;
	}
	Router()->NotifyConnectionClosed(900001);
	TestEqual(TEXT("a raw envelope claiming the closed connection is still refused"),
		Str(Send(TEXT("ping"), nullptr, 900302, TEXT("conn:900001")), TEXT("code")), FString(TEXT("owner_reserved")));

	ADD_LATENT_AUTOMATION_COMMAND(FHaybaWaitUntilLatentCommand(this, TEXT("the conn:900001 batch finishes"),
		[this, JobId, Watcher, Gate]()
		{
			const TSharedPtr<FJsonObject> Status = HaybaIdentityTest::Send(TEXT("batch_status"),
				HaybaIdentityTest::Params({ { TEXT("job_id"), JobId } }), 900303, Watcher);
			const TSharedPtr<FJsonObject> Data = HaybaIdentityTest::Obj(Status, TEXT("data"));
			const FString State = HaybaIdentityTest::Str(Data, TEXT("status"));
			if (State != TEXT("succeeded") && State != TEXT("failed")) return false;
			TestEqual(TEXT("the batch succeeded after its connection closed"), State, FString(TEXT("succeeded")));
			double StepsRun = 0.0;
			if (Data.IsValid()) Data->TryGetNumberField(TEXT("steps_run"), StepsRun);
			TestEqual(TEXT("both steps ran"), static_cast<int32>(StepsRun), 2);
			return true;
		}, 10.0));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([Gate, JobId]()
	{
		// Also cancels on a wait timeout before releasing the owned lease.
		HaybaIdentityTest::Send(TEXT("batch_cancel"), HaybaIdentityTest::Params({ { TEXT("job_id"), JobId } }), 900001);
		HaybaIdentityTest::Forget({ TEXT("conn:900001") }, { 900001, 900302, 900303 });
		return true;
	}));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPLeaseRouterBindingTest,
	"Hayba.MCP.Lease.RouterBinding",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPLeaseRouterBindingTest::RunTest(const FString& Parameters)
{
	using namespace HaybaIdentityTest;
	if (!TestNotNull(TEXT("the router exists"), Router())) return false;
	if (!TestFalse(TEXT("the editor is not unsafe (R-7)"), FHaybaEditorHealth::IsUnsafe())) return false;
	FScopedGateSettings Gate(EHaybaMCPLeaseEnforcement::EnforcedForWrites);
	const FString T = Tag();
	const FString OwnerA = TEXT("hayba-test-") + T + TEXT("-a");
	const FString Held = TEXT("/Game/__HaybaTest__/BP_Bind_") + T;
	const FString Free = TEXT("/Game/__HaybaTest__/BP_Free_") + T;
	double Advanced = 0.0;
	ON_SCOPE_EXIT
	{
		FHaybaMCPLeaseManager::Get().AdvanceClockForTests(-Advanced);
		Forget({ OwnerA, OwnerA + TEXT("-other") }, { 900401, 900402 });
	};

	const FString LeaseA = Acquire(*this, 900401, OwnerA, TEXT("asset:") + Held, /*bBind=*/false);
	if (LeaseA.IsEmpty()) return false;
	const TSharedPtr<FJsonObject> AddHeld = Params({ { TEXT("path"), Held }, { TEXT("node_type"), TEXT("branch") } });
	const TSharedPtr<FJsonObject> AddFree = Params({ { TEXT("path"), Free }, { TEXT("node_type"), TEXT("branch") } });

	// A helper that sends only A's lease is judged as its own connection.
	TSharedPtr<FJsonObject> R = Send(TEXT("blueprint_add_node"), AddHeld, 900402, FString(), LeaseA);
	TestEqual(TEXT("a lease alone does not act as its owner"), Str(R, TEXT("code")), FString(TEXT("lease_conflict")));
	const TSharedPtr<FJsonObject> Lease = Obj(R, TEXT("lease"));
	TestEqual(TEXT("reason held"), Str(Lease, TEXT("reason")), FString(TEXT("held")));
	TestEqual(TEXT("the caller is the connection"), Str(Lease, TEXT("caller_owner")), FString(TEXT("conn:900402")));
	const TSharedPtr<FJsonObject> Binding = Obj(Lease, TEXT("lease_binding"));
	TestEqual(TEXT("lease_binding names the lease owner"), Str(Binding, TEXT("named_lease_owner")), OwnerA);
	TestEqual(TEXT("lease_binding names the caller"), Str(Binding, TEXT("caller_owner")), FString(TEXT("conn:900402")));
	TestTrue(TEXT("lease_binding says how to fix it"), Str(Binding, TEXT("fix")).Contains(TEXT("lease_adopt")));
	TestFalse(TEXT("no refusal text says token"), Str(R, TEXT("error")).Contains(TEXT("token")));

	// With the owner on the envelope the same lease is Bound, and the lease gate passes.
	R = Send(TEXT("blueprint_add_node"), AddHeld, 900402, OwnerA, LeaseA);
	MissingBlueprint(*this, R, Held);
	TestFalse(TEXT("no lease detail for the owner"), R.IsValid() && R->HasField(TEXT("lease")));
	TestFalse(TEXT("no binding warning for the owner"), R.IsValid() && R->HasField(TEXT("lease_warning")));

	// No conflict: the write runs, and the reply warns lease_not_bound.
	HaybaMCPLeaseTest::FLogCapture LeaseLog(TEXT("LogHaybaMCPLease"));
	R = Send(TEXT("blueprint_add_node"), AddFree, 900402, FString(), LeaseA);
	MissingBlueprint(*this, R, Free);
	const TSharedPtr<FJsonObject> Warning = Obj(R, TEXT("lease_warning"));
	TestEqual(TEXT("lease_not_bound warning"), Str(Warning, TEXT("reason")), FString(TEXT("lease_not_bound")));
	TestEqual(TEXT("the warning carries lease_binding"), Str(Obj(Warning, TEXT("lease_binding")), TEXT("named_lease_owner")), OwnerA);
	// The warning is rate-limited like every lease warning (R-18): a second hit in
	// the same 30 s window answers with the warning again and logs nothing.
	R = Send(TEXT("blueprint_add_node"), AddFree, 900402, FString(), LeaseA);
	MissingBlueprint(*this, R, Free);
	TestEqual(TEXT("the second hit still warns on the reply"),
		Str(Obj(R, TEXT("lease_warning")), TEXT("reason")), FString(TEXT("lease_not_bound")));
	LeaseLog.Flush();
	TestEqual(TEXT("two lease_not_bound hits in one window log one Warning"),
		LeaseLog.Count(FString::Printf(
			TEXT("lease_warning/lease_not_bound: 'blueprint_add_node' from 'conn:900402' names a lease of '%s'"), *OwnerA),
			ELogVerbosity::Warning), 1);

	FHaybaMCPLeaseManager::Get().AdvanceClockForTests(31.0);
	Advanced += 31.0;
	FHaybaMCPLeaseManager::Get().DrainLeaseWarnings();
	LeaseLog.Flush();
	TestEqual(TEXT("binding warnings drain the one suppressed hit"), LeaseLog.Count(FString::Printf(
		TEXT("lease_warning/lease_not_bound repeated 1 more times in 30 s: owner='conn:*' cmd='blueprint_add_node' holder='%s' conflict='lease_not_bound'"), *OwnerA), ELogVerbosity::Warning), 1);

	// Reads never warn about binding.
	R = Send(TEXT("ping"), nullptr, 900402, FString(), LeaseA);
	TestTrue(TEXT("ping answers"), Ok(R));
	TestFalse(TEXT("ping carries no lease_warning"), R.IsValid() && R->HasField(TEXT("lease_warning")));
	// The request-specific read_only classification must also suppress binding warnings.
	TSharedPtr<FJsonObject> ReadPython = Params({ { TEXT("script"), TEXT("pass") } });
	ReadPython->SetBoolField(TEXT("read_only"), true);
	R = Send(TEXT("python_run"), ReadPython, 900402, FString(), LeaseA);
	TestTrue(TEXT("declared Python read executes"), Ok(R));
	TestFalse(TEXT("declared Python read has no binding warning"), R.IsValid() && R->HasField(TEXT("lease_warning")));
	// Adoption supplies identity only when the envelope does not explicitly override it.
	FString AdoptError;
	TestTrue(TEXT("the helper adopts the named owner"), FHaybaMCPLeaseManager::Get().AdoptConnection(900402, OwnerA, AdoptError));
	R = Send(TEXT("blueprint_add_node"), AddHeld, 900402, FString(), LeaseA);
	MissingBlueprint(*this, R, Held);
	TestFalse(TEXT("adopted caller has no binding warning"), R.IsValid() && R->HasField(TEXT("lease_warning")));
	Gate.Dev->LeaseEnforcement = EHaybaMCPLeaseEnforcement::Off;
	R = Send(TEXT("blueprint_add_node"), AddFree, 900402, OwnerA + TEXT("-other"), LeaseA);
	MissingBlueprint(*this, R, Free);
	TestFalse(TEXT("Off suppresses binding diagnostics"), R.IsValid() && R->HasField(TEXT("lease_warning")));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPLeaseUnknownLeaseRefusesWritesTest,
	"Hayba.MCP.Lease.UnknownLeaseRefusesWrites",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPLeaseUnknownLeaseRefusesWritesTest::RunTest(const FString& Parameters)
{
	using namespace HaybaIdentityTest;
	if (!TestNotNull(TEXT("the router exists"), Router())) return false;
	if (!TestFalse(TEXT("the editor is not unsafe (R-7)"), FHaybaEditorHealth::IsUnsafe())) return false;
	FScopedGateSettings Gate(EHaybaMCPLeaseEnforcement::EnforcedForWrites);
	const FString Owner = TEXT("hayba-test-") + Tag() + TEXT("-u");
	ON_SCOPE_EXIT { Forget({ Owner }, { 900501 }); };
	const FString Missing = TEXT("/Game/__HaybaTest__/BP_Unknown_") + Tag();
	const TSharedPtr<FJsonObject> Add = Params({ { TEXT("path"), Missing }, { TEXT("node_type"), TEXT("branch") } });

	TSharedPtr<FJsonObject> R = Send(TEXT("blueprint_add_node"), Add, 900501, Owner, TEXT("ls_777777_000000000000"));
	TestEqual(TEXT("a dead lease id refuses a write"), Str(R, TEXT("code")), FString(TEXT("lease_conflict")));
	TestEqual(TEXT("reason lease_unknown"), Str(Obj(R, TEXT("lease")), TEXT("reason")), FString(TEXT("lease_unknown")));
	TestEqual(TEXT("lease_id_error"), Str(Obj(R, TEXT("lease")), TEXT("lease_id_error")), FString(TEXT("unknown_or_expired")));
	TestEqual(TEXT("input_rejected"), Str(Obj(R, TEXT("advisory")), TEXT("state")), FString(TEXT("input_rejected")));
	TestEqual(TEXT("not_started"), Str(Obj(R, TEXT("advisory")), TEXT("mutation_status")), FString(TEXT("not_started")));
	TestFalse(TEXT("the refusal never echoes the id"), Str(R, TEXT("error")).Contains(TEXT("ls_777777")));
	TestTrue(TEXT("reads stay free with a dead id"), Ok(Send(TEXT("ping"), nullptr, 900501, Owner, TEXT("ls_777777_000000000000"))));

	R = Send(TEXT("blueprint_add_node"), Add, 900501, Owner, TEXT("[REDACTED:lease]"));
	MissingBlueprint(*this, R, Missing);
	TestEqual(TEXT("...and warns lease_handle_redacted"), Str(Obj(R, TEXT("lease_warning")), TEXT("reason")), FString(TEXT("lease_handle_redacted")));
	return true;
}

#endif
