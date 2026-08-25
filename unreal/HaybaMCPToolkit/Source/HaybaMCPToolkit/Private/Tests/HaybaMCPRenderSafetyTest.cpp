#include "Misc/AutomationTest.h"
#include "HaybaMCPRenderSafety.h"
#include <limits>
#include "RHIGlobals.h"
#include "HAL/FileManager.h"
#include "Misc/FileHelper.h"
#include "Misc/Guid.h"

#if WITH_DEV_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPRenderSafetyPolicyTest,
    "Hayba.MCP.RenderSafety.Policy",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPRenderSafetyPolicyTest::RunTest(const FString& Parameters)
{
    using namespace HaybaRenderSafety;

    FString Error;
    int32 Width = 0;
    int32 Height = 0;
    TestTrue(TEXT("4K stays within the bounded pixel budget"),
        ValidateDimensions(3840, 2160, Width, Height, Error));
    TestEqual(TEXT("4K width"), Width, 3840);
    TestEqual(TEXT("4K height"), Height, 2160);

    Error.Reset();
    TestFalse(TEXT("4096 squared exceeds the pixel budget"),
        ValidateDimensions(4096, 4096, Width, Height, Error));
    TestTrue(TEXT("pixel refusal names the budget"), Error.Contains(TEXT("render budget")));
    TestFalse(TEXT("fractional pixels are refused"),
        ValidateDimensions(1920.5, 1080, Width, Height, Error));
    TestFalse(TEXT("NaN dimensions are refused"),
        ValidateDimensions(std::numeric_limits<double>::quiet_NaN(), 1080, Width, Height, Error));
    TestFalse(TEXT("infinity dimensions are refused"),
        ValidateDimensions(std::numeric_limits<double>::infinity(), 1080, Width, Height, Error));
    TestFalse(TEXT("inline captures have a lower pixel budget"),
        ValidateDimensions(2560, 1440, Width, Height, Error, MaxInlinePixels));

    TestTrue(TEXT("scaled dimensions are calculated exactly"),
        ValidateScaledDimensions(800, 600, 2, Width, Height, Error));
    TestEqual(TEXT("scaled width"), Width, 1600);
    TestEqual(TEXT("scaled height"), Height, 1200);
    TestFalse(TEXT("scale is rejected, not silently clamped"),
        ValidateScaledDimensions(800, 600, 5, Width, Height, Error));

    FString Path;
    TestFalse(TEXT("EXR is honestly refused"),
        ResolveOutputPath(TEXT("x.exr"), TEXT("exr"), TEXT("probe"), Path, Error));
    TestTrue(TEXT("EXR error explains the former false artifact"), Error.Contains(TEXT("old path wrote PNG")));
    TestFalse(TEXT("extension mismatch is refused"),
        ResolveOutputPath(TEXT("x.jpg"), TEXT("png"), TEXT("probe"), Path, Error));
    TestFalse(TEXT("control characters in paths are refused"),
        ResolveOutputPath(TEXT("x\n.png"), TEXT("png"), TEXT("probe"), Path, Error));
    TestFalse(TEXT("a caller-selected relative directory is refused"),
        ResolveOutputPath(TEXT("Saved/Screenshots/HaybaTests/x.png"), TEXT("png"), TEXT("probe"), Path, Error));
    const FString AbsoluteSavedPath = FPaths::ConvertRelativePathToFull(
        FPaths::ProjectSavedDir() / TEXT("Screenshots/HaybaTests/hayba_absolute_policy_probe.png"));
    TestFalse(TEXT("an absolute path is refused even when it is beneath Saved"),
        ResolveOutputPath(AbsoluteSavedPath, TEXT("png"), TEXT("probe"), Path, Error));
    TestFalse(TEXT("absolute output outside Saved is refused"),
        ResolveOutputPath(TEXT("C:/Temp/x.png"), TEXT("png"), TEXT("probe"), Path, Error));
    TestFalse(TEXT("relative traversal is refused"),
        ResolveOutputPath(TEXT("../x.png"), TEXT("png"), TEXT("probe"), Path, Error));
    TestFalse(TEXT("embedded traversal is refused even when it would collapse inside Saved"),
        ResolveOutputPath(TEXT("Saved/Screenshots/../x.png"), TEXT("png"), TEXT("probe"), Path, Error));
    TestFalse(TEXT("Windows CON device name is refused"),
        ResolveOutputPath(TEXT("CON.png"), TEXT("png"), TEXT("probe"), Path, Error));
    TestFalse(TEXT("Windows NUL device name is refused"),
        ResolveOutputPath(TEXT("NUL.png"), TEXT("png"), TEXT("probe"), Path, Error));
    TestFalse(TEXT("Windows LPT device name with extra suffix is refused"),
        ResolveOutputPath(TEXT("LPT1.anything.png"), TEXT("png"), TEXT("probe"), Path, Error));
    TestTrue(TEXT("omitting output generates a unique safe path"),
        ResolveOutputPath(TEXT(""), TEXT("png"), TEXT("probe"), Path, Error));
    TestTrue(TEXT("generated output is in the plugin screenshot directory"),
        FPaths::IsUnderDirectory(Path, FPaths::ProjectSavedDir() / TEXT("Screenshots/Hayba")));
    TestFalse(TEXT("oversized output is refused"),
        ResolveOutputPath(FString::ChrN(MaxOutputFilenameChars + 1, TEXT('a')) + TEXT(".png"),
            TEXT("png"), TEXT("probe"), Path, Error));
    TestTrue(TEXT("a clean PNG filename resolves"),
        ResolveOutputPath(TEXT("hayba_safety_policy_probe.png"), TEXT("png"), TEXT("probe"), Path, Error));
    TestTrue(TEXT("resolved path is absolute"), !FPaths::IsRelative(Path));
    TestTrue(TEXT("resolved path is confined to the plugin screenshot directory"),
        FPaths::IsUnderDirectory(Path, FPaths::ProjectSavedDir() / TEXT("Screenshots/Hayba")));

    const FString OccupiedName = TEXT("hayba_no_overwrite_")
        + FGuid::NewGuid().ToString(EGuidFormats::Digits).Left(12) + TEXT(".png");
    FString OccupiedPath;
    TestTrue(TEXT("unique overwrite probe filename resolves"),
        ResolveOutputPath(OccupiedName, TEXT("png"), TEXT("probe"), OccupiedPath, Error));
    TestTrue(TEXT("overwrite probe directory can be staged"),
        IFileManager::Get().MakeDirectory(*FPaths::GetPath(OccupiedPath), true));
    TestTrue(TEXT("overwrite probe file can be staged"),
        FFileHelper::SaveStringToFile(TEXT("occupied"), *OccupiedPath));
    TestFalse(TEXT("an existing artifact is never overwritten"),
        ResolveOutputPath(OccupiedName, TEXT("png"), TEXT("probe"), Path, Error));
    TestTrue(TEXT("overwrite refusal is actionable"), Error.Contains(TEXT("never overwrite")));
    IFileManager::Get().Delete(*OccupiedPath, false, true, true);

    TestFalse(TEXT("fractional source dimensions are refused before scaling"),
        ValidateScaledDimensions(800.5, 600, 1, Width, Height, Error));

    // The structural verifier refuses magic-only blobs and dimension drift.
    TArray64<uint8> PngHeader;
    const uint8 HeaderBytes[] = {
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 'I', 'H', 'D', 'R',
        0x00, 0x00, 0x01, 0x40, // 320
        0x00, 0x00, 0x00, 0xf0  // 240
    };
    PngHeader.Append(HeaderBytes, UE_ARRAY_COUNT(HeaderBytes));
    TestTrue(TEXT("PNG magic and IHDR dimensions verify"),
        VerifyEncodedImage(PngHeader, TEXT("png"), 320, 240, Error));
    TestFalse(TEXT("wrong PNG dimensions are refused"),
        VerifyEncodedImage(PngHeader, TEXT("png"), 321, 240, Error));
    PngHeader[0] = 0;
    TestFalse(TEXT("wrong PNG magic is refused"),
        VerifyEncodedImage(PngHeader, TEXT("png"), 320, 240, Error));

    TestEqual(TEXT("lifecycle stage names are stable for diagnostics"),
        FString(StageName(EStage::ReadingBack)), FString(TEXT("reading_back")));

    FString LeaseError;
    if (GUsingNullRHI)
    {
        TestFalse(TEXT("NullRHI is refused before any allocation"),
            FLease::TryAcquire(TEXT("policy_test"), 5, LeaseError).IsValid());
        // Either refusal is correct here. CheckRenderCapability tests
        // FApp::CanEverRender() before GUsingNullRHI, and -nullrhi makes
        // CanEverRender() false -- so this branch actually reports the
        // render-capability refusal, not the RHI one. Pinning a single message
        // asserted on a string this path never produces.
        TestTrue(TEXT("NullRHI refusal explains the evidence boundary"),
            LeaseError.Contains(TEXT("real initialized RHI"))
            || LeaseError.Contains(TEXT("without render capability")));
    }
    else
    {
        TSharedPtr<FLease, ESPMode::ThreadSafe> First = FLease::TryAcquire(TEXT("policy_test"), 5, LeaseError);
        if (TestTrue(TEXT("real RHI acquires the render lease"), First.IsValid()))
        {
            TestFalse(TEXT("a second render cannot overlap"),
                FLease::TryAcquire(TEXT("overlap_test"), 5, LeaseError).IsValid());
            TestTrue(TEXT("overlap refusal names the active command"), LeaseError.Contains(TEXT("policy_test")));
            First.Reset();
            TestTrue(TEXT("the lease is reusable only after completion"),
                FLease::TryAcquire(TEXT("after_test"), 5, LeaseError).IsValid());
        }
    }
    return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
