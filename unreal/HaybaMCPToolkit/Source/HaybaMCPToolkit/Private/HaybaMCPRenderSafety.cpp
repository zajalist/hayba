#include "HaybaMCPRenderSafety.h"

#include "DynamicRHI.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformProcess.h"
#include "Misc/App.h"
#include "Misc/FileHelper.h"
#include "Misc/Guid.h"
#include "Misc/Paths.h"
#include "RHIGlobals.h"
#include "Serialization/Archive.h"

namespace HaybaRenderSafety
{
    namespace
    {
        FCriticalSection LifecycleMutex;
        bool bRenderInFlight = false;
        bool bQuiescing = false;
        FString ActiveCommand;

        bool IsFiniteInteger(double Value)
        {
            return FMath::IsFinite(Value) && FMath::FloorToDouble(Value) == Value;
        }

        bool CheckRenderCapability(FString& OutError)
        {
            if (IsEngineExitRequested())
            {
                OutError = TEXT("the editor is shutting down; no new RHI work is safe. Restart the editor before retrying");
                return false;
            }
            if (!FApp::CanEverRender())
            {
                OutError = TEXT("this process was started without render capability (for example a commandlet)");
                return false;
            }
            if (!GDynamicRHI || GUsingNullRHI)
            {
                OutError = TEXT("a real initialized RHI is required; -NullRHI is valid for logic tests, not render evidence");
                return false;
            }
            return true;
        }

        FString OutputRoot()
        {
            // Default artifact contract: Saved/Screenshots/Hayba.
            FString Root = FPaths::ConvertRelativePathToFull(
                FPaths::ProjectSavedDir() / TEXT("Screenshots/Hayba"));
            FPaths::NormalizeDirectoryName(Root);
            FPaths::CollapseRelativeDirectories(Root, true);
            return Root;
        }

        bool IsReservedWindowsDeviceName(const FString& Filename)
        {
            FString Head = Filename;
            int32 DotIndex = INDEX_NONE;
            if (Head.FindChar(TEXT('.'), DotIndex)) Head = Head.Left(DotIndex);
            Head.TrimEndInline();
            if (Head.Equals(TEXT("CON"), ESearchCase::IgnoreCase)
                || Head.Equals(TEXT("PRN"), ESearchCase::IgnoreCase)
                || Head.Equals(TEXT("AUX"), ESearchCase::IgnoreCase)
                || Head.Equals(TEXT("NUL"), ESearchCase::IgnoreCase)
                || Head.Equals(TEXT("CLOCK$"), ESearchCase::IgnoreCase))
            {
                return true;
            }
            if (Head.Len() == 4)
            {
                const FString Prefix = Head.Left(3);
                const TCHAR Digit = Head[3];
                return (Prefix.Equals(TEXT("COM"), ESearchCase::IgnoreCase)
                    || Prefix.Equals(TEXT("LPT"), ESearchCase::IgnoreCase))
                    && Digit >= TEXT('1') && Digit <= TEXT('9');
            }
            return false;
        }

        bool ValidatePublishDestination(const FString& Candidate, const FString& Format,
                                        FString& OutNormalized, FString& OutError)
        {
            OutNormalized = FPaths::ConvertRelativePathToFull(Candidate);
            FPaths::NormalizeFilename(OutNormalized);
            if (!FPaths::CollapseRelativeDirectories(OutNormalized, true))
            {
                OutError = TEXT("output filename contains unresolved traversal");
                return false;
            }

            const FString Root = OutputRoot();
            FString Parent = FPaths::GetPath(OutNormalized);
            FPaths::NormalizeDirectoryName(Parent);
            FPaths::CollapseRelativeDirectories(Parent, true);
            if (!Parent.Equals(Root, ESearchCase::IgnoreCase))
            {
                OutError = TEXT("output must be a clean filename in Saved/Screenshots/Hayba; callers cannot choose a directory");
                return false;
            }
            if (!FPaths::GetExtension(OutNormalized).Equals(Format, ESearchCase::IgnoreCase))
            {
                OutError = FString::Printf(TEXT("output extension must be .%s so artifact type and filename agree"), *Format);
                return false;
            }
            const FString CleanFilename = FPaths::GetCleanFilename(OutNormalized);
            if (CleanFilename.IsEmpty() || CleanFilename.Len() > MaxOutputFilenameChars
                || CleanFilename.EndsWith(TEXT(".")) || CleanFilename.EndsWith(TEXT(" "))
                || IsReservedWindowsDeviceName(CleanFilename))
            {
                OutError = TEXT("resolved output filename is invalid, too long, or a reserved device name");
                return false;
            }
            if (IFileManager::Get().FileExists(*OutNormalized)
                || IFileManager::Get().DirectoryExists(*OutNormalized))
            {
                OutError = TEXT("output already exists; render artifacts never overwrite files — choose another filename or omit it for a unique name");
                return false;
            }
            return true;
        }

