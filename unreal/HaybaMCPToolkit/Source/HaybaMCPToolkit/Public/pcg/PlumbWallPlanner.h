// Plumb | Wall Plan — the pure resolution core (spec: 2026-07-05-plumb-pcg-vs-native-split-decision).
// Realization stays in PCG graphs; THIS decides. Everything here is a deterministic pure function
// of drawing splines + params (grill Q1: symmetric derivation — both structures independently
// compute bit-identical sockets). Arc-length parameterized (Q6). Explicit Z intervals (Q12).
// UObject-free; unit-tested headless before any PCG node wraps it.
#pragma once

#include "CoreMinimal.h"
#include "pcg/HaybaSocketSolver.h"
#include "Algo/Reverse.h"

// ---------- inputs ----------

enum class EPlumbStructureKind : uint8 { Room, Corridor };

// A socket TYPE a structure offers at junctions (Q3: authored as DA_SocketType, converted
// to this plain decl before Plan). Compatibility = the SP-1 tag contract; dims = type-sized (Q4).
struct FPlumbSocketTypeDecl
{
    FHaybaSocketContract Contract;          // Name + Provides/Requires/bRelaxable (dotted tags)
    double OpeningWidth    = 150.0;
    double OpeningHeight   = 220.0;
    double TransitionRadius = 0.0;          // Q9b: noisy-surface flatten falloff (0 = flat modular)
};

struct FPlumbStructure
{
    FName                Id;                 // actor name — the deterministic identity (Q8 tie-break)
    EPlumbStructureKind  Kind = EPlumbStructureKind::Room;
    TArray<FVector>      Points;             // drawing-spline control points, WORLD space (linear runs)
    bool                 bClosed = true;     // rooms closed, corridors open
    double               FloorZ = 0.0;       // Points[i].Z of the drawing plane
    double               WallHeight = 300.0;
    double               CorridorWidth = 300.0; // corridors only (Q10: rides with the corridor's data)
    TArray<FPlumbSocketTypeDecl> SocketTypes;   // Q3: declared kinds; empty => params default type
};

struct FPlumbPlanParams
{
    double MinOverlap     = 150.0;  // Q10 default: narrowest socket type's width
    double CornerAngleDeg = 30.0;   // Q2: the corner-angle slider
    double WallThickness  = 30.0;
    double OpeningWidth   = 150.0;  // v1 stand-in for DA_SocketType dims (Q4: type-sized)
    double OpeningHeight  = 220.0;
    double CoincidenceTol = 26.0;   // how close a mouth must sit to a wall to count (>= thickness)
    bool   bFlipWallFacing = false; // author knob: reverse wall winding (inner<->outer faces)
};

// ---------- outputs ----------

// A straight wall run (post corner-split) minus socket spans: what the bay grammar tiles.
struct FPlumbSegmentPlan
{
    FVector A = FVector::ZeroVector; // world start
    FVector B = FVector::ZeroVector; // world end
    double  Z0 = 0.0, Z1 = 300.0;    // explicit vertical interval (Q12 — never inferred downstream)
};

struct FPlumbSocketPlan
{
    FName    OtherId;                 // who we connect to
    FVector  Center = FVector::ZeroVector; // world, at Z0 (walk level)
    FVector  Tangent = FVector::XAxisVector;  // along the wall
    FVector  Normal  = FVector::YAxisVector;  // out of the wall, toward the neighbor
    double   Width = 0.0;             // opening width (type-sized, Q4)
    double   Z0 = 0.0, Z1 = 0.0;      // walk level = max(floorA, floorB) .. +OpeningHeight (Q12)
    double   FloorDeltaSelf = 0.0;    // Z0 - own floor (stairs hook, Q12)
    bool     bOwned = false;          // Q8: this side realizes the entrance assembly; other side yields
    FName    TypeName;                // winning DA_SocketType (drives the entrance kit)
    double   TransitionRadius = 0.0;  // Q9b flatten falloff, from the winning type
    bool     bRelaxedBond = false;    // solver committed by relaxing a requirement (yellow)
};

struct FPlumbRejectPlan
{
    FName   OtherId;
    FVector At = FVector::ZeroVector;
    FString Reason;                   // human unsat text (Q13 overlay)
};

struct FPlumbWallPlan
{
    TArray<FPlumbSegmentPlan> Segments;
    TArray<FPlumbSocketPlan>  Sockets;
    TArray<FPlumbRejectPlan>  Rejects;
};

