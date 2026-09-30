#pragma once

#include "CoreMinimal.h"
#include "HaybaMCPAccessPolicy.h"
#include "Misc/SecureHash.h"

/**
 * Pure lease table: who holds which resources, who is waiting, and in what
 * order waiters are served. No sockets, no GEditor, no real clock: time is
 * injected, so every expiry, aging and fairness edge case is deterministic
 * in Hayba.MCP.Lease.* tests.
 *
 * The table never blocks. Acquire answers "granted" (with a lease_id) or
 * "queued" (with a ticket, position, the blocking holder and an ETA); the
 * caller polls by calling Acquire again with its ticket. The game thread is
 * never parked waiting for a lease. See docs/adr/0010.
 */
namespace HaybaMCPLease
{
	using HaybaMCPAccess::FClaim;
	using HaybaMCPAccess::FLock;

	/**
	 * Interactive: short edits an agent is waiting on right now.
	 * Long: bulk work (region loads, big saves) that tolerates waiting.
	 * Interactive waiters are served ahead of long ones, but a long waiter
	 * that has been overtaken AgingGrants times, or has waited AgingSeconds,
	 * is aged: nothing enqueued after it may overtake it any more.
	 */
	enum class ELane : uint8
	{
		Interactive,
		Long,
	};

	struct FTuning
	{
		double DefaultTtlSeconds = 120.0;
		double MinTtlSeconds = 5.0;
		double MaxTtlSeconds = 900.0;
		/** A waiter that has not polled for this long is dropped, so a crashed
		 *  agent's ticket cannot hold the queue forever. */
		double WaiterTtlSeconds = 30.0;
		int32 AgingGrants = 3;
		double AgingSeconds = 60.0;
		int32 MaxWaiters = 64;
		int32 MaxLeasesPerOwner = 16;
		/** A lease granted while a batch lease yields at a fence lives at most
		 *  this long from its grant, renewals included, so a batch parked at a
		 *  fence always gets its resources back. */
		double FenceGrantMaxSeconds = 30.0;
	};

	struct FRequest
	{
		FString Owner;
		TArray<FClaim> Claims;
		/** 0 = default TTL. Clamped to [MinTtlSeconds, MaxTtlSeconds]. */
		double TtlSeconds = 0.0;
		ELane Lane = ELane::Interactive;
		/** Connection the lease dies with (bind_connection). 0 = unbound. */
		int32 ConnId = 0;
		/** A ticket from an earlier Queued answer; empty for a new request. */
		FString Ticket;
		FString Label;
	};

	struct FLease
	{
		FString Token;
		FString Owner;
		FString Label;
		TArray<FClaim> Claims;
		TArray<FLock> Locks;
		double GrantedAt = 0.0;
		double ExpiresAt = 0.0;
		int32 ConnId = 0;
		ELane Lane = ELane::Interactive;
		/** Held by a running editor_batch: it may yield at the batch's fences. */
		bool bYieldable = false;
		/** While yielding at a fence: waiters with Seq <= YieldSeq that are
		 *  interactive (or aged) are not blocked by this lease. 0 = not yielding. */
		int64 YieldSeq = 0;
		/** Token of the yielding lease this one was granted under, if any. */
		FString FenceOf;

		bool IsYielding() const { return YieldSeq > 0; }
	};

	struct FWaiter
	{
		FString Ticket;
		FRequest Request;
		TArray<FLock> Locks;
		double EnqueuedAt = 0.0;
		double LastPolledAt = 0.0;
		int64 Seq = 0;
		/** How many conflicting later requests were granted ahead of it. */
		int32 Bypassed = 0;
	};

	enum class EStatus : uint8
	{
		Granted,
		Queued,
		Rejected,
	};

	struct FAcquireResult
	{
		EStatus Status = EStatus::Rejected;
		/** Lease token when Granted, waiter ticket when Queued. */
		FString Token;
		double ExpiresAt = 0.0;
		/** 1-based place among the waiters that must go first. */
		int32 Position = 0;
		FString HolderOwner;
		FString HolderToken;
		/** Seconds until the blocking holders' leases lapse; -1 if unknown. */
		double EtaSeconds = -1.0;
		FString ConflictDetail;
		FString Error;
	};

