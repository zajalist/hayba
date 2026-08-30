#pragma once

#include "CoreMinimal.h"
#include "HAL/CriticalSection.h"
#include "HAL/ThreadSafeCounter.h"
#include "Misc/ScopeLock.h"

/**
 * Pure, allocation-free admission decisions for the TCP response path.
 *
 * The production sender measures UTF-8 bytes before constructing FTCHARToUTF8,
 * then calls ClassifyFrameBytes. Tests can pass UINT64_MAX here without ever
 * allocating an attacker-sized FString or byte buffer.
 */
enum class EHaybaMCPResponseAdmission : uint8
{
	Accepted,
	Empty,
	Oversized,
};

class FHaybaMCPOutboundAdmission
{
public:
	static EHaybaMCPResponseAdmission ClassifyFrameBytes(uint64 FrameBytes, uint64 MaxFrameBytes)
	{
		if (FrameBytes == 0)
		{
			return EHaybaMCPResponseAdmission::Empty;
		}
		return FrameBytes <= MaxFrameBytes
			? EHaybaMCPResponseAdmission::Accepted
			: EHaybaMCPResponseAdmission::Oversized;
	}
};

class FHaybaMCPOutboundBudgetReservation;

/** Lock-guarded outbound memory-byte budget; never relies on counter return semantics. */
class FHaybaMCPOutboundBudget
{
public:
	explicit FHaybaMCPOutboundBudget(int64 InMaxBytes = 1)
		: MaxBytes(FMath::Max<int64>(1, InMaxBytes))
	{
	}

	bool Configure(int64 InMaxBytes)
	{
		FScopeLock Lock(&Mutex);
		// Start() reconfigures only after the previous workers were joined.
		if (ReservedBytes != 0)
		{
			return false;
		}
		MaxBytes = FMath::Max<int64>(1, InMaxBytes);
		return true;
	}

	int64 GetReservedBytes() const
	{
		FScopeLock Lock(&Mutex);
		return ReservedBytes;
	}

	int64 GetMaxBytes() const
	{
		FScopeLock Lock(&Mutex);
		return MaxBytes;
	}

private:
	friend class FHaybaMCPOutboundBudgetReservation;

	bool TryReserve(int64 CandidateBytes)
	{
		FScopeLock Lock(&Mutex);
		if (CandidateBytes <= 0 || ReservedBytes < 0 || ReservedBytes > MaxBytes
			|| CandidateBytes > MaxBytes - ReservedBytes)
		{
			return false;
		}
		ReservedBytes += CandidateBytes;
		return true;
	}

	void Release(int64 Bytes)
	{
		FScopeLock Lock(&Mutex);
		if (Bytes <= 0 || Bytes > ReservedBytes)
		{
			return;
		}
		ReservedBytes -= Bytes;
	}

	mutable FCriticalSection Mutex;
	int64 MaxBytes = 1;
	int64 ReservedBytes = 0;
};

using FHaybaMCPOutboundBudgetPtr = TSharedPtr<FHaybaMCPOutboundBudget, ESPMode::ThreadSafe>;

/** Coupled per-client/global lease held until the exact send completes. */
class FHaybaMCPOutboundBudgetReservation
{
public:
	static TSharedPtr<FHaybaMCPOutboundBudgetReservation, ESPMode::ThreadSafe> TryCreate(
		const FHaybaMCPOutboundBudgetPtr& ClientBudget,
		const FHaybaMCPOutboundBudgetPtr& GlobalBudget,
		int64 CandidateBytes)
	{
		if (!ClientBudget.IsValid() || !GlobalBudget.IsValid()
			|| !ClientBudget->TryReserve(CandidateBytes))
		{
			return nullptr;
		}
		if (!GlobalBudget->TryReserve(CandidateBytes))
		{
			ClientBudget->Release(CandidateBytes);
			return nullptr;
		}
		return MakeShared<FHaybaMCPOutboundBudgetReservation, ESPMode::ThreadSafe>(
			ClientBudget, GlobalBudget, CandidateBytes);
	}

	FHaybaMCPOutboundBudgetReservation(
		FHaybaMCPOutboundBudgetPtr InClientBudget,
		FHaybaMCPOutboundBudgetPtr InGlobalBudget,
		int64 InReservedBytes)
		: ClientBudget(MoveTemp(InClientBudget))
		, GlobalBudget(MoveTemp(InGlobalBudget))
		, ReservedBytes(InReservedBytes)
	{
	}

	~FHaybaMCPOutboundBudgetReservation()
	{
		Release();
	}

