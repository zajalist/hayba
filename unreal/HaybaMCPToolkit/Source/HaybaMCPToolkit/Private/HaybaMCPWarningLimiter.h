#pragma once

#include "CoreMinimal.h"
#include "Templates/Function.h"

/**
 * Pure per-key log rate limiter (P0 spec §3.0). Every refusal Warning from
 * Deploy A on goes through one of these: at most one line per key per window,
 * and the next line (or a drain) says how many identical lines it swallowed,
 * so a flood never hides a regression from the M2 count. The clock is
 * injected; the map holds at most MaxKeys keys, and a new key past capacity
 * shares the "<overflow>" window.
 */
class FWarningLimiter
{
public:
	static constexpr double DefaultWindowSeconds = 30.0;
	static constexpr int32 DefaultMaxKeys = 512;

	explicit FWarningLimiter(TFunction<double()> InClock, double InWindowSeconds = DefaultWindowSeconds, int32 InMaxKeys = DefaultMaxKeys)
		: Clock(MoveTemp(InClock))
		, WindowSeconds(InWindowSeconds)
		, MaxKeys(FMath::Max(2, InMaxKeys))
	{
	}

	struct FHit
	{
		/** First hit of this key in the current window: log it. */
		bool bLog = false;
		/** How many hits the key's previous window swallowed (only on a logging hit). */
		int32 SuppressedInPreviousWindow = 0;
		/** Hits in the current window so far, this one included. */
		int32 RepeatsInWindow = 0;
	};

	FHit Note(const FString& InKey)
	{
		const double Now = Clock();
		const FString* Key = &InKey;
		if (!Entries.Contains(InKey) && Entries.Num() >= MaxKeys - 1)
		{
			DropQuietClosedWindows(Now);
			if (Entries.Num() >= MaxKeys - 1) Key = &OverflowKey();
		}

		FHit Hit;
		FEntry* Entry = Entries.Find(*Key);
		if (!Entry)
		{
			FEntry& Added = Entries.Add(*Key);
			Added.WindowStart = Now;
			Added.Hits = 1;
			Hit.bLog = true;
			Hit.RepeatsInWindow = 1;
			return Hit;
		}
		if (Now - Entry->WindowStart >= WindowSeconds)
		{
			Hit.bLog = true;
			Hit.SuppressedInPreviousWindow = Entry->Suppressed;
			Hit.RepeatsInWindow = 1;
			Entry->WindowStart = Now;
			Entry->Suppressed = 0;
			Entry->Hits = 1;
			return Hit;
		}
		++Entry->Hits;
		++Entry->Suppressed;
		Hit.RepeatsInWindow = Entry->Hits;
		return Hit;
	}

	struct FDrained
	{
		FString Key;
		int32 Suppressed = 0;
	};

	/** Closed windows that swallowed something, sorted by key. Every closed window is forgotten. */
	TArray<FDrained> DrainExpired()
	{
		const double Now = Clock();
		TArray<FDrained> Out;
		for (auto It = Entries.CreateIterator(); It; ++It)
		{
			if (Now - It.Value().WindowStart < WindowSeconds) continue;
			if (It.Value().Suppressed > 0)
			{
				FDrained& Drained = Out.AddDefaulted_GetRef();
				Drained.Key = It.Key();
				Drained.Suppressed = It.Value().Suppressed;
			}
			It.RemoveCurrent();
		}
		Out.Sort([](const FDrained& A, const FDrained& B) { return A.Key < B.Key; });
		return Out;
	}

	/** "conn:<digits>" -> "conn:*": one-connection-per-call clients must not mint a key per call (R-9). */
	static FString CollapseOwner(const FString& Owner)
	{
		static const FString Prefix = TEXT("conn:");
		if (!Owner.StartsWith(Prefix) || Owner.Len() == Prefix.Len()) return Owner;
		for (int32 I = Prefix.Len(); I < Owner.Len(); ++I)
		{
			if (!FChar::IsDigit(Owner[I])) return Owner;
		}
		return TEXT("conn:*");
	}

	/** "Domain|Code|Owner|Cmd|Extra", owner collapsed, '|' inside a part replaced by '/'. */
	static FString MakeKey(const FString& Domain, const FString& Code, const FString& Owner, const FString& Cmd, const FString& Extra = FString())
	{
		auto Part = [](const FString& Value) { return Value.Replace(TEXT("|"), TEXT("/")); };
		return FString::Join(TArray<FString>{ Part(Domain), Part(Code), Part(CollapseOwner(Owner)), Part(Cmd), Part(Extra) }, TEXT("|"));
	}

	/** The pinned next-window suffix: " (+N identical in the previous 30 s)", empty for 0. */
	static FString PreviousWindowSuffix(int32 Suppressed, double InWindowSeconds = DefaultWindowSeconds)
	{
		return Suppressed > 0
			? FString::Printf(TEXT(" (+%d identical in the previous %.0f s)"), Suppressed, InWindowSeconds)
			: FString();
	}

	/** The pinned drained-line tail: " repeated N more times in 30 s". */
	static FString RepeatedMoreTimes(int32 Suppressed, double InWindowSeconds = DefaultWindowSeconds)
	{
		return FString::Printf(TEXT(" repeated %d more times in %.0f s"), Suppressed, InWindowSeconds);
	}

	int32 NumKeys() const { return Entries.Num(); }

private:
	struct FEntry
	{
		double WindowStart = 0.0;
		int32 Hits = 0;
		int32 Suppressed = 0;
	};

	static const FString& OverflowKey()
	{
		static const FString Key = TEXT("<overflow>");
		return Key;
	}

	/** At capacity: forget closed windows that swallowed nothing (nothing to report is lost). */
	void DropQuietClosedWindows(double Now)
	{
		for (auto It = Entries.CreateIterator(); It; ++It)
		{
			if (Now - It.Value().WindowStart >= WindowSeconds && It.Value().Suppressed == 0) It.RemoveCurrent();
		}
	}

	TFunction<double()> Clock;
	double WindowSeconds;
	int32 MaxKeys;
	TMap<FString, FEntry> Entries;
};