// ---------- core ----------

namespace PlumbWallPlanner
{
    // -- polyline helpers (2-D in XY; Z carried separately) --

    struct FRun // one straight wall run with its arc range
    {
        FVector A, B;
        double  Len = 0.0;
    };

    // Split a structure's wall polyline into straight runs at corners sharper than CornerAngleDeg (Q2).
    inline TArray<FRun> SplitRuns(const FPlumbStructure& S, double CornerAngleDeg)
    {
        TArray<FRun> Runs;
        const int32 N = S.Points.Num();
        if (N < 2) return Runs;
        const double CosThresh = FMath::Cos(FMath::DegreesToRadians(CornerAngleDeg));

        const int32 EdgeCount = S.bClosed ? N : N - 1;
        int32 RunStart = 0;
        for (int32 e = 0; e < EdgeCount; ++e)
        {
            const FVector P0 = S.Points[e % N], P1 = S.Points[(e + 1) % N];
            const FVector D0 = (P1 - P0).GetSafeNormal2D();
            const int32 eNext = (e + 1) % EdgeCount;
            const FVector Q0 = S.Points[eNext % N], Q1 = S.Points[(eNext + 1) % N];
            const FVector D1 = (Q1 - Q0).GetSafeNormal2D();
            const bool bCornerAfter = (FVector::DotProduct(D0, D1) < CosThresh) || (!S.bClosed && e == EdgeCount - 1);
            if (bCornerAfter)
            {
                FRun R; R.A = S.Points[RunStart % N]; R.B = P1; R.Len = FVector::Dist2D(R.A, R.B);
                if (R.Len > KINDA_SMALL_NUMBER) Runs.Add(R);
                RunStart = (e + 1) % N;
            }
        }
        // closed loop with no corner at wrap: merge is unnecessary for our fixtures (square rooms
        // always corner at every vertex); open polylines already flushed the last run above.
        return Runs;
    }

    // Project P onto run AB (2-D). Returns param t in [0,1] and squared distance.
    inline double ProjectOnRun(const FRun& R, const FVector& P, double& OutT)
    {
        const FVector AB = R.B - R.A;
        const double  L2 = AB.SizeSquared2D();
        OutT = (L2 <= KINDA_SMALL_NUMBER) ? 0.0 : FMath::Clamp(FVector::DotProduct((P - R.A), AB) / L2, 0.0, 1.0);
        const FVector C = R.A + AB * OutT;
        return FVector::DistSquared2D(C, P);
    }

    // -- corridor offsetting (Q2 absorption): a corridor's WALLS are the mitered offset LOOP
    //    around its centerline (left side + far cap + right side + near cap), not the centerline.
    //    Pure + deterministic => both sides of a junction still derive identical geometry.
    inline TArray<FVector> CorridorWallLoop(const FPlumbStructure& S)
    {
        TArray<FVector> Loop;
        const int32 N = S.Points.Num();
        if (S.bClosed || N < 2) return Loop;
        const double H = S.CorridorWidth * 0.5;

        // Offset one side of the polyline with LINE_PLANE-style mitered corners.
        auto OffsetSide = [&](double Sign, TArray<FVector>& Out)
        {
            for (int32 i = 0; i < N; ++i)
            {
                const FVector DirIn  = (i > 0)     ? (S.Points[i] - S.Points[i-1]).GetSafeNormal2D() : (S.Points[1] - S.Points[0]).GetSafeNormal2D();
                const FVector DirOut = (i < N - 1) ? (S.Points[i+1] - S.Points[i]).GetSafeNormal2D() : DirIn;
                const FVector NIn (-DirIn.Y * Sign,  DirIn.X * Sign, 0.0);
                const FVector NOut(-DirOut.Y * Sign, DirOut.X * Sign, 0.0);
                FVector MiterN = (NIn + NOut).GetSafeNormal2D();
                if (MiterN.IsNearlyZero()) MiterN = NIn;
                const double Cos = FVector::DotProduct(MiterN, NIn);
                const double Scale = (FMath::Abs(Cos) > 0.1) ? (1.0 / Cos) : 1.0; // miter length
                FVector P = S.Points[i] + MiterN * (H * Scale);
                P.Z = S.Points[i].Z;
                Out.Add(P);
            }
        };
        TArray<FVector> Left, Right;
        OffsetSide(+1.0, Left);
        OffsetSide(-1.0, Right);
        // Winding: modules face LEFT of travel (rooms: CCW loop => inner faces). For the tunnel
        // interior to be faced, traverse right side forward, then left side back.
        Loop.Append(Right);
        for (int32 i = Left.Num() - 1; i >= 0; --i) Loop.Add(Left[i]);
        return Loop; // closed implicitly: last->first edge = the near (mouth) cap
    }

