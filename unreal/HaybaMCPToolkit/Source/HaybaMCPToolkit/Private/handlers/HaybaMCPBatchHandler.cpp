// HaybaMCPBatchHandler.cpp - see header.
//
// Threading: everything here runs on the game thread. Start() is dispatched by
// the router; the pump is an FTSTicker core-ticker delegate (outside task-graph
// execution, the same reason the TCP drain and test_run use one). Each pump
// asks the pure machine for ONE action and does it. Nothing ever waits.

#include "HaybaMCPBatchHandler.h"

#include "HaybaMCPAccessPolicy.h"
#include "HaybaMCPBatchPolicy.h"
#include "HaybaMCPCommandHandler.h"
#include "HaybaMCPJobRegistry.h"
#include "HaybaMCPLeaseManager.h"
#include "HaybaMCPModule.h"
#include "HaybaMCPSettings.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "Containers/Ticker.h"
#include "Dom/JsonObject.h"
#include "Editor.h"
#include "Engine/World.h"
#include "HAL/PlatformTime.h"
#include "Modules/ModuleManager.h"
#include "Policies/CondensedJsonPrintPolicy.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "ShaderCompiler.h"
#include "UObject/UObjectGlobals.h"
#include "WorldPartition/LoaderAdapter/LoaderAdapterShape.h"
#include "WorldPartition/WorldPartition.h"
#include "WorldPartition/WorldPartitionEditorLoaderAdapter.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPBatch, Log, All);

namespace
{
	using namespace HaybaMCPBatch;

	constexpr int32 MaxStepDataChars = 16 * 1024;
	/** Keep the batch lease alive while it runs: renew when this close to lapsing. */
	constexpr double LeaseKeepAliveBelowSeconds = 30.0;
	constexpr double LeaseKeepAliveTtlSeconds = 90.0;

