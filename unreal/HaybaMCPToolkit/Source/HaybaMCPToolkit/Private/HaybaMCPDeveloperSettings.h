// Private/HaybaMCPDeveloperSettings.h
#pragma once
#include "CoreMinimal.h"
#include "Engine/DeveloperSettings.h"
#include "HaybaMCPAdvisoryTypes.h"
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

    UPROPERTY(EditAnywhere, Config, Category="Transport Safety",
        meta=(ClampMin=65536, ClampMax=16777216, UIMin=65536, UIMax=16777216,
            ToolTip="Maximum UTF-8 bytes accepted in one MCP request. Applied when the TCP server next starts."))
    int32 TcpMaxRequestBytes = 1024 * 1024;

    UPROPERTY(EditAnywhere, Config, Category="Transport Safety",
        meta=(ClampMin=1048576, ClampMax=67108864, UIMin=1048576, UIMax=67108864,
            ToolTip="Maximum UTF-8 bytes emitted in one MCP response. Keep large enough for bounded image/base64 tools. Applied when the TCP server next starts."))
    int32 TcpMaxResponseBytes = 8 * 1024 * 1024;

    UPROPERTY(EditAnywhere, Config, Category="Transport Safety",
        meta=(ClampMin=1, ClampMax=64,
            ToolTip="Maximum simultaneous MCP client connections. Applied when the TCP server next starts."))
    int32 TcpMaxClientConnections = 16;

    UPROPERTY(EditAnywhere, Config, Category="Transport Safety",
        meta=(ClampMin=1, ClampMax=1024,
            ToolTip="Maximum accepted commands waiting for the game thread. Excess clients are disconnected before enqueue. Applied when the TCP server next starts."))
    int32 TcpMaxPendingCommands = 128;

    UPROPERTY(EditAnywhere, Config, Category="Transport Safety",
        meta=(ClampMin=8, ClampMax=256,
            ToolTip="Maximum JSON object/array nesting accepted before parsing. Applied when the TCP server next starts."))
    int32 TcpMaxJsonNestingDepth = 64;

    UPROPERTY(EditAnywhere, Config, Category="Transport Safety",
        meta=(ClampMin=500, ClampMax=30000,
            ToolTip="Maximum total milliseconds allowed to receive one complete framed request. Prevents slow clients from holding every connection slot. Applied when the TCP server next starts."))
    int32 TcpFrameReadTimeoutMs = 5000;

    UPROPERTY(EditAnywhere, Config, Category="Transport Safety",
        meta=(ClampMin=100, ClampMax=30000,
            ToolTip="Maximum total milliseconds allowed to send one response before disconnecting a client that is not reading. Applied when the TCP server next starts."))
    int32 TcpSendTimeoutMs = 1000;

    UPROPERTY(EditAnywhere, Config, Category="Performance")
    bool bCodeModeEnabled = true;

    UPROPERTY(EditAnywhere, Config, Category="AI Response Guidance",
        meta=(ToolTip="Controls optional guidance in MCP responses. Errors and mandatory recovery instructions are always returned, even in Errors only mode."))
    EHaybaMCPAdvisoryVerbosity AdvisoryVerbosity = EHaybaMCPAdvisoryVerbosity::ErrorsAndWarnings;

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

    UPROPERTY(EditAnywhere, Config, Category="Asset Connectors", meta=(PasswordField=true,
        ToolTip="Sketchfab API token (https://sketchfab.com/settings/password). Required for hayba_sketchfab_* tools. Leave empty to disable Sketchfab."))
    FString SketchfabApiToken;

    // UDeveloperSettings overrides
    virtual FName GetCategoryName() const override { return TEXT("Plugins"); }

#if WITH_EDITOR
    virtual void PostEditChangeProperty(struct FPropertyChangedEvent& PropertyChangedEvent) override;
#endif

    /** Recomputes VRAMEstimate from preset + sidecar toggles. */
    void RecomputeVRAMEstimate();
};
