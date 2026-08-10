#pragma once

#include "CoreMinimal.h"

/**
 * Deadline state for one length-prefixed TCP frame.
 *
 * An idle client is bounded, but an idle read is not abandoned while the
 * server still owes that connection a response. Once any byte of the next
 * frame arrives, the partial-frame deadline is absolute: an in-flight command
 * never gives a slowloris extra time to finish a second frame.
 *
 * Kept independent of FSocket so the timing and transition edge cases can be
 * tested deterministically without sleeping or opening a real editor port.
 */
class FHaybaMCPFrameReadPolicy
{
public:
	explicit FHaybaMCPFrameReadPolicy(double NowSeconds, double TimeoutSeconds, int32 ResponseGeneration = 0)
		: Timeout(FMath::Max(0.001, TimeoutSeconds))
		, IdleDeadline(NowSeconds + Timeout)
		, ObservedResponseGeneration(ResponseGeneration)
	{
	}

	void MarkFrameStarted(double NowSeconds)
	{
		if (!bFrameStarted)
		{
			bFrameStarted = true;
			PartialFrameDeadline = NowSeconds + Timeout;
		}
	}

	bool ShouldDisconnect(double NowSeconds, bool bResponsePending, int32 ResponseGeneration = 0)
	{
		if (bFrameStarted)
		{
			return NowSeconds >= PartialFrameDeadline;
		}

		if (bResponsePending)
		{
			return false;
		}

		// A generation is written before the pending count is cleared. Unlike a
		// sampled boolean, it still records a response that began and completed
		// while this reader thread was descheduled.
		if (ResponseGeneration != ObservedResponseGeneration)
		{
			ObservedResponseGeneration = ResponseGeneration;
			IdleDeadline = NowSeconds + Timeout;
			return false;
		}

		return NowSeconds >= IdleDeadline;
	}

	bool HasStartedFrame() const { return bFrameStarted; }

private:
	double Timeout = 5.0;
	double IdleDeadline = 0.0;
	double PartialFrameDeadline = 0.0;
	bool bFrameStarted = false;
	int32 ObservedResponseGeneration = 0;
};

/** Bounded response-send deadlines: progress refreshes only the stall window;
 *  it cannot extend the absolute ceiling forever. */
class FHaybaMCPSendDeadlinePolicy
{
public:
	FHaybaMCPSendDeadlinePolicy(double NowSeconds, double StallTimeoutSeconds, double TotalTimeoutSeconds)
		: StallTimeout(FMath::Max(0.001, StallTimeoutSeconds))
		, StallDeadline(NowSeconds + StallTimeout)
		, TotalDeadline(NowSeconds + FMath::Max(StallTimeout, TotalTimeoutSeconds))
	{
	}

	bool ShouldAbort(double NowSeconds) const
	{
		return NowSeconds >= StallDeadline || NowSeconds >= TotalDeadline;
	}

	void MarkProgress(double NowSeconds)
	{
		StallDeadline = NowSeconds + StallTimeout;
	}

private:
	double StallTimeout = 5.0;
	double StallDeadline = 0.0;
	double TotalDeadline = 0.0;
};
