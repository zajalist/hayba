// HaybaMCPLeaseHandler.cpp - see header.

#include "HaybaMCPLeaseHandler.h"
#include "HaybaMCPLeaseManager.h"
#include "HaybaMCPDeveloperSettings.h"
#include "HAL/PlatformTime.h"

namespace
{
	using namespace HaybaMCPLease;

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

	const TCHAR* LexEnforcement()
	{
		const UHaybaMCPDeveloperSettings* Settings = GetDefault<UHaybaMCPDeveloperSettings>();
		switch (Settings ? Settings->LeaseEnforcement : EHaybaMCPLeaseEnforcement::Advisory)
		{
		case EHaybaMCPLeaseEnforcement::Off:      return TEXT("off");
		case EHaybaMCPLeaseEnforcement::Enforced: return TEXT("enforced");
		default:                                  return TEXT("advisory");
		}
	}

	/** The envelope owner, or the owner of the lease its `lease` token names. */
	FString CallerOwner()
	{
		return FHaybaMCPLeaseManager::Get().EffectiveOwner();
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
		Out->SetStringField(TEXT("token"), Result.Token);
		Out->SetNumberField(TEXT("expires_in_s"), FMath::Max(0.0, Result.ExpiresAt - FPlatformTime::Seconds()));
		Out->SetBoolField(TEXT("bound_to_connection"), Request.ConnId != 0);
		if (Lease)
		{
			Out->SetArrayField(TEXT("resources"), ClaimsToJson(Lease->Claims));
		}
		Out->SetStringField(TEXT("next"),
			TEXT("Send this token as the envelope 'lease' field (or keep the same owner), renew with lease_renew before it lapses, "
				 "and lease_release when done."));
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
	FString Token;
	if (!P->TryGetStringField(TEXT("token"), Token) || Token.IsEmpty())
	{
		return FHaybaHandlerResult::Err(TEXT("lease_renew: token is required"));
	}
	double Ttl = 0.0;
	P->TryGetNumberField(TEXT("ttl_s"), Ttl);
	double ExpiresAt = 0.0;
	FString Error;
	if (!FHaybaMCPLeaseManager::Get().Table().Renew(Token, CallerOwner(), Ttl, ExpiresAt, Error))
	{
		return FHaybaHandlerResult::Err(TEXT("lease_renew: ") + Error);
	}
	TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
	Out->SetStringField(TEXT("token"), Token);
	Out->SetBoolField(TEXT("renewed"), true);
	Out->SetNumberField(TEXT("expires_in_s"), FMath::Max(0.0, ExpiresAt - FPlatformTime::Seconds()));
	return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPLeaseHandler::Release(const TSharedPtr<FJsonObject>& P)
{
	FString Token;
	if (!P->TryGetStringField(TEXT("token"), Token) || Token.IsEmpty())
	{
		return FHaybaHandlerResult::Err(TEXT("lease_release: token (a lease token or a queued ticket) is required"));
	}
	FString Error;
	if (!FHaybaMCPLeaseManager::Get().Table().Release(Token, CallerOwner(), Error))
	{
		return FHaybaHandlerResult::Err(TEXT("lease_release: ") + Error);
	}
	TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
	Out->SetStringField(TEXT("token"), Token);
	Out->SetBoolField(TEXT("released"), true);
	return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPLeaseHandler::Status(const TSharedPtr<FJsonObject>& /*P*/)
{
	FTable& Table = FHaybaMCPLeaseManager::Get().Table();
	Table.Expire();
	const double Now = FPlatformTime::Seconds();
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
			// Only the owner sees its token; a token in an envelope acts as its owner.
			Item->SetStringField(TEXT("token"), Lease.Token);
		}
		if (!Lease.Label.IsEmpty()) Item->SetStringField(TEXT("label"), Lease.Label);
		Item->SetArrayField(TEXT("resources"), ClaimsToJson(Lease.Claims));
		Item->SetStringField(TEXT("lane"), LexLane(Lease.Lane));
		Item->SetNumberField(TEXT("held_s"), Now - Lease.GrantedAt);
		Item->SetNumberField(TEXT("expires_in_s"), FMath::Max(0.0, Lease.ExpiresAt - Now));
		Item->SetBoolField(TEXT("bound_to_connection"), Lease.ConnId != 0);
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
	Out->SetStringField(TEXT("enforcement"), LexEnforcement());
	Out->SetStringField(TEXT("caller_owner"), Caller);
	Out->SetStringField(TEXT("current_world"), FHaybaMCPLeaseManager::CurrentWorldPackage());
	Out->SetNumberField(TEXT("lease_count"), LeasesJson.Num());
	Out->SetNumberField(TEXT("waiter_count"), WaitersJson.Num());
	Out->SetArrayField(TEXT("leases"), LeasesJson);
	Out->SetArrayField(TEXT("waiters"), WaitersJson);
	return FHaybaHandlerResult::Ok(Out);
}
