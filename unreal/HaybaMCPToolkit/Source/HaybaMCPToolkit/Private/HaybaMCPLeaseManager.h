#pragma once

#include "CoreMinimal.h"
#include "Containers/Ticker.h"
#include "Dom/JsonObject.h"
#include "HAL/PlatformTime.h"
#include "HaybaMCPEnforcementPolicy.h"
#include "HaybaMCPLeasePolicy.h"
#include "HaybaMCPWarningLimiter.h"

/** How the envelope `lease` relates to the resolved caller (P0 T9). */
enum class ELeaseRef : uint8
{
	None,      // no envelope lease
	Bound,     // a live lease whose owner is the caller
	Unknown,   // not a live lease id
	NotBound,  // a live lease of ANOTHER owner: the caller is still judged as itself
	Redacted,  // a "[REDACTED:" marker: counts as absent
};

/** Who is calling, resolved once per request (FHaybaMCPLeaseManager::ResolveCaller). */
struct FCallerResolution
{
	FString Owner;
	/** "envelope" | "adopted" | "conn" | "local" | "batch" */
	FString Via;
	ELeaseRef LeaseRef = ELeaseRef::None;
	/** The envelope lease id; empty for None and Redacted. */
	FString LeaseId;
	/** For NotBound: the owner of the lease the envelope named. */
	FString NamedLeaseOwner;
	/** The envelope claimed conn:<n> or local, and that is not this caller. */
	bool bReservedViolation = false;
};

/** The `lease:` value of the Processing-command log line (T6 names; not_bound is T9's). */
inline const TCHAR* LexLeaseRef(ELeaseRef Ref)
{
	switch (Ref)
	{
	case ELeaseRef::Bound:    return TEXT("valid");
	case ELeaseRef::Unknown:  return TEXT("unknown");
	case ELeaseRef::NotBound: return TEXT("not_bound");
	case ELeaseRef::Redacted: return TEXT("redacted");
	default:                  return TEXT("none");
	}
}

/**
 * Who sent the command being processed. Set by FHaybaMCPCommandHandler for
 * the duration of one ProcessCommand call (game thread only), so a handler
 * such as lease_acquire or python_run can ask about its caller without every
 * IHaybaMCPHandler signature changing.
 */
struct FHaybaMCPRequestContext
{
	/** Envelope owner, adopted owner, else conn:<id> / local (T9). */
	FString Owner;
	/** TCP connection the command arrived on; 0 for in-process callers. */
	int32 ConnId = 0;
	/** Compatibility flag: the resolved caller is an identified agent (T9). */
	bool bOwnerFromEnvelope = false;
	/** Envelope `lease`: the lease_id the caller named (may be a redaction marker). */
	FString LeaseToken;
	/** Resolved once; Owner always equals Caller.Owner after envelope parsing. */
	FCallerResolution Caller;
	/** Set by the Advisory check; merged into the response as `lease_warning`. */
	TSharedPtr<FJsonObject> LeaseWarning;
	/** Set by the router's asset_busy slot under Advisory. Merged into the
	 *  response as `state_warning`, after `lease_warning` (P0 T3). */
	TSharedPtr<FJsonObject> StateWarning;
	/** A step of this editor_batch job (empty for an ordinary request). */
	FString BatchJobId;
	/** The batch itself passed the Plan-Mode gate, so its steps are covered
	 *  by that approval and do not spend it again. */
	bool bPlanPreApproved = false;
};

/**
 * Game-thread owner of the lease table plus the glue between it and the
 * router: request context, disconnect release, and the per-command check.
 * The table itself is the pure HaybaMCPLease::FTable. See docs/adr/0010.
 */
class FHaybaMCPLeaseManager
{
public:
	static FHaybaMCPLeaseManager& Get();

	HaybaMCPLease::FTable& Table() { return LeaseTable; }

	/** Owner string for an envelope: the sanitized `owner` if present, else
	 *  per connection. `bOutFromEnvelope` says which (T6). */
	static FString ResolveOwner(const TSharedPtr<FJsonObject>& Envelope, int32 ConnId, bool* bOutFromEnvelope = nullptr);

	/**
	 * T9: owner first. The envelope owner, else the connection's adopted owner,
	 * else conn:<n> / local. conn:<n> is accepted only from connection n and
	 * local only in-process; any other claim sets bReservedViolation and the
	 * caller stays its own synthetic owner. The envelope lease never changes
	 * the owner; it is only classified as Bound / NotBound / Unknown / Redacted.
	 */
	static FCallerResolution ResolveCaller(const FString& EnvelopeOwner, int32 ConnId, const FString& EnvelopeLease);