	/** One exclusive asset lock and the lease that holds it (a build marking
	 *  its asset busy, D5). `Lease` points into the table and is valid only
	 *  until the next call on the table; copy what you need at once. */
	struct FAssetHold
	{
		/** The lock key, lower-cased: "asset:/game/…". */
		FString AssetKey;
		const FLease* Lease = nullptr;
	};

	/** Only the owner that proposed a plan may spend its approval. A plan
	 *  proposed with no owner (a pre-lease client) keeps the old global rule. */
	inline bool PlanApprovalApplies(bool bApproved, const FString& PlanOwner, const FString& CallerOwner)
	{
		return bApproved && (PlanOwner.IsEmpty() || PlanOwner == CallerOwner);
	}

	/** A value one of the redaction layers wrote in place of a secret-shaped
	 *  one, e.g. "[REDACTED:token]". It can never name a lease. */
	inline bool IsRedactionMarker(const FString& Value)
	{
		return Value.StartsWith(TEXT("[REDACTED:"), ESearchCase::CaseSensitive);
	}

	/** How a request named a lease: under its canonical param (lease_id)
	 *  and/or an alias (lease_renew's deprecated `token`, editor_batch's `lease`). */
	enum class EIdParam : uint8
	{
		None,
		Value,
		Ambiguous,
		RedactionMarker,
	};

	struct FIdParam
	{
		EIdParam Kind = EIdParam::None;
		FString Value;
		/** The value came from the alias because the canonical param was empty. */
		bool bFromAlias = false;
	};

	/** The canonical value wins; the alias fills an empty canonical. Two
	 *  different non-empty values are Ambiguous; a marker is RedactionMarker
	 *  (Value and bFromAlias still say where it came from). */
	inline FIdParam ResolveIdParam(const FString& Canonical, const FString& Alias)
	{
		const FString C = Canonical.TrimStartAndEnd();
		const FString A = Alias.TrimStartAndEnd();
		FIdParam Out;
		if (C.IsEmpty() && A.IsEmpty())
		{
			return Out;
		}
		if (!C.IsEmpty() && !A.IsEmpty() && C != A)
		{
			Out.Kind = EIdParam::Ambiguous;
			return Out;
		}
		Out.bFromAlias = C.IsEmpty();
		Out.Value = Out.bFromAlias ? A : C;
		Out.Kind = IsRedactionMarker(Out.Value) ? EIdParam::RedactionMarker : EIdParam::Value;
		return Out;
	}

	/**
	 * Remembers which keys already happened once, up to MaxKeys. Used for
	 * once-per-session log lines whose key includes a caller-controlled owner:
	 * raw per-call clients get a new conn:<n> on every call, so the set must be
	 * bounded (R-9). Once full, nothing new is reported.
	 */
	class FOncePerKey
	{
	public:
		explicit FOncePerKey(int32 InMaxKeys = 512)
			: MaxKeys(InMaxKeys)
		{
		}

		/** True the first time a key is seen while there is room. */
		bool First(const FString& Key)
		{
			if (Seen.Contains(Key) || Seen.Num() >= MaxKeys)
			{
				return false;
			}
			Seen.Add(Key);
			return true;
		}

		int32 Num() const { return Seen.Num(); }

	private:
		int32 MaxKeys;
		TSet<FString> Seen;
	};

	class FTable
	{
	public:
		explicit FTable(TFunction<double()> InClock, FTuning InTuning = FTuning(), FString InTokenSalt = FString())
			: Clock(MoveTemp(InClock))
			, Tuning(InTuning)
			, TokenSalt(MoveTemp(InTokenSalt))
		{
		}

		const FTuning& GetTuning() const { return Tuning; }
		const TArray<FLease>& GetLeases() const { return Leases; }
		const TArray<FWaiter>& GetWaiters() const { return Waiters; }

		double ClampTtl(double Requested) const
		{
			if (!FMath::IsFinite(Requested) || Requested <= 0.0) return Tuning.DefaultTtlSeconds;
			return FMath::Clamp(Requested, Tuning.MinTtlSeconds, Tuning.MaxTtlSeconds);
		}

