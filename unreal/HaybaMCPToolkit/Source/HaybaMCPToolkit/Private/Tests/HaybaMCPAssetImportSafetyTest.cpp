#if WITH_DEV_AUTOMATION_TESTS

#include "Misc/AutomationTest.h"
#include "Modules/ModuleManager.h"
#include "handlers/HaybaMCPAssetHandler.h"

namespace
{
TSharedPtr<FJsonObject> ValidRequest()
{
    TSharedPtr<FJsonObject> Json = MakeShared<FJsonObject>();
    Json->SetStringField(TEXT("source_file"), TEXT("C:/Temp/hayba-asset-connectors/provider/request/Mesh.png"));
    Json->SetStringField(TEXT("destination_path"), TEXT("/Game/Imported"));
    Json->SetStringField(TEXT("asset_type"), TEXT("texture"));
    return Json;
}

void WriteLe32(TArray<uint8>& Bytes, int32 Offset, uint32 Value)
{
    Bytes[Offset] = static_cast<uint8>(Value);
    Bytes[Offset + 1] = static_cast<uint8>(Value >> 8);
    Bytes[Offset + 2] = static_cast<uint8>(Value >> 16);
    Bytes[Offset + 3] = static_cast<uint8>(Value >> 24);
}

void WriteBe32(TArray<uint8>& Bytes, int32 Offset, uint32 Value)
{
    Bytes[Offset] = static_cast<uint8>(Value >> 24);
    Bytes[Offset + 1] = static_cast<uint8>(Value >> 16);
    Bytes[Offset + 2] = static_cast<uint8>(Value >> 8);
    Bytes[Offset + 3] = static_cast<uint8>(Value);
}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaAssetImportRequestTest,
    "Hayba.AssetImport.StrictRequestPreflight",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaAssetImportRequestTest::RunTest(const FString& Parameters)
{
    using namespace HaybaAssetImport;
    FRequest Parsed;
    FString Error;
    TestTrue(TEXT("strict valid request parses"), ParseAndValidateRequest(ValidRequest(), Parsed, Error));
    TestEqual(TEXT("exact object path is derived, not sanitized"), Parsed.ExpectedObjectPath,
        FString(TEXT("/Game/Imported/Mesh.Mesh")));
    TestEqual(TEXT("texture PNG cap is 64 MiB"), Parsed.MaxFileBytes, 64ll * 1024ll * 1024ll);

    TSharedPtr<FJsonObject> Unknown = ValidRequest();
    Unknown->SetBoolField(TEXT("replace_existing"), true);
    TestFalse(TEXT("unknown overwrite option is rejected"), ParseAndValidateRequest(Unknown, Parsed, Error));
    TestTrue(TEXT("unknown option has stable request code"), Error.Contains(TEXT("HAI_INVALID_REQUEST")));

    TSharedPtr<FJsonObject> WrongType = ValidRequest();
    WrongType->SetStringField(TEXT("asset_type"), TEXT("static_mesh"));
    TestFalse(TEXT("extension/type mismatch is rejected"), ParseAndValidateRequest(WrongType, Parsed, Error));

    TSharedPtr<FJsonObject> Traversal = ValidRequest();
    Traversal->SetStringField(TEXT("source_file"), TEXT("C:/Temp/hayba-asset-connectors/p/../escape/Mesh.png"));
    TestFalse(TEXT("source traversal is rejected"), ParseAndValidateRequest(Traversal, Parsed, Error));

    TSharedPtr<FJsonObject> DriveRelative = ValidRequest();
    DriveRelative->SetStringField(TEXT("source_file"), TEXT("C:Temp/hayba-asset-connectors/p/r/Mesh.png"));
    TestFalse(TEXT("drive-relative source is rejected"), ParseAndValidateRequest(DriveRelative, Parsed, Error));

    TSharedPtr<FJsonObject> Control = ValidRequest();
    Control->SetStringField(TEXT("source_file"), TEXT("C:/Temp/hayba-asset-connectors/p/r/Me\nsh.png"));
    TestFalse(TEXT("source controls are rejected"), ParseAndValidateRequest(Control, Parsed, Error));

    TSharedPtr<FJsonObject> BadDestination = ValidRequest();
    BadDestination->SetStringField(TEXT("destination_path"), TEXT("/Engine/Imported"));
    TestFalse(TEXT("non-Game destination is rejected"), ParseAndValidateRequest(BadDestination, Parsed, Error));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaAssetImportHeaderTest,
    "Hayba.AssetImport.BoundedFormatHeaders",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaAssetImportHeaderTest::RunTest(const FString& Parameters)
{
    using namespace HaybaAssetImport;
    FString Error;

    const int64 TextureMax = 64ll * 1024ll * 1024ll;
    TestTrue(TEXT("texture exact byte cap passes"), ValidateFileSize(EKind::TexturePng, TextureMax, Error));
    TestFalse(TEXT("texture byte cap plus one fails"), ValidateFileSize(EKind::TexturePng, TextureMax + 1, Error));
    TestFalse(TEXT("zero-byte source fails"), ValidateFileSize(EKind::SoundWave, 0, Error));

    TArray<uint8> Png;
    Png.SetNumZeroed(33);
    const uint8 PngSignature[] = { 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a };
    FMemory::Memcpy(Png.GetData(), PngSignature, UE_ARRAY_COUNT(PngSignature));
    WriteBe32(Png, 8, 13);
    FMemory::Memcpy(Png.GetData() + 12, "IHDR", 4);
    WriteBe32(Png, 16, 1024);
    WriteBe32(Png, 20, 1024);
    Png[24] = 8;
    Png[25] = 6;
    TestTrue(TEXT("bounded canonical PNG header passes"), ValidateFileHeader(EKind::TexturePng, Png, Png.Num(), Error));
    WriteBe32(Png, 16, 16384);
    TestFalse(TEXT("oversized PNG dimensions fail"), ValidateFileHeader(EKind::TexturePng, Png, Png.Num(), Error));

    TArray<uint8> Jpeg;
    Jpeg.SetNumZeroed(21);
    Jpeg[0] = 0xff; Jpeg[1] = 0xd8; Jpeg[2] = 0xff; Jpeg[3] = 0xc0;
    Jpeg[4] = 0x00; Jpeg[5] = 0x11; Jpeg[6] = 8;
    Jpeg[7] = 0x04; Jpeg[8] = 0x00; Jpeg[9] = 0x04; Jpeg[10] = 0x00;
    Jpeg[11] = 3;
    TestTrue(TEXT("bounded JPEG SOF header passes"), ValidateFileHeader(EKind::TextureJpeg, Jpeg, Jpeg.Num(), Error));
    Jpeg[3] = 0xc9;
    TestFalse(TEXT("arithmetic JPEG frame fails"), ValidateFileHeader(EKind::TextureJpeg, Jpeg, Jpeg.Num(), Error));
    Jpeg[3] = 0xc0;

    TArray<uint8> Wave;
    Wave.SetNumZeroed(48);
    FMemory::Memcpy(Wave.GetData(), "RIFF", 4);
    WriteLe32(Wave, 4, 40);
    FMemory::Memcpy(Wave.GetData() + 8, "WAVEfmt ", 8);
    WriteLe32(Wave, 16, 16);
    Wave[20] = 1; Wave[22] = 2;
    WriteLe32(Wave, 24, 48000);
    WriteLe32(Wave, 28, 192000);
    Wave[32] = 4; Wave[34] = 16;
    FMemory::Memcpy(Wave.GetData() + 36, "data", 4);
    WriteLe32(Wave, 40, 4);
    TestTrue(TEXT("bounded PCM WAV header passes"), ValidateFileHeader(EKind::SoundWave, Wave, Wave.Num(), Error));
    Wave[20] = 3;
    TestFalse(TEXT("non-32-bit float WAV fails"), ValidateFileHeader(EKind::SoundWave, Wave, Wave.Num(), Error));
    Wave[20] = 1;
    WriteLe32(Wave, 40, MAX_uint32);
    TestFalse(TEXT("WAV chunk overflow fails"), ValidateFileHeader(EKind::SoundWave, Wave, Wave.Num(), Error));

    TArray<uint8> Fbx;
    Fbx.SetNumZeroed(27);
    const uint8 FbxSignature[] = {
        'K','a','y','d','a','r','a',' ','F','B','X',' ','B','i','n','a','r','y',' ',' ',0x00,0x1a,0x00
    };
    FMemory::Memcpy(Fbx.GetData(), FbxSignature, UE_ARRAY_COUNT(FbxSignature));
    WriteLe32(Fbx, 23, 7400);
    TestTrue(TEXT("bounded binary FBX header passes"), ValidateFileHeader(EKind::StaticMeshFbx, Fbx, Fbx.Num(), Error));
    Fbx[0] = ';';
    TestFalse(TEXT("ASCII/noncanonical FBX fails"), ValidateFileHeader(EKind::StaticMeshFbx, Fbx, Fbx.Num(), Error));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaAssetImportAuthorityBeforeModuleTest,
    "Hayba.AssetImport.AuthorityRejectsBeforeAssetTools",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaAssetImportAuthorityBeforeModuleTest::RunTest(const FString& Parameters)
{
#if PLATFORM_WINDOWS
    const bool bAssetToolsLoadedBefore = FModuleManager::Get().IsModuleLoaded(TEXT("AssetTools"));
    TSharedPtr<FJsonObject> Json = ValidRequest();
    Json->SetStringField(TEXT("source_file"), TEXT("C:/definitely-outside-hayba-authority/Mesh.png"));
    FHaybaMCPAssetHandler Handler;
    const FHaybaHandlerResult Result = Handler.Handle(TEXT("asset_import"), Json);
    TestTrue(TEXT("structured failure uses data envelope"), Result.bOk && Result.Data.IsValid());
    if (!Result.Data.IsValid()) return false;
    bool bInnerOk = true;
    Result.Data->TryGetBoolField(TEXT("ok"), bInnerOk);
    TestFalse(TEXT("outside authority is rejected"), bInnerOk);
    FString Code;
    Result.Data->TryGetStringField(TEXT("code"), Code);
    TestEqual(TEXT("authority code is stable"), Code, FString(TEXT("HAI_AUTHORITY_REJECTED")));
    TestEqual(TEXT("authority refusal does not load AssetTools"),
        FModuleManager::Get().IsModuleLoaded(TEXT("AssetTools")), bAssetToolsLoadedBefore);
#endif
    return true;
}

#endif
