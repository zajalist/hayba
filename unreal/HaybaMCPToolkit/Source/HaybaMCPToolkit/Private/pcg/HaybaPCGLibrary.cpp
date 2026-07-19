#include "pcg/HaybaPCGLibrary.h"

#include "PCGNode.h"
#include "PCGCommon.h" // EPCGNodeTitleType

FString UHaybaPCGLibrary::GetPCGNodeTitle(UPCGNode* Node)
{
	if (!Node)
	{
		return FString();
	}

	// EPCGNodeTitleType::FullTitle is the multi-line display title shown in the
	// PCG graph editor (e.g. "Shape : 3D Grid"). Verified UE 5.8:
	//   PCGNode.h:71   FText GetNodeTitle(EPCGNodeTitleType) const  (PCG_API)
	//   PCGCommon.h:725 enum class EPCGNodeTitleType : uint8 { FullTitle, ListView }
	return Node->GetNodeTitle(EPCGNodeTitleType::FullTitle).ToString();
}
