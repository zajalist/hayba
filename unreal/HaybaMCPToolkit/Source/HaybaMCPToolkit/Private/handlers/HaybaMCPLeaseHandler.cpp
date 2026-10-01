// HaybaMCPLeaseHandler.cpp - see header.

#include "HaybaMCPLeaseHandler.h"
#include "HaybaMCPLeaseManager.h"
#include "HAL/PlatformTime.h"

namespace
{
	using namespace HaybaMCPLease;

	/** On renew/release replies that named the lease with `token`. Same text in the Node tools. */
	const TCHAR* const TokenDeprecation = TEXT("'token' was renamed to lease_id; send lease_id");

	FString IdAmbiguous(const TCHAR* Cmd)
	{
		return FString::Printf(TEXT("%s [lease_id_ambiguous]: lease_id and its deprecated alias name different leases; send lease_id only"), Cmd);
	}

	FString IdRedacted(const TCHAR* Cmd)
	{
		return FString::Printf(TEXT("%s [lease_id_redacted]: the value is a redaction marker, not a lease_id; run lease_acquire again and send the lease_id it returns"), Cmd);
	}

	FString IdUnknown(const TCHAR* Cmd)
	{
		return FString::Printf(TEXT("%s [lease_id_unknown]: unknown or expired lease"), Cmd);
	}

	/** A request's lease: `lease_id`, or the deprecated `token`. */
	FIdParam ReadLeaseId(const TSharedPtr<FJsonObject>& P)
	{
		FString Canonical;
		FString Alias;
		P->TryGetStringField(TEXT("lease_id"), Canonical);
		P->TryGetStringField(TEXT("token"), Alias);
		return ResolveIdParam(Canonical, Alias);
	}

	bool IsWaitingTicket(FTable& Table, const FString& Ticket)
	{
		Table.Expire();
		return Table.GetWaiters().ContainsByPredicate([&Ticket](const FWaiter& W) { return W.Ticket == Ticket; });
	}

	/** Re-poll hint for a queued request: soon, but never a busy loop. */
	double PollAfterSeconds(double EtaSeconds)
	{
		return EtaSeconds < 0.0 ? 2.0 : FMath::Clamp(EtaSeconds / 4.0, 1.0, 10.0);
	}

	TArray<TSharedPtr<FJsonValue>> ClaimsToJson(const TArray<HaybaMCPAccess::FClaim>& Claims)
	{
		TArray<TSharedPtr<FJsonValue>> Out;
		for (const HaybaMCPAccess::FClaim& Claim : Claims)
		{
			TSharedPtr<FJsonObject> Item = MakeShared<FJsonObject>();
			Item->SetStringField(TEXT("resource"), Claim.Resource.Key());
			Item->SetStringField(TEXT("mode"), Claim.bExclusive ? TEXT("exclusive") : TEXT("shared"));
			Out.Add(MakeShared<FJsonValueObject>(Item));
		}
		return Out;
	}

	const TCHAR* LexLane(ELane Lane)
	{
		return Lane == ELane::Long ? TEXT("long") : TEXT("interactive");
	}


	/** The resolved owner-first caller; an envelope lease never supplies identity. */
	FString CallerOwner()
	{
		return FHaybaMCPLeaseManager::Get().EffectiveOwner();
	}

	/** The table's owner-mismatch text with its bracket code (R3 channel). The
	 *  substrings "belongs to" and "ticket" stay verbatim (editor_gate.py). An
	 *  unknown lease never reaches the table: the handler answers IdUnknown first. */
	FString CodedTableError(const FString& TableError)
	{
		if (TableError.StartsWith(TEXT("lease belongs to")) || TableError.StartsWith(TEXT("ticket belongs to")))
		{
			return TEXT("[lease_owner_mismatch] ") + TableError;
		}
		return TableError;
	}

	const TCHAR* RedactedReleaseError()
	{
		return TEXT("lease_release: [lease_id_redacted] a redacted marker cannot name a lease; send lease_id, or all:true to release every lease you hold");
	}