	/** A batch step acts as its batch's owner, checked when editor_batch was accepted. */
	static FCallerResolution ResolveBatchCaller(const FString& BatchOwner, const FString& EnvelopeLease);

	/** conn:<anything> or local. */
	static bool IsReservedOwner(const FString& Owner);

	/** A named agent (envelope, adopted, or a named batch owner): counts for presence and owner_required. */
	static bool IsIdentifiedCaller(const FCallerResolution& Caller);

	/** Connection ConnId acts as Owner whenever its envelope names no owner, until it closes. */
	bool AdoptConnection(int32 ConnId, const FString& Owner, FString& OutError);

	/** The adopted owner of ConnId, or empty. */
	FString ConnectionOwner(int32 ConnId) const;

	/** TCP server restart: the close queue was discarded, so forget every adoption. */
	void ForgetAllAdoptions();

	/** Re-bind only Owner's orphaned leases to ConnId; live and unbound leases are unchanged. */
	int32 ReviveOrphanedLeases(const FString& Owner, int32 ConnId);

	struct FAdoptResult
	{
		double ExpiresInSeconds = 0.0;
		int32 Revived = 0;
	};
	/** Validate a named lease, adopt and revive orphans at one table-clock boundary.
	 *  The handler has already checked required fields, connection and marker.
	 *  Failure changes neither adoption nor other orphans; success returns copied facts. */
	bool AdoptLease(int32 ConnId, const FString& Owner, const FString& LeaseId, FAdoptResult& Out, FString& OutError);

	/** What the envelope `lease` names. Only ever classified; never logged. */
	enum class EEnvelopeLease : uint8
	{
		None,
		Valid,
		Unknown,
		Redacted,
	};
	EEnvelopeLease ClassifyEnvelopeLease(const FString& LeaseValue);
	static const TCHAR* LexEnvelopeLease(EEnvelopeLease State);

	/** Presence for owner_required (T6/T8): an identified caller got past auth.
	 *  Never refuses, never extends a lease. */
	void NoteAuthenticatedCaller(const FString& Owner, int32 ConnId, bool bIdentified);

	/** Log the "repeated N more times" line of every closed warning window. */
	void DrainLeaseWarnings();
	/** A 30 s core-ticker drain (R-18); the module starts and stops it. */
	void StartWarningDrain();
	void StopWarningDrain();

	/** The manager clock: the table, the warning limiter and presence share it. */
	double Now() const { return FPlatformTime::Seconds() + ClockOffsetSeconds; }

#if WITH_DEV_AUTOMATION_TESTS
	void AdvanceClockForTests(double Seconds) { ClockOffsetSeconds += Seconds; }
	/** Release every lease and ticket of Owner and drop its presence. */
	void ForgetOwnerForTests(const FString& Owner);
	/** Forget every owner's presence. Leases are not touched. */
	void ResetPresenceForTests() { Presence.Reset(); }
#endif

	/**
	 * Parse `resources`: an array of resource strings, or of
	 * {resource, mode:"shared"|"exclusive"} objects. `bDefaultExclusive`
	 * applies to plain strings. Absent field -> true with no claims.
	 */
	static bool ParseClaims(
		const TSharedPtr<FJsonObject>& Params,
		bool bDefaultExclusive,
		TArray<HaybaMCPAccess::FClaim>& OutClaims,
		FString& OutError);

	/** Package name of the editor world (e.g. /Game/Maps/Valley); empty if none. */
	static FString CurrentWorldPackage();

	/** RAII: publishes the request context for one ProcessCommand. */
	class FScope
	{
	public:
		explicit FScope(FHaybaMCPRequestContext& Context);
		~FScope();
	private:
		FHaybaMCPRequestContext* Previous = nullptr;
	};

	/** The request being processed, or null outside ProcessCommand. */
	FHaybaMCPRequestContext* Current() const { return CurrentContext; }

	/** The owner the current command acts as: the resolved caller (T9). The
	 *  envelope lease no longer changes it. "local" outside ProcessCommand. */
	FString EffectiveOwner();

	/** bind_connection: orphan what a closed connection held (T7); drop its tickets. */
	void OnConnectionClosed(int32 ConnId);