		/** Drop lapsed leases and abandoned waiters. Every entry point calls it. */
		void Expire()
		{
			const double Now = Clock();
			Leases.RemoveAll([Now](const FLease& L) { return L.ExpiresAt <= Now; });
			const double WaiterTtl = Tuning.WaiterTtlSeconds;
			Waiters.RemoveAll([Now, WaiterTtl](const FWaiter& W) { return Now - W.LastPolledAt > WaiterTtl; });
		}

		/** Never blocks: grant now, or enqueue / keep queued and say why. */
		FAcquireResult Acquire(const FRequest& Request)
		{
			Expire();
			const double Now = Clock();
			FAcquireResult Result;
			if (Request.Owner.IsEmpty())
			{
				Result.Error = TEXT("owner is required");
				return Result;
			}

			int32 WaiterIndex = INDEX_NONE;
			if (!Request.Ticket.IsEmpty())
			{
				WaiterIndex = Waiters.IndexOfByPredicate([&Request](const FWaiter& W)
				{
					return W.Ticket == Request.Ticket && W.Request.Owner == Request.Owner;
				});
				if (WaiterIndex == INDEX_NONE)
				{
					Result.Error = TEXT("unknown or expired ticket; request the lease again");
					return Result;
				}
				Waiters[WaiterIndex].LastPolledAt = Now;
			}
			else
			{
				if (Request.Claims.Num() == 0)
				{
					Result.Error = TEXT("at least one resource is required");
					return Result;
				}
				const int32 Held = Leases.FilterByPredicate(
					[&Request](const FLease& L) { return L.Owner == Request.Owner; }).Num();
				if (Held >= Tuning.MaxLeasesPerOwner)
				{
					Result.Error = FString::Printf(TEXT("owner already holds %d leases (limit %d)"),
						Held, Tuning.MaxLeasesPerOwner);
					return Result;
				}
				if (Waiters.Num() >= Tuning.MaxWaiters)
				{
					Result.Error = FString::Printf(TEXT("lease queue is full (%d waiters)"), Tuning.MaxWaiters);
					return Result;
				}
				FWaiter Waiter;
				Waiter.Seq = ++Sequence;
				Waiter.Ticket = MakeId(TEXT("lq"), Waiter.Seq);
				Waiter.Request = Request;
				Waiter.Locks = HaybaMCPAccess::ExpandClaims(Request.Claims);
				Waiter.EnqueuedAt = Now;
				Waiter.LastPolledAt = Now;
				WaiterIndex = Waiters.Add(MoveTemp(Waiter));
			}

			const FWaiter& Candidate = Waiters[WaiterIndex];

			// 1. A conflicting holder (another owner) blocks outright, unless it
			//    is a batch lease yielding at a fence and this request is one the
			//    fence serves (queued before the fence opened, interactive or aged).
			double LatestHolderExpiry = -1.0;
			const FLease* Blocker = nullptr;
			FString FenceOf;
			for (const FLease& L : Leases)
			{
				FString Detail;
				if (L.Owner != Candidate.Request.Owner
					&& HaybaMCPAccess::FindConflict(Candidate.Locks, L.Locks, &Detail))
				{
					if (FenceServes(L, Candidate, Now))
					{
						if (FenceOf.IsEmpty()) FenceOf = L.Token;
						continue;
					}
					if (!Blocker)
					{
						Blocker = &L;
						Result.ConflictDetail = Detail;
						if (L.bYieldable)
						{
							Result.ConflictDetail += TEXT(" (held by a running editor_batch: interactive requests are granted at its next fence)");
						}
					}
					LatestHolderExpiry = FMath::Max(LatestHolderExpiry, L.ExpiresAt);
				}
			}

			// 2. So does a conflicting waiter that ranks ahead of it.
			const FWaiter* AheadBlocker = nullptr;
			int32 Ahead = 0;
			for (const FWaiter& Other : Waiters)
			{
				if (&Other == &Candidate || Other.Request.Owner == Candidate.Request.Owner) continue;
				if (Ranks(Other, Now) < Ranks(Candidate, Now)
					&& HaybaMCPAccess::FindConflict(Candidate.Locks, Other.Locks))
				{
					++Ahead;
					if (!AheadBlocker) AheadBlocker = &Other;
				}
			}

			if (!Blocker && !AheadBlocker)
			{
				return Grant(WaiterIndex, Now, FenceOf);
			}

			Result.Status = EStatus::Queued;
			Result.Token = Candidate.Ticket;
			Result.Position = Ahead + 1;
			if (Blocker)
			{
				Result.HolderOwner = Blocker->Owner;
				Result.HolderToken = Blocker->Token;
				// A batch lease is renewed while it runs, so its expiry says
				// nothing; its next fence is the real ETA and that is unknown.
				Result.EtaSeconds = Blocker->bYieldable ? -1.0 : FMath::Max(0.0, LatestHolderExpiry - Now);
			}
			else
			{
				Result.HolderOwner = AheadBlocker->Request.Owner;
				Result.ConflictDetail = TEXT("an earlier conflicting request is queued ahead");
			}
			return Result;
		}

