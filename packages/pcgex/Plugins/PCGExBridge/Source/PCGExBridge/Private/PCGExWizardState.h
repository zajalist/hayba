// Plugins/PCGExBridge/Source/PCGExBridge/Private/PCGExWizardState.h
#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/** Status of a single wizard step */
UENUM()
enum class EPCGExWizardStepStatus : uint8
{
	Pending,     // Not yet started
	InProgress,  // AI is generating / user is reviewing
	Approved,    // User approved and locked this step
	Redoing,     // User requested a redo
};

/** A single wizard step */
struct FPCGExWizardStep
{
	FString Name;                          // e.g., "Layout", "Roads", "Parcels"
	EPCGExWizardStepStatus Status = EPCGExWizardStepStatus::Pending;
	TSharedPtr<FJsonObject> Graph;         // Partial graph JSON for this step
	FString AssetPath;                     // UE asset path if created
};

/** A single message in the chat */
struct FPCGExChatMessage
{
	bool bFromUser;         // true = user, false = AI
	FString Text;
	TSharedPtr<FJsonObject> AttachedGraph; // Non-null if AI produced a graph
	bool bShowActions;      // Show Preview/Create/Test buttons
};

/** Full wizard session state */
struct FPCGExWizardSession
{
	FString SessionId;
	FString Goal;                           // User's initial goal
	TArray<FPCGExWizardStep> Steps;
	int32 CurrentStep = 0;
	TArray<FPCGExChatMessage> Messages;
	bool bWaitingForAI = false;

	bool HasCurrentStep() const { return Steps.IsValidIndex(CurrentStep); }
	FPCGExWizardStep& GetCurrentStep() { return Steps[CurrentStep]; }
};
