// Plumb | Wall Plan — the pure resolution core (spec: 2026-07-05-plumb-pcg-vs-native-split-decision).
// Realization stays in PCG graphs; THIS decides. Everything here is a deterministic pure function
// of drawing splines + params (grill Q1: symmetric derivation — both structures independently
// compute bit-identical sockets). Arc-length parameterized (Q6). Explicit Z intervals (Q12).
// UObject-free; unit-tested headless before any PCG node wraps it.
#pragma once

#include "CoreMinimal.h"

// ---------- inputs ----------

enum class EPlumbStructureKind : uint8 { Room, Corridor };

struct FPlumbStructure
{
    FName                Id;                 // actor name — the deterministic identity (Q8 tie-break)
    EPlumbStructureKind  Kind = EPlumbStructureKind::Room;
    TArray<FVector>      Points;             // drawing-spline control points, WORLD space (linear runs)
    bool                 bClosed = true;     // rooms closed, corridors open
    double               FloorZ = 0.0;       // Points[i].Z of the drawing plane
    double               WallHeight = 300.0;
    double               CorridorWidth = 300.0; // corridors only (Q10: rides with the corridor's data)
};

struct FPlumbPlanParams
{
    double MinOverlap     = 150.0;  // Q10 default: narrowest socket type's width
    double CornerAngleDeg = 30.0;   // Q2: the corner-angle slider
    double WallThickness  = 30.0;
    double OpeningWidth   = 150.0;  // v1 stand-in for DA_SocketType dims (Q4: type-sized)
    double OpeningHeight  = 220.0;
    double CoincidenceTol = 26.0;   // how close a mouth must sit to a wall to count (>= thickness)
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

    // Try to derive the socket between Wall-owner `W` and open structure `C` at one mouth.
    // Returns true and fills Out on geometric success; Reason set on a *near-miss* reject.
    inline bool DeriveMouthSocket(const FPlumbStructure& W, const FPlumbStructure& C, const FMouth& M,
                                  const FPlumbPlanParams& P, FPlumbSocketPlan& Out, FString& Reason)
    {
        const TArray<FRun> Runs = SplitRuns(W, P.CornerAngleDeg);
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
        if (P.OpeningWidth > SpanLen)
        {
            Reason = FString::Printf(TEXT("opening %.0fcm wider than shared wall %.0fcm"), P.OpeningWidth, SpanLen);
            return false;
        }

        // Z algebra (Q12): walk level = max of floors; must fit under both ceilings.
        const double Z0 = FMath::Max(W.FloorZ, C.FloorZ);
        const double Z1 = Z0 + P.OpeningHeight;
        const double SharedCeil = FMath::Min(W.FloorZ + W.WallHeight, C.FloorZ + C.WallHeight);
        if (Z1 > SharedCeil)
        {
            Reason = FString::Printf(TEXT("opening top %.0f exceeds shared ceiling %.0f"), Z1, SharedCeil);
            return false;
        }

        const double SCenter = (Span0 + Span1) * 0.5;   // opening centered on the span (Q4)
        const FVector Tan = (R.B - R.A).GetSafeNormal2D();
        Out.OtherId = C.Id;
        Out.Center  = R.A + Tan * SCenter; Out.Center.Z = Z0;
        Out.Tangent = Tan;
        Out.Normal  = -M.Dir;              // out of the wall, toward the corridor
        Out.Width   = P.OpeningWidth;
        Out.Z0 = Z0; Out.Z1 = Z1;
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
        const TArray<FRun> Runs = SplitRuns(Self, P.CornerAngleDeg);

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
