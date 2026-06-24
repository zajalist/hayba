#pragma once
#include "CoreMinimal.h"

/**
 * FHaybaDeterminism — deterministic jitter utilities.
 *
 * PIN VERBATIM — any change to Unit() reshuffles ALL scatter.
 * Knuth multiplicative hash: 2654435761 / 2246822519, rotate 13/19,
 * top-24-bit extraction.  NO FMath::Rand, no time dependency.
 *
 * Extracted from PCGGrammarSolver.cpp (anonymous-namespace DeterministicUnit,
 * lines 91-102) as part of Phase-0 Task 0.1.  The monolith now calls this
 * header; byte output is unchanged.
 */
struct FHaybaDeterminism
{
	/**
	 * Map (Kind, IndexA, IndexB) → [0, 1).
	 *
	 * Mixes the FString hash with two integers via Knuth's multiplicative hash
	 * so the result is stable across runs and platforms.
	 *
	 * Channel salts used by the rubble scatter:
	 *   yaw    → (SymbolKind, Index, i)
	 *   pitch  → (SymbolKind, Index, i + 7919)
	 *   roll   → (SymbolKind, Index, i + 104729)
	 *   lateral→ (SymbolKind, Index, i + 200)
	 */
	static double Unit(const FString& Kind, int32 IndexA, int32 IndexB)
	{
		uint32 H = GetTypeHash(Kind);
		H ^= (uint32)IndexA * 2654435761u;
		H = (H << 13) | (H >> 19); // rotate to spread bits
		H ^= (uint32)IndexB * 2246822519u;
		// Map to [0,1): use the top 24 bits for a stable fraction.
		return (double)(H & 0xFFFFFFu) / (double)0x1000000u;
	}
};
