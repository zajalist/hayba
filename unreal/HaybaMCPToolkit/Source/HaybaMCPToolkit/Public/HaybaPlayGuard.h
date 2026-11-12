#pragma once

#include "CoreMinimal.h"

// PIE never starts into UE's modal "Blueprint Compilation Errors" prompt.
//
// When a loaded Blueprint fails to compile, UE's pre-PIE pass asks whether to play anyway in a modal dialog. The
// dialog parks the game thread until a human answers it, and on a production project's shared editor nobody did: 6 h frozen on
// 2026-11-09 (BP_RoomAudio, a function named like its component). Every PIE start Hayba sees asks here first.
namespace HaybaPlayGuard
{
    /** Loaded Blueprints UE's pre-PIE pass would stop on, sorted by path. */
    HAYBAMCPTOOLKIT_API TArray<FString> BlueprintsFailingToCompile();

    /** "<Cmd> refused [HCR-PIE-001]: ..." naming them, or empty when PIE may start. */
    HAYBAMCPTOOLKIT_API FString RefusalFor(const TCHAR* Cmd);
}
