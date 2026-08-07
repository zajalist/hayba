// Parameter handling for the actor domain, tested without an editor.
//
// Before the seam existed this was untestable. actor_spawn read its params
// inline, spawned through UEditorActorSubsystem, and built its reply in one
// function, so exercising "does location default sensibly" meant standing up a
// world and spawning something. 1 of 33 handler domains had any test at all,
// and it is not a coincidence that the tested code — the param reader,
// reflection, the game-thread helper — is the code that had a seam.
//
// ParseSpawn / ParseTransform are pure. These run anywhere.

#include "Misc/AutomationTest.h"
#include "HaybaActorOps.h"
#include "HaybaMCPParams.h"
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
    FHaybaActorOpsParseSpawnTest,
    "Hayba.MCP.ActorOps.ParseSpawn",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaActorOpsParseSpawnTest::RunTest(const FString&)
{
    {
        FHaybaParamReader R(Json(TEXT(R"({"class_path":"/Script/Engine.StaticMeshActor"})")), TEXT("actor_spawn"));
        const HaybaActorOps::FSpawnRequest Req = HaybaActorOps::ParseSpawn(R);
        TestFalse(TEXT("a class_path alone is valid"), R.HasErrors());
        TestEqual(TEXT("location defaults to origin"), Req.Location, FVector::ZeroVector);
        TestFalse(TEXT("scale is UNSET, not 1,1,1 — an absent scale must not overwrite the class default"),
                  Req.Scale.IsSet());
    }

    {
        FHaybaParamReader R(Json(TEXT(R"({})")), TEXT("actor_spawn"));
        HaybaActorOps::ParseSpawn(R);
        TestTrue(TEXT("missing class_path is an error"), R.HasErrors());
        TestTrue(TEXT("the error names the command"), R.ErrorMessage().Contains(TEXT("actor_spawn")));
        TestTrue(TEXT("the error names the field"), R.ErrorMessage().Contains(TEXT("class_path")));
    }

    {
        // [pitch, yaw, roll] — FRotator's constructor order, which is not the
        // order its members are declared in. Getting this wrong rotates things
        // about the wrong axis and looks like a content bug.
        FHaybaParamReader R(Json(TEXT(R"({"class_path":"X","rotation":[10,20,30]})")), TEXT("actor_spawn"));
        const HaybaActorOps::FSpawnRequest Req = HaybaActorOps::ParseSpawn(R);
        TestEqual(TEXT("pitch"), Req.Rotation.Pitch, 10.0);
        TestEqual(TEXT("yaw"),   Req.Rotation.Yaw,   20.0);
        TestEqual(TEXT("roll"),  Req.Rotation.Roll,  30.0);
    }

    {
        FHaybaParamReader R(Json(TEXT(R"({"class_path":"X","location":[1,2]})")), TEXT("actor_spawn"));
        HaybaActorOps::ParseSpawn(R);
        TestTrue(TEXT("a short vector is an error, not a silent zero"), R.HasErrors());
    }

    {
        // Every problem at once, rather than one round trip per mistake.
        FHaybaParamReader R(Json(TEXT(R"({"location":[1,2]})")), TEXT("actor_spawn"));
        HaybaActorOps::ParseSpawn(R);
        const FString Msg = R.ErrorMessage();
        TestTrue(TEXT("reports the missing class_path"), Msg.Contains(TEXT("class_path")));
        TestTrue(TEXT("and the malformed location, in the same message"), Msg.Contains(TEXT("location")));
    }

    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaActorOpsParseTransformTest,
    "Hayba.MCP.ActorOps.ParseTransform",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaActorOpsParseTransformTest::RunTest(const FString&)
{
    {
        FHaybaParamReader R(Json(TEXT(R"({"actor_id":"Cube_1","location":[0,0,100]})")), TEXT("actor_transform"));
        const HaybaActorOps::FTransformRequest Req = HaybaActorOps::ParseTransform(R);
        TestFalse(TEXT("one component is enough"), R.HasErrors());
        TestTrue(TEXT("location set"), Req.Location.IsSet());
        TestFalse(TEXT("rotation left unset"), Req.Rotation.IsSet());
        TestFalse(TEXT("scale left unset"), Req.Scale.IsSet());
    }

    {
        // The important one. A transform naming an actor and nothing else used
        // to succeed having changed nothing, which is indistinguishable from a
        // transform that silently failed.
        FHaybaParamReader R(Json(TEXT(R"({"actor_id":"Cube_1"})")), TEXT("actor_transform"));
        HaybaActorOps::ParseTransform(R);
        TestTrue(TEXT("a transform with nothing to apply is rejected"), R.HasErrors());
        TestTrue(TEXT("and says what to pass"),
                 R.ErrorMessage().Contains(TEXT("location")) && R.ErrorMessage().Contains(TEXT("scale")));
    }

    {
        FHaybaParamReader R(Json(TEXT(R"({"location":[1,2,3]})")), TEXT("actor_transform"));
        HaybaActorOps::ParseTransform(R);
        TestTrue(TEXT("missing actor_id is an error"), R.ErrorMessage().Contains(TEXT("actor_id")));
    }

    return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
