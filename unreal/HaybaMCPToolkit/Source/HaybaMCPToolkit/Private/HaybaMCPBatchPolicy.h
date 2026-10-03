#pragma once

#include "CoreMinimal.h"
#include "HaybaMCPAccessPolicy.h"

/**
 * Pure state machine for editor_batch: several commands under one lease, run
 * in order on the game thread, ONE step per tick, with a fence after each
 * step. No GEditor, no ticker, no real clock: the driver
 * (handlers/HaybaMCPBatchHandler.cpp) feeds in the clock, the idle predicate
 * and the lease facts every tick and does what the machine answers. Every
 * transition is therefore deterministic in Hayba.MCP.Batch.* tests.
 *
 * A fence is where the editor is allowed to tick: shader compiles, asset
 * loads, async loading and garbage collection settle, and other owners' work
 * may run. Fences never block the game thread; they span ticks.
 *
 *   Step --ok--> Fence --idle N ticks--> [Yield] --> Step (next) ... --> Cleanup --> Done
 *     \--fail----------------------------------------------------------> Cleanup
 *
 * Cleanup always releases the World Partition regions the batch loaded (the
 * batch owns their loader adapters, so load and release pair). A successful
 * batch and `on_error: unload_then_stop` then run a settle fence (idle, plus
 * gc when the lease allows it) before reporting done; `on_error: stop`
 * reports done right after the release. See docs/adr/0010.
 */
namespace HaybaMCPBatch
{
	/** What happens after a step before the next one may run.
	 *  None - the next tick. Idle - N consecutive idle ticks.
	 *  Gc - CollectGarbage (only under an exclusive region/world lease), then idle. */
	enum class EFence : uint8
	{
		None,
		Idle,
		Gc,
	};

	enum class EOnError : uint8
	{
		Stop,
		UnloadThenStop,
	};

	inline const TCHAR* LexFence(EFence Fence)
	{
		switch (Fence)
		{
		case EFence::None: return TEXT("none");
		case EFence::Idle: return TEXT("idle");
		case EFence::Gc:   return TEXT("gc");
		}
		return TEXT("idle");
	}

	inline bool ParseFence(const FString& Text, EFence& Out)
	{
		if (Text == TEXT("none")) { Out = EFence::None; return true; }
		if (Text == TEXT("idle")) { Out = EFence::Idle; return true; }
		if (Text == TEXT("gc"))   { Out = EFence::Gc;   return true; }
		return false;
	}

	inline bool ParseOnError(const FString& Text, EOnError& Out)
	{
		if (Text == TEXT("stop"))             { Out = EOnError::Stop; return true; }
		if (Text == TEXT("unload_then_stop")) { Out = EOnError::UnloadThenStop; return true; }
		return false;
	}

	/** Step commands the batch runs natively instead of through ProcessCommand. */
	inline bool IsRegionStep(const FString& Cmd)
	{
		return Cmd == TEXT("wp_region_load") || Cmd == TEXT("wp_region_unload");
	}

	struct FTuning
	{
		/** Consecutive idle ticks an Idle/Gc fence needs. */
		int32 IdleTicksRequired = 2;
		/** A fence that never settles fails its step after this long. */
		double FenceTimeoutSeconds = 120.0;
		/** Aging for the batch: after this many yields, or this much time spent
		 *  yielding, nothing overtakes the batch at a fence any more. */
		int32 MaxYields = 3;
		double MaxYieldSeconds = 60.0;
		/** An open fence waits this long for queued waiters to poll (the lease
		 *  queue's poll hint for a batch-blocked waiter is 2 s). */
		double YieldWindowSeconds = 4.0;
		/** Hard cap on one yield; above the table's FenceGrantMaxSeconds so a
		 *  fence grant always lapses first. */
		double YieldMaxSeconds = 35.0;
		int32 MaxSteps = 64;
	};

	struct FStepSpec
	{
		FString Cmd;
		EFence FenceAfter = EFence::Idle;
	};

