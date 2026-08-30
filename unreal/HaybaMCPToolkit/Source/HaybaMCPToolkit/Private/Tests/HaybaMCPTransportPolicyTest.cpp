#include "Misc/AutomationTest.h"
#include "HAL/PlatformProcess.h"
#include "HaybaMCPJoinableWorker.h"
#include "HaybaMCPTransportPolicy.h"

#if WITH_DEV_AUTOMATION_TESTS

namespace
{
	struct FJoinCaptureProbe
	{
		explicit FJoinCaptureProbe(FThreadSafeCounter& InDestroyed)
			: Destroyed(InDestroyed)
		{
		}

		~FJoinCaptureProbe()
		{
			Destroyed.Increment();
		}

		FThreadSafeCounter& Destroyed;
	};
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPTransportPolicyTest,
	"Hayba.MCP.Transport.OutboundAdmissionAndAccounting",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPTransportPolicyTest::RunTest(const FString& Parameters)
{
	using EAdmission = EHaybaMCPResponseAdmission;

	FThreadSafeCounter CallableRuns;
	FThreadSafeCounter CapturesDestroyed;
	{
		TSharedPtr<FJoinCaptureProbe, ESPMode::ThreadSafe> Probe =
			MakeShared<FJoinCaptureProbe, ESPMode::ThreadSafe>(CapturesDestroyed);
		TWeakPtr<FJoinCaptureProbe, ESPMode::ThreadSafe> WeakProbe = Probe;
		TUniquePtr<FHaybaMCPJoinableWorker> Worker =
			MakeUnique<FHaybaMCPJoinableWorker>([Probe, &CallableRuns]()
			{
				CallableRuns.Increment();
			});
		Probe.Reset();
		TestTrue(TEXT("owned connection worker starts"),
			Worker->Start(TEXT("HaybaMCPJoinCaptureTest")));
		Worker->JoinAndDestroy();
		TestEqual(TEXT("true join waits for callable return"), CallableRuns.GetValue(), 1);
		TestEqual(TEXT("true join destroys callable captures before returning"),
			CapturesDestroyed.GetValue(), 1);
		TestFalse(TEXT("no capture survives the join boundary"), WeakProbe.IsValid());
	}
	TestEqual(TEXT("worker owner destruction does not destroy captures twice"),
		CapturesDestroyed.GetValue(), 1);

	{
		TSharedPtr<FJoinCaptureProbe, ESPMode::ThreadSafe> RestartProbe =
			MakeShared<FJoinCaptureProbe, ESPMode::ThreadSafe>(CapturesDestroyed);
		TUniquePtr<FHaybaMCPJoinableWorker> RestartWorker =
			MakeUnique<FHaybaMCPJoinableWorker>([RestartProbe, &CallableRuns]()
			{
				CallableRuns.Increment();
			});
		RestartProbe.Reset();
		TestTrue(TEXT("a fresh worker starts after exact prior teardown"),
			RestartWorker->Start(TEXT("HaybaMCPJoinRestartTest")));
		RestartWorker->JoinAndDestroy();
	}
	TestEqual(TEXT("restart callable ran after prior capture destruction"),
		CallableRuns.GetValue(), 2);
	TestEqual(TEXT("restart capture also dies before join returns"),
		CapturesDestroyed.GetValue(), 2);

	// This is the non-allocating oversized-response hook: even the maximum
	// representable declared size is classified using only integer arithmetic.
	TestTrue(TEXT("empty response is refused"),
		FHaybaMCPOutboundAdmission::ClassifyFrameBytes(0, 1024) == EAdmission::Empty);
	TestTrue(TEXT("response at the byte limit is accepted"),
		FHaybaMCPOutboundAdmission::ClassifyFrameBytes(1024, 1024) == EAdmission::Accepted);
	TestTrue(TEXT("response one byte above the limit is refused"),
		FHaybaMCPOutboundAdmission::ClassifyFrameBytes(1025, 1024) == EAdmission::Oversized);
	TestTrue(TEXT("maximum uint64 response is refused without allocation"),
		FHaybaMCPOutboundAdmission::ClassifyFrameBytes(MAX_uint64, 1024) == EAdmission::Oversized);


	FHaybaMCPOutboundBudgetPtr ClientBudget =
		MakeShared<FHaybaMCPOutboundBudget, ESPMode::ThreadSafe>(1024);
	FHaybaMCPOutboundBudgetPtr GlobalBudget =
		MakeShared<FHaybaMCPOutboundBudget, ESPMode::ThreadSafe>(1024);
	FHaybaMCPOutboundBudgetReservationPtr FirstMemory =
		FHaybaMCPOutboundBudgetReservation::TryCreate(ClientBudget, GlobalBudget, 700);
	FHaybaMCPOutboundBudgetReservationPtr BoundaryMemory =
		FHaybaMCPOutboundBudgetReservation::TryCreate(ClientBudget, GlobalBudget, 324);
	TestTrue(TEXT("coupled reservations accept exactly the remaining budget"),
		FirstMemory.IsValid() && BoundaryMemory.IsValid());
	TestEqual(TEXT("client budget reaches its exact boundary"), ClientBudget->GetReservedBytes(), 1024ll);
	TestEqual(TEXT("global budget reaches its exact boundary"), GlobalBudget->GetReservedBytes(), 1024ll);
	TestFalse(TEXT("one char above the coupled boundary is refused"),
		FHaybaMCPOutboundBudgetReservation::TryCreate(ClientBudget, GlobalBudget, 1).IsValid());
	TestFalse(TEXT("integer-maximum candidate is refused without overflow"),
		FHaybaMCPOutboundBudgetReservation::TryCreate(
			ClientBudget, GlobalBudget, MAX_int64).IsValid());
	TestFalse(TEXT("restart cannot reconfigure a budget with active sends"),
		GlobalBudget->Configure(2048));
	TestEqual(TEXT("failed live reconfiguration preserves the active ceiling"),
		GlobalBudget->GetMaxBytes(), 1024ll);

	// Dequeue must not release memory: the local response/lease remains in-flight
	// until SendMessage has completed or refused it.
	BoundaryMemory.Reset();
	TestEqual(TEXT("in-flight response remains globally accounted after dequeue"),
		GlobalBudget->GetReservedBytes(), 700ll);
	FirstMemory.Reset();
	TestEqual(TEXT("send completion releases client memory"), ClientBudget->GetReservedBytes(), 0ll);
	TestEqual(TEXT("send completion releases global memory"), GlobalBudget->GetReservedBytes(), 0ll);
	TestTrue(TEXT("quiescent restart may reconfigure the global budget"),
		GlobalBudget->Configure(2048));
	TestEqual(TEXT("quiescent reconfiguration applies exactly"), GlobalBudget->GetMaxBytes(), 2048ll);

	{
		FHaybaMCPOutboundBudgetPtr ClientA =
			MakeShared<FHaybaMCPOutboundBudget, ESPMode::ThreadSafe>(1024);
		FHaybaMCPOutboundBudgetPtr ClientB =
			MakeShared<FHaybaMCPOutboundBudget, ESPMode::ThreadSafe>(1024);
		FHaybaMCPOutboundBudgetPtr SharedGlobal =
			MakeShared<FHaybaMCPOutboundBudget, ESPMode::ThreadSafe>(1024);
		FEvent* StartGate = FPlatformProcess::GetSynchEventFromPool(true);
		if (!StartGate)
		{
			AddError(TEXT("could not allocate the concurrent outbound-budget test gate"));
			return false;
		}
		FHaybaMCPOutboundBudgetReservationPtr LeaseA;
		FHaybaMCPOutboundBudgetReservationPtr LeaseB;
		TUniquePtr<FHaybaMCPJoinableWorker> A =
			MakeUnique<FHaybaMCPJoinableWorker>([ClientA, SharedGlobal, StartGate, &LeaseA]()
			{
				StartGate->Wait();
				LeaseA = FHaybaMCPOutboundBudgetReservation::TryCreate(
					ClientA, SharedGlobal, 700);
			});
		TUniquePtr<FHaybaMCPJoinableWorker> B =
			MakeUnique<FHaybaMCPJoinableWorker>([ClientB, SharedGlobal, StartGate, &LeaseB]()
			{
				StartGate->Wait();
				LeaseB = FHaybaMCPOutboundBudgetReservation::TryCreate(
					ClientB, SharedGlobal, 700);
			});
		TestTrue(TEXT("first concurrent budget worker starts"),
			A->Start(TEXT("HaybaMCPBudgetConcurrentA")));
		TestTrue(TEXT("second concurrent budget worker starts"),
			B->Start(TEXT("HaybaMCPBudgetConcurrentB")));
		StartGate->Trigger();
		A->JoinAndDestroy();
		B->JoinAndDestroy();
		FPlatformProcess::ReturnSynchEventToPool(StartGate);
		const int32 Accepted = (LeaseA.IsValid() ? 1 : 0) + (LeaseB.IsValid() ? 1 : 0);
		TestEqual(TEXT("concurrent clients cannot each retain the global maximum"), Accepted, 1);
		TestEqual(TEXT("losing global admission rolls back its client reservation"),
			ClientA->GetReservedBytes() + ClientB->GetReservedBytes(), 700ll);
		LeaseA.Reset();
		LeaseB.Reset();
		TestEqual(TEXT("concurrent global leases return to zero"),
			SharedGlobal->GetReservedBytes(), 0ll);
	}

	{
		FHaybaMCPOutboundBudgetPtr SharedGlobal =
			MakeShared<FHaybaMCPOutboundBudget, ESPMode::ThreadSafe>(1024);
		TArray<FHaybaMCPOutboundBudgetReservationPtr> Leases;
		int32 Accepted = 0;
		for (int32 ClientIndex = 0; ClientIndex < 64; ++ClientIndex)
		{
			FHaybaMCPOutboundBudgetPtr OneClient =
				MakeShared<FHaybaMCPOutboundBudget, ESPMode::ThreadSafe>(1024);
			FHaybaMCPOutboundBudgetReservationPtr Lease =
				FHaybaMCPOutboundBudgetReservation::TryCreate(
					OneClient, SharedGlobal, 1024);
			if (Lease.IsValid())
			{
				++Accepted;
				Leases.Add(MoveTemp(Lease));
			}
		}
		TestEqual(TEXT("64 clients cannot each retain a maximum-size response"), Accepted, 1);
		TestEqual(TEXT("64-client pressure remains at the one global ceiling"),
			SharedGlobal->GetReservedBytes(), 1024ll);
		Leases.Reset();
		TestEqual(TEXT("64-client pressure releases the global ceiling"),
			SharedGlobal->GetReservedBytes(), 0ll);
	}

	FThreadSafeCounter Counter;
	{
		FHaybaMCPCountReservationPtr Reservation =
			MakeShared<FHaybaMCPCountReservation, ESPMode::ThreadSafe>(Counter);
		TestEqual(TEXT("reservation increments once"), Reservation->GetCountAfterAcquire(), 1);
		TestEqual(TEXT("first explicit release decrements once"), Reservation->Release(), 0);
		TestEqual(TEXT("duplicate release is idempotent"), Reservation->Release(), 0);
		TestFalse(TEXT("released reservation reports unheld"), Reservation->IsHeld());
	}
	TestEqual(TEXT("destructor does not double-release"), Counter.GetValue(), 0);

	{
		FHaybaMCPCountReservationPtr Reservation =
			MakeShared<FHaybaMCPCountReservation, ESPMode::ThreadSafe>(Counter);
		FHaybaMCPCountReservationPtr RetainedByWorker = Reservation;
		Reservation.Reset();
		TestEqual(TEXT("shared worker ownership retains accounting"), Counter.GetValue(), 1);
		RetainedByWorker.Reset();
		TestEqual(TEXT("last-owner destruction releases accounting"), Counter.GetValue(), 0);
	}

	{
		FHaybaMCPCountReservationPtr Reservation =
			MakeShared<FHaybaMCPCountReservation, ESPMode::ThreadSafe>(Counter);
		TUniquePtr<FHaybaMCPJoinableWorker> First =
			MakeUnique<FHaybaMCPJoinableWorker>([Reservation]()
			{
				Reservation->Release();
			});
		TUniquePtr<FHaybaMCPJoinableWorker> Second =
			MakeUnique<FHaybaMCPJoinableWorker>([Reservation]()
			{
				Reservation->Release();
			});
		TestTrue(TEXT("first concurrent cleanup worker starts"),
			First->Start(TEXT("HaybaMCPCleanupConcurrentA")));
		TestTrue(TEXT("second concurrent cleanup worker starts"),
			Second->Start(TEXT("HaybaMCPCleanupConcurrentB")));
		First->JoinAndDestroy();
		Second->JoinAndDestroy();
		TestEqual(TEXT("concurrent cleanup releases exactly once"), Counter.GetValue(), 0);
	}

	{
		FHaybaMCPCountReservationPtr ClientSlot =
			MakeShared<FHaybaMCPCountReservation, ESPMode::ThreadSafe>(Counter);
		FHaybaMCPWorkerQuorum ClientWorkers(2, MoveTemp(ClientSlot));
		const FHaybaMCPWorkerCompletion ReaderExit = ClientWorkers.WorkerFinished();
		TestFalse(TEXT("reader exit alone does not free a client slot"),
			ReaderExit.bReleasedReservation);
		TestEqual(TEXT("writer remains after reader exit"), ReaderExit.RemainingWorkers, 1);
		TestEqual(TEXT("reader exit retains max-client occupancy"), Counter.GetValue(), 1);

		const FHaybaMCPWorkerCompletion WriterExit = ClientWorkers.WorkerFinished();
		TestTrue(TEXT("final writer exit releases the client slot"),
			WriterExit.bReleasedReservation);
		TestEqual(TEXT("both workers have finished"), WriterExit.RemainingWorkers, 0);
		TestEqual(TEXT("final worker returns client occupancy to zero"), Counter.GetValue(), 0);

		ClientWorkers.WorkerFinished();
		TestEqual(TEXT("duplicate worker completion cannot make occupancy negative"),
			Counter.GetValue(), 0);
	}

	{
		FHaybaMCPCountReservationPtr ClientSlot =
			MakeShared<FHaybaMCPCountReservation, ESPMode::ThreadSafe>(Counter);
		FHaybaMCPWorkerQuorum ClientWorkers(2, MoveTemp(ClientSlot));
		ClientWorkers.WorkerFinished();
		TestEqual(TEXT("one-worker startup/early-exit still retains the slot"), Counter.GetValue(), 1);
	}
	TestEqual(TEXT("quorum destruction releases a missing worker exactly once"),
		Counter.GetValue(), 0);

	FThreadSafeCounter Clients;
	FThreadSafeCounter Pending;
	FThreadSafeCounter Responses;
	{
		FHaybaMCPCountReservationPtr ClientSlot =
			MakeShared<FHaybaMCPCountReservation, ESPMode::ThreadSafe>(Clients);
		FHaybaMCPWorkerQuorum ClientWorkers(2, MoveTemp(ClientSlot));
		FHaybaMCPCountReservationPtr PendingCommand =
			MakeShared<FHaybaMCPCountReservation, ESPMode::ThreadSafe>(Pending);
		FHaybaMCPCountReservationPtr Response =
			MakeShared<FHaybaMCPCountReservation, ESPMode::ThreadSafe>(Responses);

		PendingCommand->Release(); // game-thread dequeue
		Response->Release();       // rejection or writer completion
		ClientWorkers.WorkerFinished(); // reader disconnect; writer still owns slot
		TestEqual(TEXT("reader cleanup retains client accounting"), Clients.GetValue(), 1);
		ClientWorkers.WorkerFinished(); // writer exits and releases the slot
		// Shutdown may visit every cleanup branch again.
		PendingCommand->Release();
		Response->Release();
		ClientWorkers.WorkerFinished();
	}
	TestEqual(TEXT("client accounting never goes negative"), Clients.GetValue(), 0);
	TestEqual(TEXT("pending accounting never goes negative"), Pending.GetValue(), 0);
	TestEqual(TEXT("response accounting never goes negative"), Responses.GetValue(), 0);

	return true;
}

#endif
