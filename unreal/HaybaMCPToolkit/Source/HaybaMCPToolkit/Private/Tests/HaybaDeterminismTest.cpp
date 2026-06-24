// HaybaDeterminismTest.cpp
// Automation test for FHaybaDeterminism::Unit.
//
// Self-pinning strategy: each golden assertion RE-COMPUTES the Knuth formula
// inline so any future arithmetic change to HaybaDeterminism.h causes a
// compile-time type-check failure OR a runtime value mismatch here — without
// requiring externally-captured literals.
//
// The inline recomputation is a verbatim copy of the formula; the test passes
// iff both sides produce identical IEEE-754 doubles.

#include "CoreMinimal.h"
#include "Misc/AutomationTest.h"
#include "pcg/HaybaDeterminism.h"

// ---------------------------------------------------------------------------
// Helper: inline Knuth formula, duplicated verbatim from HaybaDeterminism.h.
// If you change the header you MUST change this too — that is the point.
// ---------------------------------------------------------------------------
static double KnuthUnit_Inline(const FString& Kind, int32 IndexA, int32 IndexB)
{
	uint32 H = GetTypeHash(Kind);
	H ^= (uint32)IndexA * 2654435761u;
	H = (H << 13) | (H >> 19); // rotate to spread bits
	H ^= (uint32)IndexB * 2246822519u;
	return (double)(H & 0xFFFFFFu) / (double)0x1000000u;
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------
IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaDeterminismUnitTest,
	"Hayba.Determinism.Unit",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaDeterminismUnitTest::RunTest(const FString& Parameters)
{
	// --- 1. Range: all results must be in [0, 1) ----------------------------

	const TArray<TTuple<FString, int32, int32>> RangeCases = {
		MakeTuple(FString(TEXT("tunnel")),  0,      0),
		MakeTuple(FString(TEXT("tunnel")),  3,   7919),
		MakeTuple(FString(TEXT("native")),  1,    200),
		MakeTuple(FString(TEXT("room")),    7, 104729),
		MakeTuple(FString(TEXT("")),        0,      1),
	};

	for (const auto& C : RangeCases)
	{
		const double V = FHaybaDeterminism::Unit(C.Get<0>(), C.Get<1>(), C.Get<2>());
		TestTrue(FString::Printf(TEXT("range [0,1) for (%s,%d,%d)"),
			*C.Get<0>(), C.Get<1>(), C.Get<2>()),
			V >= 0.0 && V < 1.0);
	}

	// --- 2. Stability: same inputs → same output (pure function) ------------

	TestEqual(TEXT("stable tunnel/0/0"),
		FHaybaDeterminism::Unit(TEXT("tunnel"), 0, 0),
		FHaybaDeterminism::Unit(TEXT("tunnel"), 0, 0));

	TestEqual(TEXT("stable native/1/200"),
		FHaybaDeterminism::Unit(TEXT("native"), 1, 200),
		FHaybaDeterminism::Unit(TEXT("native"), 1, 200));

	TestEqual(TEXT("stable room/7/104729"),
		FHaybaDeterminism::Unit(TEXT("room"), 7, 104729),
		FHaybaDeterminism::Unit(TEXT("room"), 7, 104729));

	// --- 3. Self-pinning golden equality: header == inline recomputation ----
	//
	// Five tuples covering the four actual channel-salt families used by the
	// rubble scatter (yaw: i, pitch: i+7919, roll: i+104729, lateral: i+200).
	// If the header arithmetic ever drifts from the inline copy the test fails.

	// Tuple 0 — yaw channel salt (i = 0)
	{
		const FString K(TEXT("tunnel"));
		const int32 A = 0, B = 0;
		TestEqual(TEXT("golden: tunnel/0/0 == inline"),
			FHaybaDeterminism::Unit(K, A, B),
			KnuthUnit_Inline(K, A, B));
	}

	// Tuple 1 — pitch channel salt (i + 7919, i=3)
	{
		const FString K(TEXT("tunnel"));
		const int32 A = 3, B = 7919;
		TestEqual(TEXT("golden: tunnel/3/7919 == inline"),
			FHaybaDeterminism::Unit(K, A, B),
			KnuthUnit_Inline(K, A, B));
	}

	// Tuple 2 — roll channel salt (i + 104729, i=1)
	{
		const FString K(TEXT("tunnel"));
		const int32 A = 1, B = 104729;
		TestEqual(TEXT("golden: tunnel/1/104729 == inline"),
			FHaybaDeterminism::Unit(K, A, B),
			KnuthUnit_Inline(K, A, B));
	}

	// Tuple 3 — lateral channel salt (i + 200, i=5)
	{
		const FString K(TEXT("native"));
		const int32 A = 5, B = 200;
		TestEqual(TEXT("golden: native/5/200 == inline"),
			FHaybaDeterminism::Unit(K, A, B),
			KnuthUnit_Inline(K, A, B));
	}

	// Tuple 4 — different kind string to exercise GetTypeHash mixing
	{
		const FString K(TEXT("room"));
		const int32 A = 7, B = 104729;
		TestEqual(TEXT("golden: room/7/104729 == inline"),
			FHaybaDeterminism::Unit(K, A, B),
			KnuthUnit_Inline(K, A, B));
	}

	// --- 4. Distinctness: different inputs should (with high probability)
	//        produce different outputs.  Not a hard correctness guarantee,
	//        but a sanity-check that the hash is actually mixing. ------------

	TestNotEqual(TEXT("distinct: tunnel/0/0 != tunnel/0/1"),
		FHaybaDeterminism::Unit(TEXT("tunnel"), 0, 0),
		FHaybaDeterminism::Unit(TEXT("tunnel"), 0, 1));

	TestNotEqual(TEXT("distinct: tunnel/0/0 != native/0/0"),
		FHaybaDeterminism::Unit(TEXT("tunnel"), 0, 0),
		FHaybaDeterminism::Unit(TEXT("native"), 0, 0));

	return true;
}