	/** lease_renew with no lease_id (R6), or a marker under the alias (R5). */
	FHaybaHandlerResult RenewByOwnerReply(const FString& Owner, double Ttl, int32 ConnId, bool bDeprecated)
	{
		FHaybaMCPLeaseManager& Manager = FHaybaMCPLeaseManager::Get();
		FTable& Table = Manager.Table();
		const FOwnerRenewResult Renewed = Table.RenewOwner(Owner, Ttl, ConnId);
		if (Renewed.Renewed == 0)
		{
			return FHaybaHandlerResult::Err(FString::Printf(
				TEXT("lease_renew: [no_leases] owner '%s' holds no live lease; lease_acquire first"), *Owner));
		}
		const double Now = Manager.Now();
		TArray<TSharedPtr<FJsonValue>> LeasesJson;
		for (const FLease& Lease : Table.GetLeases())
		{
			if (Lease.Owner != Owner) continue;
			TSharedPtr<FJsonObject> Item = MakeShared<FJsonObject>();
			Item->SetStringField(TEXT("lease_id"), Lease.Token);
			Item->SetArrayField(TEXT("resources"), ClaimsToJson(Lease.Claims));
			Item->SetNumberField(TEXT("expires_in_s"), FMath::Max(0.0, Lease.ExpiresAt - Now));
			Item->SetBoolField(TEXT("orphaned"), Lease.IsOrphaned());
			LeasesJson.Add(MakeShared<FJsonValueObject>(Item));
		}
		TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
		Out->SetStringField(TEXT("owner"), Owner);
		Out->SetNumberField(TEXT("renewed"), Renewed.Renewed);
		Out->SetNumberField(TEXT("expires_in_s"), FMath::Max(0.0, Renewed.MinExpiresAt - Now));
		Out->SetArrayField(TEXT("leases"), LeasesJson);
		if (bDeprecated) Out->SetStringField(TEXT("deprecation"), TokenDeprecation);
		return FHaybaHandlerResult::Ok(Out);
	}
}

TArray<FString> FHaybaMCPLeaseHandler::GetCommands() const
{
	return {
		TEXT("lease_acquire"),
		TEXT("lease_renew"),
		TEXT("lease_release"),
		TEXT("lease_status"),
	};
}

FHaybaHandlerResult FHaybaMCPLeaseHandler::Handle(const FString& Command, const TSharedPtr<FJsonObject>& Params)
{
	const TSharedPtr<FJsonObject> P = Params.IsValid() ? Params : MakeShared<FJsonObject>();
	if (Command == TEXT("lease_acquire")) return Acquire(P);
	if (Command == TEXT("lease_renew"))   return Renew(P);
	if (Command == TEXT("lease_release")) return Release(P);
	if (Command == TEXT("lease_status"))  return Status(P);
	return FHaybaHandlerResult::Err(FString::Printf(TEXT("Unknown lease command: %s"), *Command));
}

