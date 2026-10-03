// Router-level lease lifetime tests (T7). Every reply goes through
// ProcessCommand, so ids really pass RedactFinalEnvelope. Owners are unique,
// ConnIds are >= 900000, assets live under /Game/__HaybaTest__/.
#include "Misc/AutomationTest.h"
#include "HaybaMCPLeaseManager.h"
#include "HaybaMCPDeveloperSettings.h"
#include "HaybaMCPSettings.h"
#include "Tests/HaybaMCPLeaseTestUtil.h"
#include "Misc/ScopeExit.h"

#if WITH_DEV_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPLeaseTouchOnUseTest,
	"Hayba.MCP.Lease.TouchOnUse",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPLeaseTouchOnUseTest::RunTest(const FString& Parameters)
{
	using namespace HaybaMCPLeaseTest;
	const TSharedPtr<FHaybaMCPCommandHandler> R = Router();
	if (!TestTrue(TEXT("command router exists"), R.IsValid())) return false;
	FHaybaMCPLeaseManager& Leases = FHaybaMCPLeaseManager::Get();
	FHaybaMCPSettings& Settings = FHaybaMCPSettings::Get();
	UHaybaMCPDeveloperSettings* Dev = GetMutableDefault<UHaybaMCPDeveloperSettings>();
	const bool bPlanWas = Settings.bPlanModeEnabled;
	const EHaybaMCPLeaseEnforcement ModeWas = Dev->LeaseEnforcement;
	const FString Owner = UniqueOwner(TEXT("touch"));
	constexpr int32 Conn = 900301;
	double Advanced = 0.0;
	ON_SCOPE_EXIT
	{
		Leases.AdvanceClockForTests(-Advanced);
		Settings.bPlanModeEnabled = bPlanWas;
		Dev->LeaseEnforcement = ModeWas;
		Leases.ForgetOwnerForTests(Owner);
		R->NotifyConnectionClosed(Conn);
	};
	Dev->LeaseEnforcement = EHaybaMCPLeaseEnforcement::Advisory;
	Settings.bPlanModeEnabled = false;
	auto Advance = [&Leases, &Advanced](double Seconds) { Leases.AdvanceClockForTests(Seconds); Advanced += Seconds; };
	const TSharedPtr<FJsonObject> Write = Json(
		TEXT("{\"path\":\"/Game/__HaybaTest__/BP_Touch\",\"node_type\":\"call_function\",\"function_name\":\"PrintString\"}"));

	// 1. Routine traffic every 5 s never keeps a lease alive.
	const FString Routine = AcquireId(*R, Conn, Owner,
		TEXT("{\"resources\":[\"global\"],\"ttl_s\":60,\"bind_connection\":false,\"label\":\"touch-routine\"}"));
	TestFalse(TEXT("lease granted"), Routine.IsEmpty());
	for (int32 Tick = 0; Tick < 12; ++Tick)
	{
		Advance(5.0);
		Send(*R, Conn, Owner, TEXT("ping"), nullptr);
		Send(*R, Conn, Owner, TEXT("ui_tool_stream"), Json(TEXT("{\"tool\":\"ping\",\"params\":\"{}\",\"result\":\"{}\"}")));
		Send(*R, Conn, Owner, TEXT("editor_get_state"), Json(TEXT("{\"include_dirty\":false}")));
	}
	TestNull(TEXT("a lease whose owner only polls lapses at its TTL"), Leases.Table().FindLease(Routine));

	// 2. A refused write never touches.
	const FString Kept = AcquireId(*R, Conn, Owner,
		TEXT("{\"resources\":[\"global\"],\"ttl_s\":60,\"bind_connection\":false,\"label\":\"touch-write\"}"));
	if (!TestNotNull(TEXT("second lease granted"), Leases.Table().FindLease(Kept))) return false;
	const double ExpiresBefore = Leases.Table().FindLease(Kept)->ExpiresAt;
	Advance(30.0);
	Settings.bPlanModeEnabled = true;
	const FString RefusalCode = CodeOf(Send(*R, Conn, Owner, TEXT("blueprint_add_node"), Write));
	Settings.bPlanModeEnabled = false;
	TestEqual(TEXT("the Plan gate refuses unsupported exact review"), RefusalCode,
		FString(TEXT("exact_approval_unavailable")));
	TestEqual(TEXT("a refused write leaves the expiry"), Leases.Table().FindLease(Kept)->ExpiresAt, ExpiresBefore);

	// 3. A write that passes every gate and uses the lease's lock extends it.
	const TSharedPtr<FJsonObject> Ran = Send(*R, Conn, Owner, TEXT("blueprint_add_node"), Write);
	TestEqual(TEXT("no gate refused it"), CodeOf(Ran), FString());
	TestEqual(TEXT("the lease runs a full TTL from this write"),
		Leases.Table().FindLease(Kept)->ExpiresAt, Leases.Now() + 60.0, 0.5);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPLeaseRenewRevivesOrphanTest,
	"Hayba.MCP.Lease.RenewRevivesOrphanedLeaseOfSameOwner",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPLeaseRenewRevivesOrphanTest::RunTest(const FString& Parameters)
{
	using namespace HaybaMCPLeaseTest;
	const TSharedPtr<FHaybaMCPCommandHandler> R = Router();
	if (!TestTrue(TEXT("command router exists"), R.IsValid())) return false;
	FHaybaMCPLeaseManager& Leases = FHaybaMCPLeaseManager::Get();
	FHaybaMCPSettings& Settings = FHaybaMCPSettings::Get();
	UHaybaMCPDeveloperSettings* Dev = GetMutableDefault<UHaybaMCPDeveloperSettings>();
	const bool bPlanWas = Settings.bPlanModeEnabled;
	const EHaybaMCPLeaseEnforcement ModeWas = Dev->LeaseEnforcement;
	const FString Owner = UniqueOwner(TEXT("revive"));
	const FString Other = UniqueOwner(TEXT("other"));
	ON_SCOPE_EXIT
	{
		Settings.bPlanModeEnabled = bPlanWas;
		Dev->LeaseEnforcement = ModeWas;
		Leases.ForgetOwnerForTests(Owner);
		Leases.ForgetOwnerForTests(Other);
		for (int32 Conn = 900401; Conn <= 900404; ++Conn) R->NotifyConnectionClosed(Conn);
	};
	Dev->LeaseEnforcement = EHaybaMCPLeaseEnforcement::Advisory;
	Settings.bPlanModeEnabled = false;

	const FString Id = AcquireId(*R, 900401, Owner,
		TEXT("{\"resources\":[\"asset:/Game/__HaybaTest__/BP_Revive\"],\"label\":\"revive\"}"));
	if (!TestFalse(TEXT("bound lease granted"), Id.IsEmpty())) return false;
	TestEqual(TEXT("bound to its connection"), Leases.Table().FindLease(Id)->ConnId, 900401);

	R->NotifyConnectionClosed(900401);
	TestTrue(TEXT("the close orphans it"), Leases.Table().FindLease(Id)->IsOrphaned());
	const double OrphanExpiry = Leases.Table().FindLease(Id)->ExpiresAt;

	// A write that uses the lock does not revive it (touch never revives).
	Send(*R, 900402, Owner, TEXT("blueprint_add_node"), Json(
		TEXT("{\"path\":\"/Game/__HaybaTest__/BP_Revive\",\"node_type\":\"call_function\",\"function_name\":\"PrintString\"}")));
	TestTrue(TEXT("a touch does not revive an orphan"), Leases.Table().FindLease(Id)->IsOrphaned());
	TestEqual(TEXT("nor extend it"), Leases.Table().FindLease(Id)->ExpiresAt, OrphanExpiry);

	// Another owner cannot revive it.
	FString MismatchError;
	Send(*R, 900403, Other, TEXT("lease_renew"), Json(FString::Printf(TEXT("{\"lease_id\":\"%s\"}"), *Id)))
		->TryGetStringField(TEXT("error"), MismatchError);
	TestTrue(TEXT("[lease_owner_mismatch]"), MismatchError.Contains(TEXT("[lease_owner_mismatch]")));
	TestTrue(TEXT("keeps 'belongs to' for editor_gate.py"), MismatchError.Contains(TEXT("belongs to")));
	TestTrue(TEXT("still orphaned"), Leases.Table().FindLease(Id)->IsOrphaned());

	// The owner's renew from a new connection revives and re-binds it.
	bool bRenewed = false;
	DataOf(Send(*R, 900402, Owner, TEXT("lease_renew"), Json(FString::Printf(TEXT("{\"lease_id\":\"%s\"}"), *Id))))
		->TryGetBoolField(TEXT("renewed"), bRenewed);
	TestTrue(TEXT("renewed"), bRenewed);
	const HaybaMCPLease::FLease* Revived = Leases.Table().FindLease(Id);
	TestFalse(TEXT("revived"), Revived->IsOrphaned());
	TestEqual(TEXT("re-bound to the renewing connection"), Revived->ConnId, 900402);
	TestTrue(TEXT("still a bound lease"), Revived->bBindConnection);

	// Orphan it again; an in-process renew (ConnId 0) revives it unbound.
	R->NotifyConnectionClosed(900402);
	Send(*R, 0, Owner, TEXT("lease_renew"), Json(FString::Printf(TEXT("{\"lease_id\":\"%s\"}"), *Id)));
	const HaybaMCPLease::FLease* Unbound = Leases.Table().FindLease(Id);
	TestFalse(TEXT("revived in-process"), Unbound->IsOrphaned());
	TestEqual(TEXT("bound to no connection"), Unbound->ConnId, 0);
	TestFalse(TEXT("now an unbound lease"), Unbound->bBindConnection);

	// R-25: the batch keep-alive (Renew with ConnId 0) leaves a live bound lease bound.
	const FString KeepAlive = AcquireId(*R, 900404, Owner,
		TEXT("{\"resources\":[\"asset:/Game/__HaybaTest__/BP_Revive2\"],\"label\":\"keepalive\"}"));
	if (!TestNotNull(TEXT("keep-alive lease granted"), Leases.Table().FindLease(KeepAlive))) return false;
	double Expiry = 0.0;
	FString Error;
	TestTrue(TEXT("keep-alive renew"), Leases.Table().Renew(KeepAlive, Owner, 90.0, Expiry, Error));
	TestEqual(TEXT("still bound to its connection"), Leases.Table().FindLease(KeepAlive)->ConnId, 900404);
	TestTrue(TEXT("still a bound lease"), Leases.Table().FindLease(KeepAlive)->bBindConnection);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPLeaseConnectionDropTest,
	"Hayba.MCP.Lease.ConnectionDrop",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPLeaseConnectionDropTest::RunTest(const FString& Parameters)
{
	using namespace HaybaMCPLeaseTest;
	const TSharedPtr<FHaybaMCPCommandHandler> R = Router();
	if (!TestTrue(TEXT("command router exists"), R.IsValid())) return false;
	FHaybaMCPLeaseManager& Leases = FHaybaMCPLeaseManager::Get();
	const FString O = UniqueOwner(TEXT("drop"));
	const FString P = UniqueOwner(TEXT("waiter"));
	double Advanced = 0.0;
	ON_SCOPE_EXIT
	{
		Leases.AdvanceClockForTests(-Advanced);
		Leases.ForgetOwnerForTests(O);
		Leases.ForgetOwnerForTests(P);
		for (int32 Conn = 900811; Conn <= 900815; ++Conn) R->NotifyConnectionClosed(Conn);
	};
	auto Advance = [&Leases, &Advanced](double Seconds) { Leases.AdvanceClockForTests(Seconds); Advanced += Seconds; };
	auto WaitersOf = [&Leases](const FString& Owner)
	{
		int32 N = 0;
		for (const HaybaMCPLease::FWaiter& W : Leases.Table().GetWaiters())
		{
			if (W.Request.Owner == Owner) ++N;
		}
		return N;
	};

	const FString Unbound = AcquireId(*R, 900811, O,
		TEXT("{\"resources\":[\"asset:/Game/__HaybaTest__/CD_Unbound\"],\"bind_connection\":false,\"label\":\"cd-unbound\"}"));
	const FString Bound = AcquireId(*R, 900811, O,
		TEXT("{\"resources\":[\"asset:/Game/__HaybaTest__/CD_Bound\"],\"label\":\"cd-bound\"}"));
	if (!TestFalse(TEXT("both leases granted"), Unbound.IsEmpty() || Bound.IsEmpty())) return false;

	// A queued ticket from a bound request dies with its connection at once.
	FString QueuedStatus;
	DataOf(Send(*R, 900812, P, TEXT("lease_acquire"), Json(TEXT("{\"resources\":[\"asset:/Game/__HaybaTest__/CD_Bound\"]}"))))
		->TryGetStringField(TEXT("status"), QueuedStatus);
	TestEqual(TEXT("the other owner is queued"), QueuedStatus, FString(TEXT("queued")));
	R->NotifyConnectionClosed(900812);
	TestEqual(TEXT("its ticket is dropped with the connection"), WaitersOf(P), 0);

	// P queues again, unbound, and O's connection closes.
	FString Ticket;
	DataOf(Send(*R, 900813, P, TEXT("lease_acquire"),
		Json(TEXT("{\"resources\":[\"asset:/Game/__HaybaTest__/CD_Bound\"],\"bind_connection\":false}"))))
		->TryGetStringField(TEXT("ticket"), Ticket);
	TestFalse(TEXT("queued with a ticket"), Ticket.IsEmpty());
	R->NotifyConnectionClosed(900811);
	TestTrue(TEXT("the bound lease is orphaned"), Leases.Table().FindLease(Bound)->IsOrphaned());
	TestFalse(TEXT("the unbound lease is untouched"), Leases.Table().FindLease(Unbound)->IsOrphaned());

	// During the grace the orphan still holds; after it, P is granted. Polls
	// stay inside the 30 s waiter TTL.
	const FString PollJson = FString::Printf(TEXT("{\"ticket\":\"%s\",\"bind_connection\":false}"), *Ticket);
	const TSharedPtr<FJsonObject> Held = DataOf(Send(*R, 900813, P, TEXT("lease_acquire"), Json(PollJson)));
	TestEqual(TEXT("still queued during the grace"), Held->GetStringField(TEXT("status")), FString(TEXT("queued")));
	TestEqual(TEXT("behind the orphan's owner"), Held->GetStringField(TEXT("holder_owner")), O);
	Advance(25.0);
	TestEqual(TEXT("queued at 25 s"),
		DataOf(Send(*R, 900813, P, TEXT("lease_acquire"), Json(PollJson)))->GetStringField(TEXT("status")), FString(TEXT("queued")));
	Advance(25.0);
	TestEqual(TEXT("queued at 50 s"),
		DataOf(Send(*R, 900813, P, TEXT("lease_acquire"), Json(PollJson)))->GetStringField(TEXT("status")), FString(TEXT("queued")));
	Advance(11.0);
	TestEqual(TEXT("granted once the orphan lapsed at 60 s"),
		DataOf(Send(*R, 900813, P, TEXT("lease_acquire"), Json(PollJson)))->GetStringField(TEXT("status")), FString(TEXT("granted")));
	TestNull(TEXT("the orphan is gone"), Leases.Table().FindLease(Bound));

	// A TCP server restart orphans every bound lease and leaves unbound ones.
	const FString Restart = AcquireId(*R, 900814, O,
		TEXT("{\"resources\":[\"asset:/Game/__HaybaTest__/CD_Restart\"],\"label\":\"cd-restart\"}"));
	if (!TestFalse(TEXT("restart lease granted"), Restart.IsEmpty())) return false;
	TestTrue(TEXT("OrphanAllBound orphans at least this lease"), Leases.Table().OrphanAllBound() >= 1);
	TestTrue(TEXT("the bound lease is orphaned"), Leases.Table().FindLease(Restart)->IsOrphaned());
	TestFalse(TEXT("the unbound lease is not"), Leases.Table().FindLease(Unbound)->IsOrphaned());
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPLeaseRenewWithoutHandleTest,
	"Hayba.MCP.Lease.RenewWithoutHandle",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPLeaseRenewWithoutHandleTest::RunTest(const FString& Parameters)
{
	using namespace HaybaMCPLeaseTest;
	const TSharedPtr<FHaybaMCPCommandHandler> R = Router();
	if (!TestTrue(TEXT("command router exists"), R.IsValid())) return false;
	FHaybaMCPLeaseManager& Leases = FHaybaMCPLeaseManager::Get();
	const FString O = UniqueOwner(TEXT("byowner"));
	const FString HolderOwner = UniqueOwner(TEXT("release-holder"));
	constexpr int32 Conn = 900801;
	ON_SCOPE_EXIT
	{
		Leases.ForgetOwnerForTests(O);
		Leases.ForgetOwnerForTests(HolderOwner);
		R->NotifyConnectionClosed(Conn);
		R->NotifyConnectionClosed(Conn + 1);
	};

	const TSharedPtr<FJsonObject> Granted = DataOf(Send(*R, Conn, O, TEXT("lease_acquire"),
		Json(TEXT("{\"resources\":[\"asset:/Game/__HaybaTest__/RWH_A\"],\"label\":\"rwh-a\"}"))));
	const FString A = Granted->GetStringField(TEXT("lease_id"));
	TestFalse(TEXT("a first grant is not reused"), Granted->GetBoolField(TEXT("reused")));
	TestEqual(TEXT("ttl_s"), Granted->GetNumberField(TEXT("ttl_s")), 120.0);
	TestEqual(TEXT("max_ttl_s"), Granted->GetNumberField(TEXT("max_ttl_s")), 900.0);
	TestEqual(TEXT("orphan_grace_s"), Granted->GetNumberField(TEXT("orphan_grace_s")), 60.0);
	TestTrue(TEXT("bind_connection"), Granted->GetBoolField(TEXT("bind_connection")));
	TestTrue(TEXT("bound_to_connection"), Granted->GetBoolField(TEXT("bound_to_connection")));
	FString Next;
	Granted->TryGetStringField(TEXT("next"), Next);
	TestTrue(TEXT("the next hint tells per-call clients what to do (R-9)"), Next.Contains(TEXT("bind_connection:false")));

	const TSharedPtr<FJsonObject> Again = DataOf(Send(*R, Conn, O, TEXT("lease_acquire"),
		Json(TEXT("{\"resources\":[\"asset:/Game/__HaybaTest__/RWH_A\"],\"label\":\"rwh-a\"}"))));
	TestTrue(TEXT("an identical acquire on the wire is reused"), Again->GetBoolField(TEXT("reused")));
	TestEqual(TEXT("same lease_id"), Again->GetStringField(TEXT("lease_id")), A);

	const FString B = AcquireId(*R, Conn, O,
		TEXT("{\"resources\":[\"asset:/Game/__HaybaTest__/RWH_B\"],\"ttl_s\":30,\"label\":\"rwh-b\"}"));

	// Renew with no handle renews every lease of the caller.
	const TSharedPtr<FJsonObject> Renewed = DataOf(Send(*R, Conn, O, TEXT("lease_renew"), Json(TEXT("{}"))));
	TestEqual(TEXT("names the owner"), Renewed->GetStringField(TEXT("owner")), O);
	TestEqual(TEXT("renewed both"), Renewed->GetNumberField(TEXT("renewed")), 2.0);
	TestEqual(TEXT("expires_in_s is the earliest"), Renewed->GetNumberField(TEXT("expires_in_s")), 30.0, 1.0);
	TSet<FString> Ids;
	for (const TSharedPtr<FJsonValue>& Item : Renewed->GetArrayField(TEXT("leases")))
	{
		Ids.Add(Item->AsObject()->GetStringField(TEXT("lease_id")));
		TestFalse(TEXT("nothing orphaned"), Item->AsObject()->GetBoolField(TEXT("orphaned")));
	}
	TestTrue(TEXT("the ids survive RedactFinalEnvelope byte for byte"), Ids.Contains(A) && Ids.Contains(B) && Ids.Num() == 2);

	// Status shows the lifetime fields.
	const TSharedPtr<FJsonObject> Status = DataOf(Send(*R, Conn, O, TEXT("lease_status"), nullptr));
	TestEqual(TEXT("status max_ttl_s"), Status->GetNumberField(TEXT("max_ttl_s")), 900.0);
	TestEqual(TEXT("status orphan_grace_s"), Status->GetNumberField(TEXT("orphan_grace_s")), 60.0);
	for (const TSharedPtr<FJsonValue>& Item : Status->GetArrayField(TEXT("leases")))
	{
		const TSharedPtr<FJsonObject> Lease = Item->AsObject();
		if (Lease->GetStringField(TEXT("owner")) != O) continue;
		TestTrue(TEXT("orphaned field"), Lease->HasField(TEXT("orphaned")));
		TestTrue(TEXT("bind_connection field"), Lease->HasField(TEXT("bind_connection")));
		TestTrue(TEXT("ttl_s field"), Lease->HasField(TEXT("ttl_s")));
	}

	// lease_release needs exactly one of lease_id, ticket or all:true.
	auto ErrorOf = [&R, &O](const FString& ParamsJson)
	{
		FString Error;
		Send(*R, Conn, O, TEXT("lease_release"), Json(ParamsJson))->TryGetStringField(TEXT("error"), Error);
		return Error;
	};
	TestTrue(TEXT("neither"), ErrorOf(TEXT("{}")).Contains(TEXT("[bad_request]")));
	TestTrue(TEXT("both"), ErrorOf(FString::Printf(TEXT("{\"lease_id\":\"%s\",\"all\":true}"), *A)).Contains(TEXT("[bad_request]")));
	TestTrue(TEXT("all:false"), ErrorOf(TEXT("{\"all\":false}")).Contains(TEXT("[bad_request]")));

	const FString HolderId = AcquireId(*R, Conn + 1, HolderOwner,
		TEXT("{\"resources\":[\"asset:/Game/__HaybaTest__/RWH_Queued\"],\"bind_connection\":false}"));
	if (!TestFalse(TEXT("ticket blocker granted"), HolderId.IsEmpty())) return false;
	const TSharedPtr<FJsonObject> Queued = DataOf(Send(*R, Conn, O, TEXT("lease_acquire"),
		Json(TEXT("{\"resources\":[\"asset:/Game/__HaybaTest__/RWH_Queued\"],\"bind_connection\":false}"))));
	const FString Ticket = Queued->GetStringField(TEXT("ticket"));
	if (!TestFalse(TEXT("owner has a queued ticket"), Ticket.IsEmpty())) return false;
	FString Mismatch;
	Send(*R, Conn + 1, HolderOwner, TEXT("lease_release"), Json(FString::Printf(TEXT("{\"ticket\":\"%s\"}"), *Ticket)))
		->TryGetStringField(TEXT("error"), Mismatch);
	TestEqual(TEXT("ticket owner mismatch is coded"), Mismatch,
		FString::Printf(TEXT("lease_release: [lease_owner_mismatch] ticket belongs to '%s'"), *O));

	const TSharedPtr<FJsonObject> All = DataOf(Send(*R, Conn, O, TEXT("lease_release"), Json(TEXT("{\"all\":true}"))));
	TestEqual(TEXT("release all drops both"), All->GetNumberField(TEXT("released")), 2.0);
	TestEqual(TEXT("owner ticket withdrawn"), All->GetNumberField(TEXT("tickets_withdrawn")), 1.0);
	TestNotNull(TEXT("another owner retains its lease"), Leases.Table().FindLease(HolderId));
	TestFalse(TEXT("owner has no tickets left"), Leases.Table().GetWaiters().ContainsByPredicate(
		[&O](const HaybaMCPLease::FWaiter& W) { return W.Request.Owner == O; }));

	FString NoLeases;
	Send(*R, Conn, O, TEXT("lease_renew"), Json(TEXT("{}")))->TryGetStringField(TEXT("error"), NoLeases);
	TestTrue(TEXT("renewing nothing says so"), NoLeases.Contains(TEXT("[no_leases]")));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPLeaseRedactedMarkerShimTest,
	"Hayba.MCP.Lease.RedactedMarkerShim",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPLeaseRedactedMarkerShimTest::RunTest(const FString& Parameters)
{
	using namespace HaybaMCPLeaseTest;
	const TSharedPtr<FHaybaMCPCommandHandler> R = Router();
	if (!TestTrue(TEXT("command router exists"), R.IsValid())) return false;
	FHaybaMCPLeaseManager& Leases = FHaybaMCPLeaseManager::Get();
	FHaybaMCPSettings& Settings = FHaybaMCPSettings::Get();
	UHaybaMCPDeveloperSettings* Dev = GetMutableDefault<UHaybaMCPDeveloperSettings>();
	const bool bPlanWas = Settings.bPlanModeEnabled;
	const EHaybaMCPLeaseEnforcement ModeWas = Dev->LeaseEnforcement;
	const FString G = UniqueOwner(TEXT("gate"));
	const FString Other = UniqueOwner(TEXT("shim-holder"));
	constexpr int32 Conn = 900901;
	ON_SCOPE_EXIT
	{
		Settings.bPlanModeEnabled = bPlanWas;
		Dev->LeaseEnforcement = ModeWas;
		Leases.ForgetOwnerForTests(G);
		Leases.ForgetOwnerForTests(Other);
		R->NotifyConnectionClosed(Conn);
		R->NotifyConnectionClosed(Conn + 1);
		R->NotifyConnectionClosed(Conn + 2);
	};
	Settings.bPlanModeEnabled = false;
	const FString Marker = TEXT("[REDACTED:token]");
	const FString GateLabel = TEXT("editor_gate:") + G;

	const FString GateLease = AcquireId(*R, Conn, G, FString::Printf(
		TEXT("{\"resources\":[\"world:/Game/__HaybaTest__/ShimMap\"],\"bind_connection\":false,\"label\":\"%s\"}"), *GateLabel));
	const FString BatchLease = AcquireId(*R, Conn, G, FString::Printf(
		TEXT("{\"resources\":[\"world:/Game/__HaybaTest__/ShimBatch\"],\"bind_connection\":false,\"label\":\"%s\"}"), *GateLabel));
	const FString AssetLease = AcquireId(*R, Conn, G,
		TEXT("{\"resources\":[\"asset:/Game/__HaybaTest__/ShimAsset\"],\"bind_connection\":false}"));
	// A build's asset lease taken through the gate with --label build:<id> (spec 5.2 Helpers).
	const FString BuildLease = AcquireId(*R, Conn, G,
		TEXT("{\"resources\":[\"asset:/Game/__HaybaTest__/ShimBuild\"],\"bind_connection\":false,\"label\":\"build:bp1\"}"));
	if (!TestFalse(TEXT("all shim leases granted"), GateLease.IsEmpty() || BatchLease.IsEmpty() || AssetLease.IsEmpty() || BuildLease.IsEmpty())) return false;
	TestTrue(TEXT("the batch lease is a running batch's"), Leases.Table().SetYieldable(BatchLease, true));

	FLogCapture LeaseLog(TEXT("LogHaybaMCPLease"));

	// A marker under the deprecated alias releases only the legacy gate lease.
	const TSharedPtr<FJsonObject> Released = DataOf(Send(*R, Conn, G, TEXT("lease_release"),
		Json(FString::Printf(TEXT("{\"token\":\"%s\"}"), *Marker))));
	TestEqual(TEXT("one legacy gate lease released"), Released->GetNumberField(TEXT("released")), 1.0);
	TestTrue(TEXT("the reply says the alias is deprecated"), Released->HasField(TEXT("deprecation")));
	TestNull(TEXT("the gate lease is gone"), Leases.Table().FindLease(GateLease));
	TestNotNull(TEXT("the batch lease stays"), Leases.Table().FindLease(BatchLease));
	TestNotNull(TEXT("the asset lease stays"), Leases.Table().FindLease(AssetLease));
	TestNotNull(TEXT("an asset lease labelled build:bp1 stays (it would be dropped mid-build under the gate's label)"),
		Leases.Table().FindLease(BuildLease));

	FString NoGate;
	Send(*R, Conn, G, TEXT("lease_release"), Json(FString::Printf(TEXT("{\"token\":\"%s\"}"), *Marker)))
		->TryGetStringField(TEXT("error"), NoGate);
	TestTrue(TEXT("no gate lease left: [lease_id_redacted]"), NoGate.Contains(TEXT("[lease_id_redacted]")));
	TestTrue(TEXT("and the hint names all:true"), NoGate.Contains(TEXT("all:true")));

	FString Canonical;
	Send(*R, Conn, G, TEXT("lease_release"), Json(FString::Printf(TEXT("{\"lease_id\":\"%s\"}"), *Marker)))
		->TryGetStringField(TEXT("error"), Canonical);
	TestTrue(TEXT("a marker under lease_id is an error"), Canonical.Contains(TEXT("[lease_id_redacted]")));
	TestNotNull(TEXT("and releases nothing"), Leases.Table().FindLease(BatchLease));

	// A marker under the alias on lease_renew renews by owner.
	const TSharedPtr<FJsonObject> Renewed = DataOf(Send(*R, Conn, G, TEXT("lease_renew"),
		Json(FString::Printf(TEXT("{\"token\":\"%s\"}"), *Marker))));
	TestEqual(TEXT("renews the owner's three remaining leases"), Renewed->GetNumberField(TEXT("renewed")), 3.0);
	TestEqual(TEXT("the alias is deprecated in T4's words"), Renewed->GetStringField(TEXT("deprecation")),
		FString(TEXT("'token' was renamed to lease_id; send lease_id")));

	// An envelope marker counts as absent: never a refusal, even under Enforced.
	Dev->LeaseEnforcement = EHaybaMCPLeaseEnforcement::Enforced;
	const TSharedPtr<FJsonObject> WriteParams = Json(
		TEXT("{\"path\":\"/Game/__HaybaTest__/BP_Shim\",\"node_type\":\"call_function\",\"function_name\":\"PrintString\"}"));
	const TSharedPtr<FJsonObject> Absent = Send(*R, Conn + 1, G, TEXT("blueprint_add_node"), WriteParams);
	const TSharedPtr<FJsonObject> Write = Send(*R, Conn + 1, G, TEXT("blueprint_add_node"), WriteParams, Marker);
	TestEqual(TEXT("marker and absent envelope have the same admission code"), CodeOf(Write), CodeOf(Absent));
	TestEqual(TEXT("marker and absent reach the same handler result"), Write->GetBoolField(TEXT("ok")), Absent->GetBoolField(TEXT("ok")));
	TestEqual(TEXT("marker and absent reach the same handler error"), Write->GetStringField(TEXT("error")), Absent->GetStringField(TEXT("error")));

	const TSharedPtr<FJsonObject> Batch = Send(*R, Conn + 1, G, TEXT("editor_batch"), Json(FString::Printf(
		TEXT("{\"lease_id\":\"%s\",\"steps\":[{\"cmd\":\"ping\",\"params\":{}}]}"), *Marker)));
	TestTrue(TEXT("explicit batch lease_id marker is refused"), Batch->GetStringField(TEXT("error")).Contains(TEXT("[lease_id_redacted]")));
	TestNotEqual(TEXT("not refused"), CodeOf(Write), FString(TEXT("lease_conflict")));
	const TSharedPtr<FJsonObject>* Warning = nullptr;
	if (TestTrue(TEXT("warned"), Write->TryGetObjectField(TEXT("lease_warning"), Warning) && Warning))
	{
		TestEqual(TEXT("reason"), (*Warning)->GetStringField(TEXT("reason")), FString(TEXT("lease_handle_redacted")));
		TestEqual(TEXT("lease_id_error"), (*Warning)->GetStringField(TEXT("lease_id_error")), FString(TEXT("redaction_marker")));
	}

	const FString ConflictId = AcquireId(*R, Conn + 2, Other,
		TEXT("{\"resources\":[\"asset:/Game/__HaybaTest__/BP_Shim\"],\"bind_connection\":false}"));
	if (!TestFalse(TEXT("conflicting holder granted"), ConflictId.IsEmpty())) return false;
	const TSharedPtr<FJsonObject> HeldAbsent = Send(*R, Conn + 1, G, TEXT("blueprint_add_node"), WriteParams);
	const TSharedPtr<FJsonObject> HeldMarker = Send(*R, Conn + 1, G, TEXT("blueprint_add_node"), WriteParams, Marker);
	TestEqual(TEXT("absent envelope still refuses a real conflict"), CodeOf(HeldAbsent), FString(TEXT("lease_conflict")));
	TestEqual(TEXT("marker preserves real-conflict admission parity"), CodeOf(HeldMarker), CodeOf(HeldAbsent));
	TestEqual(TEXT("marker preserves real-conflict reason"), HeldMarker->GetObjectField(TEXT("lease"))->GetStringField(TEXT("reason")),
		HeldAbsent->GetObjectField(TEXT("lease"))->GetStringField(TEXT("reason")));

	// Each shim use is counted in the log.
	LeaseLog.Flush();
	TestEqual(TEXT("three shim uses logged"), LeaseLog.Count(TEXT("(marker shim)"), ELogVerbosity::Log), 3);
	return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