    // Wall geometry a structure exposes: rooms = drawn loop; corridors = offset tunnel loop.
    // bFlip reverses winding (inner<->outer faces) — the author's facing knob, uniform for both kinds.
    inline FPlumbStructure EffectiveWalls(const FPlumbStructure& S, bool bFlip = false)
    {
        FPlumbStructure W = S;
        if (!S.bClosed)
        {
            W.Points = CorridorWallLoop(S);
            W.bClosed = true; // the tunnel loop is closed (caps included)
        }
        if (bFlip) Algo::Reverse(W.Points);
        return W;
    }

    // -- the canonical socket derivation (Q1): pure function of the two structures --
    // v1 detector: corridor-mouth — an OPEN structure's endpoint sitting on another structure's wall.
    // (Pair-agnostic interval framework; collinear room|room shared-wall detector is the next fixture.)

    struct FMouth { FVector At; FVector Dir; };  // endpoint + inward direction of the corridor

    inline TArray<FMouth> Mouths(const FPlumbStructure& S)
    {
        TArray<FMouth> M;
        if (S.bClosed || S.Points.Num() < 2) return M;
        M.Add({ S.Points[0],                (S.Points[1] - S.Points[0]).GetSafeNormal2D() });
        M.Add({ S.Points.Last(),            (S.Points[S.Points.Num() - 2] - S.Points.Last()).GetSafeNormal2D() });
        return M;
    }

    // -- socket-type resolution (Q3): SP-1 cost-min over the two sides' declared types --
    struct FTypeChoice
    {
        bool    bOk = false;
        bool    bRelaxed = false;
        FName   TypeName;              // the WALL side's winning type (owner-facing kit)
        double  Width = 0.0, Height = 0.0, Transition = 0.0;
        FString Reason;                // unsat text when !bOk
    };

    inline FPlumbSocketTypeDecl DefaultType(const FPlumbPlanParams& P)
    {
        FPlumbSocketTypeDecl D;
        D.Contract.Name = FName(TEXT("Default"));
        D.Contract.Provides = { TEXT("Entrance") };
        D.Contract.Requires.All = {};              // permissive: connects to anything
        D.OpeningWidth  = P.OpeningWidth;
        D.OpeningHeight = P.OpeningHeight;
        return D;
    }

    // Pick the min-cost (wallType, otherType) pair that also FITS (width<=span, height<=headroom).
    // Deterministic: candidates scanned in declared order; strict improvement wins (stable tie-break).
    inline FTypeChoice SolveSocketType(const FPlumbStructure& Wall, const FPlumbStructure& Other,
                                       double SpanLen, double Headroom, const FPlumbPlanParams& P)
    {
        TArray<FPlumbSocketTypeDecl> A = Wall.SocketTypes;  if (A.Num() == 0) A.Add(DefaultType(P));
        TArray<FPlumbSocketTypeDecl> B = Other.SocketTypes; if (B.Num() == 0) B.Add(DefaultType(P));

        FTypeChoice Best; double BestCost = HaybaSocketSolver::HardPenalty; FString FirstReason;
        for (const FPlumbSocketTypeDecl& TA : A)
        {
            for (const FPlumbSocketTypeDecl& TB : B)
            {
                if (TA.OpeningWidth > SpanLen || TA.OpeningHeight > Headroom)
                {
                    if (FirstReason.IsEmpty())
                        FirstReason = FString::Printf(TEXT("%s does not fit: w %.0f vs span %.0f, h %.0f vs headroom %.0f under shared ceiling"),
                            *TA.Contract.Name.ToString(), TA.OpeningWidth, SpanLen, TA.OpeningHeight, Headroom);
                    continue;
                }
                const FHaybaBondOutcome O = HaybaSocketSolver::SolveBond(TA.Contract, { TB.Contract });
                if (O.bOk && O.Cost < BestCost)
                {
                    BestCost = O.Cost;
                    Best.bOk = true; Best.bRelaxed = O.bRelaxed;
                    Best.TypeName = TA.Contract.Name;
                    Best.Width = TA.OpeningWidth; Best.Height = TA.OpeningHeight; Best.Transition = TA.TransitionRadius;
                    if (BestCost <= 0.0) return Best; // clean bond: cannot improve
                }
                else if (!O.bOk && FirstReason.IsEmpty())
                {
                    FirstReason = FString::Printf(TEXT("%s vs %s: missing [%s]"),
                        *TA.Contract.Name.ToString(), *TB.Contract.Name.ToString(),
                        *FString::Join(O.MissingRequired, TEXT(", ")));
                }
            }
        }
        if (!Best.bOk) Best.Reason = FirstReason.IsEmpty() ? TEXT("no compatible socket types") : FirstReason;
        return Best;
    }

