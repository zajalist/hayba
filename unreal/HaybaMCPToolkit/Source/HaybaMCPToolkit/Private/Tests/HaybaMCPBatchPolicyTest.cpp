#include "Misc/AutomationTest.h"
#include "HaybaMCPAccessPolicy.h"
#include "HaybaMCPBatchPolicy.h"
#include "HaybaMCPLeasePolicy.h"

#if WITH_DEV_AUTOMATION_TESTS

// Pure editor_batch policy: the step/fence/yield/cleanup state machine with an
// injected clock and idle predicate, and the lease table's fence grants.
// Nothing here touches GEditor, a ticker or World Partition.

namespace
{
	using namespace HaybaMCPBatch;

	TArray<FStepSpec> MakeSteps(std::initializer_list<EFence> Fences)
	{
		TArray<FStepSpec> Steps;
		int32 I = 0;
		for (EFence Fence : Fences)
		{
			FStepSpec Step;
			Step.Cmd = FString::Printf(TEXT("step_%d"), I++);
			Step.FenceAfter = Fence;
			Steps.Add(Step);
		}
		return Steps;
	}

	/** Drives a machine the way the handler does: one Tick per engine tick. */
	struct FHarness
	{
		FMachine Machine;
		FInputs In;
		TArray<EAction> Actions;
		TArray<int32> StepsRunAt;
		/** Step indexes that should fail when run. */
		TSet<int32> FailingSteps;
		int32 GcCount = 0;
		int32 Unloads = 0;

		FHarness(TArray<FStepSpec> Steps, EOnError OnError, FTuning Tuning = FTuning())
			: Machine(MoveTemp(Steps), OnError, Tuning)
		{
		}

		EAction TickOnce()
		{
			const EAction Action = Machine.Tick(In);
			Actions.Add(Action);
			switch (Action)
			{
			case EAction::RunStep:
			{
				const int32 Index = Machine.GetStepIndex();
				StepsRunAt.Add(Index);
				const bool bOk = !FailingSteps.Contains(Index);
				Machine.OnStepResult(bOk, bOk ? FString() : FString::Printf(TEXT("step %d exploded"), Index), In.Now);
				break;
			}
			case EAction::CollectGarbage: ++GcCount; break;
			case EAction::UnloadAll: ++Unloads; In.LoadedRegions = 0; break;
			default: break;
			}
			In.Now += 0.1;
			return Action;
		}

		/** Tick until Finish (or a safety cap). Returns ticks taken. */
		int32 RunToEnd(int32 Cap = 10000)
		{
			for (int32 Tick = 1; Tick <= Cap; ++Tick)
			{
				if (TickOnce() == EAction::Finish) return Tick;
			}
			return -1;
		}

