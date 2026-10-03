#pragma once

#include "CoreMinimal.h"
#include "HaybaMCPAccessPolicy.h"

/**
 * Pure lease-enforcement policy (T6/T8, docs/adr/0010): whether one command
 * runs, runs with a lease_warning, or is refused, from facts the caller has
 * already gathered. No GEditor, no settings, no sockets; time is injected into
 * FOwnerPresence, so every case is deterministic in Hayba.MCP.Lease.* tests.
 */
namespace HaybaMCPEnforcement
{
	enum class EMode : uint8
	{
		Off,
		Advisory,
		EnforcedForWrites,
		Enforced,
	};

	inline const TCHAR* LexMode(EMode Mode)
	{
		switch (Mode)
		{
		case EMode::Off:               return TEXT("off");
		case EMode::Advisory:          return TEXT("advisory");
		case EMode::EnforcedForWrites: return TEXT("enforced_for_writes");
		case EMode::Enforced:          return TEXT("enforced");
		}
		return TEXT("unknown");
	}

	/** What the envelope `lease` handle resolved to. A redaction marker counts
	 *  as None (R5): it names no lease. */
	enum class EHandle : uint8
	{
		None,
		Valid,
		Unknown,
	};

	enum class EReason : uint8
	{
		None,
		Held,
		LeaseUnknown,
		OwnerMissing,
	};

	inline const TCHAR* LexReason(EReason Reason)
	{
		switch (Reason)
		{
		case EReason::None:         return TEXT("");
		case EReason::Held:         return TEXT("held");
		case EReason::LeaseUnknown: return TEXT("lease_unknown");
		case EReason::OwnerMissing: return TEXT("owner_missing");
		}
		return TEXT("");
	}

	enum class EVerdict : uint8
	{
		Allow,
		Warn,
		Refuse,
	};

	struct FFacts
	{
		EMode Mode = EMode::Advisory;
		HaybaMCPAccess::EAccessClass Class = HaybaMCPAccess::EAccessClass::Read;
		/** The caller named itself in the envelope `owner`. */
		bool bOwnerFromEnvelope = false;
		EHandle Handle = EHandle::None;
		/** ConnId 0: an in-process caller (a batch step, a test, the editor UI). */
		bool bInProcess = false;
		/** Another owner holds a lease that conflicts with this command's locks. */
		bool bHeldConflict = false;
		/** Identified owners other than the caller, active now. */
		int32 OtherActiveOwners = 0;
	};

	struct FDecision
	{
		EVerdict Verdict = EVerdict::Allow;
		EReason Reason = EReason::None;
		/** "lease_conflict" or "owner_required"; empty on Allow. */
		FString Code;
	};

	inline bool IsIdentified(const FFacts& Facts)
	{
		return Facts.bOwnerFromEnvelope || Facts.Handle == EHandle::Valid || Facts.bInProcess;
	}

	/**
	 * A write is any class other than Read. Precedence: OwnerMissing (an
	 * unidentified write while other owners are active), then LeaseUnknown,
	 * then Held.
	 *
	 *   Mode               Read                           Write
	 *   Off                allow                          allow
	 *   Advisory           warn on any reason             warn on any reason
	 *   EnforcedForWrites  warn on a dead handle only     refuse on any reason
	 *   Enforced           refuse on a dead handle        refuse on any reason
	 */
	inline FDecision Decide(const FFacts& Facts)
	{
		FDecision Out;
		if (Facts.Mode == EMode::Off)
		{
			return Out;
		}
		const bool bWrite = Facts.Class != HaybaMCPAccess::EAccessClass::Read;
		if (bWrite && !IsIdentified(Facts) && Facts.OtherActiveOwners > 0)
		{
			Out.Reason = EReason::OwnerMissing;
		}
		else if (Facts.Handle == EHandle::Unknown)
		{
			Out.Reason = EReason::LeaseUnknown;
		}
		else if (Facts.bHeldConflict)
		{
			Out.Reason = EReason::Held;
		}
		if (Out.Reason == EReason::None)
		{
			return Out;
		}

		switch (Facts.Mode)
		{
		case EMode::Advisory:
			Out.Verdict = EVerdict::Warn;
			break;
		case EMode::EnforcedForWrites:
			Out.Verdict = bWrite ? EVerdict::Refuse
				: (Out.Reason == EReason::LeaseUnknown ? EVerdict::Warn : EVerdict::Allow);
			break;
		case EMode::Enforced:
			Out.Verdict = (bWrite || Out.Reason == EReason::LeaseUnknown) ? EVerdict::Refuse : EVerdict::Allow;
			break;
		default:
			Out.Verdict = EVerdict::Allow;
			break;
		}
		if (Out.Verdict == EVerdict::Allow)
		{
			return FDecision();
		}
		Out.Code = Out.Reason == EReason::OwnerMissing ? TEXT("owner_required") : TEXT("lease_conflict");
		return Out;
	}

