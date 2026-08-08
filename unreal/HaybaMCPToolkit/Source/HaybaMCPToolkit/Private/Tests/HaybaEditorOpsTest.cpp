// Camera orientation rules, tested without a viewport.
//
// The rule these pin is the one most likely to be got wrong and least likely to
// be noticed: UE's FRotator is (Pitch, Yaw, Roll), not XYZ euler. An agent
// thinking "rotate N about Z" sends [0, 0, N] expecting yaw and gets ROLL. The
// horizon tilts, the screenshot comes back at an angle, and it reads as a
// rendering bug rather than a caller mistake.
//
// The guard against that lived inside editor_set_camera, next to
// SetViewLocation/SetViewRotation calls on a live FEditorViewportClient, where
// nothing could reach it.

#include "Misc/AutomationTest.h"
#include "HaybaEditorOps.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

#if WITH_DEV_AUTOMATION_TESTS

namespace
{
    TSharedPtr<FJsonObject> Json(const FString& Text)
    {
        TSharedPtr<FJsonObject> Obj;
        const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Text);
        FJsonSerializer::Deserialize(Reader, Obj);
        return Obj;
    }
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaEditorOpsCameraTest,
    "Hayba.MCP.EditorOps.CameraRotation",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaEditorOpsCameraTest::RunTest(const FString&)
{
    using namespace HaybaEditorOps;
    const FVector Eye(0, 0, 0);
    const FRotator Current(10, 20, 30);   // deliberately rolled, to prove roll is dropped

    {
        // THE REGRESSION. [0, 0, 90] is what an agent sends meaning "yaw 90".
        // Index 2 is roll. It must be ignored, not applied.
        const FCameraOrientation R =
            ResolveCameraRotation(Json(TEXT(R"({"rotation":[0,0,90]})")), Eye, Current);
        TestTrue(TEXT("array form is used"), R.Source == ECameraRotationSource::RotationArr);
        TestEqual(TEXT("roll is NOT taken from index 2 — the horizon stays level"), R.Rotation.Roll, 0.0);
        TestEqual(TEXT("pitch comes from index 0"), R.Rotation.Pitch, 0.0);
        TestEqual(TEXT("yaw comes from index 1"), R.Rotation.Yaw, 0.0);
    }

    {
        const FCameraOrientation R =
            ResolveCameraRotation(Json(TEXT(R"({"rotation":[15,45]})")), Eye, Current);
        TestEqual(TEXT("pitch"), R.Rotation.Pitch, 15.0);
        TestEqual(TEXT("yaw"),   R.Rotation.Yaw,   45.0);
        TestEqual(TEXT("roll stays level even though Current was rolled"), R.Rotation.Roll, 0.0);
    }

    {
        // The object form is the only way to ask for roll, and it must work —
        // suppressing a deliberate tilt would be its own bug.
        const FCameraOrientation R =
            ResolveCameraRotation(Json(TEXT(R"({"rotation":{"pitch":5,"yaw":6,"roll":7}})")), Eye, Current);
        TestTrue(TEXT("object form is used"), R.Source == ECameraRotationSource::RotationObj);
        TestEqual(TEXT("roll is honoured when named explicitly"), R.Rotation.Roll, 7.0);
    }

    {
        // Absent roll means level, not "keep whatever tilt was there".
        const FCameraOrientation R =
            ResolveCameraRotation(Json(TEXT(R"({"rotation":{"yaw":90}})")), Eye, Current);
        TestEqual(TEXT("yaw applied"), R.Rotation.Yaw, 90.0);
        TestEqual(TEXT("pitch falls back to current"), R.Rotation.Pitch, Current.Pitch);
        TestEqual(TEXT("roll resets to level"), R.Rotation.Roll, 0.0);
    }

    {
        // look_at outranks rotation, and yields roll = 0 by construction.
        const FCameraOrientation R = ResolveCameraRotation(
            Json(TEXT(R"({"look_at":[100,0,0],"rotation":[80,80,80]})")), Eye, Current);
        TestTrue(TEXT("look_at wins over rotation"), R.Source == ECameraRotationSource::LookAt);
        TestEqual(TEXT("facing +X is yaw 0"), R.Rotation.Yaw, 0.0);
        TestEqual(TEXT("and level"), R.Rotation.Roll, 0.0);
    }

    {
        const FCameraOrientation R =
            ResolveCameraRotation(Json(TEXT(R"({"look_at":[0,100,0]})")), Eye, Current);
        TestEqual(TEXT("facing +Y is yaw 90"), R.Rotation.Yaw, 90.0);
    }

    {
        // Aiming at the camera's own position says nothing about facing, so it
        // must fall through rather than snap to zero.
        const FCameraOrientation R = ResolveCameraRotation(
            Json(TEXT(R"({"look_at":[0,0,0],"rotation":[11,22]})")), Eye, Current);
        TestTrue(TEXT("degenerate look_at falls through to rotation"),
                 R.Source == ECameraRotationSource::RotationArr);
        TestEqual(TEXT("and the rotation form is honoured"), R.Rotation.Pitch, 11.0);
    }

    {
        const FCameraOrientation R = ResolveCameraRotation(Json(TEXT(R"({})")), Eye, Current);
        TestFalse(TEXT("nothing supplied changes nothing"), R.bChanged());
        TestEqual(TEXT("current rotation is preserved verbatim"), R.Rotation.Roll, Current.Roll);
    }

    {
        const FCameraOrientation R = ResolveCameraRotation(nullptr, Eye, Current);
        TestFalse(TEXT("a null params object is handled"), R.bChanged());
    }

    return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
