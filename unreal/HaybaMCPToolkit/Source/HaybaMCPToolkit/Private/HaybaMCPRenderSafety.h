#pragma once

#include "CoreMinimal.h"

/**
 * One fail-closed boundary for every MCP operation that allocates an RHI
 * render target or performs a synchronous GPU readback.
 *
 * Rendering is deliberately single-flight. ReadPixels/DrawWidget can block the
 * game thread and allocate width*height*4 bytes (before encoder scratch); two
 * otherwise-valid calls arriving together must not multiply that pressure.
 */
namespace HaybaRenderSafety
{
    constexpr int32 MinDimension = 16;
    constexpr int32 MaxDimension = 4096;
    constexpr int64 MaxPixels = 8ll * 1024ll * 1024ll;
    constexpr int64 MaxInlinePixels = 1920ll * 1080ll;
    constexpr int64 MaxEncodedBytes = 64ll * 1024ll * 1024ll;
    constexpr int32 MaxOutputFilenameChars = 240;
    constexpr double MinDeadlineSeconds = 1.0;
    constexpr double MaxDeadlineSeconds = 75.0;

    enum class EStage : uint8
    {
        Acquired,
        WaitingForIdle,
        AllocatingTarget,
        Capturing,
        ReadingBack,
        Encoding,
        Publishing,
        Complete
    };

    const TCHAR* StageName(EStage Stage);

    /** Strict integer dimensions. Never clamps: a rejected allocation must be
     * visible to the caller instead of silently changing its request. */
    bool ValidateDimensions(double Width, double Height, int32& OutWidth, int32& OutHeight,
                            FString& OutError, int64 PixelLimit = MaxPixels);

    /** Validate request dimensions after applying scale without overflowing. */
    bool ValidateScaledDimensions(double Width, double Height, double Scale,
                                  int32& OutWidth, int32& OutHeight, FString& OutError);

    /** Resolve a caller-supplied clean filename inside the plugin-owned
     * Saved/Screenshots/Hayba directory. Callers never choose a directory or
     * absolute path. Existing destinations are refused. Only PNG/JPEG are
     * supported; the old EXR path wrote PNG bytes behind an .exr extension. */
    bool ResolveOutputPath(const FString& Requested, const FString& Format,
                           const FString& DefaultStem, FString& OutPath, FString& OutError);

    /** Structural magic + encoded dimension verification without touching disk. */
    bool VerifyEncodedImage(const TArray64<uint8>& Encoded, const FString& Format,
                            int32 Width, int32 Height, FString& OutError);

    /** Verify encoded bytes, publish through a same-directory temporary file,
     * then re-read and verify the final artifact before success is reported. */
    bool PublishVerifiedImage(const TArray64<uint8>& Encoded, const FString& Format,
                              int32 Width, int32 Height, const FString& OutPath,
                              int64& OutFileBytes, FString& OutError);

    /** Reset the process-wide gate when the module starts. Safe only before
     * the TCP surface is exposed; it deliberately refuses to reset while a
     * previous render is still draining. */
    bool Initialize(FString& OutError);

    /** Permanently refuse new render work for this module lifetime. Returns
     * false and names the active command when shutdown began mid-render. */
    bool BeginShutdown(FString& OutActiveCommand);

    class FLease final
    {
    public:
        ~FLease();

        FLease(const FLease&) = delete;
        FLease& operator=(const FLease&) = delete;

        /** Acquire the process-wide render slot and a bounded total deadline. */
        static TSharedPtr<FLease, ESPMode::ThreadSafe> TryAcquire(
            const FString& Command, double DeadlineSeconds, FString& OutError);

        /** Advance the explicit lifecycle. Also fails if shutdown/RHI loss or
         * the total deadline has been observed since acquisition. */
        bool Advance(EStage NextStage, FString& OutError);

        double RemainingSeconds() const;
        EStage GetStage() const { return Stage; }

    private:
        FLease(FString InCommand, double InDeadlineAtSeconds);

        FString Command;
        double DeadlineAtSeconds = 0.0;
        EStage Stage = EStage::Acquired;
    };
}
