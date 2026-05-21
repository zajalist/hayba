// HaybaMCPIdleHandler.h — UE subsystem readiness waits (wait_for_idle).
//
// Single command `wait_for_idle` that polls per-subsystem IsBusy() predicates
// at 250ms cadence on the game thread (via FTSTicker), blocks the calling
// TCP-handler thread on an FEvent until all requested subsystems settle or
// the timeout expires. Subsystem set v1: shaders, assets, gc, pcg, world_tick.
//
// Companion spec: docs/superpowers/specs/2026-05-21-wait-for-idle-design.md
//
// Also exposes a `wait_for_shaders` command that delegates to wait_for_idle
// with subsystems=['shaders'], so this single handler subsumes both names.

#pragma once
#include "IHaybaMCPHandler.h"

class FHaybaMCPIdleHandler : public IHaybaMCPHandler
{
public:
    virtual FString GetDomain() const override { return TEXT("idle"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Command,
                                       const TSharedPtr<FJsonObject>& Params) override;
};