	constexpr int32 MaxOwnerChars = 128;

	/** Trim, replace control characters with '?', cap at MaxOwnerChars. */
	inline FString SanitizeOwner(const FString& Owner)
	{
		FString Out = Owner.TrimStartAndEnd();
		for (int32 Index = 0; Index < Out.Len(); ++Index)
		{
			if (FChar::IsControl(Out[Index]))
			{
				Out[Index] = TEXT('?');
			}
		}
		return Out.Left(MaxOwnerChars);
	}

	/**
	 * Which identified owners are connected. An owner is active while it has an
	 * open connection or was seen within SeenWindowSeconds. At most MaxOwners
	 * are tracked; a new owner evicts an inactive one first, then the
	 * longest-idle owner without a connection, then the longest-idle of all.
	 * Presence never extends a lease.
	 */
	class FOwnerPresence
	{
	public:
		explicit FOwnerPresence(TFunction<double()> InClock, double InSeenWindowSeconds = 60.0, int32 InMaxOwners = 256)
			: Clock(MoveTemp(InClock))
			, SeenWindowSeconds(InSeenWindowSeconds)
			, MaxOwners(FMath::Max(1, InMaxOwners))
		{
		}

		void Note(const FString& Owner, int32 ConnId)
		{
			if (Owner.IsEmpty())
			{
				return;
			}
			const double Now = Clock();
			if (!Owners.Contains(Owner) && Owners.Num() >= MaxOwners)
			{
				EvictOne(Now);
			}
			FEntry& Entry = Owners.FindOrAdd(Owner);
			Entry.LastSeen = Now;
			if (ConnId > 0)
			{
				Entry.Conns.Add(ConnId);
			}
		}

		void OnConnectionClosed(int32 ConnId)
		{
			if (ConnId <= 0)
			{
				return;
			}
			for (TPair<FString, FEntry>& Pair : Owners)
			{
				Pair.Value.Conns.Remove(ConnId);
			}
		}

		TArray<FString> ActiveOwners(const FString& Except = FString()) const
		{
			const double Now = Clock();
			TArray<FString> Out;
			for (const TPair<FString, FEntry>& Pair : Owners)
			{
				if (Pair.Key != Except && IsActive(Pair.Value, Now))
				{
					Out.Add(Pair.Key);
				}
			}
			Out.Sort();
			return Out;
		}

		void Forget(const FString& Owner)
		{
			Owners.Remove(Owner);
		}

		/** Forget everyone (tests: FHaybaMCPLeaseManager::ResetPresenceForTests). */
		void Reset()
		{
			Owners.Reset();
		}

		int32 NumTracked() const
		{
			return Owners.Num();
		}

	private:
		struct FEntry
		{
			double LastSeen = 0.0;
			TSet<int32> Conns;
		};

		bool IsActive(const FEntry& Entry, double Now) const
		{
			return Entry.Conns.Num() > 0 || Now - Entry.LastSeen <= SeenWindowSeconds;
		}

		void EvictOne(double Now)
		{
			FString Victim;
			double VictimSeen = 0.0;
			int32 VictimRank = MAX_int32;
			for (const TPair<FString, FEntry>& Pair : Owners)
			{
				const int32 Rank = !IsActive(Pair.Value, Now) ? 0 : (Pair.Value.Conns.Num() == 0 ? 1 : 2);
				if (Rank < VictimRank || (Rank == VictimRank && Pair.Value.LastSeen < VictimSeen))
				{
					Victim = Pair.Key;
					VictimSeen = Pair.Value.LastSeen;
					VictimRank = Rank;
				}
			}
			if (!Victim.IsEmpty())
			{
				Owners.Remove(Victim);
			}
		}

		TFunction<double()> Clock;
		double SeenWindowSeconds;
		int32 MaxOwners;
		TMap<FString, FEntry> Owners;
	};
}
