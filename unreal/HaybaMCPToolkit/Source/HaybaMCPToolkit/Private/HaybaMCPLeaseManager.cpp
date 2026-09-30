#include "HaybaMCPLeaseManager.h"
#include "HaybaMCPAccessPolicy.h"
#include "HaybaMCPCommandHandler.h"
#include "HaybaMCPDeveloperSettings.h"
#include "handlers/HaybaMCPPythonHandler.h"
#include "Editor.h"
#include "Engine/World.h"
#include "HAL/PlatformTime.h"
#include "Misc/Guid.h"
#include "UObject/Package.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPLease, Log, All);

namespace
{
	constexpr int32 MaxOwnerChars = 128;

	FString MakeTokenSalt()
	{
		// Tokens are coordination handles, not credentials (the capability
		// token is the auth boundary), but they should not be guessable
		// sequence numbers either: the envelope `lease` field acts as the
		// lease's owner.
		return FGuid::NewGuid().ToString(EGuidFormats::Digits).Left(12).ToLower();
	}
}

FHaybaMCPLeaseManager& FHaybaMCPLeaseManager::Get()
{
	static FHaybaMCPLeaseManager Instance;
	return Instance;
}

FHaybaMCPLeaseManager::FHaybaMCPLeaseManager()
	: LeaseTable([]() { return FPlatformTime::Seconds(); }, HaybaMCPLease::FTuning(), MakeTokenSalt())
{
}

FString FHaybaMCPLeaseManager::ResolveOwner(const TSharedPtr<FJsonObject>& Envelope, int32 ConnId)
{
	FString Owner;
	if (Envelope.IsValid() && Envelope->TryGetStringField(TEXT("owner"), Owner))
	{
		Owner.TrimStartAndEndInline();
		Owner = Owner.Left(MaxOwnerChars);
	}
	if (!Owner.IsEmpty())
	{
		return Owner;
	}
	return ConnId > 0 ? FString::Printf(TEXT("conn:%d"), ConnId) : FString(TEXT("local"));
}

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
	const int32 Released = LeaseTable.ReleaseConnection(ConnId);
	if (Released > 0)
	{
		UE_LOG(LogHaybaMCPLease, Log,
			TEXT("Connection %d closed: released %d bound lease(s)/ticket(s)"), ConnId, Released);
	}
}

bool FHaybaMCPLeaseManager::CallerHoldsExclusiveOnCurrentWorld()
{
	const FString World = CurrentWorldPackage();
	const FString Key = World.IsEmpty()
		? FString(TEXT("global"))
		: HaybaMCPAccess::FResource::MakeWorld(World).Key();
	return LeaseTable.OwnerHoldsExclusive(EffectiveOwner(), Key);
}