	/** Why a batch or step is refused before it runs. Empty = allowed. */
	inline FString ValidateSteps(const TArray<FStepSpec>& Steps, const FTuning& Tuning = FTuning())
	{
		if (Steps.Num() == 0)
		{
			return TEXT("steps must contain at least one step");
		}
		if (Steps.Num() > Tuning.MaxSteps)
		{
			return FString::Printf(TEXT("at most %d steps per batch (got %d)"), Tuning.MaxSteps, Steps.Num());
		}
		for (int32 I = 0; I < Steps.Num(); ++I)
		{
			const FString& Cmd = Steps[I].Cmd;
			if (Cmd.IsEmpty())
			{
				return FString::Printf(TEXT("steps[%d].cmd is required"), I);
			}
			if (Cmd == TEXT("editor_batch"))
			{
				return FString::Printf(TEXT("steps[%d]: editor_batch cannot be nested"), I);
			}
			if (Cmd == TEXT("lease_release") || Cmd == TEXT("lease_acquire"))
			{
				return FString::Printf(
					TEXT("steps[%d]: %s cannot run inside a batch; the batch runs under the lease it was given"), I, *Cmd);
			}
			if (Cmd == TEXT("editor_start_pie") || Cmd == TEXT("editor_stop_pie") || Cmd.StartsWith(TEXT("editor_pie_")))
			{
				// A batch that started PIE would pause itself before its own stop
				// step, renewing its lease and never yielding (docs/adr/0012).
				return FString::Printf(TEXT("steps[%d]: PIE cannot run inside a batch; batches pause during PIE"), I);
			}
		}
		return FString();
	}

	/**
	 * A step that switches or tears down the editor world would destroy the
	 * world the batch's loader adapters belong to. It may run only while the
	 * batch has no region loaded.
	 */
	inline FString CheckStepAllowed(HaybaMCPAccess::EAccessClass Class, int32 LoadedRegions)
	{
		if (Class == HaybaMCPAccess::EAccessClass::Global && LoadedRegions > 0)
		{
			return FString::Printf(
				TEXT("a global command (map load, PIE, quit, console) cannot run while this batch has %d World Partition "
					 "region(s) loaded; add a wp_region_unload step before it"), LoadedRegions);
		}
		return FString();
	}

	/** gc fences collect garbage only under an exclusive region, world or
	 *  global lease: a full GC under a shared or scoped lease would pull
	 *  objects out from under another owner's work. */
	inline bool LeaseAllowsGc(const TArray<HaybaMCPAccess::FLock>& LeaseLocks)
	{
		for (const HaybaMCPAccess::FLock& Lock : LeaseLocks)
		{
			if (Lock.Mode != HaybaMCPAccess::ELockMode::Exclusive) continue;
			if (Lock.Key == TEXT("global") || Lock.Key.StartsWith(TEXT("world:")) || Lock.bRegion)
			{
				return true;
			}
		}
		return false;
	}

	/** wp_region_load needs the lease to hold the region exclusively: X on
	 *  global, on its world, or on a wp-region of that world containing it. */
	inline bool LeaseCoversRegion(const TArray<HaybaMCPAccess::FLock>& LeaseLocks, const HaybaMCPAccess::FResource& Region)
	{
		for (const HaybaMCPAccess::FLock& Lock : LeaseLocks)
		{
			if (Lock.Mode != HaybaMCPAccess::ELockMode::Exclusive) continue;
			if (Lock.Key == TEXT("global")) return true;
			if (Lock.Key == HaybaMCPAccess::FResource::MakeWorld(Region.World).Key()) return true;
			if (Lock.bRegion && Lock.Region.World == Region.World
				&& Lock.Region.MinX <= Region.MinX && Lock.Region.MinY <= Region.MinY
				&& Lock.Region.MaxX >= Region.MaxX && Lock.Region.MaxY >= Region.MaxY)
			{
				return true;
			}
		}
		return false;
	}

