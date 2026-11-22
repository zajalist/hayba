#pragma once

#include "Dom/JsonObject.h"
#include "EditorValidatorSubsystem.h"

namespace HaybaAssetValidation
{
    inline TSharedRef<FJsonObject> Summarize(const FValidateAssetsResults& Results)
    {
        const int32 Validated = Results.NumValid + Results.NumInvalid;
        const bool bComplete = Results.NumRequested > 0 && !Results.bWasCancelled &&
            Results.NumSkipped == 0 && Results.NumUnableToValidate == 0 &&
            Results.NumChecked == Results.NumRequested && Validated == Results.NumRequested;
        // UE sets the limit flag even at an exactly covered limit; counts establish coverage.
        const TCHAR* Status = Results.bWasCancelled ? TEXT("cancelled") : Results.NumInvalid > 0 ? TEXT("failed") :
            bComplete ? TEXT("passed") : Validated > 0 ? TEXT("partial") : TEXT("not_validated");
        auto Out = MakeShared<FJsonObject>();
        Out->SetBoolField(TEXT("valid"), bComplete && Results.NumInvalid == 0);
        Out->SetBoolField(TEXT("complete"), bComplete);
        Out->SetStringField(TEXT("status"), Status);
        Out->SetBoolField(TEXT("cancelled"), Results.bWasCancelled);
        Out->SetBoolField(TEXT("asset_limit_reached"), Results.bAssetLimitReached);
        Out->SetNumberField(TEXT("num_valid"), Results.NumValid);
        Out->SetNumberField(TEXT("num_invalid"), Results.NumInvalid);
        Out->SetNumberField(TEXT("num_warnings"), Results.NumWarnings);
        Out->SetNumberField(TEXT("num_requested"), Results.NumRequested);
        Out->SetNumberField(TEXT("num_checked"), Results.NumChecked);
        Out->SetNumberField(TEXT("num_skipped"), Results.NumSkipped);
        Out->SetNumberField(TEXT("num_unable_to_validate"), Results.NumUnableToValidate);
        Out->SetNumberField(TEXT("num_external_objects"), Results.NumExternalObjects);
        return Out;
    }
}