	FHaybaMCPOutboundBudgetReservation(const FHaybaMCPOutboundBudgetReservation&) = delete;
	FHaybaMCPOutboundBudgetReservation& operator=(const FHaybaMCPOutboundBudgetReservation&) = delete;

	void Release()
	{
		FHaybaMCPOutboundBudgetPtr ClientToRelease;
		FHaybaMCPOutboundBudgetPtr GlobalToRelease;
		int64 BytesToRelease = 0;
		{
			FScopeLock Lock(&Mutex);
			if (ReservedBytes <= 0)
			{
				return;
			}
			BytesToRelease = ReservedBytes;
			ReservedBytes = 0;
			ClientToRelease = MoveTemp(ClientBudget);
			GlobalToRelease = MoveTemp(GlobalBudget);
		}
		ClientToRelease->Release(BytesToRelease);
		GlobalToRelease->Release(BytesToRelease);
	}

private:
	FCriticalSection Mutex;
	FHaybaMCPOutboundBudgetPtr ClientBudget;
	FHaybaMCPOutboundBudgetPtr GlobalBudget;
	int64 ReservedBytes = 0;
};

using FHaybaMCPOutboundBudgetReservationPtr =
	TSharedPtr<FHaybaMCPOutboundBudgetReservation, ESPMode::ThreadSafe>;

/**
 * A counter reservation that can be released from every cleanup branch while
 * decrementing its counter exactly once. The lock makes duplicate/concurrent
 * Release calls deterministic; the destructor is the final fallback.
 */
class FHaybaMCPCountReservation
{
public:
	explicit FHaybaMCPCountReservation(FThreadSafeCounter& InCounter)
		: Counter(InCounter)
		, CountAfterAcquire(Counter.Increment())
	{
	}

	~FHaybaMCPCountReservation()
	{
		Release();
	}

	FHaybaMCPCountReservation(const FHaybaMCPCountReservation&) = delete;
	FHaybaMCPCountReservation& operator=(const FHaybaMCPCountReservation&) = delete;

	int32 GetCountAfterAcquire() const { return CountAfterAcquire; }

	int32 Release()
	{
		FScopeLock Lock(&Mutex);
		if (!bHeld)
		{
			return Counter.GetValue();
		}
		bHeld = false;
		return Counter.Decrement();
	}

	bool IsHeld() const
	{
		FScopeLock Lock(&Mutex);
		return bHeld;
	}

private:
	FThreadSafeCounter& Counter;
	const int32 CountAfterAcquire;
	mutable FCriticalSection Mutex;
	bool bHeld = true;
};

using FHaybaMCPCountReservationPtr = TSharedPtr<FHaybaMCPCountReservation, ESPMode::ThreadSafe>;

struct FHaybaMCPWorkerCompletion
{
	bool bReleasedReservation = false;
	int32 RemainingWorkers = 0;
	int32 CountAfterRelease = 0;
};

/**
 * Explicitly coordinates every worker that occupies one bounded client slot.
 * A reader exit closes the connection but cannot admit a replacement while its
 * serial writer still owns server code/socket state. The final worker releases
 * the reservation; destruction is the exactly-once startup/shutdown fallback.
 */
class FHaybaMCPWorkerQuorum
{
public:
	FHaybaMCPWorkerQuorum(int32 InExpectedWorkers, FHaybaMCPCountReservationPtr InReservation)
		: RemainingWorkers(FMath::Max(0, InExpectedWorkers))
		, Reservation(MoveTemp(InReservation))
	{
	}

	FHaybaMCPWorkerQuorum(const FHaybaMCPWorkerQuorum&) = delete;
	FHaybaMCPWorkerQuorum& operator=(const FHaybaMCPWorkerQuorum&) = delete;

	FHaybaMCPWorkerCompletion WorkerFinished()
	{
		FHaybaMCPCountReservationPtr ReservationToRelease;
		FHaybaMCPWorkerCompletion Result;
		{
			FScopeLock Lock(&Mutex);
			if (RemainingWorkers <= 0)
			{
				Result.CountAfterRelease = Reservation.IsValid()
					? Reservation->GetCountAfterAcquire()
					: 0;
				return Result;
			}

			--RemainingWorkers;
			Result.RemainingWorkers = RemainingWorkers;
			if (RemainingWorkers == 0)
			{
				ReservationToRelease = MoveTemp(Reservation);
			}
		}

		if (ReservationToRelease.IsValid())
		{
			Result.CountAfterRelease = ReservationToRelease->Release();
			Result.bReleasedReservation = true;
		}
		return Result;
	}

private:
	FCriticalSection Mutex;
	int32 RemainingWorkers;
	FHaybaMCPCountReservationPtr Reservation;
};