	enum class EPhase : uint8
	{
		Step,
		Fence,
		Yield,
		Cleanup,
		CleanupFence,
		Done,
	};

	inline const TCHAR* LexPhase(EPhase Phase)
	{
		switch (Phase)
		{
		case EPhase::Step:         return TEXT("step");
		case EPhase::Fence:        return TEXT("fence");
		case EPhase::Yield:        return TEXT("yield");
		case EPhase::Cleanup:      return TEXT("cleanup");
		case EPhase::CleanupFence: return TEXT("cleanup_fence");
		case EPhase::Done:         return TEXT("done");
		}
		return TEXT("done");
	}

	/** What the driver must do this tick. */
	enum class EAction : uint8
	{
		/** Nothing; tick again. */
		Wait,
		/** Run steps[StepIndex()], then call OnStepResult in the same tick. */
		RunStep,
		/** CollectGarbage now (the lease was checked). */
		CollectGarbage,
		/** Open a fence in the lease table (BeginYield). */
		BeginYield,
		/** Close it (EndYield). */
		EndYield,
		/** Release every region the batch loaded. */
		UnloadAll,
		/** The batch is over; read Succeeded() / Error(). */
		Finish,
	};

	/** The world, as the driver saw it at the start of this tick. */
	struct FInputs
	{
		double Now = 0.0;
		/** No shader compile, asset registry scan, GC or async load is running. */
		bool bIdle = true;
		/** What is busy when bIdle is false (for timeouts and status). */
		FString BusyReason;
		/** The batch's lease still exists and belongs to its owner. */
		bool bLeaseValid = true;
		/** LeaseAllowsGc() of the batch's lease. */
		bool bLeaseAllowsGc = false;
		/** A waiter a fence would serve is blocked by the batch's lease. */
		bool bEligibleWaiter = false;
		/** Leases granted at this batch's fence that are still held. */
		int32 FenceGrantsOutstanding = 0;
		/** Regions the batch has loaded and not released. */
		int32 LoadedRegions = 0;
		/** PIE is running or queued (docs/adr/0012): the machine waits, evaluates
		 *  nothing, and spends no fence or yield time. */
		bool bHeld = false;
	};

	class FMachine
	{
	public:
		FMachine(TArray<FStepSpec> InSteps, EOnError InOnError, FTuning InTuning = FTuning())
			: Steps(MoveTemp(InSteps))
			, OnError(InOnError)
			, Tuning(InTuning)
		{
		}

		EAction Tick(const FInputs& In)
		{
			if (In.bHeld)
			{
				if (!bHoldActive)
				{
					bHoldActive = true;
					HeldSince = In.Now;
				}
				LastHeldNow = In.Now;
				return EAction::Wait;
			}
			if (bHoldActive)
			{
				// Held time never counts against FenceTimeoutSeconds or the yield timers.
				const double HeldSpan = FMath::Max(0.0, In.Now - HeldSince);
				FenceStartedAt += HeldSpan;
				YieldStartedAt += HeldSpan;
				HeldSecondsTotal += HeldSpan;
				bHoldActive = false;
			}
			switch (Phase)
			{
			case EPhase::Step:
				if (!In.bLeaseValid)
				{
					Fail(TEXT("the batch lease expired or was released before this step"));
					return TickCleanup(In);
				}
				bAwaitingStepResult = true;
				return EAction::RunStep;

			case EPhase::Fence:
				return TickFence(In);

			case EPhase::Yield:
				return TickYield(In);

			case EPhase::Cleanup:
				return TickCleanup(In);

			case EPhase::CleanupFence:
				return TickCleanupFence(In);

			case EPhase::Done:
				return EAction::Finish;
			}
			return EAction::Finish;
		}