		int32 Count(EAction Action) const
		{
			return Actions.FilterByPredicate([Action](EAction A) { return A == Action; }).Num();
		}
	};
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPBatchValidationTest,
	"Hayba.MCP.Batch.Validation",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPBatchValidationTest::RunTest(const FString& Parameters)
{
	using namespace HaybaMCPAccess;

	TestFalse(TEXT("an empty batch is refused"), ValidateSteps({}).IsEmpty());
	TestTrue(TEXT("a plain batch is allowed"), ValidateSteps(MakeSteps({ EFence::Idle, EFence::Gc })).IsEmpty());

	TArray<FStepSpec> Nested = MakeSteps({ EFence::Idle });
	Nested[0].Cmd = TEXT("editor_batch");
	TestFalse(TEXT("nesting is refused"), ValidateSteps(Nested).IsEmpty());
	Nested[0].Cmd = TEXT("lease_release");
	TestFalse(TEXT("releasing the batch's own lease mid-batch is refused"), ValidateSteps(Nested).IsEmpty());

	FTuning Small;
	Small.MaxSteps = 2;
	TestFalse(TEXT("the step cap holds"), ValidateSteps(MakeSteps({ EFence::None, EFence::None, EFence::None }), Small).IsEmpty());

	TestFalse(TEXT("a global command is refused while regions are loaded"),
		CheckStepAllowed(EAccessClass::Global, 1).IsEmpty());
	TestTrue(TEXT("a global command is fine with no region loaded"),
		CheckStepAllowed(EAccessClass::Global, 0).IsEmpty());
	TestTrue(TEXT("a scoped write is fine with regions loaded"),
		CheckStepAllowed(EAccessClass::WriteScoped, 3).IsEmpty());

	EFence Fence;
	TestTrue(TEXT("gc parses"), ParseFence(TEXT("gc"), Fence) && Fence == EFence::Gc);
	TestFalse(TEXT("an unknown fence is refused"), ParseFence(TEXT("forever"), Fence));
	EOnError OnError;
	TestTrue(TEXT("unload_then_stop parses"), ParseOnError(TEXT("unload_then_stop"), OnError) && OnError == EOnError::UnloadThenStop);
	TestFalse(TEXT("an unknown on_error is refused"), ParseOnError(TEXT("retry"), OnError));

	TestTrue(TEXT("wp_region_load is a native region step"), IsRegionStep(TEXT("wp_region_load")));
	TestFalse(TEXT("wp_load_cell is not"), IsRegionStep(TEXT("wp_load_cell")));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPBatchLeaseScopeTest,
	"Hayba.MCP.Batch.LeaseScope",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPBatchLeaseScopeTest::RunTest(const FString& Parameters)
{
	using namespace HaybaMCPAccess;
	auto Locks = [this](const FString& Text, bool bExclusive)
	{
		FClaim Claim;
		FString Error;
		TestTrue(*FString::Printf(TEXT("'%s' parses"), *Text), ParseResource(Text, Claim.Resource, Error));
		Claim.bExclusive = bExclusive;
		return ExpandClaims({ Claim });
	};
	auto Region = [this](const FString& Text)
	{
		FResource R;
		FString Error;
		TestTrue(*FString::Printf(TEXT("'%s' parses"), *Text), ParseResource(Text, R, Error));
		return R;
	};

	TestTrue(TEXT("exclusive world allows gc"), LeaseAllowsGc(Locks(TEXT("world:/Game/Maps/Valley"), true)));
	TestTrue(TEXT("exclusive region allows gc"), LeaseAllowsGc(Locks(TEXT("wp-region:/Game/Maps/Valley:0,0,10,10"), true)));
	TestTrue(TEXT("exclusive global allows gc"), LeaseAllowsGc(Locks(TEXT("global"), true)));
	TestFalse(TEXT("shared world does not"), LeaseAllowsGc(Locks(TEXT("world:/Game/Maps/Valley"), false)));
	TestFalse(TEXT("an exclusive actor lease does not (only intent on the world)"),
		LeaseAllowsGc(Locks(TEXT("actor:/Game/Maps/Valley.Valley:PersistentLevel.Tree_3"), true)));
	TestFalse(TEXT("an exclusive asset lease does not"), LeaseAllowsGc(Locks(TEXT("asset:/Game/Props/SM_Rock"), true)));

	const FResource Inner = Region(TEXT("wp-region:/Game/Maps/Valley:10,10,20,20"));
	TestTrue(TEXT("a containing region covers"),
		LeaseCoversRegion(Locks(TEXT("wp-region:/Game/Maps/Valley:0,0,100,100"), true), Inner));
	TestFalse(TEXT("a merely overlapping region does not"),
		LeaseCoversRegion(Locks(TEXT("wp-region:/Game/Maps/Valley:15,15,100,100"), true), Inner));
	TestFalse(TEXT("a region of another world does not"),
		LeaseCoversRegion(Locks(TEXT("wp-region:/Game/Maps/Other:0,0,100,100"), true), Inner));
	TestTrue(TEXT("the world covers"), LeaseCoversRegion(Locks(TEXT("world:/Game/Maps/Valley"), true), Inner));
	TestFalse(TEXT("a shared world does not"), LeaseCoversRegion(Locks(TEXT("world:/Game/Maps/Valley"), false), Inner));
	TestTrue(TEXT("global covers"), LeaseCoversRegion(Locks(TEXT("global"), true), Inner));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPBatchStepsAndFencesTest,
	"Hayba.MCP.Batch.StepsAndFences",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPBatchStepsAndFencesTest::RunTest(const FString& Parameters)
{
	// One step per tick, in order; a none fence costs one tick.
	{
		FHarness H(MakeSteps({ EFence::None, EFence::None, EFence::None }), EOnError::Stop);
		H.In.bIdle = true;
		TestTrue(TEXT("finishes"), H.RunToEnd() > 0);
		TestTrue(TEXT("succeeded"), H.Machine.Succeeded());
		TestEqual(TEXT("ran every step in order"), H.StepsRunAt, TArray<int32>({ 0, 1, 2 }));
		int32 RunsInOneTick = 0;
		for (EAction A : H.Actions) RunsInOneTick += A == EAction::RunStep ? 1 : 0;
		TestEqual(TEXT("each RunStep is its own tick"), RunsInOneTick, 3);
	}

	// An idle fence waits for N consecutive idle ticks; a busy tick resets it.
	{
		FTuning Tuning;
		Tuning.IdleTicksRequired = 3;
		FHarness H(MakeSteps({ EFence::Idle, EFence::None }), EOnError::Stop, Tuning);
		H.In.bIdle = true;
		TestEqual(TEXT("tick 1 runs step 0"), H.TickOnce(), EAction::RunStep);
		TestEqual(TEXT("idle 1"), H.TickOnce(), EAction::Wait);
		TestEqual(TEXT("idle 2"), H.TickOnce(), EAction::Wait);
		H.In.bIdle = false;
		H.In.BusyReason = TEXT("shaders");
		TestEqual(TEXT("busy resets the streak"), H.TickOnce(), EAction::Wait);
		TestEqual(TEXT("streak is zero"), H.Machine.GetIdleStreak(), 0);
		H.In.bIdle = true;
		TestEqual(TEXT("idle 1 again"), H.TickOnce(), EAction::Wait);
		TestEqual(TEXT("idle 2 again"), H.TickOnce(), EAction::Wait);
		TestEqual(TEXT("idle 3 satisfies the fence and runs step 1"), H.TickOnce(), EAction::RunStep);
		TestEqual(TEXT("it is step 1"), H.Machine.GetStepIndex(), 1);
	}

	// gc under a lease that allows it collects, then waits for idle.
	{
		FHarness H(MakeSteps({ EFence::Gc, EFence::None }), EOnError::Stop);
		H.In.bLeaseAllowsGc = true;
		H.RunToEnd();
		TestEqual(TEXT("collected garbage once"), H.GcCount, 1);
		TestTrue(TEXT("succeeded"), H.Machine.Succeeded());
	}

	// gc under a lease that does not allow it only waits, and says so.
	{
		FHarness H(MakeSteps({ EFence::Gc, EFence::None }), EOnError::Stop);
		H.In.bLeaseAllowsGc = false;
		H.RunToEnd();
		TestEqual(TEXT("never collected"), H.GcCount, 0);
		TestTrue(TEXT("succeeded anyway"), H.Machine.Succeeded());
		TestEqual(TEXT("left a note"), H.Machine.GetNotes().Num(), 1);
	}

	// A fence that never settles fails its step with the busy reason.
	{
		FTuning Tuning;
		Tuning.FenceTimeoutSeconds = 1.0;
		FHarness H(MakeSteps({ EFence::Idle, EFence::None }), EOnError::Stop, Tuning);
		H.In.bIdle = false;
		H.In.BusyReason = TEXT("async_loading");
		H.RunToEnd();
		TestTrue(TEXT("failed"), H.Machine.Failed());
		TestEqual(TEXT("at step 0"), H.Machine.GetFailedStep(), 0);
		TestTrue(TEXT("names what was busy"), H.Machine.GetError().Contains(TEXT("async_loading")));
		TestEqual(TEXT("step 1 never ran"), H.StepsRunAt, TArray<int32>({ 0 }));
	}

	// Losing the lease stops the batch before the next step.
	{
		FHarness H(MakeSteps({ EFence::None, EFence::None }), EOnError::Stop);
		H.TickOnce();
		H.In.bLeaseValid = false;
		H.RunToEnd();
		TestTrue(TEXT("failed"), H.Machine.Failed());
		TestTrue(TEXT("says the lease went"), H.Machine.GetError().Contains(TEXT("lease")));
		TestEqual(TEXT("only step 0 ran"), H.StepsRunAt, TArray<int32>({ 0 }));
	}
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPBatchErrorsAndCleanupTest,
	"Hayba.MCP.Batch.ErrorsAndCleanup",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPBatchErrorsAndCleanupTest::RunTest(const FString& Parameters)
{
	// stop: halt at the failing step, release loaded regions, no settle fence.
	{
		FHarness H(MakeSteps({ EFence::None, EFence::None, EFence::None }), EOnError::Stop);
		H.In.LoadedRegions = 2;
		H.In.bLeaseAllowsGc = true;
		H.FailingSteps.Add(1);
		H.RunToEnd();
		TestTrue(TEXT("failed"), H.Machine.Failed());
		TestEqual(TEXT("at step 1"), H.Machine.GetFailedStep(), 1);
		TestEqual(TEXT("step 2 never ran"), H.StepsRunAt, TArray<int32>({ 0, 1 }));
		TestEqual(TEXT("regions released anyway: load and release pair"), H.Unloads, 1);
		TestEqual(TEXT("no gc on stop"), H.GcCount, 0);
	}

	// unload_then_stop: release, then gc (lease allows) and wait for idle.
	{
		FHarness H(MakeSteps({ EFence::None, EFence::None }), EOnError::UnloadThenStop);
		H.In.LoadedRegions = 1;
		H.In.bLeaseAllowsGc = true;
		H.FailingSteps.Add(0);
		H.RunToEnd();
		TestTrue(TEXT("failed"), H.Machine.Failed());
		TestEqual(TEXT("released"), H.Unloads, 1);
		TestEqual(TEXT("then collected"), H.GcCount, 1);
		const int32 UnloadAt = H.Actions.IndexOfByKey(EAction::UnloadAll);
		const int32 GcAt = H.Actions.IndexOfByKey(EAction::CollectGarbage);
		TestTrue(TEXT("unload comes before gc"), UnloadAt != INDEX_NONE && GcAt > UnloadAt);
	}

	// Success with a region still loaded: released at the end, then settled.
	{
		FHarness H(MakeSteps({ EFence::None }), EOnError::Stop);
		H.In.LoadedRegions = 1;
		H.In.bLeaseAllowsGc = false;
		H.RunToEnd();
		TestTrue(TEXT("succeeded"), H.Machine.Succeeded());
		TestEqual(TEXT("leftover region released"), H.Unloads, 1);
		TestEqual(TEXT("no gc without an exclusive lease"), H.GcCount, 0);
	}

	// A settle fence that never goes idle still finishes, with a note.
	{
		FTuning Tuning;
		Tuning.FenceTimeoutSeconds = 0.5;
		FHarness H(MakeSteps({ EFence::None }), EOnError::Stop, Tuning);
		H.In.bIdle = true;
		H.TickOnce(); // step 0
		H.TickOnce(); // none fence -> cleanup -> settle fence
		H.In.bIdle = false;
		TestTrue(TEXT("finishes"), H.RunToEnd() > 0);
		TestTrue(TEXT("still a success"), H.Machine.Succeeded());
		TestTrue(TEXT("noted the timeout"), H.Machine.GetNotes().Num() > 0);
	}
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPBatchYieldTest,
	"Hayba.MCP.Batch.Yield",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPBatchYieldTest::RunTest(const FString& Parameters)
{
	// An eligible waiter at a fence: yield, wait for the grant to finish, resume.
	{
		FHarness H(MakeSteps({ EFence::None, EFence::None }), EOnError::Stop);
		TestEqual(TEXT("step 0"), H.TickOnce(), EAction::RunStep);
		H.In.bEligibleWaiter = true;
		TestEqual(TEXT("fence opens"), H.TickOnce(), EAction::BeginYield);
		H.In.bEligibleWaiter = false;
		H.In.FenceGrantsOutstanding = 1;
		TestEqual(TEXT("parked while the grant is held"), H.TickOnce(), EAction::Wait);
		TestEqual(TEXT("still parked"), H.TickOnce(), EAction::Wait);
		H.In.FenceGrantsOutstanding = 0;
		TestEqual(TEXT("grant released: fence closes"), H.TickOnce(), EAction::EndYield);
		TestEqual(TEXT("then step 1"), H.TickOnce(), EAction::RunStep);
		TestEqual(TEXT("step 1 it is"), H.Machine.GetStepIndex(), 1);
		H.RunToEnd();
		TestTrue(TEXT("succeeded"), H.Machine.Succeeded());
		TestEqual(TEXT("one yield"), H.Machine.GetYieldCount(), 1);
	}

	// Nobody polls within the window: the fence closes on its own.
	{
		FTuning Tuning;
		Tuning.YieldWindowSeconds = 0.35;
		FHarness H(MakeSteps({ EFence::None, EFence::None }), EOnError::Stop, Tuning);
		H.TickOnce();
		H.In.bEligibleWaiter = true;
		TestEqual(TEXT("fence opens"), H.TickOnce(), EAction::BeginYield);
		int32 Waits = 0;
		EAction A;
		while ((A = H.TickOnce()) == EAction::Wait) ++Waits;
		TestEqual(TEXT("closes after the window"), A, EAction::EndYield);
		TestTrue(TEXT("waited a few ticks for a poll"), Waits >= 2);
	}

	// Aging: after MaxYields the batch stops yielding.
	{
		FTuning Tuning;
		Tuning.MaxYields = 2;
		Tuning.YieldWindowSeconds = 0.0;
		FHarness H(MakeSteps({ EFence::None, EFence::None, EFence::None, EFence::None, EFence::None }), EOnError::Stop, Tuning);
		H.In.bEligibleWaiter = true;
		H.RunToEnd();
		TestTrue(TEXT("succeeded"), H.Machine.Succeeded());
		TestEqual(TEXT("yielded only twice"), H.Count(EAction::BeginYield), 2);
		TestTrue(TEXT("is aged"), H.Machine.IsAged());
		TestEqual(TEXT("ran all five steps"), H.StepsRunAt.Num(), 5);
	}

	// Aging by time spent yielding.
	{
		FTuning Tuning;
		Tuning.MaxYields = 100;
		Tuning.MaxYieldSeconds = 1.0;
		Tuning.YieldMaxSeconds = 0.6;
		FHarness H(MakeSteps({ EFence::None, EFence::None, EFence::None, EFence::None }), EOnError::Stop, Tuning);
		H.In.bEligibleWaiter = true;
		H.In.FenceGrantsOutstanding = 1; // a grant that is never released: the hard cap ends each yield
		H.RunToEnd();
		TestEqual(TEXT("two capped yields exhaust the budget"), H.Count(EAction::BeginYield), 2);
	}

	// No yield after the last step: nothing left to protect.
	{
		FHarness H(MakeSteps({ EFence::None }), EOnError::Stop);
		H.In.bEligibleWaiter = true;
		H.RunToEnd();
		TestEqual(TEXT("never yielded"), H.Count(EAction::BeginYield), 0);
	}
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPBatchFenceGrantTest,
	"Hayba.MCP.Batch.FenceGrants",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPBatchFenceGrantTest::RunTest(const FString& Parameters)
{
	using namespace HaybaMCPLease;
	using namespace HaybaMCPAccess;

	double Now = 1000.0;
	FTable Table([&Now]() { return Now; });

	auto Request = [this](const FString& Owner, const FString& Resource, ELane Lane)
	{
		FRequest R;
		R.Owner = Owner;
		R.Lane = Lane;
		FClaim Claim;
		FString Error;
		TestTrue(TEXT("resource parses"), ParseResource(Resource, Claim.Resource, Error));
		R.Claims.Add(Claim);
		return R;
	};

	const FAcquireResult Batch = Table.Acquire(Request(TEXT("terrain"), TEXT("world:/Game/Maps/Valley"), ELane::Long));
	TestEqual(TEXT("batch lease granted"), Batch.Status, EStatus::Granted);
	TestTrue(TEXT("mark it as a batch lease"), Table.SetYieldable(Batch.Token, true));

	const FAcquireResult Waiter = Table.Acquire(Request(TEXT("foliage"), TEXT("actor:/Game/Maps/Valley.Valley:PersistentLevel.Tree_3"), ELane::Interactive));
	TestEqual(TEXT("interactive request queues behind the batch"), Waiter.Status, EStatus::Queued);
	TestTrue(TEXT("told it is a batch"), Waiter.ConflictDetail.Contains(TEXT("editor_batch")));
	TestEqual(TEXT("no fake ETA for a batch"), Waiter.EtaSeconds, -1.0);
	TestTrue(TEXT("the batch sees an eligible waiter"), Table.HasEligibleWaiterBlockedBy(Batch.Token));

	TestTrue(TEXT("fence opens"), Table.BeginYield(Batch.Token));
	const FAcquireResult Late = Table.Acquire(Request(TEXT("verifier"), TEXT("world:/Game/Maps/Valley"), ELane::Interactive));
	TestEqual(TEXT("a request that arrives during the fence waits for the next one"), Late.Status, EStatus::Queued);

	FRequest Poll = Request(TEXT("foliage"), TEXT("actor:/Game/Maps/Valley.Valley:PersistentLevel.Tree_3"), ELane::Interactive);
	Poll.Ticket = Waiter.Token;
	Poll.TtlSeconds = 600.0;
	const FAcquireResult Granted = Table.Acquire(Poll);
	TestEqual(TEXT("the queued waiter is granted at the fence"), Granted.Status, EStatus::Granted);
	TestTrue(TEXT("its lease is capped"), Granted.ExpiresAt <= Now + Table.GetTuning().FenceGrantMaxSeconds + 0.001);
	TestEqual(TEXT("one fence grant outstanding"), Table.CountFenceGrants(Batch.Token), 1);

	const TArray<FLock> ActorWrite = ExpandClaims({ Poll.Claims[0] });
	TestNull(TEXT("the let-in owner's command does not collide with the parked batch"),
		Table.FindConflictingHolder(TEXT("foliage"), ActorWrite));
	TestNotNull(TEXT("anyone else's still does"),
		Table.FindConflictingHolder(TEXT("verifier"), ActorWrite));

	double NewExpiry = 0.0;
	FString Error;
	TestTrue(TEXT("renew succeeds"), Table.Renew(Granted.Token, TEXT("foliage"), 900.0, NewExpiry, Error));
	TestTrue(TEXT("but cannot outlive the fence cap"),
		NewExpiry <= Now + Table.GetTuning().FenceGrantMaxSeconds + 0.001);

	TestTrue(TEXT("release the grant"), Table.Release(Granted.Token, TEXT("foliage"), Error));
	TestEqual(TEXT("no grants outstanding"), Table.CountFenceGrants(Batch.Token), 0);
	Table.EndYield(Batch.Token);

	// Once the fence closes the batch lease blocks again.
	const FAcquireResult After = Table.Acquire(Request(TEXT("foliage"), TEXT("world:/Game/Maps/Valley"), ELane::Interactive));
	TestEqual(TEXT("closed fence blocks again"), After.Status, EStatus::Queued);

	// A long waiter is not served by a fence until it has aged.
	FTable Fresh([&Now]() { return Now; });
	const FAcquireResult B2 = Fresh.Acquire(Request(TEXT("terrain"), TEXT("world:/Game/Maps/Valley"), ELane::Long));
	Fresh.SetYieldable(B2.Token, true);
	const FAcquireResult LongWaiter = Fresh.Acquire(Request(TEXT("hlod"), TEXT("world:/Game/Maps/Valley"), ELane::Long));
	TestFalse(TEXT("a young long waiter is not eligible"), Fresh.HasEligibleWaiterBlockedBy(B2.Token));
	FRequest LongPoll = Request(TEXT("hlod"), TEXT("world:/Game/Maps/Valley"), ELane::Long);
	LongPoll.Ticket = LongWaiter.Token;
	// Age it while polling inside the waiter TTL, as a live agent would. The
	// batch lease is renewed alongside, as the batch driver does.
	for (int32 I = 0; I < 4; ++I)
	{
		Now += 20.0;
		double Ignored = 0.0;
		Fresh.Renew(B2.Token, TEXT("terrain"), 120.0, Ignored, Error);
		TestEqual(TEXT("still queued while polling"), Fresh.Acquire(LongPoll).Status, EStatus::Queued);
	}
	TestTrue(TEXT("an aged long waiter is eligible"), Fresh.HasEligibleWaiterBlockedBy(B2.Token));
	TestTrue(TEXT("fence opens for it"), Fresh.BeginYield(B2.Token));
	TestEqual(TEXT("and grants it"), Fresh.Acquire(LongPoll).Status, EStatus::Granted);
	TestTrue(TEXT("SetYieldable(false) clears a yield"), Fresh.SetYieldable(B2.Token, false));
	TestFalse(TEXT("a non-batch lease cannot open a fence"), Fresh.BeginYield(B2.Token));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPBatchHoldExcludedFromFenceTimeoutTest,
	"Hayba.MCP.Batch.HoldExcludedFromFenceTimeout",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPBatchHoldExcludedFromFenceTimeoutTest::RunTest(const FString& Parameters)
{
	// A hold during a fence spends none of the fence timeout: 10 x FenceTimeoutSeconds held, then the fence settles.
	{
		FTuning Tuning;
		Tuning.FenceTimeoutSeconds = 1.0;
		Tuning.IdleTicksRequired = 2;
		FHarness H(MakeSteps({ EFence::Idle, EFence::None }), EOnError::Stop, Tuning);
		H.In.bIdle = false;
		H.In.BusyReason = TEXT("shaders");
		TestEqual(TEXT("step 0 runs"), H.TickOnce(), EAction::RunStep);
		TestEqual(TEXT("its fence waits"), H.TickOnce(), EAction::Wait);
		H.In.bHeld = true;
		int32 HeldWaits = 0;
		for (int32 I = 0; I < 100; ++I)
		{
			HeldWaits += H.TickOnce() == EAction::Wait ? 1 : 0;
		}
		TestEqual(TEXT("every held tick waits"), HeldWaits, 100);
		TestTrue(TEXT("the machine reports the hold"), H.Machine.IsHeld());
		TestEqual(TEXT("held seconds up to the last held tick"), H.Machine.GetHeldSeconds(), 9.9, 1e-6);
		H.In.bHeld = false;
		H.In.bIdle = true;
		H.In.BusyReason.Reset();
		TestEqual(TEXT("idle 1 after the hold"), H.TickOnce(), EAction::Wait);
		TestFalse(TEXT("the hold is over"), H.Machine.IsHeld());
		TestEqual(TEXT("idle 2 satisfies the fence and runs step 1"), H.TickOnce(), EAction::RunStep);
		H.RunToEnd();
		TestTrue(TEXT("the batch succeeds"), H.Machine.Succeeded());
		TestEqual(TEXT("the whole hold is counted"), H.Machine.GetHeldSeconds(), 10.0, 1e-6);
	}
	// Control: the same schedule without the hold times the fence out.
	{
		FTuning Tuning;
		Tuning.FenceTimeoutSeconds = 1.0;
		FHarness H(MakeSteps({ EFence::Idle, EFence::None }), EOnError::Stop, Tuning);
		H.In.bIdle = false;
		H.In.BusyReason = TEXT("shaders");
		H.RunToEnd();
		TestTrue(TEXT("unheld busy time does time out"), H.Machine.Failed());
	}
	// A hold during a yield spends none of YieldMaxSeconds.
	{
		FTuning Tuning;
		Tuning.YieldMaxSeconds = 1.0;
		FHarness H(MakeSteps({ EFence::None, EFence::None }), EOnError::Stop, Tuning);
		TestEqual(TEXT("step 0"), H.TickOnce(), EAction::RunStep);
		H.In.bEligibleWaiter = true;
		TestEqual(TEXT("the fence opens"), H.TickOnce(), EAction::BeginYield);
		H.In.FenceGrantsOutstanding = 1;
		H.In.bHeld = true;
		for (int32 I = 0; I < 100; ++I)
		{
			H.TickOnce();
		}
		H.In.bHeld = false;
		TestEqual(TEXT("still parked: the hold did not reach YieldMaxSeconds"), H.TickOnce(), EAction::Wait);
		H.In.FenceGrantsOutstanding = 0;
		H.In.bEligibleWaiter = false;
		TestEqual(TEXT("the grant is released: the fence closes"), H.TickOnce(), EAction::EndYield);
		TestTrue(TEXT("yield time excludes the hold"), H.Machine.GetYieldSeconds() < 1.0);
		H.RunToEnd();
		TestTrue(TEXT("the batch succeeds"), H.Machine.Succeeded());
	}
	// Held before the first step: no step runs until the hold ends.
	{
		FHarness H(MakeSteps({ EFence::None }), EOnError::Stop);
		H.In.bHeld = true;
		TestEqual(TEXT("held: no step"), H.TickOnce(), EAction::Wait);
		TestEqual(TEXT("nothing ran"), H.StepsRunAt.Num(), 0);
		H.In.bHeld = false;
		TestEqual(TEXT("resumes with step 0"), H.TickOnce(), EAction::RunStep);
	}
	// R-11: a gc fence never collects on a held tick.
	{
		FHarness H(MakeSteps({ EFence::Gc, EFence::None }), EOnError::Stop);
		H.In.bLeaseAllowsGc = true;
		TestEqual(TEXT("step 0"), H.TickOnce(), EAction::RunStep);
		H.In.bHeld = true;
		TestEqual(TEXT("held: no CollectGarbage"), H.TickOnce(), EAction::Wait);
		TestEqual(TEXT("nothing collected"), H.GcCount, 0);
		H.In.bHeld = false;
		TestEqual(TEXT("collects once the hold ends"), H.TickOnce(), EAction::CollectGarbage);
	}
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPBatchValidateRejectsPieStepsTest,
	"Hayba.MCP.Batch.ValidateRejectsPieSteps",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPBatchValidateRejectsPieStepsTest::RunTest(const FString& Parameters)
{
	for (const TCHAR* Cmd : { TEXT("editor_start_pie"), TEXT("editor_stop_pie"), TEXT("editor_pie_press_key"),
		TEXT("editor_pie_screenshot"), TEXT("editor_pie_actor_list") })
	{
		TArray<FStepSpec> Steps = MakeSteps({ EFence::None, EFence::None });
		Steps[1].Cmd = Cmd;
		TestEqual(*FString::Printf(TEXT("%s is rejected at validation"), Cmd), ValidateSteps(Steps),
			FString(TEXT("steps[1]: PIE cannot run inside a batch; batches pause during PIE")));
	}
	TArray<FStepSpec> Plain = MakeSteps({ EFence::None, EFence::None });
	Plain[1].Cmd = TEXT("editor_get_state");
	TestTrue(TEXT("a non-PIE editor step is still allowed"), ValidateSteps(Plain).IsEmpty());
	return true;
}

#endif