        uint32 ReadBE32(const uint8* Bytes)
        {
            return (uint32(Bytes[0]) << 24) | (uint32(Bytes[1]) << 16)
                 | (uint32(Bytes[2]) << 8) | uint32(Bytes[3]);
        }

        bool ParseJpegDimensions(const TArray64<uint8>& Bytes, int32& OutWidth, int32& OutHeight)
        {
            if (Bytes.Num() < 4 || Bytes[0] != 0xff || Bytes[1] != 0xd8) return false;
            int64 I = 2;
            while (I + 3 < Bytes.Num())
            {
                if (Bytes[I] != 0xff) { ++I; continue; }
                while (I < Bytes.Num() && Bytes[I] == 0xff) ++I;
                if (I >= Bytes.Num()) return false;
                const uint8 Marker = Bytes[I++];
                if (Marker == 0xd8 || Marker == 0xd9 || (Marker >= 0xd0 && Marker <= 0xd7)) continue;
                if (I + 1 >= Bytes.Num()) return false;
                const int32 SegmentLength = (int32(Bytes[I]) << 8) | int32(Bytes[I + 1]);
                if (SegmentLength < 2 || I + SegmentLength > Bytes.Num()) return false;
                const bool bStartOfFrame =
                    (Marker >= 0xc0 && Marker <= 0xc3) || (Marker >= 0xc5 && Marker <= 0xc7)
                    || (Marker >= 0xc9 && Marker <= 0xcb) || (Marker >= 0xcd && Marker <= 0xcf);
                if (bStartOfFrame)
                {
                    if (SegmentLength < 7) return false;
                    OutHeight = (int32(Bytes[I + 3]) << 8) | int32(Bytes[I + 4]);
                    OutWidth = (int32(Bytes[I + 5]) << 8) | int32(Bytes[I + 6]);
                    return OutWidth > 0 && OutHeight > 0;
                }
                I += SegmentLength;
            }
            return false;
        }

        bool VerifyEncodedImpl(const TArray64<uint8>& Bytes, const FString& Format,
                               int32 ExpectedWidth, int32 ExpectedHeight, FString& OutError)
        {
            if (Bytes.Num() <= 8 || Bytes.Num() > MaxEncodedBytes)
            {
                OutError = FString::Printf(TEXT("encoded image is %lld bytes; allowed range is 9..%lld"),
                    Bytes.Num(), MaxEncodedBytes);
                return false;
            }

            int32 ActualWidth = 0;
            int32 ActualHeight = 0;
            bool bParsed = false;
            if (Format == TEXT("png"))
            {
                static const uint8 PngMagic[] = { 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a };
                static const uint8 Ihdr[] = { 'I', 'H', 'D', 'R' };
                bParsed = Bytes.Num() >= 24
                    && FMemory::Memcmp(Bytes.GetData(), PngMagic, UE_ARRAY_COUNT(PngMagic)) == 0
                    && ReadBE32(Bytes.GetData() + 8) == 13
                    && FMemory::Memcmp(Bytes.GetData() + 12, Ihdr, UE_ARRAY_COUNT(Ihdr)) == 0;
                if (bParsed)
                {
                    ActualWidth = int32(ReadBE32(Bytes.GetData() + 16));
                    ActualHeight = int32(ReadBE32(Bytes.GetData() + 20));
                }
            }
            else if (Format == TEXT("jpg"))
            {
                bParsed = ParseJpegDimensions(Bytes, ActualWidth, ActualHeight);
            }

            if (!bParsed)
            {
                OutError = FString::Printf(TEXT("encoder output is not a structurally valid %s image"), *Format);
                return false;
            }
            if (ActualWidth != ExpectedWidth || ActualHeight != ExpectedHeight)
            {
                OutError = FString::Printf(TEXT("encoded dimensions are %dx%d, expected %dx%d"),
                    ActualWidth, ActualHeight, ExpectedWidth, ExpectedHeight);
                return false;
            }
            return true;
        }
    }