		bool Renew(const FString& Token, const FString& Owner, double TtlSeconds, double& OutExpiresAt, FString& OutError)
		{
			Expire();
			FLease* Lease = Leases.FindByPredicate([&Token](const FLease& L) { return L.Token == Token; });
			if (!Lease)
			{
				OutError = TEXT("unknown or expired lease");
				return false;
			}
			if (Lease->Owner != Owner)
			{
				OutError = FString::Printf(TEXT("lease belongs to '%s'"), *Lease->Owner);
				return false;
			}
			Lease->ExpiresAt = Clock() + ClampTtl(TtlSeconds);
			if (!Lease->FenceOf.IsEmpty())
			{
				Lease->ExpiresAt = FMath::Min(Lease->ExpiresAt, Lease->GrantedAt + Tuning.FenceGrantMaxSeconds);
			}
			OutExpiresAt = Lease->ExpiresAt;
			return true;
		}

		/** Release a lease, or withdraw a queued ticket. */
		bool Release(const FString& TokenOrTicket, const FString& Owner, FString& OutError)
		{
			Expire();
			const int32 LeaseIndex = Leases.IndexOfByPredicate(
				[&TokenOrTicket](const FLease& L) { return L.Token == TokenOrTicket; });
			if (LeaseIndex != INDEX_NONE)
			{
				if (Leases[LeaseIndex].Owner != Owner)
				{
					OutError = FString::Printf(TEXT("lease belongs to '%s'"), *Leases[LeaseIndex].Owner);
					return false;
				}
				Leases.RemoveAt(LeaseIndex);
				return true;
			}
			const int32 WaiterIndex = Waiters.IndexOfByPredicate(
				[&TokenOrTicket](const FWaiter& W) { return W.Ticket == TokenOrTicket; });
			if (WaiterIndex != INDEX_NONE)
			{
				if (Waiters[WaiterIndex].Request.Owner != Owner)
				{
					OutError = FString::Printf(TEXT("ticket belongs to '%s'"), *Waiters[WaiterIndex].Request.Owner);
					return false;
				}
				Waiters.RemoveAt(WaiterIndex);
				return true;
			}
			OutError = TEXT("unknown or expired lease");
			return false;
		}

		/** bind_connection: everything a closed connection held or queued goes. */
		int32 ReleaseConnection(int32 ConnId)
		{
			if (ConnId == 0) return 0;
			const int32 Before = Leases.Num() + Waiters.Num();
			Leases.RemoveAll([ConnId](const FLease& L) { return L.ConnId == ConnId; });
			Waiters.RemoveAll([ConnId](const FWaiter& W) { return W.Request.ConnId == ConnId; });
			return Before - Leases.Num() - Waiters.Num();
		}

		/** The first lease of ANOTHER owner that conflicts with `Required`. */
		const FLease* FindConflictingHolder(const FString& Owner, const TArray<FLock>& Required, FString* OutDetail = nullptr)
		{
			Expire();
			if (Required.Num() == 0) return nullptr;
			for (const FLease& L : Leases)
			{
				if (L.Owner != Owner && HaybaMCPAccess::FindConflict(Required, L.Locks, OutDetail))
				{
					// A batch parked at a fence does not run; the owner it let in
					// works under a lease granted at that fence.
					if (L.IsYielding() && OwnerHoldsFenceGrantOf(Owner, L.Token))
					{
						continue;
					}
					return &L;
				}
			}
			return nullptr;
		}

