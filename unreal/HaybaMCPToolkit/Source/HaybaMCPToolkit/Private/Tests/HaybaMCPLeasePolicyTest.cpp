#include "Misc/AutomationTest.h"
#include "HaybaMCPAccessPolicy.h"
#include "HaybaMCPLeasePolicy.h"
#include "HaybaMCPCommandHandler.h"
#include "HaybaMCPModule.h"
#include "HaybaMCPLeaseManager.h"
#include "Modules/ModuleManager.h"

#if WITH_DEV_AUTOMATION_TESTS

namespace
{
	using namespace HaybaMCPAccess;

	FClaim ParseClaim(FAutomationTestBase& Test, const FString& Text, bool bExclusive = true)
	{
		FClaim Claim;
		FString Error;
		Test.TestTrue(*FString::Printf(TEXT("'%s' parses"), *Text), ParseResource(Text, Claim.Resource, Error));
		Claim.bExclusive = bExclusive;
		return Claim;
	}

	bool ClaimsConflict(FAutomationTestBase& Test, const FString& A, bool bAExclusive, const FString& B, bool bBExclusive)
	{
		return FindConflict(
			ExpandClaims({ ParseClaim(Test, A, bAExclusive) }),
			ExpandClaims({ ParseClaim(Test, B, bBExclusive) }));
	}