    const TCHAR* StageName(EStage Stage)
    {
        switch (Stage)
        {
        case EStage::Acquired:         return TEXT("acquired");
        case EStage::WaitingForIdle:   return TEXT("waiting_for_idle");
        case EStage::AllocatingTarget: return TEXT("allocating_target");
        case EStage::Capturing:        return TEXT("capturing");
        case EStage::ReadingBack:      return TEXT("reading_back");
        case EStage::Encoding:         return TEXT("encoding");
        case EStage::Publishing:       return TEXT("publishing");
        case EStage::Complete:         return TEXT("complete");
        }
        return TEXT("unknown");
    }

    bool ValidateDimensions(double Width, double Height, int32& OutWidth, int32& OutHeight,
                            FString& OutError, int64 PixelLimit)
    {
        OutWidth = 0;
        OutHeight = 0;
        if (!IsFiniteInteger(Width) || !IsFiniteInteger(Height))
        {
            OutError = TEXT("width and height must be finite whole pixel counts");
            return false;
        }
        if (Width < MinDimension || Height < MinDimension || Width > MaxDimension || Height > MaxDimension)
        {
            OutError = FString::Printf(TEXT("width and height must each be in [%d,%d]"), MinDimension, MaxDimension);
            return false;
        }
        const int64 W = int64(Width);
        const int64 H = int64(Height);
        if (W > PixelLimit / H)
        {
            OutError = FString::Printf(TEXT("requested %lld pixels exceeds the %lld-pixel render budget"), W * H, PixelLimit);
            return false;
        }
        OutWidth = int32(W);
        OutHeight = int32(H);
        return true;
    }

    bool ValidateScaledDimensions(double Width, double Height, double Scale,
                                  int32& OutWidth, int32& OutHeight, FString& OutError)
    {
        if (!FMath::IsFinite(Scale) || Scale < 0.1 || Scale > 4.0)
        {
            OutError = TEXT("scale must be finite and in [0.1,4.0]");
            return false;
        }
        if (!IsFiniteInteger(Width) || !IsFiniteInteger(Height) || Width <= 0.0 || Height <= 0.0)
        {
            OutError = TEXT("width and height must be finite positive whole pixel counts before scale is applied");
            return false;
        }
        const double ScaledWidth = FMath::RoundToDouble(Width * Scale);
        const double ScaledHeight = FMath::RoundToDouble(Height * Scale);
        return ValidateDimensions(ScaledWidth, ScaledHeight, OutWidth, OutHeight, OutError);
    }

