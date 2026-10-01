#include "HaybaMCPLeaseManager.h"
#include "HaybaMCPAccessPolicy.h"
#include "HaybaMCPCommandHandler.h"
#include "HaybaMCPDeveloperSettings.h"
#include "HaybaMCPWarningLimiter.h"
#include "handlers/HaybaMCPPythonHandler.h"
#include "Editor.h"
#include "Engine/World.h"
#include "HAL/PlatformTime.h"
#include "Misc/Guid.h"
#include "UObject/Package.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPLease, Log, All);

namespace
{
	FString MakeTokenSalt()
	{
		// The HMAC key for lease ids (ls_<seq>_<mac12>). Ids are coordination
		// handles, not credentials (the capability token is the auth
		// boundary), but a lease id in the envelope acts as its owner, so one
		// holder must not be able to derive another's. The salt itself never
		// appears in an id.
		return FGuid::NewGuid().ToString(EGuidFormats::Digits).ToLower();
	}
}

FHaybaMCPLeaseManager& FHaybaMCPLeaseManager::Get()
{
	static FHaybaMCPLeaseManager Instance;
	return Instance;
}

FHaybaMCPLeaseManager::FHaybaMCPLeaseManager()
	: LeaseTable([this]() { return Now(); }, HaybaMCPLease::FTuning(), MakeTokenSalt())
	, LeaseWarningLimiter([this]() { return Now(); })
	, Presence([this]() { return Now(); })
{
}

FString FHaybaMCPLeaseManager::ResolveOwner(const TSharedPtr<FJsonObject>& Envelope, int32 ConnId, bool* bOutFromEnvelope)
{
	if (bOutFromEnvelope)
	{
		*bOutFromEnvelope = false;
	}
	FString Owner;
	if (Envelope.IsValid() && Envelope->TryGetStringField(TEXT("owner"), Owner))
	{
		Owner = HaybaMCPEnforcement::SanitizeOwner(Owner);
	}
	if (!Owner.IsEmpty())
	{
		if (bOutFromEnvelope)
		{
			*bOutFromEnvelope = true;
		}
		return Owner;
	}
	return ConnId > 0 ? FString::Printf(TEXT("conn:%d"), ConnId) : FString(TEXT("local"));
}

FHaybaMCPLeaseManager::EEnvelopeLease FHaybaMCPLeaseManager::ClassifyEnvelopeLease(const FString& LeaseValue)
{
	if (LeaseValue.IsEmpty())
	{
		return EEnvelopeLease::None;
	}
	if (HaybaMCPLease::IsRedactionMarker(LeaseValue))
	{
		return EEnvelopeLease::Redacted;
	}
	return LeaseTable.FindLease(LeaseValue) ? EEnvelopeLease::Valid : EEnvelopeLease::Unknown;
}

const TCHAR* FHaybaMCPLeaseManager::LexEnvelopeLease(EEnvelopeLease State)
{
	switch (State)
	{
	case EEnvelopeLease::None:     return TEXT("none");
	case EEnvelopeLease::Valid:    return TEXT("valid");
	case EEnvelopeLease::Unknown:  return TEXT("unknown");
	case EEnvelopeLease::Redacted: return TEXT("redacted");
	}
	return TEXT("none");
}

void FHaybaMCPLeaseManager::NoteAuthenticatedCaller(const FString& Owner, int32 ConnId, bool bIdentified)
{
	// conn:<n> and local are synthetic; only a named owner (or, from T8, a
	// valid lease handle) proves an agent is present.
	if (bIdentified)
	{
		Presence.Note(Owner, ConnId);
	}
}