	FString JsonToCondensed(const TSharedPtr<FJsonObject>& Obj)
	{
		FString Out;
		if (!Obj.IsValid()) return Out;
		TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
			TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Out);
		FJsonSerializer::Serialize(Obj.ToSharedRef(), Writer);
		return Out;
	}

	TSharedPtr<FJsonObject> ParseObject(const FString& Text)
	{
		TSharedPtr<FJsonObject> Obj;
		TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Text);
		if (!FJsonSerializer::Deserialize(Reader, Obj)) return nullptr;
		return Obj;
	}

	UWorld* EditorWorld()
	{
		return GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
	}

	/** The same predicates as wait_for_idle (HaybaMCPIdleHandler.cpp) plus async
	 *  loading. Empty = idle; otherwise a comma-separated list of what is busy. */
	FString BusySubsystems()
	{
		TArray<FString> Busy;
		if (GShaderCompilingManager && GShaderCompilingManager->IsCompiling())
		{
			Busy.Add(TEXT("shaders"));
		}
		if (FAssetRegistryModule* Registry = FModuleManager::GetModulePtr<FAssetRegistryModule>(TEXT("AssetRegistry")))
		{
			if (Registry->Get().IsLoadingAssets()) Busy.Add(TEXT("assets"));
		}
		if (IsGarbageCollecting() || IsIncrementalPurgePending())
		{
			Busy.Add(TEXT("gc"));
		}
		if (IsAsyncLoading())
		{
			Busy.Add(TEXT("async_loading"));
		}
		return FString::Join(Busy, TEXT(","));
	}

	struct FRegion
	{
		FString Name;
		HaybaMCPAccess::FResource Resource;
		TWeakObjectPtr<UWorldPartition> WorldPartition;
		TWeakObjectPtr<UWorldPartitionEditorLoaderAdapter> Adapter;
	};

	struct FStepRecord
	{
		FString Cmd;
		bool bRan = false;
		bool bOk = false;
		FString Error;
		FString DataJson;
		bool bDataTruncated = false;
		TSharedPtr<FJsonObject> LeaseWarning;
		double DurationMs = 0.0;
		bool bGcRanAfter = false;
	};

	struct FBatchState
	{
		FString JobId;
		FString Owner;
		FString LeaseToken;
		FString WorldPackage;
		FString OnErrorText;
		bool bPlanPreApproved = false;
		/** Params kept as text and parsed again for every step: no step holds
		 *  an object pointer across a fence, where GC may collect anything.
		 *  Each step re-resolves its soft paths when it runs. */
		TArray<FString> StepParamsJson;
		TArray<FStepRecord> Records;
		TArray<FRegion> Regions;
		TUniquePtr<FMachine> Machine;
		FString LastBusy;
		double StartedAt = 0.0;
		double FinishedAt = 0.0;
		FTSTicker::FDelegateHandle TickHandle;
		bool bInPump = false;
		bool bFinalized = false;

		~FBatchState()
		{
			if (!bFinalized && !JobId.IsEmpty())
			{
				// Module teardown can drop the last reference without another
				// pump. Never leave the job reporting "running" forever. The
				// world partition releases its own adapters on uninitialize.
				FHaybaMCPJobRegistry::Get().SetDone(JobId, 1,
					TEXT("{\"status\":\"failed\",\"error\":\"editor_batch state was destroyed before completion\"}"));
			}
		}
	};

	/** Running batches by job id (game thread only). Leaked on purpose, like
	 *  the test-run state: it must outlive static destruction order. */
	TMap<FString, TSharedPtr<FBatchState>>& ActiveBatches()
	{
		static TMap<FString, TSharedPtr<FBatchState>>* Map = new TMap<FString, TSharedPtr<FBatchState>>();
		return *Map;
	}

	HaybaMCPAccess::EAccessClass ClassOf(const FString& Cmd)
	{
		return HaybaMCPAccess::ClassifyCommand(Cmd, FHaybaMCPCommandHandler::IsPlanGatedCommand(Cmd)).Class;
	}

	// -------------------------------------------------------------------------
	// World Partition regions (batch-owned loader adapters)
	// -------------------------------------------------------------------------

	bool ReadNumber(const TSharedPtr<FJsonValue>& V, double& Out)
	{
		return V.IsValid() && V->TryGetNumber(Out) && FMath::IsFinite(Out);
	}

	/** [minX,minY,maxX,maxY] or {min:[x,y]|{x,y}, max:[x,y]|{x,y}}. */
	bool ParseBounds(const TSharedPtr<FJsonObject>& P, double& MinX, double& MinY, double& MaxX, double& MaxY, FString& Error)
	{
		const TArray<TSharedPtr<FJsonValue>>* Flat = nullptr;
		if (P->TryGetArrayField(TEXT("bounds"), Flat) && Flat)
		{
			if (Flat->Num() != 4 || !ReadNumber((*Flat)[0], MinX) || !ReadNumber((*Flat)[1], MinY)
				|| !ReadNumber((*Flat)[2], MaxX) || !ReadNumber((*Flat)[3], MaxY))
			{
				Error = TEXT("bounds must be [minX, minY, maxX, maxY] in world units");
				return false;
			}
		}
		else
		{
			const TSharedPtr<FJsonObject>* Obj = nullptr;
			if (!P->TryGetObjectField(TEXT("bounds"), Obj) || !Obj || !Obj->IsValid())
			{
				Error = TEXT("bounds is required: [minX, minY, maxX, maxY] or {min:[x,y], max:[x,y]}");
				return false;
			}
			auto ReadPoint = [](const TSharedPtr<FJsonObject>& B, const TCHAR* Key, double& X, double& Y)
			{
				const TArray<TSharedPtr<FJsonValue>>* Arr = nullptr;
				if (B->TryGetArrayField(Key, Arr) && Arr && Arr->Num() >= 2)
				{
					return ReadNumber((*Arr)[0], X) && ReadNumber((*Arr)[1], Y);
				}
				const TSharedPtr<FJsonObject>* Pt = nullptr;
				if (B->TryGetObjectField(Key, Pt) && Pt && Pt->IsValid())
				{
					return (*Pt)->TryGetNumberField(TEXT("x"), X) && (*Pt)->TryGetNumberField(TEXT("y"), Y);
				}
				return false;
			};
			if (!ReadPoint(*Obj, TEXT("min"), MinX, MinY) || !ReadPoint(*Obj, TEXT("max"), MaxX, MaxY))
			{
				Error = TEXT("bounds {min, max} needs [x,y] or {x,y} for both corners");
				return false;
			}
		}
		if (MinX >= MaxX || MinY >= MaxY)
		{
			Error = TEXT("bounds min must be below max on both axes");
			return false;
		}
		return true;
	}

	int32 CountLoaded(const FBatchState& S)
	{
		int32 N = 0;
		for (const FRegion& R : S.Regions)
		{
			if (R.Adapter.IsValid()) ++N;
		}
		return N;
	}

	/** Release one region. False only when something was left loaded. */
	bool ReleaseRegion(FRegion& R, FString& OutNote)
	{
		UWorldPartition* WP = R.WorldPartition.Get();
		UWorldPartitionEditorLoaderAdapter* Adapter = R.Adapter.Get();
		R.Adapter.Reset();
		if (!WP || !Adapter || !WP->GetRegisteredEditorLoaderAdapters().Contains(Adapter))
		{
			OutNote = FString::Printf(TEXT("region '%s' was already released by a world teardown"), *R.Name);
			return true;
		}
		if (IWorldPartitionActorLoaderInterface::ILoaderAdapter* Loader = Adapter->GetLoaderAdapter())
		{
			Loader->Unload();
		}
		WP->ReleaseEditorLoaderAdapter(Adapter);
		return true;
	}

	bool RunRegionLoad(FBatchState& S, const TSharedPtr<FJsonObject>& P, TSharedPtr<FJsonObject>& OutData, FString& Error)
	{
		double MinX = 0, MinY = 0, MaxX = 0, MaxY = 0;
		if (!ParseBounds(P, MinX, MinY, MaxX, MaxY, Error))
		{
			Error = TEXT("wp_region_load: ") + Error;
			return false;
		}
		UWorld* World = EditorWorld();
		UWorldPartition* WP = World ? World->GetWorldPartition() : nullptr;
		if (!WP)
		{
			Error = TEXT("wp_region_load: the editor world has no World Partition");
			return false;
		}
		const FString Package = FHaybaMCPLeaseManager::CurrentWorldPackage();
		if (!S.WorldPackage.IsEmpty() && !Package.Equals(S.WorldPackage, ESearchCase::IgnoreCase))
		{
			Error = FString::Printf(TEXT("wp_region_load: the editor world changed since the batch started (%s -> %s)"),
				*S.WorldPackage, *Package);
			return false;
		}

		HaybaMCPAccess::FResource Region;
		Region.Kind = HaybaMCPAccess::EResourceKind::WpRegion;
		Region.World = Package.ToLower();
		Region.MinX = MinX;
		Region.MinY = MinY;
		Region.MaxX = MaxX;
		Region.MaxY = MaxY;
		const HaybaMCPLease::FLease* Lease = FHaybaMCPLeaseManager::Get().Table().FindLease(S.LeaseToken);
		if (!Lease || !LeaseCoversRegion(Lease->Locks, Region))
		{
			Error = FString::Printf(
				TEXT("wp_region_load: the batch lease does not hold %s exclusively; acquire world:%s or a wp-region containing it"),
				*Region.Key(), *Package);
			return false;
		}

		FString Name;
		P->TryGetStringField(TEXT("name"), Name);
		if (Name.IsEmpty()) Name = FString::Printf(TEXT("r%d"), S.Regions.Num());
		for (const FRegion& Existing : S.Regions)
		{
			if (Existing.Name == Name && Existing.Adapter.IsValid())
			{
				Error = FString::Printf(TEXT("wp_region_load: region '%s' is already loaded by this batch"), *Name);
				return false;
			}
		}

		const FBox Box(FVector(MinX, MinY, -HALF_WORLD_MAX), FVector(MaxX, MaxY, HALF_WORLD_MAX));
		const FString Label = FString::Printf(TEXT("Hayba batch %s: %s"), *S.JobId.Left(8), *Name);
		UWorldPartitionEditorLoaderAdapter* Adapter = WP->CreateEditorLoaderAdapter<FLoaderAdapterShape>(World, Box, Label);
		if (!Adapter || !Adapter->GetLoaderAdapter())
		{
			Error = TEXT("wp_region_load: could not create a loader adapter");
			return false;
		}
		Adapter->GetLoaderAdapter()->Load();

		FRegion Loaded;
		Loaded.Name = Name;
		Loaded.Resource = Region;
		Loaded.WorldPartition = WP;
		Loaded.Adapter = Adapter;
		S.Regions.Add(Loaded);

		OutData = MakeShared<FJsonObject>();
		OutData->SetStringField(TEXT("region"), Name);
		OutData->SetStringField(TEXT("resource"), Region.Key());
		OutData->SetBoolField(TEXT("loaded"), Adapter->GetLoaderAdapter()->IsLoaded());
		OutData->SetStringField(TEXT("note"), TEXT("Released by a wp_region_unload step, or automatically when the batch ends."));
		return true;
	}

	bool RunRegionUnload(FBatchState& S, const TSharedPtr<FJsonObject>& P, TSharedPtr<FJsonObject>& OutData, FString& Error)
	{
		FString Name;
		P->TryGetStringField(TEXT("name"), Name);
		TArray<TSharedPtr<FJsonValue>> Released;
		TArray<TSharedPtr<FJsonValue>> Notes;
		for (FRegion& R : S.Regions)
		{
			if (!R.Adapter.IsValid() || (!Name.IsEmpty() && R.Name != Name)) continue;
			FString Note;
			ReleaseRegion(R, Note);
			Released.Add(MakeShared<FJsonValueString>(R.Name));
			if (!Note.IsEmpty()) Notes.Add(MakeShared<FJsonValueString>(Note));
		}
		if (!Name.IsEmpty() && Released.Num() == 0)
		{
			Error = FString::Printf(TEXT("wp_region_unload: no region named '%s' is loaded by this batch"), *Name);
			return false;
		}
		OutData = MakeShared<FJsonObject>();
		OutData->SetArrayField(TEXT("released"), Released);
		if (Notes.Num() > 0) OutData->SetArrayField(TEXT("notes"), Notes);
		return true;
	}

	TArray<FString> ReleaseAll(FBatchState& S)
	{
		TArray<FString> Notes;
		for (FRegion& R : S.Regions)
		{
			if (!R.Adapter.IsValid()) continue;
			FString Note;
			ReleaseRegion(R, Note);
			Notes.Add(Note.IsEmpty() ? FString::Printf(TEXT("released region '%s' at batch end"), *R.Name) : Note);
		}
		return Notes;
	}

	// -------------------------------------------------------------------------
	// Steps
	// -------------------------------------------------------------------------

	void RunStep(FBatchState& S, int32 Index, bool& bOk, FString& Error)
	{
		FStepRecord& Record = S.Records[Index];
		const FString& Cmd = S.Machine->GetStep(Index).Cmd;
		const double T0 = FPlatformTime::Seconds();
		Record.bRan = true;

		TSharedPtr<FJsonObject> Params = ParseObject(S.StepParamsJson[Index]);
		if (!Params.IsValid()) Params = MakeShared<FJsonObject>();

		TSharedPtr<FJsonObject> Data;
		if (Cmd == TEXT("wp_region_load"))
		{
			bOk = RunRegionLoad(S, Params, Data, Error);
		}
		else if (Cmd == TEXT("wp_region_unload"))
		{
			bOk = RunRegionUnload(S, Params, Data, Error);
		}
		else if (const FString Refusal = CheckStepAllowed(ClassOf(Cmd), CountLoaded(S)); !Refusal.IsEmpty())
		{
			bOk = false;
			Error = Refusal;
		}
		else
		{
			FHaybaMCPModule* Module = FModuleManager::GetModulePtr<FHaybaMCPModule>(TEXT("HaybaMCPToolkit"));
			const TSharedPtr<FHaybaMCPCommandHandler> Router = Module ? Module->GetCommandHandler() : nullptr;
			if (!Router.IsValid())
			{
				bOk = false;
				Error = TEXT("the command router is not available");
			}
			else
			{
				TSharedPtr<FJsonObject> Envelope = MakeShared<FJsonObject>();
				Envelope->SetStringField(TEXT("cmd"), Cmd);
				Envelope->SetStringField(TEXT("id"), FString::Printf(TEXT("batch-%s-%d"), *S.JobId.Left(8), Index));
				Envelope->SetObjectField(TEXT("params"), Params);
				Envelope->SetStringField(TEXT("owner"), S.Owner);
				Envelope->SetStringField(TEXT("lease"), S.LeaseToken);
				// The batch request itself authenticated; its steps carry the
				// same capability (empty when auth is off).
				const FString& Auth = FHaybaMCPSettings::Get().CapabilityToken;
				if (!Auth.IsEmpty()) Envelope->SetStringField(TEXT("auth"), Auth);

				const FString Response = Router->ProcessBatchStep(JsonToCondensed(Envelope), S.JobId, S.bPlanPreApproved);
				const TSharedPtr<FJsonObject> Reply = ParseObject(Response);
				bOk = false;
				if (!Reply.IsValid())
				{
					Error = TEXT("the step's response was not JSON");
				}
				else
				{
					Reply->TryGetBoolField(TEXT("ok"), bOk);
					const TSharedPtr<FJsonObject>* DataObj = nullptr;
					if (Reply->TryGetObjectField(TEXT("data"), DataObj) && DataObj) Data = *DataObj;
					const TSharedPtr<FJsonObject>* Warning = nullptr;
					if (Reply->TryGetObjectField(TEXT("lease_warning"), Warning) && Warning) Record.LeaseWarning = *Warning;
					if (!bOk)
					{
						Reply->TryGetStringField(TEXT("error"), Error);
						FString Code;
						if (Reply->TryGetStringField(TEXT("code"), Code) && !Code.IsEmpty())
						{
							Error = FString::Printf(TEXT("[%s] %s"), *Code, *Error);
						}
					}
					else if (Data.IsValid())
					{
						// The Plan gate answers ok with a status, not an error.
						FString Status;
						bool bDataOk = true;
						if (Data->TryGetStringField(TEXT("status"), Status) && Status == TEXT("plan_mode_required"))
						{
							bOk = false;
							Error = TEXT("plan_mode_required: Plan Mode was turned on after this batch started; propose and approve a plan, then run the remaining steps");
						}
						else if (Data->TryGetBoolField(TEXT("ok"), bDataOk) && !bDataOk)
						{
							bOk = false;
							Data->TryGetStringField(TEXT("error"), Error);
							if (Error.IsEmpty()) Error = TEXT("the step reported ok:false");
						}
					}
				}
			}
		}

		Record.bOk = bOk;
		Record.Error = bOk ? FString() : (Error.IsEmpty() ? FString(TEXT("step failed")) : Error);
		Error = Record.Error;
		if (Data.IsValid())
		{
			Record.DataJson = JsonToCondensed(Data);
			if (Record.DataJson.Len() > MaxStepDataChars)
			{
				Record.DataJson = Record.DataJson.Left(MaxStepDataChars);
				Record.bDataTruncated = true;
			}
		}
		Record.DurationMs = (FPlatformTime::Seconds() - T0) * 1000.0;
		UE_LOG(LogHaybaMCPBatch, Log, TEXT("batch %s step %d '%s' %s (%.0f ms)%s%s"),
			*S.JobId.Left(8), Index, *Cmd, bOk ? TEXT("ok") : TEXT("FAILED"), Record.DurationMs,
			bOk ? TEXT("") : TEXT(": "), bOk ? TEXT("") : *Record.Error);
	}

	// -------------------------------------------------------------------------
	// Status JSON
	// -------------------------------------------------------------------------

	TSharedPtr<FJsonObject> BuildStatus(const FBatchState& S)
	{
		const FMachine& M = *S.Machine;
		TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
		Out->SetStringField(TEXT("command"), TEXT("editor_batch"));
		Out->SetStringField(TEXT("job_id"), S.JobId);
		Out->SetStringField(TEXT("status"), !M.IsDone() ? TEXT("running") : (M.Succeeded() ? TEXT("succeeded") : TEXT("failed")));
		Out->SetStringField(TEXT("phase"), LexPhase(M.GetPhase()));
		Out->SetStringField(TEXT("owner"), S.Owner);
		Out->SetStringField(TEXT("world"), S.WorldPackage);
		Out->SetStringField(TEXT("on_error"), S.OnErrorText);
		Out->SetNumberField(TEXT("step_index"), M.GetStepIndex());
		Out->SetNumberField(TEXT("steps_total"), M.NumSteps());
		Out->SetNumberField(TEXT("steps_run"), M.GetStepsRun());
		Out->SetNumberField(TEXT("elapsed_s"), (S.FinishedAt > 0.0 ? S.FinishedAt : FPlatformTime::Seconds()) - S.StartedAt);
		Out->SetNumberField(TEXT("yields"), M.GetYieldCount());
		Out->SetNumberField(TEXT("yield_s"), M.GetYieldSeconds());
		Out->SetBoolField(TEXT("aged"), M.IsAged());
		if (!M.IsDone() && (M.GetPhase() == EPhase::Fence || M.GetPhase() == EPhase::CleanupFence))
		{
			Out->SetStringField(TEXT("fence"), LexFence(M.GetFenceKind()));
			Out->SetStringField(TEXT("busy"), S.LastBusy.IsEmpty() ? TEXT("none") : *S.LastBusy);
		}
		if (M.Failed())
		{
			Out->SetNumberField(TEXT("failed_step"), M.GetFailedStep());
			Out->SetStringField(TEXT("error"), M.GetError());
		}

		TArray<TSharedPtr<FJsonValue>> Loaded;
		for (const FRegion& R : S.Regions)
		{
			if (R.Adapter.IsValid()) Loaded.Add(MakeShared<FJsonValueString>(R.Name));
		}
		Out->SetArrayField(TEXT("loaded_regions"), Loaded);

		TArray<TSharedPtr<FJsonValue>> Steps;
		for (int32 I = 0; I < S.Records.Num(); ++I)
		{
			const FStepRecord& R = S.Records[I];
			TSharedPtr<FJsonObject> Item = MakeShared<FJsonObject>();
			Item->SetNumberField(TEXT("index"), I);
			Item->SetStringField(TEXT("cmd"), R.Cmd);
			Item->SetStringField(TEXT("fence_after"), LexFence(M.GetStep(I).FenceAfter));
			Item->SetStringField(TEXT("state"), !R.bRan ? TEXT("pending") : (R.bOk ? TEXT("ok") : TEXT("failed")));
			if (R.bRan) Item->SetNumberField(TEXT("duration_ms"), R.DurationMs);
			if (!R.Error.IsEmpty()) Item->SetStringField(TEXT("error"), R.Error);
			if (R.bGcRanAfter) Item->SetBoolField(TEXT("gc_ran"), true);
			if (R.LeaseWarning.IsValid()) Item->SetObjectField(TEXT("lease_warning"), R.LeaseWarning);
			if (!R.DataJson.IsEmpty())
			{
				const TSharedPtr<FJsonObject> Parsed = R.bDataTruncated ? nullptr : ParseObject(R.DataJson);
				if (Parsed.IsValid()) Item->SetObjectField(TEXT("data"), Parsed);
				else
				{
					Item->SetStringField(TEXT("data_text"), R.DataJson);
					Item->SetBoolField(TEXT("data_truncated"), R.bDataTruncated);
				}
			}
			Steps.Add(MakeShared<FJsonValueObject>(Item));
		}
		Out->SetArrayField(TEXT("steps"), Steps);

		TArray<TSharedPtr<FJsonValue>> Notes;
		for (const FString& Note : M.GetNotes()) Notes.Add(MakeShared<FJsonValueString>(Note));
		Out->SetArrayField(TEXT("notes"), Notes);
		return Out;
	}

	void Finalize(const TSharedRef<FBatchState>& S)
	{
		S->FinishedAt = FPlatformTime::Seconds();
		// A batch that ended with regions loaded (it should not: cleanup runs
		// UnloadAll first) still releases them here, so they never outlive it.
		for (const FString& Note : ReleaseAll(*S))
		{
			UE_LOG(LogHaybaMCPBatch, Warning, TEXT("batch %s: %s"), *S->JobId.Left(8), *Note);
		}
		FHaybaMCPLeaseManager::Get().Table().EndYield(S->LeaseToken);
		FHaybaMCPLeaseManager::Get().Table().SetYieldable(S->LeaseToken, false);

		const TSharedPtr<FJsonObject> Result = BuildStatus(*S);
		FHaybaMCPJobRegistry::Get().SetDone(S->JobId, S->Machine->Succeeded() ? 0 : 1, JsonToCondensed(Result));
		S->bFinalized = true;
		UE_LOG(LogHaybaMCPBatch, Log, TEXT("batch %s finished: %s after %d/%d step(s)"),
			*S->JobId.Left(8), S->Machine->Succeeded() ? TEXT("succeeded") : TEXT("failed"),
			S->Machine->GetStepsRun(), S->Machine->NumSteps());
		ActiveBatches().Remove(S->JobId);
	}

	bool Pump(float /*Dt*/, const TSharedRef<FBatchState>& S)
	{
		if (S->bFinalized) return false;
		// A step that pumps the ticker itself (a modal, a slow task) must not
		// re-enter the batch.
		if (S->bInPump) return true;
		TGuardValue<bool> Guard(S->bInPump, true);

		HaybaMCPLease::FTable& Table = FHaybaMCPLeaseManager::Get().Table();
		FInputs In;
		In.Now = FPlatformTime::Seconds();
		In.BusyReason = BusySubsystems();
		In.bIdle = In.BusyReason.IsEmpty();
		S->LastBusy = In.BusyReason;
		const HaybaMCPLease::FLease* Lease = Table.FindLease(S->LeaseToken);
		In.bLeaseValid = Lease && Lease->Owner == S->Owner;
		if (In.bLeaseValid)
		{
			In.bLeaseAllowsGc = LeaseAllowsGc(Lease->Locks);
			if (Lease->ExpiresAt - In.Now < LeaseKeepAliveBelowSeconds)
			{
				double Ignored = 0.0;
				FString Error;
				Table.Renew(S->LeaseToken, S->Owner, LeaseKeepAliveTtlSeconds, Ignored, Error);
			}
			In.bEligibleWaiter = Table.HasEligibleWaiterBlockedBy(S->LeaseToken);
			In.FenceGrantsOutstanding = Table.CountFenceGrants(S->LeaseToken);
		}
		In.LoadedRegions = CountLoaded(*S);

		switch (S->Machine->Tick(In))
		{
		case EAction::Wait:
			break;
		case EAction::RunStep:
		{
			const int32 Index = S->Machine->GetStepIndex();
			bool bOk = false;
			FString Error;
			RunStep(*S, Index, bOk, Error);
			S->Machine->OnStepResult(bOk, Error, FPlatformTime::Seconds());
			break;
		}
		case EAction::CollectGarbage:
			if (S->Records.IsValidIndex(S->Machine->GetStepIndex()))
			{
				S->Records[S->Machine->GetStepIndex()].bGcRanAfter = true;
			}
			CollectGarbage(GARBAGE_COLLECTION_KEEPFLAGS, true);
			break;
		case EAction::BeginYield:
			Table.BeginYield(S->LeaseToken);
			UE_LOG(LogHaybaMCPBatch, Log, TEXT("batch %s: fence after step %d yields to a queued request"),
				*S->JobId.Left(8), S->Machine->GetStepIndex());
			break;
		case EAction::EndYield:
			Table.EndYield(S->LeaseToken);
			break;
		case EAction::UnloadAll:
			for (const FString& Note : ReleaseAll(*S))
			{
				UE_LOG(LogHaybaMCPBatch, Log, TEXT("batch %s: %s"), *S->JobId.Left(8), *Note);
			}
			break;
		case EAction::Finish:
			Finalize(S);
			return false;
		}
		return true;
	}
}