FHaybaMCPLeaseManager::FVerdict FHaybaMCPLeaseManager::CheckCommand(
	const FString& Cmd, const TSharedPtr<FJsonObject>& Params)
{
	FVerdict Verdict;
	const UHaybaMCPDeveloperSettings* Settings = GetDefault<UHaybaMCPDeveloperSettings>();
	const EHaybaMCPLeaseEnforcement Mode = Settings ? Settings->LeaseEnforcement : EHaybaMCPLeaseEnforcement::Advisory;
	if (Mode == EHaybaMCPLeaseEnforcement::Off)
	{
		return Verdict;
	}

	HaybaMCPAccess::FClassification Class =
		HaybaMCPAccess::ClassifyCommand(Cmd, FHaybaMCPCommandHandler::IsPlanGatedCommand(Cmd));
	TArray<HaybaMCPAccess::FClaim> Declared;
	FString ClaimError;
	if (Cmd == TEXT("python_run"))
	{
		FString Script;
		bool bWorldPartition = false;
		if (Params.IsValid())
		{
			Params->TryGetStringField(TEXT("script"), Script);
			Params->TryGetBoolField(TEXT("world_partition"), bWorldPartition);
		}
		if (!ParseClaims(Params, /*bDefaultExclusive=*/true, Declared, ClaimError))
		{
			// An unparseable declaration is treated as no declaration: the
			// command falls back to the undeclared (world) class.
			Declared.Reset();
		}
		Class.Class = HaybaMCPAccess::ClassifyPythonRun(
			FHaybaMCPPythonHandler::IsReadOnlyScriptForAccess(Script),
			bWorldPartition || HaybaMCPAccess::ScriptTouchesWorldPartition(Script),
			Declared.Num() > 0);
	}

	if (Declared.Num() == 0)
	{
		// An asset writer names its asset in its own request; lock that asset
		// instead of only intending the world.
		HaybaMCPAccess::FClaim Implied;
		if (HaybaMCPAccess::ImpliedAssetClaim(Cmd, Params, Implied))
		{
			Declared.Add(MoveTemp(Implied));
		}
	}

	const FString World = CurrentWorldPackage();
	const TArray<HaybaMCPAccess::FLock> Required = HaybaMCPAccess::RequiredLocks(Class.Class, Declared, World);

	FString TokenProblem;
	if (CurrentContext && !CurrentContext->LeaseToken.IsEmpty() && !LeaseTable.FindLease(CurrentContext->LeaseToken))
	{
		TokenProblem = TEXT("the envelope's lease token is unknown or expired");
	}

	FString ConflictDetail;
	const FString Owner = EffectiveOwner();
	const HaybaMCPLease::FLease* Holder = LeaseTable.FindConflictingHolder(Owner, Required, &ConflictDetail);
	if (!Holder && TokenProblem.IsEmpty())
	{
		return Verdict;
	}

	TSharedPtr<FJsonObject> Detail = MakeShared<FJsonObject>();
	Detail->SetStringField(TEXT("enforcement"), Mode == EHaybaMCPLeaseEnforcement::Enforced ? TEXT("enforced") : TEXT("advisory"));
	Detail->SetStringField(TEXT("command"), Cmd);
	Detail->SetStringField(TEXT("access_class"), HaybaMCPAccess::LexAccessClass(Class.Class));
	Detail->SetStringField(TEXT("caller_owner"), Owner);
	if (!ClaimError.IsEmpty())
	{
		Detail->SetStringField(TEXT("resources_error"), ClaimError);
	}
	if (Holder)
	{
		// Never the holder's token: a token in the envelope acts as its owner.
		Detail->SetStringField(TEXT("holder_owner"), Holder->Owner);
		if (!Holder->Label.IsEmpty()) Detail->SetStringField(TEXT("holder_label"), Holder->Label);
		Detail->SetNumberField(TEXT("holder_expires_in_s"),
			FMath::Max(0.0, Holder->ExpiresAt - FPlatformTime::Seconds()));
		Detail->SetStringField(TEXT("conflict"), ConflictDetail);
	}
	if (!TokenProblem.IsEmpty())
	{
		Detail->SetStringField(TEXT("lease_token"), TokenProblem);
	}
	Detail->SetStringField(TEXT("hint"),
		TEXT("Call lease_acquire for the resources this command needs; it answers granted or queued (with position and ETA) "
			 "and never blocks. lease_status shows every holder."));

	Verdict.Detail = Detail;
	Verdict.Message = Holder
		? FString::Printf(TEXT("lease_conflict: '%s' (%s) conflicts with a lease held by '%s' (%s)"),
			*Cmd, HaybaMCPAccess::LexAccessClass(Class.Class), *Holder->Owner, *ConflictDetail)
		: FString::Printf(TEXT("lease_conflict: '%s': %s"), *Cmd, *TokenProblem);
	if (Mode == EHaybaMCPLeaseEnforcement::Enforced)
	{
		Verdict.bRefuse = true;
	}
	else if (CurrentContext)
	{
		CurrentContext->LeaseWarning = Detail;
		UE_LOG(LogHaybaMCPLease, Warning, TEXT("[advisory] %s"), *Verdict.Message);
	}
	return Verdict;
}