    bool ResolveOutputPath(const FString& Requested, const FString& Format,
                           const FString& DefaultStem, FString& OutPath, FString& OutError)
    {
        if (Format != TEXT("png") && Format != TEXT("jpg"))
        {
            OutError = TEXT("format must be 'png' or 'jpg'; EXR is disabled because the old path wrote PNG bytes with an .exr name");
            return false;
        }
        if (Requested.Len() > MaxOutputFilenameChars)
        {
            OutError = FString::Printf(TEXT("output filename is invalid or exceeds %d characters"), MaxOutputFilenameChars);
            return false;
        }
        for (const TCHAR C : Requested)
        {
            if (C < 0x20)
            {
                OutError = TEXT("output path contains a control character");
                return false;
            }
        }
        if (!Requested.IsEmpty()
            && (FPaths::IsRelative(Requested) == false
                || !FPaths::GetPath(Requested).IsEmpty()
                || Requested.Contains(TEXT("/"))
                || Requested.Contains(TEXT("\\"))))
        {
            OutError = TEXT("output must be a clean filename only; directories and absolute paths are not accepted");
            return false;
        }

        const FString Extension = Format;
        FString Candidate;
        if (Requested.IsEmpty())
        {
            const FString Uuid = FGuid::NewGuid().ToString(EGuidFormats::Digits).Left(12).ToLower();
            const FString Filename = FString::Printf(TEXT("%s_%s.%s"), *DefaultStem, *Uuid, *Extension);
            Candidate = OutputRoot() / Filename;
        }
        else
        {
            FText InvalidReason;
            if (!FPaths::ValidatePath(Requested, &InvalidReason))
            {
                OutError = TEXT("output filename is invalid: ") + InvalidReason.ToString();
                return false;
            }
            if (!FPaths::GetExtension(Requested).Equals(Extension, ESearchCase::IgnoreCase))
            {
                OutError = FString::Printf(TEXT("output extension must be .%s so artifact type and filename agree"), *Extension);
                return false;
            }
            if (Requested.EndsWith(TEXT(".")) || Requested.EndsWith(TEXT(" "))
                || IsReservedWindowsDeviceName(Requested))
            {
                OutError = TEXT("output filename is a reserved device name or has an unsafe trailing character");
                return false;
            }
            Candidate = OutputRoot() / Requested;
        }
        return ValidatePublishDestination(Candidate, Extension, OutPath, OutError);
    }

    bool PublishVerifiedImage(const TArray64<uint8>& Encoded, const FString& Format,
                              int32 Width, int32 Height, const FString& OutPath,
                              int64& OutFileBytes, FString& OutError)
    {
        OutFileBytes = 0;
        if (!VerifyEncodedImage(Encoded, Format, Width, Height, OutError)) return false;

        FString SafeOutPath;
        if (!ValidatePublishDestination(OutPath, Format, SafeOutPath, OutError)) return false;

        const FString Parent = FPaths::GetPath(SafeOutPath);
        if (Parent.IsEmpty() || !IFileManager::Get().MakeDirectory(*Parent, true))
        {
            OutError = TEXT("could not create the output directory");
            return false;
        }
        const FString TempPath = SafeOutPath + TEXT(".hayba-")
            + FGuid::NewGuid().ToString(EGuidFormats::Digits).Left(12) + TEXT(".tmp");
        TUniquePtr<FArchive> Writer(IFileManager::Get().CreateFileWriter(
            *TempPath, FILEWRITE_NoReplaceExisting | FILEWRITE_Silent));
        if (!Writer)
        {
            OutError = TEXT("could not exclusively create the verified image temporary file");
            return false;
        }
        Writer->Serialize(const_cast<uint8*>(Encoded.GetData()), Encoded.Num());
        Writer->Close();
        const bool bWriteFailed = Writer->IsError();
        Writer.Reset();
        if (bWriteFailed)
        {
            IFileManager::Get().Delete(*TempPath, false, true, true);
            OutError = TEXT("could not completely write the verified image temporary file");
            return false;
        }

        TArray64<uint8> ReRead;
        if (!FFileHelper::LoadFileToArray(ReRead, *TempPath) || !VerifyEncodedImage(ReRead, Format, Width, Height, OutError))
        {
            IFileManager::Get().Delete(*TempPath, false, true, true);
            OutError = TEXT("temporary image failed read-after-write verification: ") + OutError;
            return false;
        }
        if (IFileManager::Get().FileExists(*SafeOutPath)
            || !IFileManager::Get().Move(*SafeOutPath, *TempPath, false, false, false, true))
        {
            IFileManager::Get().Delete(*TempPath, false, true, true);
            OutError = TEXT("could not atomically publish without overwriting an existing file");
            return false;
        }

        TArray64<uint8> FinalBytes;
        if (!FFileHelper::LoadFileToArray(FinalBytes, *SafeOutPath) || !VerifyEncodedImage(FinalBytes, Format, Width, Height, OutError))
        {
            // SafeOutPath did not exist before the no-replace move above, so
            // this removes only the artifact this operation just published.
            IFileManager::Get().Delete(*SafeOutPath, false, true, true);
            OutError = TEXT("published image failed final verification: ") + OutError;
            return false;
        }
        OutFileBytes = FinalBytes.Num();
        return true;
    }