FWarningLimiter::FHit FHaybaMCPLeaseManager::NoteLeaseWarning(
	const FString& ModeName, const FString& Code, const FString& Reason, const FString& Owner,
	const FString& Cmd, const FString& HolderOwner, const FString& Conflict, const FString& Message)
{
	DrainLeaseWarnings();
	const FString Key = FWarningLimiter::MakeKey(TEXT("lease"), Code + TEXT("/") + Reason, Owner, Cmd, HolderOwner);
	const FWarningLimiter::FHit Hit = LeaseWarningLimiter.Note(Key);
	FLeaseWarningText* Text = LeaseWarningText.Find(Key);
	if (!Text && LeaseWarningText.Num() < FWarningLimiter::DefaultMaxKeys)
	{
		Text = &LeaseWarningText.Add(Key);
		Text->Head = FString::Printf(TEXT("[%s] %s/%s"), *ModeName, *Code, *Reason);
		Text->Tail = FString::Printf(TEXT("owner='%s' cmd='%s' holder='%s' conflict='%s'"),
			*FWarningLimiter::CollapseOwner(Owner), *Cmd, *HolderOwner, *Conflict);
	}
	if (Text)
	{
		Text->LastAt = Now();
	}
	if (Hit.bLog)
	{
		if (Hit.SuppressedInPreviousWindow > 0)
		{
			UE_LOG(LogHaybaMCPLease, Warning, TEXT("[%s] %s (+%d identical in the previous 30 s)"),
				*ModeName, *Message, Hit.SuppressedInPreviousWindow);
		}
		else
		{
			UE_LOG(LogHaybaMCPLease, Warning, TEXT("[%s] %s"), *ModeName, *Message);
		}
	}
	return Hit;
}

void FHaybaMCPLeaseManager::DrainLeaseWarnings()
{
	const double NowSeconds = Now();
	for (const FWarningLimiter::FDrained& Drained : LeaseWarningLimiter.DrainExpired())
	{
		if (const FLeaseWarningText* Text = LeaseWarningText.Find(Drained.Key))
		{
			UE_LOG(LogHaybaMCPLease, Warning, TEXT("%s repeated %d more times in 30 s: %s"),
				*Text->Head, Drained.Suppressed, *Text->Tail);
		}
		else
		{
			UE_LOG(LogHaybaMCPLease, Warning, TEXT("[lease] %s repeated %d more times in 30 s"),
				*Drained.Key, Drained.Suppressed);
		}
		LeaseWarningText.Remove(Drained.Key);
	}
	// A window that closed with nothing suppressed is never drained; forget its
	// text after two windows so the map stays bounded.
	for (auto It = LeaseWarningText.CreateIterator(); It; ++It)
	{
		if (NowSeconds - It.Value().LastAt > 2.0 * FWarningLimiter::DefaultWindowSeconds)
		{
			It.RemoveCurrent();
		}
	}
}

void FHaybaMCPLeaseManager::StartWarningDrain()
{
	if (WarningDrainHandle.IsValid())
	{
		return;
	}
	WarningDrainHandle = FTSTicker::GetCoreTicker().AddTicker(
		FTickerDelegate::CreateLambda([](float)
		{
			FHaybaMCPLeaseManager::Get().DrainLeaseWarnings();
			return true;
		}),
		static_cast<float>(FWarningLimiter::DefaultWindowSeconds));
}

void FHaybaMCPLeaseManager::StopWarningDrain()
{
	if (WarningDrainHandle.IsValid())
	{
		FTSTicker::GetCoreTicker().RemoveTicker(WarningDrainHandle);
		WarningDrainHandle.Reset();
	}
}

#if WITH_DEV_AUTOMATION_TESTS
void FHaybaMCPLeaseManager::ForgetOwnerForTests(const FString& Owner)
{
	TArray<FString> Handles;
	for (const HaybaMCPLease::FLease& Lease : LeaseTable.GetLeases())
	{
		if (Lease.Owner == Owner) Handles.Add(Lease.Token);
	}
	for (const HaybaMCPLease::FWaiter& Waiter : LeaseTable.GetWaiters())
	{
		if (Waiter.Request.Owner == Owner) Handles.Add(Waiter.Ticket);
	}
	FString Ignored;
	for (const FString& Handle : Handles)
	{
		LeaseTable.Release(Handle, Owner, Ignored);
	}
	Presence.Forget(Owner);
}
#endif