		/** The driver ran steps[StepIndex()]. */
		void OnStepResult(bool bOk, const FString& StepError, double Now)
		{
			if (!bAwaitingStepResult || Phase != EPhase::Step)
			{
				return;
			}
			bAwaitingStepResult = false;
			++StepsRun;
			if (!bOk)
			{
				Fail(StepError.IsEmpty() ? FString(TEXT("step failed")) : StepError);
				return;
			}
			EnterFence(Steps[StepIndex].FenceAfter, Now);
		}

		EPhase GetPhase() const { return Phase; }
		int32 GetStepIndex() const { return StepIndex; }
		int32 GetStepsRun() const { return StepsRun; }
		int32 NumSteps() const { return Steps.Num(); }
		const FStepSpec& GetStep(int32 Index) const { return Steps[Index]; }
		bool IsDone() const { return Phase == EPhase::Done; }
		bool Succeeded() const { return Phase == EPhase::Done && !bFailed; }
		bool Failed() const { return bFailed; }
		/** The step that failed, or INDEX_NONE. */
		int32 GetFailedStep() const { return FailedStep; }
		const FString& GetError() const { return Error; }
		int32 GetYieldCount() const { return YieldCount; }
		double GetYieldSeconds() const { return YieldSecondsTotal; }
		bool IsAged() const { return !CanYield(); }
		bool GcRanAtLastFence() const { return bGcRan; }
		const TArray<FString>& GetNotes() const { return Notes; }
		EFence GetFenceKind() const { return FenceKind; }
		int32 GetIdleStreak() const { return IdleStreak; }
		/** PIE holds the batch right now. */
		bool IsHeld() const { return bHoldActive; }
		/** Seconds PIE has held the batch, the current hold included up to its last held tick. */
		double GetHeldSeconds() const { return HeldSecondsTotal + (bHoldActive ? LastHeldNow - HeldSince : 0.0); }

	private:
		void Fail(const FString& Why)
		{
			bFailed = true;
			FailedStep = StepIndex;
			Error = Why;
			bSettleAfterCleanup = OnError == EOnError::UnloadThenStop;
			Phase = EPhase::Cleanup;
		}

		void EnterFence(EFence Kind, double Now)
		{
			Phase = EPhase::Fence;
			FenceKind = Kind;
			FenceStartedAt = Now;
			IdleStreak = 0;
			bGcDone = false;
			bGcRan = false;
		}

		bool CanYield() const
		{
			return YieldCount < Tuning.MaxYields && YieldSecondsTotal < Tuning.MaxYieldSeconds;
		}

		/** Shared by step fences and the cleanup fence. True once satisfied;
		 *  OutAction is CollectGarbage when the driver must collect first. */
		bool AdvanceFence(const FInputs& In, EAction& OutAction)
		{
			OutAction = EAction::Wait;
			if (FenceKind == EFence::Gc && !bGcDone)
			{
				bGcDone = true;
				if (In.bLeaseAllowsGc)
				{
					bGcRan = true;
					OutAction = EAction::CollectGarbage;
					return false;
				}
				Notes.Add(FString::Printf(
					TEXT("step %d: gc fence skipped CollectGarbage (the lease is not exclusive on a region, world or global); waited for idle only"),
					StepIndex));
			}
			if (FenceKind == EFence::None)
			{
				return true;
			}
			IdleStreak = In.bIdle ? IdleStreak + 1 : 0;
			return IdleStreak >= Tuning.IdleTicksRequired;
		}

		EAction TickFence(const FInputs& In)
		{
			if (!In.bLeaseValid)
			{
				Fail(TEXT("the batch lease expired or was released at a fence"));
				return TickCleanup(In);
			}
			if (In.Now - FenceStartedAt > Tuning.FenceTimeoutSeconds)
			{
				Fail(FString::Printf(TEXT("fence after step %d timed out after %.0f s waiting for: %s"),
					StepIndex, Tuning.FenceTimeoutSeconds,
					In.BusyReason.IsEmpty() ? TEXT("idle") : *In.BusyReason));
				return TickCleanup(In);
			}
			EAction Action;
			if (!AdvanceFence(In, Action))
			{
				return Action;
			}
			if (StepIndex + 1 >= Steps.Num())
			{
				bSettleAfterCleanup = true;
				Phase = EPhase::Cleanup;
				return TickCleanup(In);
			}
			if (In.bEligibleWaiter && CanYield())
			{
				Phase = EPhase::Yield;
				YieldStartedAt = In.Now;
				bGrantedDuringYield = false;
				++YieldCount;
				return EAction::BeginYield;
			}
			return NextStep(In);
		}

