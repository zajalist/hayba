#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "HaybaMCPSeh.h"
#include "HaybaMCPHealthPolicy.h"

DECLARE_LOG_CATEGORY_EXTERN(LogHaybaMCPHealth, Log, All);

/**
 * Process-wide, sticky editor health (ADR-0011). Every native fault a Hayba
 * guard catches is recorded here: the process is then "unsafe" until the
 * editor restarts. There is no production clear. Game thread only; the two
 * flags are seq_cst atomics so any reader sees them flip first.
 */
class FHaybaEditorHealth
{
	struct FState;

public:
	static bool IsUnsafe();
	static bool IsPythonUnhealthy();
	static uint64 FaultSequence();
	/** The most severe cause seen so far; the unsafe gate uses it. */
	static HaybaMCPHealth::ECause GateCause();

	/** Called by HaybaSeh::RunGuardedAt after a caught fault, never from the __except filter. */
	static void RecordCaughtFault(EHaybaFaultSite Site, uint32 ExceptionCode, bool bWorldSwitchRepaired = false);
	/** A CPython-internal failure without an SEH catch: a Python fault with exception code 0. */
	static void RecordPythonCorruption(const FString& MatchedMarker);
	/** refused_count++ (the router calls it for every unsafe refusal). */
	static void NoteRefusal();

	struct FSnapshot
	{
		bool bUnsafe = false;
		bool bPythonUnhealthy = false;
		bool bCriticalError = false;
		bool bSavingPackageStranded = false;
		bool bWorldSwitchRepaired = false;
		bool bHasAsserted = false;
		/** The first fault. */
		HaybaMCPHealth::ECause Cause = HaybaMCPHealth::ECause::None;
		/** The most severe fault. */
		HaybaMCPHealth::ECause GateCause = HaybaMCPHealth::ECause::None;
		EHaybaFaultSite Site = EHaybaFaultSite::Dispatch;
		uint32 ExceptionCode = 0;
		uint64 FaultFrame = 0;
		/** Each <= 128 chars; EngineErrorFirstLine <= 512. */
		FString FaultCode, FaultedCommand, FaultedRequestId, FaultedOwner, FaultedAtUtc, EngineErrorFirstLine;
		int32 FaultCount = 0;
		int32 RefusedCount = 0;
		/** The latest fault, for the native_fault_contained reply of the command that raised it. */
		HaybaMCPHealth::ECause LastCause = HaybaMCPHealth::ECause::None;
		EHaybaFaultSite LastSite = EHaybaFaultSite::Dispatch;
		uint32 LastExceptionCode = 0;
	};
	static FSnapshot Snapshot();

	/** The `health` object (also sent as `editor_health`). */
	static TSharedRef<FJsonObject> MakeHealthJson();
	/** Writes editor_unsafe, python_unhealthy and health{} into Out. */
	static void WriteJson(const TSharedRef<FJsonObject>& Out);

	/** Module shutdown: remove the pending notification ticker and dismiss the notification. */
	static void RevokeCallbacks();

	/** Names the command being dispatched, for the fault record. Stores pointers, never allocates, nests. */
	class FScopedDispatchNote
	{
	public:
		FScopedDispatchNote(const FString& InCmd, const FString& InId, const FString& InOwner);
		~FScopedDispatchNote();
		FScopedDispatchNote(const FScopedDispatchNote&) = delete;
		FScopedDispatchNote& operator=(const FScopedDispatchNote&) = delete;

	private:
		friend class FHaybaEditorHealth;
		const FString* Cmd;
		const FString* Id;
		const FString* Owner;
		FScopedDispatchNote* Previous;
	};

#if WITH_DEV_AUTOMATION_TESTS
	/** Swaps in a FRESH health state; restores the real one on exit. The Slate poster and the pre-GC unhook become counters. */
	class FScopedOverrideForTests
	{
	public:
		FScopedOverrideForTests();
		~FScopedOverrideForTests();
		FScopedOverrideForTests(const FScopedOverrideForTests&) = delete;
		FScopedOverrideForTests& operator=(const FScopedOverrideForTests&) = delete;

		int32 NotificationCount() const;
		FString LastNotificationText() const;
		int32 PreGcUnhookCount() const;
		int32 FaultErrorLineCount() const;
		/** Runs the pending next-tick notification now (the same delegate the core ticker would run). False when none is pending. */
		bool FlushPendingNotification();

	private:
		FState* Owned = nullptr;
		FState* Previous = nullptr;
	};
	static bool IsTestOverrideActive();
#endif

private:
	static FState* ActiveOverride;
	static FState& Active();
	static void RecordFault(EHaybaFaultSite Site, uint32 ExceptionCode, bool bWorldSwitchRepaired, const FString& Marker);
	/** THE only place a notification is posted: a one-shot core-ticker delegate. */
	static bool DeliverUserNotification(float DeltaSeconds);
};
