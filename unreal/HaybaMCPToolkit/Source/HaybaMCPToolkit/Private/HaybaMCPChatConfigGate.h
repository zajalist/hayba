#pragma once

#include "CoreMinimal.h"

/** Keeps an HTTP config completion from starting a stream after Stop. */
struct FHaybaMCPChatConfigGate
{
    uint64 Generation = 0;
    bool bPending = false;

    uint64 Begin()
    {
        bPending = true;
        return ++Generation;
    }

    bool IsPending() const { return bPending; }

    bool Complete(uint64 Token)
    {
        if (!bPending || Token != Generation) return false;
        bPending = false;
        return true;
    }

    bool Cancel()
    {
        if (!bPending) return false;
        ++Generation;
        bPending = false;
        return true;
    }
};
