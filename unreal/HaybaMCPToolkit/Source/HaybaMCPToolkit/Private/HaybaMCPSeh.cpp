#include "HaybaMCPSeh.h"
#if PLATFORM_WINDOWS
#include <excpt.h>   // EXCEPTION_EXECUTE_HANDLER
#endif

namespace HaybaSeh
{
    void RunGuarded(void (*Thunk)(void*), void* Context, bool& bOutCrashed)
    {
        bOutCrashed = false;
        if (!Thunk) return;
#if PLATFORM_WINDOWS
        __try
        {
            Thunk(Context);
        }
        __except (EXCEPTION_EXECUTE_HANDLER)
        {
            bOutCrashed = true;
        }
#else
        Thunk(Context);
#endif
    }
}
