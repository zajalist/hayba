// HaybaMCPRenderHandler.h — verified single-file UE screenshot pipeline.
//
// One command `render_camera` that accepts either an actor reference or an
// inline transform, calls the wait_for_idle predicates internally for
// shaders/assets/world_tick, captures via USceneCaptureComponent2D, writes
// the file to disk, then VERIFIES the file landed (magic bytes + dimensions)
// before returning ok. Closes mcp-architectural-issues #2.
//
// Companion spec: docs/superpowers/specs/2026-05-21-render-camera-design.md
//
// All scene-graph + render-target work happens on the game thread via
// AsyncTask(ENamedThreads::GameThread). The TCP handler thread blocks on an
// FEvent until the game-thread render completes, same pattern as IdleHandler.

#pragma once
#include "IHaybaMCPHandler.h"

class FHaybaMCPRenderHandler : public IHaybaMCPHandler
{
public:
    virtual FString GetDomain() const override { return TEXT("render"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Command,
                                       const TSharedPtr<FJsonObject>& Params) override;
};
