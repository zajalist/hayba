// HaybaMCPBatchHandler.h - editor_batch / batch_status.
//
// editor_batch runs several commands under one lease, in order, on the game
// thread: one step per tick through the normal ProcessCommand path, with a
// fence after each step that waits (across ticks, never blocking) for shaders,
// the asset registry, GC and async loading to settle. It returns a job_id at
// once; batch_status (or build_status) reports progress and the result.
//
// wp_region_load / wp_region_unload are steps the batch runs natively with a
// UWorldPartitionEditorLoaderAdapter it owns, so every region a batch loads is
// released by the time the batch ends. The state machine is the pure
// HaybaMCPBatch::FMachine (HaybaMCPBatchPolicy.h). See docs/adr/0010.

#pragma once
#include "IHaybaMCPHandler.h"

class FHaybaMCPBatchHandler : public IHaybaMCPHandler
{
public:
	virtual FString GetDomain() const override { return TEXT("batch"); }
	virtual TArray<FString> GetCommands() const override;
	virtual FHaybaHandlerResult Handle(const FString& Command, const TSharedPtr<FJsonObject>& Params) override;

private:
	FHaybaHandlerResult Start(const TSharedPtr<FJsonObject>& Params);
	FHaybaHandlerResult Status(const TSharedPtr<FJsonObject>& Params);
};

#if WITH_DEV_AUTOMATION_TESTS
/** Test-only seams for Hayba.MCP.Health.Batch* (free functions: the class layout does not change). */
namespace HaybaMCPBatchTestHooks
{
	/** Start recording "RunStep", "CollectGarbage", "UnloadAll", "ReleaseEditorLoaderAdapter", "ReleaseAll". */
	void BeginRecording();
	/** Stop recording and return what the pump did since BeginRecording. */
	TArray<FString> EndRecording();
	/** Run one pump of an active job now. False when the job is not active. */
	bool PumpOnceForTests(const FString& JobId);
	/** Run wp_region_load / wp_region_unload against a throwaway batch state; returns the error ("" on success). */
	FString RunRegionStepForTests(const FString& Cmd, const TSharedPtr<FJsonObject>& Params);
	/** Give an active job one region that counts as loaded: a transient loader adapter that belongs to no
	 *  World Partition and has no loader, so releasing it would only reset the pointer. False when the job is not active. */
	bool InjectFakeLoadedRegion(const FString& JobId, const FString& Name);
	/** Drop the strong references InjectFakeLoadedRegion holds. Call it in ON_SCOPE_EXIT. */
	void ReleaseFakeLoadedRegions();
}
#endif
