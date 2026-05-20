// Private/HaybaMCPDeveloperSettings.h
#pragma once
#include "CoreMinimal.h"
#include "Engine/DeveloperSettings.h"
#include "HaybaMCPDeveloperSettings.generated.h"

UENUM()
enum class EHaybaModelPreset : uint8
{
    Minimal,
    Balanced,
    Full
};

UCLASS(Config=HaybaMCP, DefaultConfig, meta=(DisplayName="Hayba MCP Toolkit"))
class UHaybaMCPDeveloperSettings : public UDeveloperSettings
{
    GENERATED_BODY()
public:
    UPROPERTY(EditAnywhere, Config, Category="Security", meta=(PasswordField=true,
        ToolTip="When set, every TCP request must include this token in the auth field. Empty disables auth."))
    FString CapabilityToken;

    UPROPERTY(EditAnywhere, Config, Category="Security",
        meta=(ToolTip="Append every command execution to Saved/hayba-execution.log."))
    bool bEnableExecutionJournal = true;

    UPROPERTY(EditAnywhere, Config, Category="Security",
        meta=(ToolTip="DANGER: Allow Tier-3 Python scripts (subprocess, file I/O, sockets)."))
    bool bAllowUnsafePython = false;

    UPROPERTY(EditAnywhere, Config, Category="Performance", meta=(ClampMin=10, ClampMax=600))
    int32 RateLimitPerMinute = 60;

    UPROPERTY(EditAnywhere, Config, Category="Performance")
    bool bCodeModeEnabled = true;

    UPROPERTY(EditAnywhere, Config, Category="Performance", meta=(ClampMin=0.5, ClampMax=30.0))
    float ToolCacheTTLSeconds = 2.0f;

    UPROPERTY(EditAnywhere, Config, Category="Visual Sidecar")
    FString SidecarURL = TEXT("http://localhost:7821");

    UPROPERTY(EditAnywhere, Config, Category="Visual Sidecar")
    EHaybaModelPreset ModelPreset = EHaybaModelPreset::Minimal;

    UPROPERTY(EditAnywhere, Config, Category="Visual Sidecar")
    bool bEnableSpatialCLIP = false;

    UPROPERTY(EditAnywhere, Config, Category="Visual Sidecar")
    bool bEnableOWLViT = false;

    UPROPERTY(EditAnywhere, Config, Category="Visual Sidecar",
        meta=(ToolTip="WARNING: Continuous capture causes ongoing GPU load."))
    bool bEnableContinuousCapture = false;

    /** Read-only computed VRAM estimate. Updated when sidecar settings change. */
    UPROPERTY(VisibleAnywhere, Category="Visual Sidecar")
    FString VRAMEstimate;

    // UDeveloperSettings overrides
    virtual FName GetCategoryName() const override { return TEXT("Plugins"); }

#if WITH_EDITOR
    virtual void PostEditChangeProperty(struct FPropertyChangedEvent& PropertyChangedEvent) override;
#endif

    /** Recomputes VRAMEstimate from preset + sidecar toggles. */
    void RecomputeVRAMEstimate();
};
