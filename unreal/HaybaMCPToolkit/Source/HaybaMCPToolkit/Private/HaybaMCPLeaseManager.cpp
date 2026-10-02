#include "HaybaMCPLeaseManager.h"
#include "HaybaMCPAccessPolicy.h"
#include "HaybaMCPCommandHandler.h"
#include "HaybaMCPDeveloperSettings.h"
#include "HaybaMCPWarningLimiter.h"
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
		// boundary). Keep lease ids unpredictable so a caller cannot derive
		// another holder's coordination handle. The salt itself never
		// appears in an id.
		return FGuid::NewGuid().ToString(EGuidFormats::Digits).ToLower();
	}

	FString SyntheticOwner(int32 ConnId)
	{
		return ConnId > 0 ? FString::Printf(TEXT("conn:%d"), ConnId) : FString(TEXT("local"));
	}

	/** Classify the envelope lease against Out.Owner. Never changes Out.Owner. */
	void ResolveLeaseRef(FCallerResolution& Out, const FString& EnvelopeLease)
	{
		const FString Lease = EnvelopeLease.TrimStartAndEnd();
		if (Lease.IsEmpty())
		{
			Out.LeaseRef = ELeaseRef::None;
			return;
		}
		if (HaybaMCPLease::IsRedactionMarker(Lease))
		{
			Out.LeaseRef = ELeaseRef::Redacted;
			return;
		}
		Out.LeaseId = Lease;
		const HaybaMCPLease::FLease* Held = FHaybaMCPLeaseManager::Get().Table().FindLease(Lease);
		if (!Held)
		{
			Out.LeaseRef = ELeaseRef::Unknown;
		}
		else if (Held->Owner == Out.Owner)
		{
			Out.LeaseRef = ELeaseRef::Bound;
		}
		else
		{
			Out.LeaseRef = ELeaseRef::NotBound;
			Out.NamedLeaseOwner = Held->Owner;
		}
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

bool FHaybaMCPLeaseManager::IsReservedOwner(const FString& Owner)
{
	return Owner == TEXT("local") || Owner.StartsWith(TEXT("conn:"), ESearchCase::CaseSensitive);
}

bool FHaybaMCPLeaseManager::IsIdentifiedCaller(const FCallerResolution& Caller)
{
	if (Caller.Via == TEXT("envelope") || Caller.Via == TEXT("adopted"))
	{
		return true;
	}
	return Caller.Via == TEXT("batch") && !IsReservedOwner(Caller.Owner);
}

FCallerResolution FHaybaMCPLeaseManager::ResolveCaller(const FString& EnvelopeOwner, int32 ConnId, const FString& EnvelopeLease)
{
	FCallerResolution Out;
	const FString Claimed = HaybaMCPEnforcement::SanitizeOwner(EnvelopeOwner);
	const FString Mine = SyntheticOwner(ConnId);
	if (!Claimed.IsEmpty() && !IsReservedOwner(Claimed))
	{
		Out.Owner = Claimed;
		Out.Via = TEXT("envelope");
	}
	else
	{
		// A reserved claim is accepted only when it is the caller's own synthetic owner.
		Out.bReservedViolation = !Claimed.IsEmpty() && Claimed != Mine;
		const FString Adopted = Claimed.IsEmpty() ? Get().ConnectionOwner(ConnId) : FString();
		if (!Adopted.IsEmpty())
		{
			Out.Owner = Adopted;
			Out.Via = TEXT("adopted");
		}
		else
		{
			Out.Owner = Mine;
			Out.Via = ConnId > 0 ? TEXT("conn") : TEXT("local");
		}
	}
	ResolveLeaseRef(Out, EnvelopeLease);
	return Out;
}

FCallerResolution FHaybaMCPLeaseManager::ResolveBatchCaller(const FString& BatchOwner, const FString& EnvelopeLease)
{
	FCallerResolution Out;
	Out.Owner = BatchOwner;
	Out.Via = TEXT("batch");
	ResolveLeaseRef(Out, EnvelopeLease);
	return Out;
}

bool FHaybaMCPLeaseManager::AdoptConnection(int32 ConnId, const FString& OwnerValue, FString& OutError)
{
	OutError.Reset();
	const FString Owner = HaybaMCPEnforcement::SanitizeOwner(OwnerValue);
	if (ConnId <= 0)
	{
		OutError = TEXT("[adopt_needs_connection] only a TCP connection can adopt an owner; in-process callers name the owner on each envelope");
		return false;
	}
	if (Owner.IsEmpty() || IsReservedOwner(Owner))
	{
		OutError = FString::Printf(TEXT("[owner_reserved] '%s' cannot be adopted: conn:<n> and local name connections, not agents"), *Owner);
		return false;
	}
	if (const FString* Existing = AdoptedOwners.Find(ConnId))
	{
		if (*Existing != Owner)
		{
			OutError = FString::Printf(
				TEXT("[connection_already_adopted] connection %d already acts as '%s'; open a new connection to act as '%s'"),
				ConnId, **Existing, *Owner);
			return false;
		}
		return true;
	}
	AdoptedOwners.Add(ConnId, Owner);
	return true;
}

FString FHaybaMCPLeaseManager::ConnectionOwner(int32 ConnId) const
{
	const FString* Owner = AdoptedOwners.Find(ConnId);
	return Owner ? *Owner : FString();
}

void FHaybaMCPLeaseManager::ForgetAllAdoptions()
{
	AdoptedOwners.Reset();
}

int32 FHaybaMCPLeaseManager::ReviveOrphanedLeases(const FString& Owner, int32 ConnId)
{
	return ReviveOrphanedLeases(Owner, ConnId, FString(), nullptr);
}

int32 FHaybaMCPLeaseManager::ReviveOrphanedLeases(const FString& Owner, int32 ConnId,
	const FString& NamedLeaseId, double* OutNamedExpiresAt)
{
	LeaseTable.Expire();
	// Renew expires/mutates the table: copy ids and real TTLs before renewing.
	TArray<TPair<FString, double>> Orphans;
	for (const HaybaMCPLease::FLease& Lease : LeaseTable.GetLeases())
	{
		if (Lease.Owner == Owner && Lease.OrphanedAt > 0.0)
		{
			Orphans.Emplace(Lease.Token, Lease.TtlSeconds);
		}
	}
	int32 Revived = 0;
	for (const TPair<FString, double>& Orphan : Orphans)
	{
		double ExpiresAt = 0.0;
		FString Error;
		if (LeaseTable.Renew(Orphan.Key, Owner, Orphan.Value, ExpiresAt, Error, ConnId))
		{
			++Revived;
			if (OutNamedExpiresAt && Orphan.Key == NamedLeaseId)
			{
				*OutNamedExpiresAt = ExpiresAt;
			}
		}
	}
	return Revived;
}

bool FHaybaMCPLeaseManager::AdoptLease(int32 ConnId, const FString& Owner, const FString& LeaseId,
	FAdoptResult& Out, FString& OutError)
{
	Out = FAdoptResult();
	OutError.Reset();
	const double Boundary = LeaseTable.Now();
	// Game-thread-only synchronous bookkeeping: no dispatch, tick, delegate or
	// external callback occurs while this stack scope freezes the table clock.
	// Nested scopes and every early refusal restore the previous clock via RAII.
	HaybaMCPLease::FTable::FScopedClockOverride Clock(LeaseTable, [Boundary]() { return Boundary; });
	double NamedExpiresAt = 0.0;
	{
		const HaybaMCPLease::FLease* Lease = LeaseTable.FindLease(LeaseId);
		if (!Lease)
		{
			OutError = TEXT("[lease_id_unknown] no live lease has that lease_id; acquire again");
			return false;
		}
		if (Lease->Owner != Owner)
		{
			OutError = FString::Printf(TEXT("[lease_owner_mismatch] lease belongs to '%s'"), *Lease->Owner);
			return false;
		}
		NamedExpiresAt = Lease->ExpiresAt;
	}
	// All refusals precede mutations. At the captured boundary the named lease
	// remains live through every Expire/Renew; no post-mutation failure is needed.
	if (!AdoptConnection(ConnId, Owner, OutError)) return false;
	Out.Revived = ReviveOrphanedLeases(Owner, ConnId, LeaseId, &NamedExpiresAt);
	Out.ExpiresInSeconds = NamedExpiresAt - Boundary;
	return true;
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
	// Only a resolved named caller proves an agent is present. conn:<n>
	// and local remain synthetic; a lease never supplies identity.
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
	// T9: the resolved caller. The envelope lease no longer acts as its owner, so
	// the Plan gate, python_run deadline_s, editor_batch and the lease handlers
	// all judge the caller as itself.
	return CurrentContext ? CurrentContext->Owner : FString(TEXT("local"));
}

void FHaybaMCPLeaseManager::OnConnectionClosed(int32 ConnId)
{
	AdoptedOwners.Remove(ConnId);
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
		bool bDeclaredReadOnly = false;
		if (Params.IsValid())
		{
			Params->TryGetStringField(TEXT("script"), Script);
			Params->TryGetBoolField(TEXT("world_partition"), bWorldPartition);
			// Only a real boolean declares; a string "true" is undeclared (fail closed).
			const TSharedPtr<FJsonValue> ReadOnlyField = Params->TryGetField(TEXT("read_only"));
			bDeclaredReadOnly = ReadOnlyField.IsValid() && ReadOnlyField->Type == EJson::Boolean && ReadOnlyField->AsBool();
		}
		// Python declarations must be complete: the shared parser tolerates null
		// entries and a non-string mode for compatibility with lease commands.
		// Reject those shapes here before trusting any partial scope.
		bool bDeclarationShapeValid = true;
		const TArray<TSharedPtr<FJsonValue>>* ResourceItems = nullptr;
		if (Params.IsValid() && Params->TryGetArrayField(TEXT("resources"), ResourceItems) && ResourceItems)
		{
			for (const TSharedPtr<FJsonValue>& Item : *ResourceItems)
			{
				const TSharedPtr<FJsonObject>* ResourceObject = nullptr;
				if (!Item.IsValid() || Item->Type == EJson::Null)
				{
					bDeclarationShapeValid = false;
					Out.ClaimError = TEXT("resources entries must not be null");
					break;
				}
				if (Item->TryGetObject(ResourceObject) && ResourceObject && ResourceObject->IsValid())
				{
					const TSharedPtr<FJsonValue> Mode = (*ResourceObject)->TryGetField(TEXT("mode"));
					if (Mode.IsValid() && Mode->Type != EJson::String)
					{
						bDeclarationShapeValid = false;
						Out.ClaimError = TEXT("resources mode must be a string");
						break;
					}
				}
			}
		}
		if (!bDeclarationShapeValid || !ParseClaims(Params, /*bDefaultExclusive=*/true, Out.Declared, Out.ClaimError))
		{
			// An unparseable declaration is treated as no declaration.
			Out.Declared.Reset();
		}
		const bool bTouchesWorldPartition = bWorldPartition || HaybaMCPAccess::ScriptTouchesWorldPartition(Script);
		Out.Class = HaybaMCPAccess::ClassifyPythonRun(bDeclaredReadOnly, bTouchesWorldPartition, Out.Declared.Num() > 0);
		if (Out.Class == HaybaMCPAccess::EAccessClass::WriteWorld && !bTouchesWorldPartition)
		{
			// T8 design 5: undeclared and not read_only is X on global for conflicts.
			Out.Locks = HaybaMCPAccess::UndeclaredPythonRunLocks();
			return Out;
		}
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

FHaybaMCPLeaseManager::FVerdict FHaybaMCPLeaseManager::CheckCommandFacts(
	const FString& Cmd, const FRequiredAccess& Access)
{
	using namespace HaybaMCPEnforcement;
	FVerdict Verdict;
	const EMode Mode = CurrentMode();
	if (Mode == EMode::Off)
	{
		return Verdict;
	}
	const FString ModeName = LexMode(Mode);

	static const FCallerResolution NoCaller;
	const FCallerResolution& Caller = CurrentContext ? CurrentContext->Caller : NoCaller;
	const FString Owner = EffectiveOwner();
	FString ConflictDetail;
	const HaybaMCPLease::FLease* Holder = LeaseTable.FindConflictingHolder(Owner, Access.Locks, &ConflictDetail);
	const TArray<FString> Others = Presence.ActiveOwners(Owner);

	FFacts Facts;
	Facts.Mode = Mode;
	Facts.Class = Access.Class;
	Facts.bOwnerFromEnvelope = IsIdentifiedCaller(Caller);
	// A foreign live lease is valid as a reference, but never changes the caller.
	// R5: redaction markers name no lease and count as absent.
	Facts.Handle = Caller.LeaseRef == ELeaseRef::Unknown ? EHandle::Unknown
		: (Caller.LeaseRef == ELeaseRef::Bound || Caller.LeaseRef == ELeaseRef::NotBound) ? EHandle::Valid : EHandle::None;
	Facts.bInProcess = !CurrentContext || CurrentContext->ConnId == 0;
	Facts.bHeldConflict = Holder != nullptr;
	Facts.OtherActiveOwners = Others.Num();
	const FDecision Decision = Decide(Facts);

	const bool bHandleRedacted = Caller.LeaseRef == ELeaseRef::Redacted;
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
		// Never expose another holder's coordination handle.
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
	if (Caller.LeaseRef == ELeaseRef::Unknown) Detail->SetStringField(TEXT("lease_id_error"), TEXT("unknown_or_expired"));
	if (bHandleRedacted) Detail->SetStringField(TEXT("lease_id_error"), TEXT("redaction_marker"));

	FString Hint;
	if (Decision.Reason == EReason::OwnerMissing)
	{
		Verdict.Message = FString::Printf(
			TEXT("owner_required: '%s' (%s) names no owner while %d other agents are connected (%s). Send the envelope 'owner' (HAYBA_AGENT_ID), or adopt your owner on this connection with lease_adopt, then retry."),
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

FHaybaMCPLeaseManager::FVerdict FHaybaMCPLeaseManager::CheckCommand(const FString& Cmd, const TSharedPtr<FJsonObject>& Params)
{
	const FRequiredAccess Access = ResolveRequiredAccess(Cmd, Params, CurrentWorldPackage());
	FVerdict Verdict = CheckCommandFacts(Cmd, Access);
	AddLeaseBinding(Cmd, Access, Verdict);
	return Verdict;
}

void FHaybaMCPLeaseManager::AddLeaseBinding(const FString& Cmd, const FRequiredAccess& Access, FVerdict& Verdict)
{
	if (!CurrentContext || CurrentContext->Caller.LeaseRef != ELeaseRef::NotBound
		|| CurrentMode() == HaybaMCPEnforcement::EMode::Off)
	{
		return;
	}
	if (Access.Class == HaybaMCPAccess::EAccessClass::Read)
	{
		return; // A read is never judged, so naming someone else's lease changes nothing.
	}
	const FCallerResolution& Caller = CurrentContext->Caller;
	TSharedPtr<FJsonObject> Binding = MakeShared<FJsonObject>();
	Binding->SetStringField(TEXT("named_lease_owner"), Caller.NamedLeaseOwner);
	Binding->SetStringField(TEXT("caller_owner"), CurrentContext->Owner);
	Binding->SetStringField(TEXT("fix"), FString::Printf(
		TEXT("The envelope 'lease' does not change who is calling. Send the envelope 'owner' '%s' (HAYBA_AGENT_ID) with this lease, ")
		TEXT("or call lease_adopt {owner, lease_id} once on this connection."), *Caller.NamedLeaseOwner));
	if (Verdict.Detail.IsValid())
	{
		// Rides on the lease_conflict / owner_required detail (refusal or Advisory warning).
		Verdict.Detail->SetObjectField(TEXT("lease_binding"), Binding);
		return;
	}
	// Through NoteLeaseWarning, like every lease warning (T6.2): it logs the first
	// hit per key per 30 s, and it registers the text the 30 s drain ticker prints
	// for the suppressed ones. No UE_LOG and no limiter call of its own here.
	const FString ModeName = CurrentModeName();
	const FWarningLimiter::FHit Hit = NoteLeaseWarning(ModeName, TEXT("lease_warning"), TEXT("lease_not_bound"),
		CurrentContext->Owner, Cmd, Caller.NamedLeaseOwner, TEXT("lease_not_bound"),
		FString::Printf(TEXT("lease_warning/lease_not_bound: '%s' from '%s' names a lease of '%s'"),
			*Cmd, *CurrentContext->Owner, *Caller.NamedLeaseOwner));
	TSharedPtr<FJsonObject> Warning = MakeShared<FJsonObject>();
	Warning->SetStringField(TEXT("reason"), TEXT("lease_not_bound"));
	Warning->SetStringField(TEXT("enforcement"), ModeName);
	Warning->SetStringField(TEXT("command"), Cmd);
	Warning->SetStringField(TEXT("caller_owner"), CurrentContext->Owner);
	Warning->SetObjectField(TEXT("lease_binding"), Binding);
	Warning->SetNumberField(TEXT("repeats_in_window"), Hit.RepeatsInWindow);
	Warning->SetStringField(TEXT("hint"), Binding->GetStringField(TEXT("fix")));
	if (!CurrentContext->LeaseWarning.IsValid())
	{
		CurrentContext->LeaseWarning = Warning;
	}
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