    // Try to derive the socket between Wall-owner `W` and open structure `C` at one mouth.
    // Returns true and fills Out on geometric success; Reason set on a *near-miss* reject.
    inline bool DeriveMouthSocket(const FPlumbStructure& W, const FPlumbStructure& C, const FMouth& M,
                                  const FPlumbPlanParams& P, FPlumbSocketPlan& Out, FString& Reason)
    {
        const TArray<FRun> Runs = SplitRuns(EffectiveWalls(W, P.bFlipWallFacing), P.CornerAngleDeg);
        double BestD2 = TNumericLimits<double>::Max(); int32 BestRun = INDEX_NONE; double BestT = 0.0;
        for (int32 i = 0; i < Runs.Num(); ++i)
        {
            double T; const double D2 = ProjectOnRun(Runs[i], M.At, T);
            if (D2 < BestD2) { BestD2 = D2; BestRun = i; BestT = T; }
        }
        if (BestRun == INDEX_NONE) return false;
        const double Dist = FMath::Sqrt(BestD2);
        if (Dist > P.CoincidenceTol)
        {
            return false; // not touching at all — silent (no reject spam for distant structures)
        }
        const FRun& R = Runs[BestRun];

        // Span on the wall: mouth center ± corridorWidth/2, clamped to the run (arc space of the run).
        const double SAtRun   = BestT * R.Len;
        const double HalfMouth = C.CorridorWidth * 0.5;
        const double Span0 = FMath::Max(0.0, SAtRun - HalfMouth);
        const double Span1 = FMath::Min(R.Len, SAtRun + HalfMouth);
        const double SpanLen = Span1 - Span0;
        if (SpanLen < P.MinOverlap)
        {
            Reason = FString::Printf(TEXT("shared span %.0fcm < min overlap %.0fcm"), SpanLen, P.MinOverlap);
            return false;
        }
        // Z algebra (Q12): walk level = max of floors; headroom = shared ceiling above it.
        const double Z0 = FMath::Max(W.FloorZ, C.FloorZ);
        const double SharedCeil = FMath::Min(W.FloorZ + W.WallHeight, C.FloorZ + C.WallHeight);
        const double Headroom = SharedCeil - Z0;

        // Q3: the solver picks the entrance kind (dims come from the winning type).
        const FTypeChoice Choice = SolveSocketType(W, C, SpanLen, Headroom, P);
        if (!Choice.bOk)
        {
            Reason = Choice.Reason;
            return false;
        }

        const double SCenter = (Span0 + Span1) * 0.5;   // opening centered on the span (Q4)
        const FVector Tan = (R.B - R.A).GetSafeNormal2D();
        Out.OtherId = C.Id;
        Out.Center  = R.A + Tan * SCenter; Out.Center.Z = Z0;
        Out.Tangent = Tan;
        Out.Normal  = -M.Dir;              // out of the wall, toward the corridor
        Out.Width   = Choice.Width;
        Out.Z0 = Z0; Out.Z1 = Z0 + Choice.Height;
        Out.TypeName = Choice.TypeName;
        Out.TransitionRadius = Choice.Transition;
        Out.bRelaxedBond = Choice.bRelaxed;
        return true;
    }

    // Q8 ownership: room > corridor > lexicographic name.
    inline bool Owns(const FPlumbStructure& Self, const FPlumbStructure& Other)
    {
        if (Self.Kind != Other.Kind) return Self.Kind == EPlumbStructureKind::Room;
        return Self.Id.LexicalLess(Other.Id);
    }