FHaybaHandlerResult FHaybaMCPLeaseHandler::Acquire(const TSharedPtr<FJsonObject>& P)
{
	FHaybaMCPLeaseManager& Manager = FHaybaMCPLeaseManager::Get();
	const FHaybaMCPRequestContext* Context = Manager.Current();

	FRequest Request;
	Request.Owner = CallerOwner();
	P->TryGetStringField(TEXT("ticket"), Request.Ticket);
	P->TryGetStringField(TEXT("label"), Request.Label);
	Request.Label = Request.Label.Left(128);

	FString Mode = TEXT("exclusive");
	P->TryGetStringField(TEXT("mode"), Mode);
	if (Mode != TEXT("exclusive") && Mode != TEXT("shared"))
	{
		return FHaybaHandlerResult::Err(FString::Printf(TEXT("lease_acquire: mode '%s' must be 'shared' or 'exclusive'"), *Mode));
	}
	FString ClaimError;
	if (!FHaybaMCPLeaseManager::ParseClaims(P, Mode == TEXT("exclusive"), Request.Claims, ClaimError))
	{
		return FHaybaHandlerResult::Err(TEXT("lease_acquire: ") + ClaimError);
	}
	if (Request.Claims.Num() == 0 && Request.Ticket.IsEmpty())
	{
		return FHaybaHandlerResult::Err(TEXT(
			"lease_acquire: resources is required, e.g. [\"world:/Game/Maps/Valley\"] or "
			"[\"wp-region:/Game/Maps/Valley:0,0,25600,25600\"]; pass ticket to poll a queued request"));
	}

	FString Lane = TEXT("interactive");
	P->TryGetStringField(TEXT("lane"), Lane);
	if (Lane != TEXT("interactive") && Lane != TEXT("long"))
	{
		return FHaybaHandlerResult::Err(FString::Printf(TEXT("lease_acquire: lane '%s' must be 'interactive' or 'long'"), *Lane));
	}
	Request.Lane = Lane == TEXT("long") ? ELane::Long : ELane::Interactive;
	P->TryGetNumberField(TEXT("ttl_s"), Request.TtlSeconds);

	bool bBind = true;
	P->TryGetBoolField(TEXT("bind_connection"), bBind);
	Request.ConnId = (bBind && Context) ? Context->ConnId : 0;

	const FAcquireResult Result = Manager.Table().Acquire(Request);
	if (Result.Status == EStatus::Rejected)
	{
		return FHaybaHandlerResult::Err(TEXT("lease_acquire: ") + Result.Error);
	}

	TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
	Out->SetStringField(TEXT("owner"), Request.Owner);
	Out->SetStringField(TEXT("lane"), LexLane(Request.Lane));
	if (Result.Status == EStatus::Granted)
	{
		const FLease* Lease = Manager.Table().FindLease(Result.Token);
		Out->SetStringField(TEXT("status"), TEXT("granted"));
		Out->SetStringField(TEXT("lease_id"), Result.Token);
		Out->SetNumberField(TEXT("expires_in_s"), FMath::Max(0.0, Result.ExpiresAt - FHaybaMCPLeaseManager::Get().Now()));
		Out->SetBoolField(TEXT("bound_to_connection"), Request.ConnId != 0);
		Out->SetBoolField(TEXT("reused"), Result.bReused);
		if (Lease)
		{
			Out->SetNumberField(TEXT("ttl_s"), Lease->TtlSeconds);
			Out->SetBoolField(TEXT("bind_connection"), Lease->bBindConnection);
			Out->SetArrayField(TEXT("resources"), ClaimsToJson(Lease->Claims));
		}
		Out->SetNumberField(TEXT("max_ttl_s"), Manager.Table().GetTuning().MaxTtlSeconds);
		Out->SetNumberField(TEXT("orphan_grace_s"), Manager.Table().GetTuning().OrphanGraceSeconds);

		Out->SetStringField(TEXT("next"),
			TEXT("Keep sending your envelope owner (HAYBA_AGENT_ID) with this lease_id as the envelope 'lease', or adopt the owner "
				 "on a helper connection with lease_adopt {owner, lease_id}. The lease alone does not supply identity. Renew before it lapses (lease_renew {} renews every lease you hold) and lease_release "
				 "when done. A bound lease is orphaned on closing and dropped within orphan_grace_s after closing, unless it expires sooner or you "
				 "renew it. Per-call clients should pass bind_connection:false or keep one socket open."));
	}
	else
	{
		Out->SetStringField(TEXT("status"), TEXT("queued"));
		Out->SetStringField(TEXT("ticket"), Result.Token);
		Out->SetNumberField(TEXT("position"), Result.Position);
		Out->SetStringField(TEXT("holder_owner"), Result.HolderOwner);
		Out->SetNumberField(TEXT("eta_s"), Result.EtaSeconds);
		Out->SetStringField(TEXT("conflict"), Result.ConflictDetail);
		Out->SetNumberField(TEXT("poll_after_s"), PollAfterSeconds(Result.EtaSeconds));
		Out->SetNumberField(TEXT("ticket_ttl_s"), Manager.Table().GetTuning().WaiterTtlSeconds);
		Out->SetStringField(TEXT("next"),
			TEXT("Not granted yet; nothing is blocked. Call lease_acquire again with this ticket (same resources not required) "
				 "within ticket_ttl_s, or the place in the queue is dropped."));
	}
	return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPLeaseHandler::Renew(const TSharedPtr<FJsonObject>& P)
{
	FHaybaMCPLeaseManager& Manager = FHaybaMCPLeaseManager::Get();
	const FString Owner = CallerOwner();
	const int32 ConnId = Manager.Current() ? Manager.Current()->ConnId : 0;
	const FIdParam Id = ReadLeaseId(P);
	double Ttl = 0.0;
	P->TryGetNumberField(TEXT("ttl_s"), Ttl);
	if (Id.bFromAlias)
	{
		Manager.NoteDeprecatedParam(TEXT("lease_renew"), TEXT("token"), Owner);
	}

	// R6: no id renews by owner. R5: a marker under the deprecated alias does too.
	const bool bShim = Id.Kind == EIdParam::RedactionMarker && Id.bFromAlias;
	if (Id.Kind == EIdParam::None || bShim)
	{
		const FHaybaHandlerResult Result = RenewByOwnerReply(Owner, Ttl, ConnId, Id.bFromAlias);
		if (bShim)
		{
			Manager.NoteMarkerShim(TEXT("lease_renew"), Owner, Result.bOk ? TEXT("renewed by owner") : TEXT("no leases"));
		}
		return Result;
	}
	// The T4 codes keep T4.2's texts: the helpers build them.
	if (Id.Kind == EIdParam::Ambiguous)
	{
		return FHaybaHandlerResult::Err(IdAmbiguous(TEXT("lease_renew")));
	}
	if (Id.Kind == EIdParam::RedactionMarker)
	{
		// A marker under the canonical lease_id is an error (R5); only the alias is shimmed.
		return FHaybaHandlerResult::Err(IdRedacted(TEXT("lease_renew")));
	}
	if (!Manager.Table().FindLease(Id.Value))
	{
		return FHaybaHandlerResult::Err(IdUnknown(TEXT("lease_renew")));
	}

	double ExpiresAt = 0.0;
	FString Error;
	if (!Manager.Table().Renew(Id.Value, Owner, Ttl, ExpiresAt, Error, ConnId))
	{
		return FHaybaHandlerResult::Err(TEXT("lease_renew: ") + CodedTableError(Error));
	}
	TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
	Out->SetStringField(TEXT("lease_id"), Id.Value);
	Out->SetBoolField(TEXT("renewed"), true);
	Out->SetNumberField(TEXT("expires_in_s"), FMath::Max(0.0, ExpiresAt - Manager.Now()));
	if (Id.bFromAlias) Out->SetStringField(TEXT("deprecation"), TokenDeprecation);
	return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPLeaseHandler::Release(const TSharedPtr<FJsonObject>& P)
{
	FHaybaMCPLeaseManager& Manager = FHaybaMCPLeaseManager::Get();
	FTable& Table = Manager.Table();
	const FString Owner = CallerOwner();
	FString Ticket;
	P->TryGetStringField(TEXT("ticket"), Ticket);
	Ticket.TrimStartAndEndInline();
	const bool bHasAll = P->HasField(TEXT("all"));
	bool bAll = false;
	P->TryGetBoolField(TEXT("all"), bAll);
	const FIdParam Id = ReadLeaseId(P);

	const int32 Options = (Id.Kind != EIdParam::None ? 1 : 0) + (Ticket.IsEmpty() ? 0 : 1) + (bHasAll ? 1 : 0);
	if (Options != 1 || (bHasAll && !bAll))
	{
		return FHaybaHandlerResult::Err(TEXT("lease_release: [bad_request] send exactly one of lease_id, ticket or all:true"));
	}
	if (Id.bFromAlias)
	{
		Manager.NoteDeprecatedParam(TEXT("lease_release"), TEXT("token"), Owner);
	}

	TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
	if (bAll)
	{
		const FOwnerReleaseResult Released = Table.ReleaseOwner(Owner);
		Out->SetStringField(TEXT("owner"), Owner);
		Out->SetNumberField(TEXT("released"), Released.Released);
		Out->SetNumberField(TEXT("tickets_withdrawn"), Released.TicketsWithdrawn);
		return FHaybaHandlerResult::Ok(Out);
	}
	// Old clients withdrew a queued ticket under `token` (T4.2's mapping, kept).
	const bool bTicketUnderAlias = Ticket.IsEmpty() && Id.Kind == EIdParam::Value && Id.bFromAlias
		&& IsWaitingTicket(Table, Id.Value);
	if (bTicketUnderAlias)
	{
		Ticket = Id.Value;
	}
	if (!Ticket.IsEmpty())
	{
		if (!IsWaitingTicket(Table, Ticket))
		{
			return FHaybaHandlerResult::Err(TEXT("lease_release: unknown or expired ticket"));
		}
		FString Error;
		if (!Table.Release(Ticket, Owner, Error))
		{
			return FHaybaHandlerResult::Err(TEXT("lease_release: ") + CodedTableError(Error));
		}
		Out->SetStringField(TEXT("ticket"), Ticket);
		Out->SetBoolField(TEXT("released"), true);
		if (bTicketUnderAlias) Out->SetStringField(TEXT("deprecation"), TokenDeprecation);
		return FHaybaHandlerResult::Ok(Out);
	}
	if (Id.Kind == EIdParam::RedactionMarker && Id.bFromAlias)
	{
		// R5 shim: only the owner's legacy editor_gate:<owner> leases, never a
		// running batch's lease or a build's asset leases.
		const int32 Released = Table.ReleaseLegacyGateLeases(Owner);
		Manager.NoteMarkerShim(TEXT("lease_release"), Owner,
			FString::Printf(TEXT("released %d legacy gate lease(s)"), Released));
		if (Released == 0)
		{
			return FHaybaHandlerResult::Err(RedactedReleaseError());
		}
		Out->SetStringField(TEXT("owner"), Owner);
		Out->SetNumberField(TEXT("released"), Released);
		Out->SetBoolField(TEXT("legacy_gate_leases"), true);
		Out->SetStringField(TEXT("deprecation"), TokenDeprecation);
		return FHaybaHandlerResult::Ok(Out);
	}
	// The T4 codes keep T4.2's texts: the helpers build them.
	if (Id.Kind == EIdParam::Ambiguous)
	{
		return FHaybaHandlerResult::Err(IdAmbiguous(TEXT("lease_release")));
	}
	if (Id.Kind == EIdParam::RedactionMarker)
	{
		// A marker under the canonical lease_id names no lease and releases nothing (R5).
		return FHaybaHandlerResult::Err(IdRedacted(TEXT("lease_release")));
	}
	if (!Table.FindLease(Id.Value))
	{
		return FHaybaHandlerResult::Err(IdUnknown(TEXT("lease_release")));
	}
	FString Error;
	if (!Table.Release(Id.Value, Owner, Error))
	{
		return FHaybaHandlerResult::Err(TEXT("lease_release: ") + CodedTableError(Error));
	}
	Out->SetStringField(TEXT("lease_id"), Id.Value);
	Out->SetBoolField(TEXT("released"), true);
	if (Id.bFromAlias) Out->SetStringField(TEXT("deprecation"), TokenDeprecation);
	return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPLeaseHandler::Status(const TSharedPtr<FJsonObject>& /*P*/)
{
	FTable& Table = FHaybaMCPLeaseManager::Get().Table();
	Table.Expire();
	const double Now = FHaybaMCPLeaseManager::Get().Now();
	const FString Caller = CallerOwner();

	TArray<TSharedPtr<FJsonValue>> LeasesJson;
	for (const FLease& Lease : Table.GetLeases())
	{
		TSharedPtr<FJsonObject> Item = MakeShared<FJsonObject>();
		const bool bMine = Lease.Owner == Caller;
		Item->SetStringField(TEXT("owner"), Lease.Owner);
		Item->SetBoolField(TEXT("mine"), bMine);
		if (bMine)
		{
			// Only the resolved caller owning this lease sees its coordination id.
			Item->SetStringField(TEXT("lease_id"), Lease.Token);
		}
		if (!Lease.Label.IsEmpty()) Item->SetStringField(TEXT("label"), Lease.Label);
		Item->SetArrayField(TEXT("resources"), ClaimsToJson(Lease.Claims));
		Item->SetStringField(TEXT("lane"), LexLane(Lease.Lane));
		Item->SetNumberField(TEXT("held_s"), Now - Lease.GrantedAt);
		Item->SetNumberField(TEXT("expires_in_s"), FMath::Max(0.0, Lease.ExpiresAt - Now));
		Item->SetBoolField(TEXT("bound_to_connection"), Lease.ConnId != 0);
		Item->SetBoolField(TEXT("orphaned"), Lease.IsOrphaned());
		Item->SetBoolField(TEXT("bind_connection"), Lease.bBindConnection);
		Item->SetNumberField(TEXT("ttl_s"), Lease.TtlSeconds);

		LeasesJson.Add(MakeShared<FJsonValueObject>(Item));
	}

	TArray<TSharedPtr<FJsonValue>> WaitersJson;
	for (const FWaiter& Waiter : Table.GetWaiters())
	{
		TSharedPtr<FJsonObject> Item = MakeShared<FJsonObject>();
		Item->SetStringField(TEXT("owner"), Waiter.Request.Owner);
		if (Waiter.Request.Owner == Caller) Item->SetStringField(TEXT("ticket"), Waiter.Ticket);
		Item->SetArrayField(TEXT("resources"), ClaimsToJson(Waiter.Request.Claims));
		Item->SetStringField(TEXT("lane"), LexLane(Waiter.Request.Lane));
		Item->SetNumberField(TEXT("waited_s"), Now - Waiter.EnqueuedAt);
		Item->SetNumberField(TEXT("bypassed"), Waiter.Bypassed);
		Item->SetBoolField(TEXT("aged"), Table.IsAged(Waiter, Now));
		WaitersJson.Add(MakeShared<FJsonValueObject>(Item));
	}

	TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
	Out->SetStringField(TEXT("enforcement"), FHaybaMCPLeaseManager::CurrentModeName());
	TArray<TSharedPtr<FJsonValue>> ActiveJson;
	for (const FString& Active : FHaybaMCPLeaseManager::Get().ActiveOwners())
	{
		ActiveJson.Add(MakeShared<FJsonValueString>(Active));
	}
	Out->SetArrayField(TEXT("active_owners"), ActiveJson);
	Out->SetStringField(TEXT("caller_owner"), Caller);
	Out->SetStringField(TEXT("current_world"), FHaybaMCPLeaseManager::CurrentWorldPackage());
	Out->SetNumberField(TEXT("lease_count"), LeasesJson.Num());
	Out->SetNumberField(TEXT("waiter_count"), WaitersJson.Num());
	Out->SetNumberField(TEXT("max_ttl_s"), Table.GetTuning().MaxTtlSeconds);
	Out->SetNumberField(TEXT("orphan_grace_s"), Table.GetTuning().OrphanGraceSeconds);

	Out->SetArrayField(TEXT("leases"), LeasesJson);
	Out->SetArrayField(TEXT("waiters"), WaitersJson);
	return FHaybaHandlerResult::Ok(Out);
}