TArray<FString> FHaybaMCPBatchHandler::GetCommands() const
{
	return { TEXT("editor_batch"), TEXT("batch_status") };
}

FHaybaHandlerResult FHaybaMCPBatchHandler::Handle(const FString& Command, const TSharedPtr<FJsonObject>& Params)
{
	const TSharedPtr<FJsonObject> P = Params.IsValid() ? Params : MakeShared<FJsonObject>();
	if (Command == TEXT("editor_batch")) return Start(P);
	if (Command == TEXT("batch_status")) return Status(P);
	return FHaybaHandlerResult::Err(FString::Printf(TEXT("Unknown batch command: %s"), *Command));
}

FHaybaHandlerResult FHaybaMCPBatchHandler::Start(const TSharedPtr<FJsonObject>& P)
{
	FHaybaMCPLeaseManager& Leases = FHaybaMCPLeaseManager::Get();
	FString Token;
	if (!P->TryGetStringField(TEXT("lease"), Token) || Token.IsEmpty())
	{
		// Fall back to the envelope's lease token.
		if (const FHaybaMCPRequestContext* Context = Leases.Current()) Token = Context->LeaseToken;
	}
	if (Token.IsEmpty())
	{
		return FHaybaHandlerResult::Err(TEXT(
			"editor_batch: lease is required. lease_acquire the resources the steps touch (e.g. world:/Game/Maps/Valley), "
			"then pass its token as lease."));
	}
	const HaybaMCPLease::FLease* Lease = Leases.Table().FindLease(Token);
	if (!Lease)
	{
		return FHaybaHandlerResult::Err(TEXT("editor_batch: the lease is unknown or expired"));
	}
	const FString Caller = Leases.EffectiveOwner();
	if (Lease->Owner != Caller)
	{
		return FHaybaHandlerResult::Err(FString::Printf(
			TEXT("editor_batch: the lease belongs to '%s', not to the caller '%s'"), *Lease->Owner, *Caller));
	}
	if (Lease->bYieldable)
	{
		return FHaybaHandlerResult::Err(TEXT("editor_batch: another batch is already running under this lease"));
	}

	FString OnErrorText = TEXT("stop");
	P->TryGetStringField(TEXT("on_error"), OnErrorText);
	EOnError OnError;
	if (!ParseOnError(OnErrorText, OnError))
	{
		return FHaybaHandlerResult::Err(FString::Printf(
			TEXT("editor_batch: on_error '%s' must be 'stop' or 'unload_then_stop'"), *OnErrorText));
	}

	FTuning Tuning;
	double Number = 0.0;
	if (P->TryGetNumberField(TEXT("idle_ticks"), Number)) Tuning.IdleTicksRequired = FMath::Clamp(FMath::RoundToInt(Number), 1, 120);
	if (P->TryGetNumberField(TEXT("fence_timeout_s"), Number) && FMath::IsFinite(Number))
	{
		Tuning.FenceTimeoutSeconds = FMath::Clamp(Number, 1.0, 1800.0);
	}

	const TArray<TSharedPtr<FJsonValue>>* StepsJson = nullptr;
	if (!P->TryGetArrayField(TEXT("steps"), StepsJson) || !StepsJson)
	{
		return FHaybaHandlerResult::Err(TEXT("editor_batch: steps is required: [{cmd, params?, fence_after?}]"));
	}
	TArray<FStepSpec> Specs;
	TArray<FString> ParamsText;
	for (int32 I = 0; I < StepsJson->Num(); ++I)
	{
		const TSharedPtr<FJsonObject>* StepObj = nullptr;
		if (!(*StepsJson)[I].IsValid() || !(*StepsJson)[I]->TryGetObject(StepObj) || !StepObj || !StepObj->IsValid())
		{
			return FHaybaHandlerResult::Err(FString::Printf(TEXT("editor_batch: steps[%d] must be an object"), I));
		}
		FStepSpec Spec;
		(*StepObj)->TryGetStringField(TEXT("cmd"), Spec.Cmd);
		FString FenceText = TEXT("idle");
		(*StepObj)->TryGetStringField(TEXT("fence_after"), FenceText);
		if (!ParseFence(FenceText, Spec.FenceAfter))
		{
			return FHaybaHandlerResult::Err(FString::Printf(
				TEXT("editor_batch: steps[%d].fence_after '%s' must be none, idle or gc"), I, *FenceText));
		}
		const TSharedPtr<FJsonObject>* StepParams = nullptr;
		TSharedPtr<FJsonObject> ParamsObj = MakeShared<FJsonObject>();
		if ((*StepObj)->TryGetObjectField(TEXT("params"), StepParams) && StepParams && StepParams->IsValid())
		{
			ParamsObj = *StepParams;
		}
		if (Spec.Cmd == TEXT("wp_region_load"))
		{
			double A, B, C, D;
			FString BoundsError;
			if (!ParseBounds(ParamsObj, A, B, C, D, BoundsError))
			{
				return FHaybaHandlerResult::Err(FString::Printf(TEXT("editor_batch: steps[%d] wp_region_load: %s"), I, *BoundsError));
			}
		}
		Specs.Add(Spec);
		ParamsText.Add(JsonToCondensed(ParamsObj));
	}
	if (const FString Invalid = ValidateSteps(Specs, Tuning); !Invalid.IsEmpty())
	{
		return FHaybaHandlerResult::Err(TEXT("editor_batch: ") + Invalid);
	}

	TSharedRef<FBatchState> S = MakeShared<FBatchState>();
	S->JobId = FHaybaMCPJobRegistry::Get().AllocateJob(TEXT("editor_batch"));
	S->Owner = Lease->Owner;
	S->LeaseToken = Token;
	S->WorldPackage = FHaybaMCPLeaseManager::CurrentWorldPackage();
	S->OnErrorText = OnErrorText;
	// This command already passed the Plan gate (it is plan-gated): with Plan
	// Mode on, that approval covers its steps.
	S->bPlanPreApproved = FHaybaMCPSettings::Get().bPlanModeEnabled;
	S->StepParamsJson = MoveTemp(ParamsText);
	S->Records.SetNum(Specs.Num());
	for (int32 I = 0; I < Specs.Num(); ++I) S->Records[I].Cmd = Specs[I].Cmd;
	S->Machine = MakeUnique<FMachine>(MoveTemp(Specs), OnError, Tuning);
	S->StartedAt = FPlatformTime::Seconds();

	Leases.Table().SetYieldable(Token, true);
	S->TickHandle = FTSTicker::GetCoreTicker().AddTicker(
		FTickerDelegate::CreateLambda([S](float Dt) { return Pump(Dt, S); }));
	if (!S->TickHandle.IsValid())
	{
		Leases.Table().SetYieldable(Token, false);
		FHaybaMCPJobRegistry::Get().SetDone(S->JobId, 1, TEXT("{\"status\":\"failed\",\"error\":\"failed to register the batch ticker\"}"));
		S->bFinalized = true;
		return FHaybaHandlerResult::Err(TEXT("editor_batch: failed to register the batch ticker"));
	}
	ActiveBatches().Add(S->JobId, S);

	TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
	Out->SetStringField(TEXT("command"), TEXT("editor_batch"));
	Out->SetStringField(TEXT("job_id"), S->JobId);
	Out->SetStringField(TEXT("status"), TEXT("running"));
	Out->SetNumberField(TEXT("steps_total"), S->Machine->NumSteps());
	Out->SetStringField(TEXT("owner"), S->Owner);
	Out->SetStringField(TEXT("on_error"), OnErrorText);
	Out->SetBoolField(TEXT("plan_covered"), S->bPlanPreApproved);
	Out->SetStringField(TEXT("next"), TEXT(
		"Poll batch_status { job_id } (or build_status). One step runs per editor tick with a fence after each; "
		"queued interactive lease requests from other agents are granted at fences. Keep the lease until the batch is done."));
	return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPBatchHandler::Status(const TSharedPtr<FJsonObject>& P)
{
	FString JobId;
	if (!P->TryGetStringField(TEXT("job_id"), JobId) || JobId.IsEmpty())
	{
		return FHaybaHandlerResult::Err(TEXT("batch_status: job_id is required"));
	}
	if (const TSharedPtr<FBatchState>* Active = ActiveBatches().Find(JobId))
	{
		return FHaybaHandlerResult::Ok(BuildStatus(**Active));
	}
	const FHaybaJobState Job = FHaybaMCPJobRegistry::Get().GetJob(JobId);
	if (!Job.bFound || Job.OpName != TEXT("editor_batch"))
	{
		return FHaybaHandlerResult::Err(FString::Printf(TEXT("batch_status: no editor_batch job '%s'"), *JobId));
	}
	TSharedPtr<FJsonObject> Out = ParseObject(Job.Output);
	if (!Out.IsValid())
	{
		Out = MakeShared<FJsonObject>();
		Out->SetStringField(TEXT("output"), Job.Output);
	}
	Out->SetStringField(TEXT("job_id"), JobId);
	if (!Out->HasField(TEXT("status")))
	{
		Out->SetStringField(TEXT("status"), Job.Status == EHaybaJobStatus::Done ? TEXT("done") : TEXT("running"));
	}
	return FHaybaHandlerResult::Ok(Out);
}