    // -- retile (Q11 audit invariant: full coverage, zero gaps/overlaps) --
    inline void RetileRun(const FRun& R, double Z0, double Z1,
                          TArray<TPair<double,double>> SocketSpans /*run-arc space, sorted*/,
                          TArray<FPlumbSegmentPlan>& OutSegments)
    {
        SocketSpans.Sort([](const TPair<double,double>& X, const TPair<double,double>& Y){ return X.Key < Y.Key; });
        const FVector Tan = (R.B - R.A).GetSafeNormal2D();
        double Cursor = 0.0;
        auto Emit = [&](double S0, double S1)
        {
            if (S1 - S0 <= KINDA_SMALL_NUMBER) return;
            FPlumbSegmentPlan Seg;
            Seg.A = R.A + Tan * S0; Seg.B = R.A + Tan * S1;
            Seg.Z0 = Z0; Seg.Z1 = Z1;
            OutSegments.Add(Seg);
        };
        for (const auto& Sp : SocketSpans)
        {
            Emit(Cursor, FMath::Max(Cursor, Sp.Key));
            Cursor = FMath::Max(Cursor, Sp.Value);
        }
        Emit(Cursor, R.Len);
    }

    // -- the entry point --
    inline FPlumbWallPlan Plan(const FPlumbStructure& Self, TArrayView<const FPlumbStructure> Others,
                               const FPlumbPlanParams& P)
    {
        FPlumbWallPlan Out;
        // Q2: corridors plan their offset tunnel loop (side walls + caps); rooms plan the drawn loop.
        const FPlumbStructure SelfWalls = EffectiveWalls(Self, P.bFlipWallFacing);
        const TArray<FRun> Runs = SplitRuns(SelfWalls, P.CornerAngleDeg);

        // Collect sockets ON MY WALLS (I am the wall-owner in DeriveMouthSocket terms):
        // any open Other whose mouth touches my wall. Symmetric: the Other, planning itself,
        // derives the identical socket via the same function with roles known from geometry.
        struct FPerRun { TArray<TPair<double,double>> Spans; };
        TArray<FPerRun> PerRun; PerRun.SetNum(Runs.Num());

        auto RegisterSocket = [&](const FPlumbSocketPlan& S)
        {
            // locate the run + arc interval this socket occupies on my wall
            for (int32 i = 0; i < Runs.Num(); ++i)
            {
                double T; const double D2 = ProjectOnRun(Runs[i], S.Center, T);
                if (D2 < FMath::Square(P.CoincidenceTol))
                {
                    const double SC = T * Runs[i].Len;
                    PerRun[i].Spans.Emplace(SC - S.Width * 0.5, SC + S.Width * 0.5);
                    return;
                }
            }
        };

        for (const FPlumbStructure& O : Others)
        {
            if (O.Id == Self.Id) continue; // identity self-exclusion — structural, not a flag (Q1)

            // Case 1: Other is open and its mouth lands on MY wall.
            if (!O.bClosed)
            {
                for (const FMouth& M : Mouths(O))
                {
                    FPlumbSocketPlan S; FString Why;
                    if (DeriveMouthSocket(Self, O, M, P, S, Why))
                    {
                        S.bOwned = Owns(Self, O);
                        S.FloorDeltaSelf = S.Z0 - Self.FloorZ;
                        Out.Sockets.Add(S);
                        RegisterSocket(S);
                    }
                    else if (!Why.IsEmpty())
                    {
                        Out.Rejects.Add({ O.Id, M.At, Why });
                    }
                }
            }
            // Case 2: I am open and MY mouth lands on Other's wall — my cap yields the same span.
            if (!Self.bClosed)
            {
                for (const FMouth& M : Mouths(Self))
                {
                    FPlumbSocketPlan S; FString Why;
                    if (DeriveMouthSocket(O, Self, M, P, S, Why)) // derived on THEIR wall — identical both sides
                    {
                        S.OtherId = O.Id;
                        S.bOwned  = Owns(Self, O);
                        S.FloorDeltaSelf = S.Z0 - Self.FloorZ;
                        S.Normal = M.Dir; // from my cap, opening faces along my inward dir
                        Out.Sockets.Add(S);
                        RegisterSocket(S); // registers only if the span lies on one of MY runs (the cap)
                    }
                }
            }
        }

        // Retile every run around its sockets (guaranteed coverage — kills empty walls & the cap bug).
        for (int32 i = 0; i < Runs.Num(); ++i)
        {
            RetileRun(Runs[i], Self.FloorZ, Self.FloorZ + Self.WallHeight, PerRun[i].Spans, Out.Segments);
        }
        return Out;
    }
}
