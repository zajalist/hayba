#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/**
 * Pure access policy for one MCP command: whether it may open the global
 * editor transaction and how long python_run may run.
 *
 * Kept free of GEditor, sockets and settings so every decision is unit-testable
 * without an editor. The caller supplies the facts (settings, lease state).
 */
namespace HaybaMCPAccess
{
	/** python_run's cooperative bytecode deadline without an exclusive lease. */
	constexpr double DefaultPythonDeadlineSeconds = 5.0;
	/** Upper clamp for a caller-requested python_run deadline. */
	constexpr double MaxPythonDeadlineSeconds = 60.0;

	/**
	 * True when a python_run script visibly loads or unloads World Partition
	 * actors. Unloading actors inside Hayba's global BeginTransaction left
	 * UTransBuffer with a non-zero active count ("UTransBuffer::Reset non-zero
	 * active count") and the next tick crashed in Landscape. A false positive
	 * only costs the Ctrl+Z record for that script; a false negative is the
	 * crash, so the match is deliberately broad.
	 */
	inline bool ScriptTouchesWorldPartition(const FString& Script)
	{
		static const TCHAR* const Markers[] = {
			TEXT("worldpartitioneditorloaderadapter"),
			TEXT("worldpartitionblueprintlibrary"),
			TEXT("worldpartitioneditorsubsystem"),
			TEXT("load_actors("),
			TEXT("unload_actors("),
			TEXT("pin_actors("),
			TEXT("unpin_actors("),
			TEXT("load_regions("),
			TEXT("unload_regions("),
		};
		const FString Lower = Script.ToLower();
		for (const TCHAR* Marker : Markers)
		{
			if (Lower.Contains(Marker))
			{
				return true;
			}
		}
		return false;
	}

	/**
	 * Per-request opt-outs from the global editor transaction. Only ever turns
	 * a transaction OFF; it cannot add one to a command the static policy
	 * leaves unwrapped.
	 *
	 *  - `transaction: false` on any command (follows the ui_compile_widget
	 *    precedent, but chosen by the caller for one request).
	 *  - python_run with `world_partition: true`, or a script that visibly
	 *    uses the World Partition load/unload APIs.
	 */
	inline bool ParamsAllowEditorTransaction(const FString& Cmd, const TSharedPtr<FJsonObject>& Params)
	{
		if (!Params.IsValid())
		{
			return true;
		}
		bool bTransaction = true;
		if (Params->TryGetBoolField(TEXT("transaction"), bTransaction) && !bTransaction)
		{
			return false;
		}
		if (Cmd == TEXT("python_run"))
		{
			bool bWorldPartition = false;
			if (Params->TryGetBoolField(TEXT("world_partition"), bWorldPartition) && bWorldPartition)
			{
				return false;
			}
			FString Script;
			if (Params->TryGetStringField(TEXT("script"), Script) && ScriptTouchesWorldPartition(Script))
			{
				return false;
			}
		}
		return true;
	}

	/** Outcome of resolving python_run's `deadline_s`. */
	struct FPythonDeadline
	{
		bool bAllowed = true;
		double Seconds = DefaultPythonDeadlineSeconds;
		/** Set when bAllowed is false: the stable refusal reason. */
		FString Error;
	};

	/**
	 * Resolve python_run's cooperative deadline.
	 *
	 * Absent -> 5 s. Present -> clamped to [5, 60]. Anything above 5 s holds the
	 * game thread long enough to starve every other agent, so it is granted only
	 * when the caller holds an exclusive lease on the world (or global), or when
	 * the server setting allows it without one. Otherwise it is refused rather
	 * than silently clamped, so the caller learns why its long script cannot run.
	 */
	inline FPythonDeadline ResolvePythonDeadline(
		bool bHasField,
		double Requested,
		bool bCallerHoldsExclusiveLease,
		bool bSettingAllowsWithoutLease)
	{
		FPythonDeadline Out;
		if (!bHasField)
		{
			return Out;
		}
		if (!FMath::IsFinite(Requested))
		{
			Out.bAllowed = false;
			Out.Error = TEXT("deadline_s must be a finite number of seconds");
			return Out;
		}
		Out.Seconds = FMath::Clamp(Requested, DefaultPythonDeadlineSeconds, MaxPythonDeadlineSeconds);
		if (Out.Seconds > DefaultPythonDeadlineSeconds
			&& !bCallerHoldsExclusiveLease && !bSettingAllowsWithoutLease)
		{
			Out.bAllowed = false;
			Out.Error = FString::Printf(
				TEXT("deadline_s %.1f needs an exclusive lease on the current world (lease_acquire mode:\"exclusive\"); ")
				TEXT("without one python_run is limited to %.0f s so it cannot starve other agents"),
				Out.Seconds, DefaultPythonDeadlineSeconds);
		}
		return Out;
	}
}