	HaybaMCPLease::FRequest MakeRequest(
		FAutomationTestBase& Test,
		const FString& Owner,
		const FString& Resource,
		HaybaMCPLease::ELane Lane = HaybaMCPLease::ELane::Interactive,
		bool bExclusive = true)
	{
		HaybaMCPLease::FRequest Request;
		Request.Owner = Owner;
		Request.Claims.Add(ParseClaim(Test, Resource, bExclusive));
		Request.Lane = Lane;
		return Request;
	}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPLeaseClassificationTest,
	"Hayba.MCP.Lease.Classification",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPLeaseClassificationTest::RunTest(const FString& Parameters)
{
	TestEqual(TEXT("level_save is a world write"),
		ClassifyCommand(TEXT("level_save"), false).Class, EAccessClass::WriteWorld);
	TestEqual(TEXT("wp_load_cell is a world write"),
		ClassifyCommand(TEXT("wp_load_cell"), false).Class, EAccessClass::WriteWorld);
	TestEqual(TEXT("editor_save* is a world write"),
		ClassifyCommand(TEXT("editor_save_current_level"), false).Class, EAccessClass::WriteWorld);
	TestEqual(TEXT("save-and-quit is global even though it starts editor_save"),
		ClassifyCommand(TEXT("editor_save_all_and_quit"), true).Class, EAccessClass::Global);
	TestEqual(TEXT("level_load is global"), ClassifyCommand(TEXT("level_load"), false).Class, EAccessClass::Global);
	TestEqual(TEXT("level_create is global"), ClassifyCommand(TEXT("level_create"), true).Class, EAccessClass::Global);
	TestEqual(TEXT("console commands are global"),
		ClassifyCommand(TEXT("editor_run_console_command"), true).Class, EAccessClass::Global);
	TestEqual(TEXT("every editor_pie_* is global"),
		ClassifyCommand(TEXT("editor_pie_screenshot"), false).Class, EAccessClass::Global);
	TestEqual(TEXT("lease control plane is a read"),
		ClassifyCommand(TEXT("lease_acquire"), false).Class, EAccessClass::Read);

	const FClassification Spawn = ClassifyCommand(TEXT("actor_spawn"), true);
	TestEqual(TEXT("a destructive command defaults to scoped write"), Spawn.Class, EAccessClass::WriteScoped);
	TestFalse(TEXT("the default is marked derived"), Spawn.bExplicit);
	TestEqual(TEXT("a non-destructive command defaults to read"),
		ClassifyCommand(TEXT("actor_list"), false).Class, EAccessClass::Read);

	TestEqual(TEXT("python_run by name is an undeclared mutation"),
		ClassifyCommand(TEXT("python_run"), true).Class, EAccessClass::WriteWorld);
	TestEqual(TEXT("a WP python script is a world write whatever its tier"),
		ClassifyPythonRun(true, true, true), EAccessClass::WriteWorld);
	TestEqual(TEXT("declared resources scope a python mutation"),
		ClassifyPythonRun(false, false, true), EAccessClass::WriteScoped);
	TestEqual(TEXT("a read-only-tier script is a read"),
		ClassifyPythonRun(true, false, false), EAccessClass::Read);
	TestEqual(TEXT("an undeclared python mutation is a world write"),
		ClassifyPythonRun(false, false, false), EAccessClass::WriteWorld);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPLeaseAssetWriteTest,
	"Hayba.MCP.Lease.AssetWrites",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPLeaseAssetWriteTest::RunTest(const FString& Parameters)
{
	// Blueprint graph and widget authoring write one asset. They are scoped
	// writes whatever Plan Mode says, including compile-and-save, which Plan
	// Mode does not gate.
	const FClassification Node = ClassifyCommand(TEXT("blueprint_add_node"), true);
	TestEqual(TEXT("blueprint graph authoring is a scoped write"), Node.Class, EAccessClass::WriteScoped);
	TestTrue(TEXT("by the asset table, not by default"), Node.bExplicit);
	TestEqual(TEXT("blueprint compile-and-save is a scoped write even ungated"),
		ClassifyCommand(TEXT("blueprint_compile"), false).Class, EAccessClass::WriteScoped);
	TestEqual(TEXT("widget authoring is a scoped write even ungated"),
		ClassifyCommand(TEXT("ui_set_variable"), false).Class, EAccessClass::WriteScoped);

	// Every spelling of one asset is one lock.
	TestEqual(TEXT("package path"), AssetPackageKey(TEXT("/Game/Pawn/BP_Pawn")), FString(TEXT("/game/pawn/bp_pawn")));
	TestEqual(TEXT("object path"), AssetPackageKey(TEXT("/Game/Pawn/BP_Pawn.BP_Pawn")), FString(TEXT("/game/pawn/bp_pawn")));
	TestEqual(TEXT("class path"), AssetPackageKey(TEXT("/Game/Pawn/BP_Pawn.BP_Pawn_C")), FString(TEXT("/game/pawn/bp_pawn")));
	TestTrue(TEXT("a bare name is not a package"), AssetPackageKey(TEXT("BP_Pawn")).IsEmpty());
	TestTrue(TEXT("a resource string is not a package"), AssetPackageKey(TEXT("asset:/Game/X")).IsEmpty());

	TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
	Params->SetStringField(TEXT("path"), TEXT("/Game/Pawn/BP_Pawn.BP_Pawn"));
	FClaim Claim;
	TestTrue(TEXT("a Blueprint writer implies its asset"), ImpliedAssetClaim(TEXT("blueprint_connect_nodes"), Params, Claim));
	TestEqual(TEXT("as asset:<package>"), Claim.Resource.Key(), FString(TEXT("asset:/game/pawn/bp_pawn")));
	TestTrue(TEXT("exclusively"), Claim.bExclusive);
	FClaim Other;
	TestFalse(TEXT("other commands imply nothing"), ImpliedAssetClaim(TEXT("actor_spawn"), Params, Other));
	TestFalse(TEXT("nor does a request without the path"),
		ImpliedAssetClaim(TEXT("blueprint_connect_nodes"), MakeShared<FJsonObject>(), Other));
	TestFalse(TEXT("a widget writer does not read 'path'"), ImpliedAssetClaim(TEXT("ui_build_tree"), Params, Other));

	TSharedPtr<FJsonObject> WidgetParams = MakeShared<FJsonObject>();
	WidgetParams->SetStringField(TEXT("widget_blueprint_path"), TEXT("/Game/UI/WBP_Menu.WBP_Menu"));
	FClaim Widget;
	TestTrue(TEXT("a widget writer implies its widget blueprint"), ImpliedAssetClaim(TEXT("ui_build_tree"), WidgetParams, Widget));
	TestEqual(TEXT("keyed on widget_blueprint_path"), Widget.Resource.Key(), FString(TEXT("asset:/game/ui/wbp_menu")));

	// Two agents on one Blueprint collide; on different assets, or against a
	// world lease, they do not: an asset is not inside a world.
	const TArray<FLock> Mine = RequiredLocks(EAccessClass::WriteScoped, { Claim }, TEXT("/Game/Maps/Valley"));
	Params->SetStringField(TEXT("path"), TEXT("/Game/Pawn/BP_Pawn"));
	FClaim Same;
	ImpliedAssetClaim(TEXT("blueprint_add_node"), Params, Same);
	TestTrue(TEXT("same Blueprint, two spellings: conflict"),
		FindConflict(Mine, RequiredLocks(EAccessClass::WriteScoped, { Same }, TEXT("/Game/Maps/Valley"))));
	TestFalse(TEXT("a Blueprint and a widget: no conflict"),
		FindConflict(Mine, RequiredLocks(EAccessClass::WriteScoped, { Widget }, TEXT("/Game/Maps/Valley"))));
	TestFalse(TEXT("a world lease does not block asset authoring"),
		FindConflict(Mine, ExpandClaims({ ParseClaim(*this, TEXT("world:/Game/Maps/Valley")) })));
	TestTrue(TEXT("a global lease does"), FindConflict(Mine, ExpandClaims({ FClaim() })));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPLeaseResourceTest,
	"Hayba.MCP.Lease.Resources",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPLeaseResourceTest::RunTest(const FString& Parameters)
{
	FResource R;
	FString Error;
	TestTrue(TEXT("world parses"), ParseResource(TEXT("world:/Game/Maps/Valley"), R, Error));
	TestEqual(TEXT("world key is lower-cased"), R.Key(), FString(TEXT("world:/game/maps/valley")));

	TestTrue(TEXT("region parses"), ParseResource(TEXT("wp-region:/Game/Maps/Valley:-100,-50.5,200,300"), R, Error));
	TestEqual(TEXT("region belongs to its world"), R.World, FString(TEXT("/game/maps/valley")));
	TestEqual(TEXT("region min x"), R.MinX, -100.0);
	TestEqual(TEXT("region ancestors are global then world"), R.AncestorKeys(),
		TArray<FString>{ TEXT("global"), TEXT("world:/game/maps/valley") });

	TestTrue(TEXT("actor parses"), ParseResource(TEXT("actor:/Game/Maps/Valley.Valley:PersistentLevel.Tree_3"), R, Error));
	TestEqual(TEXT("actor world is the package before the first dot"), R.World, FString(TEXT("/game/maps/valley")));
	TestTrue(TEXT("asset parses"), ParseResource(TEXT("asset:/Game/Props/SM_Rock"), R, Error));
	TestEqual(TEXT("an asset sits directly under global"), R.AncestorKeys(), TArray<FString>{ TEXT("global") });
	TestTrue(TEXT("pie parses"), ParseResource(TEXT("pie"), R, Error));
	TestTrue(TEXT("global parses"), ParseResource(TEXT(" GLOBAL "), R, Error));

	TestFalse(TEXT("unknown kind is rejected"), ParseResource(TEXT("level:/Game/X"), R, Error));
	TestFalse(TEXT("world without a package path is rejected"), ParseResource(TEXT("world:Valley"), R, Error));
	TestFalse(TEXT("region with three numbers is rejected"), ParseResource(TEXT("wp-region:/Game/V:0,0,1"), R, Error));
	TestFalse(TEXT("region with min > max is rejected"), ParseResource(TEXT("wp-region:/Game/V:5,0,1,1"), R, Error));
	TestFalse(TEXT("region with a non-number is rejected"), ParseResource(TEXT("wp-region:/Game/V:a,0,1,1"), R, Error));
	TestFalse(TEXT("asset without a path is rejected"), ParseResource(TEXT("asset:SM_Rock"), R, Error));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPLeaseLockTest,
	"Hayba.MCP.Lease.Locks",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPLeaseLockTest::RunTest(const FString& Parameters)
{
	TestTrue(TEXT("IS/IX are compatible"), AreCompatible(ELockMode::IntentShared, ELockMode::IntentExclusive));
	TestTrue(TEXT("IX/IX are compatible"), AreCompatible(ELockMode::IntentExclusive, ELockMode::IntentExclusive));
	TestFalse(TEXT("IX/S conflict"), AreCompatible(ELockMode::IntentExclusive, ELockMode::Shared));
	TestTrue(TEXT("S/S are compatible"), AreCompatible(ELockMode::Shared, ELockMode::Shared));
	TestFalse(TEXT("X conflicts with IS"), AreCompatible(ELockMode::Exclusive, ELockMode::IntentShared));

	const FString W = TEXT("world:/Game/V");
	const FString A1 = TEXT("actor:/Game/V.V:PersistentLevel.A1");
	const FString A2 = TEXT("actor:/Game/V.V:PersistentLevel.A2");
	TestFalse(TEXT("two actors in one world do not conflict"), ClaimsConflict(*this, A1, true, A2, true));
	TestTrue(TEXT("the same actor conflicts"), ClaimsConflict(*this, A1, true, A1, true));
	TestTrue(TEXT("a world holder excludes an actor writer"), ClaimsConflict(*this, W, true, A1, true));
	TestTrue(TEXT("a shared world reader excludes an actor writer"), ClaimsConflict(*this, W, false, A1, true));
	TestFalse(TEXT("a shared world reader and a shared actor reader coexist"), ClaimsConflict(*this, W, false, A1, false));
	TestTrue(TEXT("global excludes everything below it"), ClaimsConflict(*this, TEXT("global"), true, A1, false));
	TestFalse(TEXT("different worlds are independent"),
		ClaimsConflict(*this, W, true, TEXT("world:/Game/Other"), true));
	TestFalse(TEXT("an asset does not collide with a world"),
		ClaimsConflict(*this, W, true, TEXT("asset:/Game/Props/SM_Rock"), true));
	TestTrue(TEXT("pie collides with global"), ClaimsConflict(*this, TEXT("pie"), true, TEXT("global"), false));

	const FString R1 = TEXT("wp-region:/Game/V:0,0,100,100");
	TestTrue(TEXT("overlapping regions conflict"),
		ClaimsConflict(*this, R1, true, TEXT("wp-region:/Game/V:50,50,150,150"), true));
	TestFalse(TEXT("overlapping shared regions coexist"),
		ClaimsConflict(*this, R1, false, TEXT("wp-region:/Game/V:50,50,150,150"), false));
	TestFalse(TEXT("edge-touching regions do not conflict"),
		ClaimsConflict(*this, R1, true, TEXT("wp-region:/Game/V:100,0,200,100"), true));
	TestFalse(TEXT("overlapping regions of different worlds do not conflict"),
		ClaimsConflict(*this, R1, true, TEXT("wp-region:/Game/Other:0,0,100,100"), true));
	TestTrue(TEXT("a region writer collides with a world holder"), ClaimsConflict(*this, R1, true, W, false));

	// RequiredLocks: what a command needs from its class.
	const FString World = TEXT("/Game/V");
	const TArray<FLock> Scoped = RequiredLocks(EAccessClass::WriteScoped, {}, World);
	TestFalse(TEXT("two undeclared scoped writers coexist"), FindConflict(Scoped, Scoped));
	TestTrue(TEXT("a scoped writer collides with a world writer"),
		FindConflict(Scoped, RequiredLocks(EAccessClass::WriteWorld, {}, World)));
	TestTrue(TEXT("a world writer collides with a world writer"),
		FindConflict(RequiredLocks(EAccessClass::WriteWorld, {}, World), RequiredLocks(EAccessClass::WriteWorld, {}, World)));
	TestFalse(TEXT("world writers of different worlds coexist"),
		FindConflict(RequiredLocks(EAccessClass::WriteWorld, {}, World),
			RequiredLocks(EAccessClass::WriteWorld, {}, TEXT("/Game/Other"))));
	TestTrue(TEXT("a global command collides with a scoped writer"),
		FindConflict(RequiredLocks(EAccessClass::Global, {}, World), Scoped));
	TestEqual(TEXT("a read needs no locks"), RequiredLocks(EAccessClass::Read, {}, World).Num(), 0);

	const TArray<FLock> Declared = RequiredLocks(EAccessClass::WriteScoped, { ParseClaim(*this, A1, false) }, World);
	TestTrue(TEXT("declared resources are always taken exclusively"),
		HoldsExclusiveOn(Declared, ParseClaim(*this, A1).Resource.Key()));
	TestTrue(TEXT("exclusive on global covers any key"),
		HoldsExclusiveOn(RequiredLocks(EAccessClass::Global, {}, World), TEXT("world:/game/v")));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPLeaseTableTest,
	"Hayba.MCP.Lease.Table",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPLeaseTableTest::RunTest(const FString& Parameters)
{
	using namespace HaybaMCPLease;
	double Now = 1000.0;
	FTable Table([&Now]() { return Now; });
	const FString World = TEXT("world:/Game/V");

	const FAcquireResult A = Table.Acquire(MakeRequest(*this, TEXT("agent-a"), World));
	TestEqual(TEXT("a free world is granted"), A.Status, EStatus::Granted);
	TestEqual(TEXT("default TTL is 120 s"), A.ExpiresAt, Now + 120.0);

	const FAcquireResult Again = Table.Acquire(MakeRequest(*this, TEXT("agent-a"), World));
	TestEqual(TEXT("an owner never conflicts with itself"), Again.Status, EStatus::Granted);

	const FAcquireResult B = Table.Acquire(MakeRequest(*this, TEXT("agent-b"), World));
	TestEqual(TEXT("another owner is queued, not blocked"), B.Status, EStatus::Queued);
	TestEqual(TEXT("first in line"), B.Position, 1);
	TestEqual(TEXT("the holder is named"), B.HolderOwner, FString(TEXT("agent-a")));
	TestEqual(TEXT("ETA is the holder's remaining TTL"), B.EtaSeconds, 120.0);
	TestFalse(TEXT("the conflict is described"), B.ConflictDetail.IsEmpty());

	FString Error;
	TestFalse(TEXT("only the owner may release"), Table.Release(A.Token, TEXT("agent-b"), Error));
	TestTrue(TEXT("owner releases its first lease"), Table.Release(A.Token, TEXT("agent-a"), Error));
	HaybaMCPLease::FRequest Poll = MakeRequest(*this, TEXT("agent-b"), World);
	Poll.Ticket = B.Token;
	TestEqual(TEXT("still blocked by the owner's second lease"), Table.Acquire(Poll).Status, EStatus::Queued);
	TestTrue(TEXT("owner releases its second lease"), Table.Release(Again.Token, TEXT("agent-a"), Error));
	const FAcquireResult BGranted = Table.Acquire(Poll);
	TestEqual(TEXT("polling the ticket grants once free"), BGranted.Status, EStatus::Granted);
	TestEqual(TEXT("the ticket is spent"), Table.GetWaiters().Num(), 0);

	// Renew and expiry.
	double NewExpiry = 0.0;
	TestFalse(TEXT("only the owner may renew"), Table.Renew(BGranted.Token, TEXT("agent-a"), 60.0, NewExpiry, Error));
	TestTrue(TEXT("renew extends"), Table.Renew(BGranted.Token, TEXT("agent-b"), 5000.0, NewExpiry, Error));
	TestEqual(TEXT("renew clamps to the 900 s max"), NewExpiry, Now + 900.0);
	Now += 900.0;
	TestNull(TEXT("a lapsed lease disappears"), Table.FindLease(BGranted.Token));
	TestFalse(TEXT("renewing a lapsed lease fails"), Table.Renew(BGranted.Token, TEXT("agent-b"), 60.0, NewExpiry, Error));

	// bind_connection.
	HaybaMCPLease::FRequest Bound = MakeRequest(*this, TEXT("agent-c"), World);
	Bound.ConnId = 7;
	const FAcquireResult C = Table.Acquire(Bound);
	TestEqual(TEXT("bound lease granted"), C.Status, EStatus::Granted);
	TestEqual(TEXT("a disconnect releases what the connection held"), Table.ReleaseConnection(7), 1);
	TestNull(TEXT("bound lease is gone"), Table.FindLease(C.Token));
	TestEqual(TEXT("connection 0 is never released"), Table.ReleaseConnection(0), 0);

	// Abandoned waiters drop out.
	const FAcquireResult Holder = Table.Acquire(MakeRequest(*this, TEXT("agent-d"), World));
	const FAcquireResult Abandoned = Table.Acquire(MakeRequest(*this, TEXT("agent-e"), World));
	TestEqual(TEXT("second agent queued"), Abandoned.Status, EStatus::Queued);
	Now += 31.0;
	Table.Expire();
	TestEqual(TEXT("a waiter that stopped polling is dropped"), Table.GetWaiters().Num(), 0);
	HaybaMCPLease::FRequest Stale = MakeRequest(*this, TEXT("agent-e"), World);
	Stale.Ticket = Abandoned.Token;
	TestEqual(TEXT("a dropped ticket is rejected, not silently re-queued"), Table.Acquire(Stale).Status, EStatus::Rejected);
	TestTrue(TEXT("holder still owns its lease"), Table.FindLease(Holder.Token) != nullptr);

	// Enforcement queries.
	TestTrue(TEXT("holder is seen as exclusive on the world"),
		Table.OwnerHoldsExclusive(TEXT("agent-d"), TEXT("world:/game/v")));
	TestNotNull(TEXT("another owner's world write conflicts"),
		Table.FindConflictingHolder(TEXT("agent-x"), RequiredLocks(EAccessClass::WriteWorld, {}, TEXT("/Game/V"))));
	TestNull(TEXT("the holder's own write does not conflict"),
		Table.FindConflictingHolder(TEXT("agent-d"), RequiredLocks(EAccessClass::WriteWorld, {}, TEXT("/Game/V"))));
	TestNull(TEXT("reads never conflict"),
		Table.FindConflictingHolder(TEXT("agent-x"), RequiredLocks(EAccessClass::Read, {}, TEXT("/Game/V"))));

	// Validation.
	HaybaMCPLease::FRequest NoOwner = MakeRequest(*this, TEXT(""), World);
	TestEqual(TEXT("owner is required"), Table.Acquire(NoOwner).Status, EStatus::Rejected);
	HaybaMCPLease::FRequest NoClaims;
	NoClaims.Owner = TEXT("agent-f");
	TestEqual(TEXT("a resource is required"), Table.Acquire(NoClaims).Status, EStatus::Rejected);

	// Plan approval is per owner.
	TestTrue(TEXT("the proposer may spend its approval"), PlanApprovalApplies(true, TEXT("a"), TEXT("a")));
	TestFalse(TEXT("another owner may not spend it"), PlanApprovalApplies(true, TEXT("a"), TEXT("b")));
	TestTrue(TEXT("an ownerless plan keeps the old global rule"), PlanApprovalApplies(true, TEXT(""), TEXT("b")));
	TestFalse(TEXT("no approval is no approval"), PlanApprovalApplies(false, TEXT(""), TEXT("b")));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPLeaseAssetHoldersTest,
	"Hayba.MCP.Lease.AssetHolders",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPLeaseAssetHoldersTest::RunTest(const FString& Parameters)
{
	using namespace HaybaMCPLease;
	double Now = 1000.0;
	FTable Table([&Now]() { return Now; });
	TestEqual(TEXT("an empty table has no asset holders"), Table.FindAssetHolders(FString()).Num(), 0);

	// A build holds two assets exclusively in one lease (D5). A reader shares a
	// third asset. A world writer holds a world.
	FRequest Build = MakeRequest(*this, TEXT("builder"), TEXT("asset:/Game/B/BP_A"), ELane::Long);
	Build.Claims.Add(ParseClaim(*this, TEXT("asset:/Game/B/BP_B")));
	Build.Label = TEXT("build:bpgraph_1");
	Build.TtlSeconds = 60.0;
	TestEqual(TEXT("the build lease is granted"), Table.Acquire(Build).Status, EStatus::Granted);
	TestEqual(TEXT("a shared asset reader is granted"),
		Table.Acquire(MakeRequest(*this, TEXT("reader"), TEXT("asset:/Game/B/BP_C"), ELane::Interactive, false)).Status,
		EStatus::Granted);
	TestEqual(TEXT("a world writer is granted"),
		Table.Acquire(MakeRequest(*this, TEXT("mapper"), TEXT("world:/Game/Maps/V"))).Status, EStatus::Granted);

	const TArray<FAssetHold> All = Table.FindAssetHolders(FString());
	TestEqual(TEXT("only exclusive asset locks count, one per asset"), All.Num(), 2);
	TSet<FString> Keys;
	for (const FAssetHold& Hold : All)
	{
		Keys.Add(Hold.AssetKey);
		if (TestNotNull(TEXT("every hold names its lease"), Hold.Lease))
		{
			TestEqual(TEXT("held by the builder"), Hold.Lease->Owner, FString(TEXT("builder")));
			TestEqual(TEXT("with its label"), Hold.Lease->Label, FString(TEXT("build:bpgraph_1")));
		}
	}
	TestTrue(TEXT("asset A is listed by its lock key"), Keys.Contains(TEXT("asset:/game/b/bp_a")));
	TestTrue(TEXT("asset B is listed by its lock key"), Keys.Contains(TEXT("asset:/game/b/bp_b")));

	TestEqual(TEXT("excluding the builder leaves nobody"), Table.FindAssetHolders(TEXT("builder")).Num(), 0);
	TestEqual(TEXT("another caller sees the build"), Table.FindAssetHolders(TEXT("lane5")).Num(), 2);
	TestEqual(TEXT("one asset key"), Table.FindAssetHolders(FString(), TEXT("asset:/game/b/bp_a")).Num(), 1);
	TestEqual(TEXT("the key match ignores case"), Table.FindAssetHolders(FString(), TEXT("asset:/Game/B/BP_A")).Num(), 1);
	TestEqual(TEXT("a shared-only asset is not busy"), Table.FindAssetHolders(FString(), TEXT("asset:/game/b/bp_c")).Num(), 0);
	TestEqual(TEXT("a world key is never an asset hold"), Table.FindAssetHolders(FString(), TEXT("world:/game/maps/v")).Num(), 0);

	// A global X holder (the editor gate) is not an asset build.
	{
		double GateNow = 0.0;
		FTable Gate([&GateNow]() { return GateNow; });
		TestEqual(TEXT("a global lease is granted"), Gate.Acquire(MakeRequest(*this, TEXT("gate"), TEXT("global"))).Status, EStatus::Granted);
		TestEqual(TEXT("a global lease marks no asset busy"), Gate.FindAssetHolders(FString()).Num(), 0);
	}

	// Expire runs first: a lapsed build is no longer busy; the others remain.
	Now += 61.0;
	TestEqual(TEXT("a lapsed build lease is no longer busy"), Table.FindAssetHolders(FString()).Num(), 0);
	TestEqual(TEXT("the unrelated leases are still held"), Table.GetLeases().Num(), 2);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPLeaseFairQueueTest,
	"Hayba.MCP.Lease.FairQueue",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPLeaseFairQueueTest::RunTest(const FString& Parameters)
{
	using namespace HaybaMCPLease;
	const FString Region = TEXT("wp-region:/Game/V:0,0,100,100");
	const FString Actor = TEXT("actor:/Game/V.V:PersistentLevel.A1");
	const FString World = TEXT("world:/Game/V");

	// Interactive overtakes long; each overtaking conflicting grant counts.
	{
		double Now = 0.0;
		FTuning Tuning;
		Tuning.AgingGrants = 2;
		Tuning.AgingSeconds = 1000.0;
		FTable Table([&Now]() { return Now; }, Tuning);

		const FAcquireResult Holder = Table.Acquire(MakeRequest(*this, TEXT("holder"), Actor));
		TestEqual(TEXT("holder granted"), Holder.Status, EStatus::Granted);
		const FAcquireResult Long = Table.Acquire(MakeRequest(*this, TEXT("bulk"), World, ELane::Long));
		TestEqual(TEXT("long world request waits behind the actor holder"), Long.Status, EStatus::Queued);

		// An interactive request that conflicts with the queued long one but not
		// with the holder is served first.
		const FAcquireResult Quick1 = Table.Acquire(MakeRequest(*this, TEXT("quick1"), TEXT("actor:/Game/V.V:PersistentLevel.B1")));
		TestEqual(TEXT("interactive overtakes a long waiter"), Quick1.Status, EStatus::Granted);
		TestEqual(TEXT("the overtaken waiter counts the bypass"), Table.GetWaiters()[0].Bypassed, 1);
		TestFalse(TEXT("one bypass does not age it"), Table.IsAged(Table.GetWaiters()[0], Now));

		const FAcquireResult Quick2 = Table.Acquire(MakeRequest(*this, TEXT("quick2"), TEXT("actor:/Game/V.V:PersistentLevel.B2")));
		TestEqual(TEXT("second interactive still overtakes"), Quick2.Status, EStatus::Granted);
		TestTrue(TEXT("K bypasses age the long waiter"), Table.IsAged(Table.GetWaiters()[0], Now));

		const FAcquireResult Quick3 = Table.Acquire(MakeRequest(*this, TEXT("quick3"), TEXT("actor:/Game/V.V:PersistentLevel.B3")));
		TestEqual(TEXT("an aged long waiter cannot be overtaken"), Quick3.Status, EStatus::Queued);
		// Position is the 1-based place in line: one waiter (the aged long one)
		// goes first, so this request is second.
		TestEqual(TEXT("the aged waiter is ahead"), Quick3.Position, 2);
		TestEqual(TEXT("the queue names who is ahead"), Quick3.HolderOwner, FString(TEXT("bulk")));

		const FAcquireResult Unrelated = Table.Acquire(MakeRequest(*this, TEXT("other"), TEXT("world:/Game/Other")));
		TestEqual(TEXT("a non-conflicting request is never held back"), Unrelated.Status, EStatus::Granted);

		FString Error;
		Table.Release(Holder.Token, TEXT("holder"), Error);
		Table.Release(Quick1.Token, TEXT("quick1"), Error);
		Table.Release(Quick2.Token, TEXT("quick2"), Error);
		HaybaMCPLease::FRequest QuickPoll = MakeRequest(*this, TEXT("quick3"), TEXT("actor:/Game/V.V:PersistentLevel.B3"));
		QuickPoll.Ticket = Quick3.Token;
		TestEqual(TEXT("with the holders gone the later interactive is still behind the aged waiter"),
			Table.Acquire(QuickPoll).Status, EStatus::Queued);
		HaybaMCPLease::FRequest LongPoll = MakeRequest(*this, TEXT("bulk"), World, ELane::Long);
		LongPoll.Ticket = Long.Token;
		TestEqual(TEXT("the aged waiter is granted first"), Table.Acquire(LongPoll).Status, EStatus::Granted);
		TestEqual(TEXT("and the interactive now waits on a holder"), Table.Acquire(QuickPoll).Status, EStatus::Queued);
	}

	// Time alone ages a long waiter.
	{
		double Now = 0.0;
		FTuning Tuning;
		Tuning.AgingGrants = 100;
		Tuning.AgingSeconds = 20.0;
		Tuning.WaiterTtlSeconds = 1000.0;
		FTable Table([&Now]() { return Now; }, Tuning);
		Table.Acquire(MakeRequest(*this, TEXT("holder"), Region));
		const FAcquireResult Long = Table.Acquire(MakeRequest(*this, TEXT("bulk"), World, ELane::Long));
		TestEqual(TEXT("long waiter queued"), Long.Status, EStatus::Queued);
		TestFalse(TEXT("not aged yet"), Table.IsAged(Table.GetWaiters()[0], Now));
		Now += 20.0;
		TestTrue(TEXT("T seconds age it"), Table.IsAged(Table.GetWaiters()[0], Now));
		const FAcquireResult Late = Table.Acquire(MakeRequest(*this, TEXT("late"), TEXT("wp-region:/Game/V:500,500,600,600")));
		TestEqual(TEXT("a later conflicting interactive waits behind the aged long waiter"), Late.Status, EStatus::Queued);
	}

	// Two long waiters keep arrival order.
	{
		double Now = 0.0;
		FTable Table([&Now]() { return Now; });
		Table.Acquire(MakeRequest(*this, TEXT("holder"), World));
		const FAcquireResult First = Table.Acquire(MakeRequest(*this, TEXT("first"), World, ELane::Long));
		const FAcquireResult Second = Table.Acquire(MakeRequest(*this, TEXT("second"), World, ELane::Long));
		TestEqual(TEXT("first long waiter is at position 1"), First.Position, 1);
		TestEqual(TEXT("second long waiter is at position 2"), Second.Position, 2);
	}
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPLeaseClassificationDriftTest,
	"Hayba.MCP.Lease.ClassificationDrift",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPLeaseClassificationDriftTest::RunTest(const FString& Parameters)
{
	FHaybaMCPModule* Module = FModuleManager::GetModulePtr<FHaybaMCPModule>(TEXT("HaybaMCPToolkit"));
	if (!TestNotNull(TEXT("toolkit module is loaded"), Module)) return false;
	const TSharedPtr<FHaybaMCPCommandHandler> Router = Module->GetCommandHandler();
	if (!TestTrue(TEXT("command router exists"), Router.IsValid())) return false;

	const TSet<FString> Registered(Router->GetAllCommands());
	TestTrue(TEXT("a plausible command surface is registered"), Registered.Num() > 100);

	// Every explicit table entry must be a real command. A typo here silently
	// downgrades that command to its derived class (the editor_execute_console
	// failure mode of the Plan-Mode gate).
	for (const FString& Cmd : WriteWorldCommands())
	{
		TestTrue(*FString::Printf(TEXT("WriteWorld table names a registered command: %s"), *Cmd), Registered.Contains(Cmd));
	}
	for (const FString& Cmd : GlobalCommands())
	{
		TestTrue(*FString::Printf(TEXT("Global table names a registered command: %s"), *Cmd), Registered.Contains(Cmd));
	}
	for (const TPair<FString, FString>& Entry : AssetWriteCommands())
	{
		TestTrue(*FString::Printf(TEXT("AssetWrite table names a registered command: %s"), *Entry.Key), Registered.Contains(Entry.Key));
	}
	// S1 rows are pinned (P0 spec T3 design 1). Blueprint rows key on path and
	// widget rows on widget_blueprint_path. The deploy branch's animation rows
	// arrive by merge, and that merge updates this pin to the union (spec 7.3).
	const TMap<FString, FString> ExpectedAssetWrites = {
		{ TEXT("blueprint_add_node"), TEXT("path") },
		{ TEXT("blueprint_connect_nodes"), TEXT("path") },
		{ TEXT("blueprint_set_pin_default"), TEXT("path") },
		{ TEXT("blueprint_add_variable"), TEXT("path") },
		{ TEXT("blueprint_add_function"), TEXT("path") },
		{ TEXT("blueprint_add_event"), TEXT("path") },
		{ TEXT("blueprint_compile"), TEXT("path") },
		{ TEXT("ui_build_tree"), TEXT("widget_blueprint_path") },
		{ TEXT("ui_mutate_tree"), TEXT("widget_blueprint_path") },
		{ TEXT("ui_set_variable"), TEXT("widget_blueprint_path") },
		{ TEXT("ui_set_widget_properties"), TEXT("widget_blueprint_path") },
		{ TEXT("ui_add_element"), TEXT("widget_blueprint_path") },
		{ TEXT("ui_bind_property"), TEXT("widget_blueprint_path") },
		{ TEXT("ui_compile_widget"), TEXT("widget_blueprint_path") },
		{ TEXT("ui_save_widget"), TEXT("widget_blueprint_path") },
	};
	TestEqual(TEXT("AssetWrite rows are exactly the Blueprint and widget writers"),
		AssetWriteCommands().Num(), ExpectedAssetWrites.Num());
	for (const TPair<FString, FString>& Row : ExpectedAssetWrites)
	{
		const FString* Field = AssetWriteCommands().Find(Row.Key);
		TestTrue(*FString::Printf(TEXT("AssetWrite row %s keys on %s"), *Row.Key, *Row.Value),
			Field != nullptr && *Field == Row.Value);
		const FClassification RowClass = ClassifyCommand(Row.Key, false);
		TestEqual(*FString::Printf(TEXT("AssetWrite row %s is a scoped write"), *Row.Key), RowClass.Class, EAccessClass::WriteScoped);
		TestTrue(*FString::Printf(TEXT("AssetWrite row %s is explicit"), *Row.Key), RowClass.bExplicit);
	}

	// Every registered command classifies, and nothing Plan Mode gates is a read.
	for (const FString& Cmd : Registered)
	{
		const bool bDestructive = FHaybaMCPCommandHandler::IsPlanGatedCommand(Cmd);
		const FClassification Class = ClassifyCommand(Cmd, bDestructive);
		if (bDestructive)
		{
			TestNotEqual(*FString::Printf(TEXT("plan-gated command is not classified read: %s"), *Cmd),
				Class.Class, EAccessClass::Read);
		}
	}
	for (const FString& Cmd : { FString(TEXT("lease_acquire")), FString(TEXT("lease_renew")),
		FString(TEXT("lease_release")), FString(TEXT("lease_status")),
		FString(TEXT("editor_batch")), FString(TEXT("batch_status")) })
	{
		TestTrue(*FString::Printf(TEXT("lease command is registered: %s"), *Cmd), Registered.Contains(Cmd));
	}
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPLeaseEnvelopeTest,
	"Hayba.MCP.Lease.Envelope",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPLeaseEnvelopeTest::RunTest(const FString& Parameters)
{
	TSharedPtr<FJsonObject> Envelope = MakeShared<FJsonObject>();
	TestEqual(TEXT("no owner field: one owner per connection"),
		FHaybaMCPLeaseManager::ResolveOwner(Envelope, 12), FString(TEXT("conn:12")));
	TestEqual(TEXT("no owner and no connection: local"),
		FHaybaMCPLeaseManager::ResolveOwner(Envelope, 0), FString(TEXT("local")));
	Envelope->SetStringField(TEXT("owner"), TEXT("  agent-7  "));
	TestEqual(TEXT("owner field wins and is trimmed"),
		FHaybaMCPLeaseManager::ResolveOwner(Envelope, 12), FString(TEXT("agent-7")));
	Envelope->SetStringField(TEXT("owner"), FString::ChrN(500, TEXT('a')));
	TestEqual(TEXT("owner is bounded"), FHaybaMCPLeaseManager::ResolveOwner(Envelope, 12).Len(), 128);

	TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
	TArray<HaybaMCPAccess::FClaim> Claims;
	FString Error;
	TestTrue(TEXT("absent resources parse to nothing"), FHaybaMCPLeaseManager::ParseClaims(Params, true, Claims, Error));
	TestEqual(TEXT("no claims"), Claims.Num(), 0);

	TArray<TSharedPtr<FJsonValue>> Items;
	Items.Add(MakeShared<FJsonValueString>(TEXT("world:/Game/V")));
	TSharedPtr<FJsonObject> Shared = MakeShared<FJsonObject>();
	Shared->SetStringField(TEXT("resource"), TEXT("asset:/Game/Props/SM_Rock"));
	Shared->SetStringField(TEXT("mode"), TEXT("shared"));
	Items.Add(MakeShared<FJsonValueObject>(Shared));
	Params->SetArrayField(TEXT("resources"), Items);
	TestTrue(TEXT("strings and objects parse"), FHaybaMCPLeaseManager::ParseClaims(Params, true, Claims, Error));
	if (TestEqual(TEXT("two claims"), Claims.Num(), 2))
	{
		TestTrue(TEXT("a plain string takes the default mode"), Claims[0].bExclusive);
		TestFalse(TEXT("an object can ask for shared"), Claims[1].bExclusive);
	}

	Items.Add(MakeShared<FJsonValueString>(TEXT("level:/Game/V")));
	Params->SetArrayField(TEXT("resources"), Items);
	TestFalse(TEXT("a bad resource fails the whole list"), FHaybaMCPLeaseManager::ParseClaims(Params, true, Claims, Error));
	TestTrue(TEXT("the error names the bad resource"), Error.Contains(TEXT("level:/Game/V")));
	return true;
}

#endif