		/**
		 * Exclusive asset locks, one entry per asset per lease. This is what
		 * asset_busy and editor_get_state.building report. It expires lapsed
		 * leases first. An empty ExcludeOwner excludes nobody. An empty AssetKey
		 * matches any asset; otherwise only that key matches, ignoring case.
		 * Shared asset locks, intent locks and world or global locks are not
		 * builds and never appear.
		 */
		TArray<FAssetHold> FindAssetHolders(const FString& ExcludeOwner, const FString& AssetKey = FString())
		{
			Expire();
			TArray<FAssetHold> Out;
			for (const FLease& L : Leases)
			{
				if (!ExcludeOwner.IsEmpty() && L.Owner == ExcludeOwner)
				{
					continue;
				}
				for (const FLock& Lock : L.Locks)
				{
					if (Lock.Mode != HaybaMCPAccess::ELockMode::Exclusive || !Lock.Key.StartsWith(TEXT("asset:")))
					{
						continue;
					}
					if (!AssetKey.IsEmpty() && !Lock.Key.Equals(AssetKey, ESearchCase::IgnoreCase))
					{
						continue;
					}
					FAssetHold Hold;
					Hold.AssetKey = Lock.Key;
					Hold.Lease = &L;
					Out.Add(MoveTemp(Hold));
				}
			}
			return Out;
		}

		// ---------------------------------------------------------------------
		// Fences (editor_batch). A batch holds its lease across many steps. At
		// a fence it may yield, so queued interactive work is granted, and then
		// it takes the resources back. See docs/adr/0010, "Fair queue at fences".
		// ---------------------------------------------------------------------

		/** Mark a lease as held by a running batch (true) or not (false). */
		bool SetYieldable(const FString& Token, bool bYieldable)
		{
			Expire();
			FLease* Lease = FindMutable(Token);
			if (!Lease) return false;
			Lease->bYieldable = bYieldable;
			if (!bYieldable) Lease->YieldSeq = 0;
			return true;
		}

		/** True when a waiter of another owner that a fence would serve
		 *  (interactive, or an aged long waiter) is blocked by this lease. */
		bool HasEligibleWaiterBlockedBy(const FString& Token)
		{
			Expire();
			const FLease* Lease = Leases.FindByPredicate([&Token](const FLease& L) { return L.Token == Token; });
			if (!Lease) return false;
			const double Now = Clock();
			for (const FWaiter& W : Waiters)
			{
				if (W.Request.Owner != Lease->Owner && IsFenceEligible(W, Now)
					&& HaybaMCPAccess::FindConflict(W.Locks, Lease->Locks))
				{
					return true;
				}
			}
			return false;
		}

		/** Open a fence: waiters already queued may be granted past this lease. */
		bool BeginYield(const FString& Token)
		{
			Expire();
			FLease* Lease = FindMutable(Token);
			if (!Lease || !Lease->bYieldable) return false;
			Lease->YieldSeq = FMath::Max<int64>(Sequence, 1);
			return true;
		}

		/** Close the fence. Leases granted at it keep running until released or
		 *  capped by FenceGrantMaxSeconds; the batch waits for them first. */
		void EndYield(const FString& Token)
		{
			Expire();
			if (FLease* Lease = FindMutable(Token))
			{
				Lease->YieldSeq = 0;
			}
		}

		/** Leases still held that were granted at this lease's fence. */
		int32 CountFenceGrants(const FString& Token)
		{
			Expire();
			int32 Count = 0;
			for (const FLease& L : Leases)
			{
				if (L.FenceOf == Token) ++Count;
			}
			return Count;
		}

		/** True when `Owner` holds an exclusive lease on `Key` or on global. */
		bool OwnerHoldsExclusive(const FString& Owner, const FString& Key)
		{
			Expire();
			for (const FLease& L : Leases)
			{
				if (L.Owner == Owner && HaybaMCPAccess::HoldsExclusiveOn(L.Locks, Key))
				{
					return true;
				}
			}
			return false;
		}

		const FLease* FindLease(const FString& Token)
		{
			Expire();
			return Leases.FindByPredicate([&Token](const FLease& L) { return L.Token == Token; });
		}

		bool IsAged(const FWaiter& W, double Now) const
		{
			return W.Request.Lane == ELane::Long
				&& (W.Bypassed >= Tuning.AgingGrants || Now - W.EnqueuedAt >= Tuning.AgingSeconds);
		}