FString FHaybaMCPLeaseManager::CurrentWorldPackage()
{
	if (!GEditor)
	{
		return FString();
	}
	const UWorld* World = GEditor->GetEditorWorldContext().World();
	return World ? World->GetOutermost()->GetName() : FString();
}

bool FHaybaMCPLeaseManager::ParseClaims(
	const TSharedPtr<FJsonObject>& Params,
	bool bDefaultExclusive,
	TArray<HaybaMCPAccess::FClaim>& OutClaims,
	FString& OutError)
{
	OutClaims.Reset();
	if (!Params.IsValid() || !Params->HasField(TEXT("resources")))
	{
		return true;
	}
	const TArray<TSharedPtr<FJsonValue>>* Items = nullptr;
	if (!Params->TryGetArrayField(TEXT("resources"), Items) || !Items)
	{
		OutError = TEXT("resources must be an array of resource strings or {resource, mode} objects");
		return false;
	}
	if (Items->Num() > 32)
	{
		OutError = TEXT("at most 32 resources per request");
		return false;
	}
	for (const TSharedPtr<FJsonValue>& Item : *Items)
	{
		if (!Item.IsValid()) continue;
		FString Text;
		bool bExclusive = bDefaultExclusive;
		const TSharedPtr<FJsonObject>* Obj = nullptr;
		if (Item->TryGetObject(Obj) && Obj && Obj->IsValid())
		{
			if (!(*Obj)->TryGetStringField(TEXT("resource"), Text))
			{
				OutError = TEXT("each resources[] object needs a 'resource' string");
				return false;
			}
			FString Mode;
			if ((*Obj)->TryGetStringField(TEXT("mode"), Mode))
			{
				if (Mode == TEXT("shared")) bExclusive = false;
				else if (Mode == TEXT("exclusive")) bExclusive = true;
				else
				{
					OutError = FString::Printf(TEXT("mode '%s' must be 'shared' or 'exclusive'"), *Mode);
					return false;
				}
			}
		}
		else if (!Item->TryGetString(Text))
		{
			OutError = TEXT("resources must be an array of resource strings or {resource, mode} objects");
			return false;
		}
		HaybaMCPAccess::FClaim Claim;
		Claim.bExclusive = bExclusive;
		if (!HaybaMCPAccess::ParseResource(Text, Claim.Resource, OutError))
		{
			return false;
		}
		OutClaims.Add(MoveTemp(Claim));
	}
	return true;
}

FHaybaMCPLeaseManager::FScope::FScope(FHaybaMCPRequestContext& Context)
{
	FHaybaMCPLeaseManager& Manager = FHaybaMCPLeaseManager::Get();
	Previous = Manager.CurrentContext;
	Manager.CurrentContext = &Context;
}

FHaybaMCPLeaseManager::FScope::~FScope()
{
	FHaybaMCPLeaseManager::Get().CurrentContext = Previous;
}

FString FHaybaMCPLeaseManager::EffectiveOwner()
{
	if (!CurrentContext)
	{
		return TEXT("local");
	}
	if (!CurrentContext->LeaseToken.IsEmpty())
	{
		// FindLease expires first; a lapsed token falls back to the envelope owner.
		if (const HaybaMCPLease::FLease* Lease = LeaseTable.FindLease(CurrentContext->LeaseToken))
		{
			return Lease->Owner;
		}
	}
	return CurrentContext->Owner;
}

void FHaybaMCPLeaseManager::OnConnectionClosed(int32 ConnId)
{
	Presence.OnConnectionClosed(ConnId);
	const int32 Orphaned = LeaseTable.OnConnectionClosed(ConnId);
	if (Orphaned > 0)
	{
		UE_LOG(LogHaybaMCPLease, Log,
			TEXT("Connection %d closed: %d bound lease(s) orphaned; each lapses in up to %.0f s, or at its earlier expiry, unless its owner renews it"),
			ConnId, Orphaned, LeaseTable.GetTuning().OrphanGraceSeconds);
	}
}

