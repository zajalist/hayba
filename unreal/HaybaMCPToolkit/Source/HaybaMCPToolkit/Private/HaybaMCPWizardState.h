#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/** Status of a single wizard step */
UENUM()
enum class EHaybaMCPWizardStepStatus : uint8
{
	Pending,     // Not yet started
	InProgress,  // AI is generating / user is reviewing
	Approved,    // User approved and locked this step
	Redoing,     // User requested a redo
};

/** A single wizard step */
struct FHaybaMCPWizardStep
{
	FString Name;                          // e.g., "Layout", "Roads", "Parcels"
	EHaybaMCPWizardStepStatus Status = EHaybaMCPWizardStepStatus::Pending;
	TSharedPtr<FJsonObject> Graph;         // Partial graph JSON for this step
	FString AssetPath;                     // UE asset path if created
};

/** A single message in the chat */
struct FHaybaMCPChatMessage
{
	bool bFromUser;         // true = user, false = AI
	FString Text;
	TSharedPtr<FJsonObject> AttachedGraph; // Non-null if AI produced a graph
	bool bShowActions;      // Show Preview/Create/Test buttons
	FDateTime Timestamp = FDateTime::Now();
};

/** Full wizard session state */
struct FHaybaMCPWizardSession
{
	FString SessionId;
	FString Goal;                           // User's initial goal
	TArray<FHaybaMCPWizardStep> Steps;
	int32 CurrentStep = 0;
	TArray<FHaybaMCPChatMessage> Messages;
	bool bWaitingForAI = false;

	bool HasCurrentStep() const { return Steps.IsValidIndex(CurrentStep); }
	FHaybaMCPWizardStep& GetCurrentStep() { return Steps[CurrentStep]; }
};