    bool VerifyEncodedImage(const TArray64<uint8>& Encoded, const FString& Format,
                            int32 Width, int32 Height, FString& OutError)
    {
        return VerifyEncodedImpl(Encoded, Format, Width, Height, OutError);
    }

    bool Initialize(FString& OutError)
    {
        FScopeLock Lock(&LifecycleMutex);
        if (bRenderInFlight)
        {
            OutError = FString::Printf(TEXT("cannot initialize render lifecycle while '%s' is still draining"), *ActiveCommand);
            return false;
        }
        if (IsEngineExitRequested())
        {
            OutError = TEXT("cannot initialize render lifecycle during engine shutdown");
            return false;
        }
        bQuiescing = false;
        ActiveCommand.Reset();
        return true;
    }

    bool BeginShutdown(FString& OutActiveCommand)
    {
        FScopeLock Lock(&LifecycleMutex);
        bQuiescing = true;
        OutActiveCommand = bRenderInFlight ? ActiveCommand : FString();
        return !bRenderInFlight;
    }

    FLease::FLease(FString InCommand, double InDeadlineAtSeconds)
        : Command(MoveTemp(InCommand)), DeadlineAtSeconds(InDeadlineAtSeconds)
    {
    }

    FLease::~FLease()
    {
        FScopeLock Lock(&LifecycleMutex);
        bRenderInFlight = false;
        ActiveCommand.Reset();
        if (IsEngineExitRequested()) bQuiescing = true;
    }

    TSharedPtr<FLease, ESPMode::ThreadSafe> FLease::TryAcquire(
        const FString& Command, double DeadlineSeconds, FString& OutError)
    {
        if (!FMath::IsFinite(DeadlineSeconds) || DeadlineSeconds < MinDeadlineSeconds
            || DeadlineSeconds > MaxDeadlineSeconds)
        {
            OutError = FString::Printf(TEXT("total render deadline must be finite and in [%.0f,%.0f] seconds"),
                MinDeadlineSeconds, MaxDeadlineSeconds);
            return nullptr;
        }
        if (!CheckRenderCapability(OutError))
        {
            FScopeLock Lock(&LifecycleMutex);
            if (IsEngineExitRequested()) bQuiescing = true;
            return nullptr;
        }

        FScopeLock Lock(&LifecycleMutex);
        if (bQuiescing)
        {
            OutError = TEXT("the render lifecycle is quiescing for editor shutdown; restart before retrying");
            return nullptr;
        }
        if (bRenderInFlight)
        {
            OutError = FString::Printf(TEXT("another render operation is in flight (%s); wait for it to finish before retrying"),
                *ActiveCommand);
            return nullptr;
        }
        bRenderInFlight = true;
        ActiveCommand = Command;
        return MakeShareable(new FLease(Command, FPlatformTime::Seconds() + DeadlineSeconds));
    }

    bool FLease::Advance(EStage NextStage, FString& OutError)
    {
        if (uint8(NextStage) < uint8(Stage))
        {
            OutError = FString::Printf(TEXT("render lifecycle cannot move backward from %s to %s"),
                StageName(Stage), StageName(NextStage));
            return false;
        }
        FString CapabilityError;
        if (!CheckRenderCapability(CapabilityError))
        {
            FScopeLock Lock(&LifecycleMutex);
            bQuiescing = true;
            OutError = FString::Printf(TEXT("%s stopped at %s: %s"), *Command, StageName(Stage), *CapabilityError);
            return false;
        }
        if (FPlatformTime::Seconds() > DeadlineAtSeconds)
        {
            OutError = FString::Printf(TEXT("%s exceeded its total deadline at stage %s; session state is unknown, do not retry until the current operation drains"),
                *Command, StageName(Stage));
            return false;
        }
        Stage = NextStage;
        return true;
    }

    double FLease::RemainingSeconds() const
    {
        return FMath::Max(0.0, DeadlineAtSeconds - FPlatformTime::Seconds());
    }
}