void FHaybaMCPLeaseManager::NoteDeprecatedParam(const FString& Cmd, const FString& Param, const FString& Owner)
{
	const FString Collapsed = FWarningLimiter::CollapseOwner(Owner);
	if (!DeprecatedParamNotes.First(Cmd + TEXT("|") + Param + TEXT("|") + Collapsed))
	{
		return;
	}
	UE_LOG(LogHaybaMCPLease, Warning, TEXT("%s: deprecated param '%s' from owner '%s'; send lease_id"),
		*Cmd, *Param, *Collapsed);
}

bool FHaybaMCPLeaseManager::CallerHoldsExclusiveOnCurrentWorld()
{
	const FString World = CurrentWorldPackage();
	const FString Key = World.IsEmpty()
		? FString(TEXT("global"))
		: HaybaMCPAccess::FResource::MakeWorld(World).Key();
	return LeaseTable.OwnerHoldsExclusive(EffectiveOwner(), Key);
}

FHaybaMCPLeaseManager::FRequiredAccess FHaybaMCPLeaseManager::ResolveRequiredAccess(
	const FString& Cmd, const TSharedPtr<FJsonObject>& Params, const FString& CurrentWorld)
{
	FRequiredAccess Out;
	Out.Class = HaybaMCPAccess::ClassifyCommand(Cmd, FHaybaMCPCommandHandler::IsPlanGatedCommand(Cmd)).Class;
	if (Cmd == TEXT("python_run"))
	{
		FString Script;
		bool bWorldPartition = false;
		if (Params.IsValid())
		{
			Params->TryGetStringField(TEXT("script"), Script);
			Params->TryGetBoolField(TEXT("world_partition"), bWorldPartition);
		}
		if (!ParseClaims(Params, /*bDefaultExclusive=*/true, Out.Declared, Out.ClaimError))
		{
			// An unparseable declaration is treated as no declaration.
			Out.Declared.Reset();
		}
		Out.Class = HaybaMCPAccess::ClassifyPythonRun(
			FHaybaMCPPythonHandler::IsReadOnlyScriptForAccess(Script),
			bWorldPartition || HaybaMCPAccess::ScriptTouchesWorldPartition(Script),
			Out.Declared.Num() > 0);
	}
	if (Out.Declared.Num() == 0)
	{
		// An asset writer names its asset in its own request (S1).
		HaybaMCPAccess::FClaim Implied;
		if (HaybaMCPAccess::ImpliedAssetClaim(Cmd, Params, Implied))
		{
			Out.Declared.Add(MoveTemp(Implied));
		}
	}
	Out.Locks = HaybaMCPAccess::RequiredLocks(Out.Class, Out.Declared, CurrentWorld);
	return Out;
}

HaybaMCPEnforcement::EMode FHaybaMCPLeaseManager::CurrentMode()
{
	const UHaybaMCPDeveloperSettings* Settings = GetDefault<UHaybaMCPDeveloperSettings>();
	switch (Settings ? Settings->LeaseEnforcement : EHaybaMCPLeaseEnforcement::EnforcedForWrites)
	{
	case EHaybaMCPLeaseEnforcement::Off:               return HaybaMCPEnforcement::EMode::Off;
	case EHaybaMCPLeaseEnforcement::Advisory:          return HaybaMCPEnforcement::EMode::Advisory;
	case EHaybaMCPLeaseEnforcement::EnforcedForWrites: return HaybaMCPEnforcement::EMode::EnforcedForWrites;
	case EHaybaMCPLeaseEnforcement::Enforced:          return HaybaMCPEnforcement::EMode::Enforced;
	}
	return HaybaMCPEnforcement::EMode::EnforcedForWrites;
}

FString FHaybaMCPLeaseManager::CurrentModeName()
{
	return HaybaMCPEnforcement::LexMode(CurrentMode());
}

