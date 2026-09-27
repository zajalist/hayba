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
