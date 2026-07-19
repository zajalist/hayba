// Small Blueprint/Python-callable helpers for PCG authoring that wrap engine
// methods which are NOT UFUNCTIONs in UE 5.8 (so Python reflection can't reach
// them directly). Kept intentionally tiny — one static per gap.
#pragma once

#include "CoreMinimal.h"
#include "Kismet/BlueprintFunctionLibrary.h"
#include "HaybaPCGLibrary.generated.h"

class UPCGNode;

UCLASS()
class HAYBAMCPTOOLKIT_API UHaybaPCGLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()

public:
	/**
	 * Returns the friendly display title of a PCG node (e.g. "Shape : 3D Grid")
	 * instead of the raw settings-class name (e.g. "PCGExCreateShapeGridSettings").
	 *
	 * Wraps UPCGNode::GetNodeTitle(EPCGNodeTitleType::FullTitle), which is a plain
	 * C++ method (not a UFUNCTION) in UE 5.8, so Python cannot call it directly.
	 * Null-guarded: returns an empty string if Node is null.
	 */
	UFUNCTION(BlueprintCallable, Category = "Hayba|PCG")
	static FString GetPCGNodeTitle(UPCGNode* Node);
};
