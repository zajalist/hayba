// HaybaPlumbEnumsSelfCheck.cpp
//
// Load-time self-check: asserts at compile time that the generated enum mirror
// has exactly the expected cardinality, and at runtime that the string id tables
// match the enum counts.
//
// "Plumb is the single rule authority." No C++ node may reference an emit kind,
// a 14th primitive, a junction type, or a gate not defined in the TS contracts.
//
// This TU is PURELY ADDITIVE — no production code is modified.
// The static_asserts fail the BUILD if someone hand-edits the generated header
// or regenerates it from a drifted TS source.

#include "pcg/HaybaPlumbEnums.generated-mirror.h"

// Compile-time cardinality guards.
// EHaybaPrimitive: 13 entries (indices 0..12), last = MaxStraightRun
static_assert((int)EHaybaPrimitive::MaxStraightRun == 12,
    "PRIMITIVES drifted: expected 13 entries (0..12). "
    "Regenerate via: cd D:/Hackathons/hayba/mcp-tools/hayba-mcp && npm run gen:plumb-enums");

// EHaybaEmitOp: 6 entries (indices 0..5), last = Fill
static_assert((int)EHaybaEmitOp::Fill == 5,
    "EmitOp drifted: expected 6 entries (0..5). "
    "Regenerate via: npm run gen:plumb-enums");

// EHaybaJunctionType: 3 entries (indices 0..2), last = Clash
static_assert((int)EHaybaJunctionType::Clash == 2,
    "JunctionType drifted: expected 3 entries (0..2). "
    "Regenerate via: npm run gen:plumb-enums");

// Runtime guard: string table lengths must match the compile-time enum cardinalities.
// checkf fires in Development/Debug at module load time (before any PCG cook).
struct FHaybaPlumbEnumsSelfCheck
{
    FHaybaPlumbEnumsSelfCheck()
    {
        checkf(UE_ARRAY_COUNT(GHaybaPrimitiveIds) == 13,
            TEXT("primitive id table != 13: the generated header is out of sync. "
                 "Regenerate via: npm run gen:plumb-enums"));

        checkf(UE_ARRAY_COUNT(GHaybaEmitOpIds) == 6,
            TEXT("EmitOp id table != 6: the generated header is out of sync. "
                 "Regenerate via: npm run gen:plumb-enums"));

        checkf(UE_ARRAY_COUNT(GHaybaJunctionTypeIds) == 3,
            TEXT("JunctionType id table != 3: the generated header is out of sync. "
                 "Regenerate via: npm run gen:plumb-enums"));

        checkf(UE_ARRAY_COUNT(GHaybaGateOrder) == 4,
            TEXT("GATE_ORDER != 4: the generated header is out of sync. "
                 "Regenerate via: npm run gen:plumb-enums"));
    }
};

// Instantiated at static-initialization time (before main / before any PCG element runs).
static FHaybaPlumbEnumsSelfCheck GHaybaPlumbEnumsSelfCheckInstance;