	/**
	 * One Warning per (command, param, owner) per session when a caller uses a
	 * deprecated param, e.g. lease_renew's `token`:
	 *   lease_renew: deprecated param 'token' from owner 'X'; send lease_id
	 * The owner is collapsed (conn:<n> -> conn:*) and the set is capped, so raw
	 * per-call clients cannot grow it (R-9). This line is the removal metric
	 * for the alias (spec §4.4).
	 */
	void NoteDeprecatedParam(const FString& Cmd, const FString& Param, const FString& Owner);

	/** True when the current caller holds an exclusive lease on the current
	 *  world or on global (python_run deadline_s above 5 s). */
	bool CallerHoldsExclusiveOnCurrentWorld();

	struct FVerdict
	{
		/** Refuse with Code (lease_conflict or owner_required). */
		bool bRefuse = false;
		FString Message;
		/** Conflict facts; set for refuse and warn. Never a handle. */
		TSharedPtr<FJsonObject> Detail;
		/** "lease_conflict" | "owner_required" (T8). */
		FString Code;
		HaybaMCPEnforcement::EReason Reason = HaybaMCPEnforcement::EReason::None;
	};

	/** The live LeaseEnforcement setting; read on every check, so a change in
	 *  Project Settings applies at once (the T8 rollback). */
	static HaybaMCPEnforcement::EMode CurrentMode();
	/** LexMode(CurrentMode()): the only way the mode is ever reported. */
	static FString CurrentModeName();

	/** Identified owners with an open connection or seen within 60 s. */
	TArray<FString> ActiveOwners(const FString& Except = FString()) const { return Presence.ActiveOwners(Except); }

	/** The lease gate (router slot 4, T8): HaybaMCPEnforcement::Decide over this command's facts. Never blocks and never grants. */
	FVerdict CheckCommand(const FString& Cmd, const TSharedPtr<FJsonObject>& Params);

	/** What one command needs from the lease table: its class and its locks
	 *  (python_run refined per request, S1 implied asset claims). */
	struct FRequiredAccess
	{
		HaybaMCPAccess::EAccessClass Class = HaybaMCPAccess::EAccessClass::Read;
		TArray<HaybaMCPAccess::FClaim> Declared;
		TArray<HaybaMCPAccess::FLock> Locks;
		FString ClaimError;
	};
	static FRequiredAccess ResolveRequiredAccess(const FString& Cmd, const TSharedPtr<FJsonObject>& Params, const FString& CurrentWorld);

	/** Renew-on-use (T7). The router calls it only for a command that passed
	 *  every gate, just before dispatch. Reads never touch. */
	void TouchOnUse(const FString& Cmd, const TSharedPtr<FJsonObject>& Params);

	/** One Log line per use of the R5 marker shim (the removal metric). */
	void NoteMarkerShim(const FString& Cmd, const FString& Owner, const FString& Outcome);


private:
	FHaybaMCPLeaseManager();

	/** The fact decision and binding diagnostics share the resolved request access. */
	FVerdict CheckCommandFacts(const FString& Cmd, const FRequiredAccess& Access);
	void AddLeaseBinding(const FString& Cmd, const FRequiredAccess& Access, FVerdict& Verdict);
	/** Optional named expiry is copied from Renew, avoiding a post-mutation lookup. */
	int32 ReviveOrphanedLeases(const FString& Owner, int32 ConnId, const FString& NamedLeaseId, double* OutNamedExpiresAt);

	/** ConnId -> adopted owner. Game thread only; cleared on close/restart. */
	TMap<int32, FString> AdoptedOwners;

	/** Rate-limit one lease warning (T6): log the first per key per 30 s. */
	FWarningLimiter::FHit NoteLeaseWarning(const FString& ModeName, const FString& Code, const FString& Reason,
		const FString& Owner, const FString& Cmd, const FString& HolderOwner, const FString& Conflict,
		const FString& Message);

	struct FLeaseWarningText
	{
		FString Head;
		FString Tail;
		double LastAt = 0.0;
	};

	HaybaMCPLease::FTable LeaseTable;
	FHaybaMCPRequestContext* CurrentContext = nullptr;
	FWarningLimiter LeaseWarningLimiter;
	HaybaMCPEnforcement::FOwnerPresence Presence;
	/** Drain-line text per limiter key; at most FWarningLimiter::DefaultMaxKeys. */
	TMap<FString, FLeaseWarningText> LeaseWarningText;
	FTSTicker::FDelegateHandle WarningDrainHandle;
	double ClockOffsetSeconds = 0.0;
	HaybaMCPLease::FOncePerKey DeprecatedParamNotes{ 512 };
};