	private:
		FLease* FindMutable(const FString& Token)
		{
			return Leases.FindByPredicate([&Token](const FLease& L) { return L.Token == Token; });
		}

		bool IsFenceEligible(const FWaiter& W, double Now) const
		{
			return W.Request.Lane == ELane::Interactive || IsAged(W, Now);
		}

		/** A yielding lease lets through the waiters its fence serves. */
		bool FenceServes(const FLease& L, const FWaiter& Candidate, double Now) const
		{
			return L.IsYielding() && Candidate.Seq <= L.YieldSeq && IsFenceEligible(Candidate, Now);
		}

		bool OwnerHoldsFenceGrantOf(const FString& Owner, const FString& Token) const
		{
			for (const FLease& L : Leases)
			{
				if (L.Owner == Owner && L.FenceOf == Token) return true;
			}
			return false;
		}

		/** Lower ranks are served first: interactive-or-aged before long, then
		 *  by arrival. */
		int64 Ranks(const FWaiter& W, double Now) const
		{
			const int64 Lane = (W.Request.Lane == ELane::Interactive || IsAged(W, Now)) ? 0 : 1;
			return (Lane << 48) + W.Seq;
		}

		FAcquireResult Grant(int32 WaiterIndex, double Now, const FString& FenceOf = FString())
		{
			FWaiter Waiter = MoveTemp(Waiters[WaiterIndex]);
			Waiters.RemoveAt(WaiterIndex);

			// Every conflicting waiter that arrived earlier has just been overtaken.
			for (FWaiter& Other : Waiters)
			{
				if (Other.Seq < Waiter.Seq && Other.Request.Owner != Waiter.Request.Owner
					&& HaybaMCPAccess::FindConflict(Waiter.Locks, Other.Locks))
				{
					++Other.Bypassed;
				}
			}

			FLease Lease;
			Lease.Token = MakeId(TEXT("ls"), Waiter.Seq);
			Lease.Owner = Waiter.Request.Owner;
			Lease.Label = Waiter.Request.Label;
			Lease.Claims = Waiter.Request.Claims;
			Lease.Locks = MoveTemp(Waiter.Locks);
			Lease.GrantedAt = Now;
			Lease.ExpiresAt = Now + ClampTtl(Waiter.Request.TtlSeconds);
			Lease.ConnId = Waiter.Request.ConnId;
			Lease.Lane = Waiter.Request.Lane;
			Lease.FenceOf = FenceOf;
			if (!FenceOf.IsEmpty())
			{
				Lease.ExpiresAt = FMath::Min(Lease.ExpiresAt, Now + Tuning.FenceGrantMaxSeconds);
			}

			FAcquireResult Result;
			Result.Status = EStatus::Granted;
			Result.Token = Lease.Token;
			Result.ExpiresAt = Lease.ExpiresAt;
			Leases.Add(MoveTemp(Lease));
			return Result;
		}

		/**
		 * ls_<seq>_<mac12> for leases, lq_<seq>_<mac12> for tickets. mac12 is the
		 * first 12 lower hex of HMAC-SHA1(key = session salt, "<prefix>:<seq>"),
		 * so an id reveals neither the salt nor any other holder's id. Only
		 * [a-z0-9_]: no redaction rule in either layer matches it (ADR-0010,
		 * "Lease ids"). An empty salt (pure tests) gives <prefix>_<seq>.
		 */
		FString MakeId(const TCHAR* Prefix, int64 Seq) const
		{
			if (TokenSalt.IsEmpty())
			{
				return FString::Printf(TEXT("%s_%lld"), Prefix, Seq);
			}
			const FString Message = FString::Printf(TEXT("%s:%lld"), Prefix, Seq);
			const FTCHARToUTF8 Key(*TokenSalt);
			const FTCHARToUTF8 Data(*Message);
			uint8 Hash[FSHA1::DigestSize];
			FSHA1::HMACBuffer(Key.Get(), Key.Length(), Data.Get(), Data.Length(), Hash);
			return FString::Printf(TEXT("%s_%lld_%s"), Prefix, Seq, *BytesToHexLower(Hash, 6));
		}

		TFunction<double()> Clock;
		FTuning Tuning;
		FString TokenSalt;
		TArray<FLease> Leases;
		TArray<FWaiter> Waiters;
		int64 Sequence = 0;
	};
}
