#pragma once
#include "CoreMinimal.h"
#include "Data/PCGSplineData.h"

struct FHaybaSplineFrame
{
	// Sample the spline TNB frame at arc-distance D (UE units, cm).
	// X=tangent, Y=right, Z=up.  D is clamped to [0, TotalLen] before alpha conversion.
	// Verbatim extraction of the Frame lambda from PCGGrammarSolver.cpp (Task 0.2, H3).
	static void Sample(const UPCGSplineData* Spline, double D, double TotalLen,
	                   FVector& OutLoc, FVector& OutRight, FVector& OutUp, FVector& OutTan)
	{
		const float A = (float)FMath::Clamp(D / TotalLen, 0.0, 1.0);
		const FTransform T = Spline->GetTransformAtAlpha(A);
		OutLoc   = T.GetLocation();
		OutRight = T.GetUnitAxis(EAxis::Y);
		OutUp    = T.GetUnitAxis(EAxis::Z);
		OutTan   = T.GetUnitAxis(EAxis::X);
	}
};
