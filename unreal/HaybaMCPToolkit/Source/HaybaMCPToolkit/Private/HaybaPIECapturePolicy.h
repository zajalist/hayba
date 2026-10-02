#pragma once

#include "CoreMinimal.h"

// Pure bounds and completion policy for the asynchronous PIE capture.
namespace HaybaPIECapturePolicy
{
    constexpr int32 MaxFrames = 600;
    constexpr int32 MaxWarmupFrames = 120;

    inline bool ValidRequest(int32 Frames, int32 Warmup)
    {
        return Frames >= 1 && Frames <= MaxFrames
            && Warmup >= 0 && Warmup <= MaxWarmupFrames;
    }

    inline bool ReachedTickLimit(int32 Seen, int32 Frames, int32 Warmup)
    {
        return Seen >= Frames + Warmup;
    }

    inline bool SamplesTruncated(bool bComplete, int32 Collected, int32 Requested)
    {
        return bComplete && Collected < Requested;
    }

    inline bool MustAbort(bool bUnsafe, bool bPieRunning, bool bSameEndSerial,
        bool bWorldValid, bool bSameWorld)
    {
        return bUnsafe || !bPieRunning || !bSameEndSerial || !bWorldValid || !bSameWorld;
    }
}
