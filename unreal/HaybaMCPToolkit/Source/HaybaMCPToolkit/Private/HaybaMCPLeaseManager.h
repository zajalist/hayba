#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "HaybaMCPLeasePolicy.h"

/**
 * Who sent the command being processed. Set by FHaybaMCPCommandHandler for
 * the duration of one ProcessCommand call (game thread only), so a handler
 * such as lease_acquire or python_run can ask about its caller without every
 * IHaybaMCPHandler signature changing.
 */
struct FHaybaMCPRequestContext
{
	/** Envelope `owner`, else "conn:<id>", else "local". */
	FString Owner;
	/** TCP connection the command arrived on; 0 for in-process callers. */
	int32 ConnId = 0;
	/** Envelope `lease`: the lease_id the caller named (may be a redaction marker). */
	FString LeaseToken;
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

	/** Owner string for an envelope: `owner` if present, else per connection. */
	static FString ResolveOwner(const TSharedPtr<FJsonObject>& Envelope, int32 ConnId);

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

	/** The owner the current command acts as: the named lease's owner when a valid envelope lease_id was sent, otherwise the envelope owner. */
	FString EffectiveOwner();

	/** bind_connection: release everything a closed connection held or queued. */
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
		/** Enforced mode and a conflict: refuse with code lease_conflict. */
		bool bRefuse = false;
		FString Message;
		/** Conflict facts (holder, resource, class); set for refuse and warn. */
		TSharedPtr<FJsonObject> Detail;
	};

	/**
	 * Check one command against the table. Off -> always allowed. Advisory ->
	 * allowed, a conflict is recorded on the context as a warning. Enforced ->
	 * a conflict refuses. Never blocks and never grants anything.
	 */
	FVerdict CheckCommand(const FString& Cmd, const TSharedPtr<FJsonObject>& Params);

private:
	FHaybaMCPLeaseManager();

	HaybaMCPLease::FTable LeaseTable;
	FHaybaMCPRequestContext* CurrentContext = nullptr;
	HaybaMCPLease::FOncePerKey DeprecatedParamNotes{ 512 };
};