		EAction NextStep(const FInputs& In)
		{
			++StepIndex;
			Phase = EPhase::Step;
			return Tick(In);
		}

		EAction TickYield(const FInputs& In)
		{
			const double Elapsed = In.Now - YieldStartedAt;
			bool bEnd = false;
			if (!In.bLeaseValid || Elapsed >= Tuning.YieldMaxSeconds)
			{
				bEnd = true;
			}
			else if (In.FenceGrantsOutstanding > 0)
			{
				bGrantedDuringYield = true;
			}
			else if (bGrantedDuringYield || !In.bEligibleWaiter || Elapsed >= Tuning.YieldWindowSeconds)
			{
				// Everyone let in has finished, or nobody came.
				bEnd = true;
			}
			if (!bEnd)
			{
				return EAction::Wait;
			}
			YieldSecondsTotal += Elapsed;
			if (!In.bLeaseValid)
			{
				Fail(TEXT("the batch lease expired or was released while yielding at a fence"));
				return EAction::EndYield;
			}
			// Resume next tick: the step runs once the table has closed the fence.
			++StepIndex;
			Phase = EPhase::Step;
			return EAction::EndYield;
		}

		EAction TickCleanup(const FInputs& In)
		{
			if (In.LoadedRegions > 0 && !bUnloadIssued)
			{
				bUnloadIssued = true;
				return EAction::UnloadAll;
			}
			if (bSettleAfterCleanup)
			{
				Phase = EPhase::CleanupFence;
				FenceKind = bUnloadIssued ? EFence::Gc : EFence::Idle;
				FenceStartedAt = In.Now;
				IdleStreak = 0;
				bGcDone = false;
				bGcRan = false;
				return EAction::Wait;
			}
			Phase = EPhase::Done;
			return EAction::Finish;
		}

		EAction TickCleanupFence(const FInputs& In)
		{
			if (In.Now - FenceStartedAt > Tuning.FenceTimeoutSeconds)
			{
				Notes.Add(FString::Printf(TEXT("the settle fence after cleanup timed out waiting for: %s"),
					In.BusyReason.IsEmpty() ? TEXT("idle") : *In.BusyReason));
				Phase = EPhase::Done;
				return EAction::Finish;
			}
			EAction Action;
			if (!AdvanceFence(In, Action))
			{
				return Action;
			}
			Phase = EPhase::Done;
			return EAction::Finish;
		}

		TArray<FStepSpec> Steps;
		EOnError OnError = EOnError::Stop;
		FTuning Tuning;

		EPhase Phase = EPhase::Step;
		int32 StepIndex = 0;
		int32 StepsRun = 0;
		bool bAwaitingStepResult = false;

		EFence FenceKind = EFence::Idle;
		double FenceStartedAt = 0.0;
		int32 IdleStreak = 0;
		bool bGcDone = false;
		bool bGcRan = false;

		double YieldStartedAt = 0.0;
		bool bGrantedDuringYield = false;
		int32 YieldCount = 0;
		double YieldSecondsTotal = 0.0;

		bool bFailed = false;
		int32 FailedStep = INDEX_NONE;
		FString Error;
		bool bSettleAfterCleanup = false;
		bool bUnloadIssued = false;
		TArray<FString> Notes;

		bool bHoldActive = false;
		double HeldSince = 0.0;
		double LastHeldNow = 0.0;
		double HeldSecondsTotal = 0.0;
	};
}
