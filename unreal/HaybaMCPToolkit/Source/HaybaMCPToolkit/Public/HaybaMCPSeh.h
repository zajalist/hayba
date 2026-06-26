#pragma once
#include "CoreMinimal.h"

// Structured-exception guard for native calls that can fault the process.
//
// Some synchronous editor operations we invoke (RecompileMaterial,
// PostEditChange, stat extraction, …) broadcast change notifications that can
// reach a stale/destroyed callback — most often a Python-registered editor
// delegate whose target was garbage-collected — and dereference freed memory.
// That is a C-level access violation, NOT a C++/Python exception, so try/catch
// cannot stop it: it takes the whole editor down. RunGuarded wraps the call in
// Windows SEH and converts such a fault into a reported flag, keeping the
// editor alive.
//
// The thunk takes a void* context so callers can pass a CAPTURELESS lambda
// (which converts to a function pointer). TFunctionRef cannot be used: MSVC
// C2712 forbids C++ object unwinding across __try, and even a TFunctionRef
// parameter trips it on the 14.50 toolchain. Non-Windows runs the thunk directly.
namespace HaybaSeh
{
    void RunGuarded(void (*Thunk)(void*), void* Context, bool& bOutCrashed);
}
