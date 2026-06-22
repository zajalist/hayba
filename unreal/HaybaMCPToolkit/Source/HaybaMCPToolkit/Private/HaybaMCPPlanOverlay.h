#pragma once
#include "CoreMinimal.h"
#include "Containers/Ticker.h"

// Green/red plan-mode viewport overlay (Plan C3 / the original Phase 4). When
// Plan Mode is ON, reads .scratch/verdicts.json (written by plumb_validate
// write_overlay) and draws, per matched level actor, a green box (passes) or a
// red box + fix-vector arrow (a hard gate fails) in the level viewport.
class FHaybaPlanOverlay
{
public:
    void Register();
    void Unregister();

private:
    bool Tick(float DeltaSeconds);
    FTSTicker::FDelegateHandle TickHandle;
    double LastReadTime = 0.0;
};