FHaybaMCPLeaseManager::FVerdict FHaybaMCPLeaseManager::CheckCommand(
	const FString& Cmd, const TSharedPtr<FJsonObject>& Params)
{
	using namespace HaybaMCPEnforcement;
	FVerdict Verdict;
	const EMode Mode = CurrentMode();
	if (Mode == EMode::Off)
	{
		return Verdict;
	}
	const FString ModeName = LexMode(Mode);

	const FRequiredAccess Access = ResolveRequiredAccess(Cmd, Params, CurrentWorldPackage());
	const EEnvelopeLease LeaseState = CurrentContext ? ClassifyEnvelopeLease(CurrentContext->LeaseToken) : EEnvelopeLease::None;
	const FString Owner = EffectiveOwner();
	FString ConflictDetail;
	const HaybaMCPLease::FLease* Holder = LeaseTable.FindConflictingHolder(Owner, Access.Locks, &ConflictDetail);
	const TArray<FString> Others = Presence.ActiveOwners(Owner);

	FFacts Facts;
	Facts.Mode = Mode;
	Facts.Class = Access.Class;
	Facts.bOwnerFromEnvelope = CurrentContext && CurrentContext->bOwnerFromEnvelope;
	// R5: a redaction marker names no lease; it counts as absent.
	Facts.Handle = LeaseState == EEnvelopeLease::Valid ? EHandle::Valid
		: LeaseState == EEnvelopeLease::Unknown ? EHandle::Unknown : EHandle::None;
	Facts.bInProcess = !CurrentContext || CurrentContext->ConnId == 0;
	Facts.bHeldConflict = Holder != nullptr;
	Facts.OtherActiveOwners = Others.Num();
	const FDecision Decision = Decide(Facts);

	const bool bHandleRedacted = LeaseState == EEnvelopeLease::Redacted;
	if (Decision.Verdict == EVerdict::Allow && !bHandleRedacted)
	{
		return Verdict;
	}
	// A marker alone only warns (reason lease_handle_redacted); it never refuses.
	const bool bRedactedOnly = Decision.Verdict == EVerdict::Allow;
	const FString Code = bRedactedOnly ? FString(TEXT("lease_conflict")) : Decision.Code;
	const FString ReasonName = bRedactedOnly ? FString(TEXT("lease_handle_redacted")) : FString(LexReason(Decision.Reason));
	TArray<FString> Shown = Others;
	if (Shown.Num() > 8)
	{
		Shown.SetNum(8);
	}

	TSharedPtr<FJsonObject> Detail = MakeShared<FJsonObject>();
	Detail->SetStringField(TEXT("code"), Code);
	Detail->SetStringField(TEXT("enforcement"), ModeName);
	Detail->SetStringField(TEXT("reason"), ReasonName);
	Detail->SetStringField(TEXT("command"), Cmd);
	Detail->SetStringField(TEXT("access_class"), HaybaMCPAccess::LexAccessClass(Access.Class));
	Detail->SetStringField(TEXT("caller_owner"), Owner);
	if (!Access.ClaimError.IsEmpty())
	{
		Detail->SetStringField(TEXT("resources_error"), Access.ClaimError);
	}
	if (Holder)
	{
		// Never the holder's lease_id: an envelope lease acts as its owner.
		Detail->SetStringField(TEXT("holder_owner"), Holder->Owner);
		if (!Holder->Label.IsEmpty()) Detail->SetStringField(TEXT("holder_label"), Holder->Label);
		Detail->SetNumberField(TEXT("holder_expires_in_s"), FMath::Max(0.0, Holder->ExpiresAt - Now()));
		Detail->SetStringField(TEXT("conflict"), ConflictDetail);
	}
	if (Decision.Reason == EReason::OwnerMissing)
	{
		TArray<TSharedPtr<FJsonValue>> OwnersJson;
		for (const FString& Other : Shown) OwnersJson.Add(MakeShared<FJsonValueString>(Other));
		Detail->SetArrayField(TEXT("other_owners"), OwnersJson);
	}
	if (LeaseState == EEnvelopeLease::Unknown) Detail->SetStringField(TEXT("lease_id_error"), TEXT("unknown_or_expired"));
	if (bHandleRedacted) Detail->SetStringField(TEXT("lease_id_error"), TEXT("redaction_marker"));

	FString Hint;
	if (Decision.Reason == EReason::OwnerMissing)
	{
		Verdict.Message = FString::Printf(
			TEXT("owner_required: '%s' (%s) names no owner while %d other agents are connected (%s). Send the envelope 'owner' (HAYBA_AGENT_ID) or a valid lease handle, then retry."),
			*Cmd, HaybaMCPAccess::LexAccessClass(Access.Class), Others.Num(), *FString::Join(Shown, TEXT(", ")));
		Hint = TEXT("Set HAYBA_AGENT_ID (Node) or send the envelope 'owner' on every command, so the editor knows which agent is writing.");
	}
	else if (Decision.Reason == EReason::LeaseUnknown)
	{
		Verdict.Message = FString::Printf(TEXT("lease_conflict: '%s': the envelope's lease_id is unknown or expired"), *Cmd);
		Hint = TEXT("The envelope's lease_id is dead. Run lease_acquire again and send the lease_id it returns, or stop sending the envelope lease and send only your owner.");
	}
	else if (Decision.Reason == EReason::Held)
	{
		Verdict.Message = FString::Printf(TEXT("lease_conflict: '%s' (%s) conflicts with a lease held by '%s' (%s)"),
			*Cmd, HaybaMCPAccess::LexAccessClass(Access.Class), *Holder->Owner, *ConflictDetail);
		Hint = TEXT("Wait for the holder or ask it to release. lease_acquire queues you fairly: it answers granted or queued (with position and ETA) and never blocks. lease_status shows every holder.");
	}
	else
	{
		Verdict.Message = FString::Printf(
			TEXT("lease_conflict: '%s': the envelope's lease is a redaction marker, not a lease_id; run lease_acquire again and send the lease_id it returns"), *Cmd);
		Hint = TEXT("Send the lease_id from lease_acquire. A [REDACTED:...] marker is ignored; this command was judged by its owner.");
	}
	Detail->SetStringField(TEXT("hint"), Hint);

	const FWarningLimiter::FHit Hit = NoteLeaseWarning(ModeName, Code, ReasonName, Owner, Cmd,
		Holder ? Holder->Owner : FString(), ConflictDetail, Verdict.Message);
	Detail->SetNumberField(TEXT("repeats_in_window"), Hit.RepeatsInWindow);
	Verdict.Detail = Detail;
	Verdict.Code = Code;
	Verdict.Reason = bRedactedOnly ? EReason::None : Decision.Reason;
	if (Decision.Verdict == EVerdict::Refuse)
	{
		Verdict.bRefuse = true;
	}
	else if (CurrentContext)
	{
		CurrentContext->LeaseWarning = Detail;
	}
	return Verdict;
}

void FHaybaMCPLeaseManager::TouchOnUse(const FString& Cmd, const TSharedPtr<FJsonObject>& Params)
{
	// Reads, status polls and refused commands never keep a lease alive, and an
	// orphan is never touched: only an explicit renew by its owner revives it.
	const FRequiredAccess Access = ResolveRequiredAccess(Cmd, Params, CurrentWorldPackage());
	if (Access.Class == HaybaMCPAccess::EAccessClass::Read || Access.Locks.Num() == 0)
	{
		return;
	}
	LeaseTable.Touch(EffectiveOwner(), Access.Locks);
}

void FHaybaMCPLeaseManager::NoteMarkerShim(const FString& Cmd, const FString& Owner, const FString& Outcome)
{
	UE_LOG(LogHaybaMCPLease, Log, TEXT("%s: redaction marker under the deprecated alias from owner '%s' (marker shim): %s"),
		*Cmd, *FWarningLimiter::CollapseOwner(Owner), *Outcome);
}
