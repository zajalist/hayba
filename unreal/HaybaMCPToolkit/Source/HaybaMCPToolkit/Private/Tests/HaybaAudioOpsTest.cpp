#include "Misc/AutomationTest.h"
#include "HaybaAudioOps.h"

#if WITH_DEV_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaAudioPathTest,
    "Hayba.MCP.Audio.PathNormalization",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaAudioPathTest::RunTest(const FString& Parameters)
{
    using namespace HaybaAudioOps;

    TestEqual(TEXT("package-only path gains object basename"),
        NormalizeObjectPath(TEXT("/Game/Audio/SC_UI")),
        FString(TEXT("/Game/Audio/SC_UI.SC_UI")));
    TestEqual(TEXT("canonical object path is stable"),
        NormalizeObjectPath(TEXT("/Game/Audio/SC_UI.SC_UI")),
        FString(TEXT("/Game/Audio/SC_UI.SC_UI")));
    TestEqual(TEXT("export text is accepted"),
        NormalizeObjectPath(TEXT("SoundClass'/Game/Audio/SC_UI.SC_UI'")),
        FString(TEXT("/Game/Audio/SC_UI.SC_UI")));

    const FAssetTarget Target = ResolveAssetTarget(TEXT("/Game/Audio/Mixes/MX_City"));
    TestTrue(TEXT("valid target"), Target.IsValid());
    TestEqual(TEXT("directory"), Target.Directory, FString(TEXT("/Game/Audio/Mixes")));
    TestEqual(TEXT("asset name"), Target.AssetName, FString(TEXT("MX_City")));

    TestFalse(TEXT("engine content creation rejected"),
        ResolveAssetTarget(TEXT("/Engine/Audio/SC_Bad")).IsValid());
    TestFalse(TEXT("filesystem path rejected"),
        ResolveAssetTarget(TEXT("C:/Audio/SC_Bad")).IsValid());
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaAudioTypeTest,
    "Hayba.MCP.Audio.AssetTypes",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaAudioTypeTest::RunTest(const FString& Parameters)
{
    using namespace HaybaAudioOps;
    TestEqual(TEXT("snake-case class"), ParseAssetType(TEXT("sound_class")), EAssetType::SoundClass);
    TestEqual(TEXT("short attenuation alias"), ParseAssetType(TEXT("attenuation")), EAssetType::SoundAttenuation);
    TestEqual(TEXT("submix"), AssetTypeName(ParseAssetType(TEXT("SoundSubmix"))), FString(TEXT("SoundSubmix")));
    TestEqual(TEXT("unknown is rejected"), ParseAssetType(TEXT("SoundCue")), EAssetType::Unsupported);
    return true;
}

#endif
