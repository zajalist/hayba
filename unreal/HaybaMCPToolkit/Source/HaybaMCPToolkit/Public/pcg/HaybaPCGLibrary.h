// Small Blueprint/Python-callable helpers for PCG authoring that wrap engine
// methods which are NOT UFUNCTIONs in UE 5.8 (so Python reflection can't reach
// them directly). Kept intentionally tiny — one static per gap.
#pragma once

#include "CoreMinimal.h"
#include "Kismet/BlueprintFunctionLibrary.h"
#include "HaybaPCGLibrary.generated.h"

class UPCGNode;
class UPCGGraph;

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

	/**
	 * Sets a PCG graph user parameter from JSON, adding it first when it is missing. Python can neither add graph
	 * parameters nor set a struct-typed one (e.g. FPCGVirtualTexturePrimingInfo, which PCG does not export).
	 *   StructType: the struct of a parameter to add, by path ("/Script/PCG.PCGVirtualTexturePrimingInfo") or name
	 *               ("PCGVirtualTexturePrimingInfo"); empty to set an existing parameter of any type.
	 *   ValueJson:  a JSON value; a struct takes an object of its fields, e.g.
	 *               {"VirtualTexture": "/Game/VT/RVT_Ground.RVT_Ground", "Grid": "Grid64", "WorldTexelSize": 50}.
	 *               Text that is not JSON is imported as UE text, e.g. (Grid=Grid64,WorldTexelSize=50.0).
	 * Returns an empty string when the value was applied, else what was not done.
	 */
	UFUNCTION(BlueprintCallable, Category = "Hayba|PCG")
	static FString SetPCGGraphUserParameter(UPCGGraph* Graph, FName Name, const FString& StructType, const FString& ValueJson);
};
