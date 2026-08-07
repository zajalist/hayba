#include "Misc/AutomationTest.h"
#include "HaybaMCPReflection.h"

#if WITH_EDITOR
#include "Engine/StaticMeshActor.h"
#include "Engine/PointLight.h"
#include "Components/PointLightComponent.h"
#include "Editor.h"
#include "Subsystems/EditorActorSubsystem.h"
#include "handlers/HaybaMCPActorHandler.h"

namespace
{
    TSharedPtr<FJsonValue> Num(double D) { return MakeShared<FJsonValueNumber>(D); }
    TSharedPtr<FJsonValue> Str(const TCHAR* S) { return MakeShared<FJsonValueString>(S); }

    TSharedPtr<FJsonValue> NumArray(std::initializer_list<double> Vals)
    {
        TArray<TSharedPtr<FJsonValue>> Arr;
        for (double D : Vals) Arr.Add(Num(D));
        return MakeShared<FJsonValueArray>(Arr);
    }
}

// The conversion every property write now goes through. Three handlers used to
// carry their own copy of this and each one was subtly different — the point of
// these tests is that there is one behaviour to characterise.
IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPReflectionSetValueTest,
    "Hayba.MCP.Reflection.SetValueFromJson",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPReflectionSetValueTest::RunTest(const FString& Parameters)
{
    UPointLightComponent* Light = NewObject<UPointLightComponent>(GetTransientPackage());
    if (!TestNotNull(TEXT("test component constructed"), Light)) return true;

    UClass* C = Light->GetClass();

    // Numeric property from a JSON number.
    {
        FProperty* P = C->FindPropertyByName(TEXT("Intensity"));
        if (TestNotNull(TEXT("Intensity exists"), P))
        {
            TestTrue(TEXT("sets a float from a number"), HaybaReflection::SetValueFromJson(P, Light, Num(1234.0), Light));
            TestEqual(TEXT("float round-trips"), Light->Intensity, 1234.0f);
        }
    }

    // Bool from a JSON bool.
    {
        FProperty* P = C->FindPropertyByName(TEXT("CastShadows"));
        if (TestNotNull(TEXT("CastShadows exists"), P))
        {
            TestTrue(TEXT("sets a bool"), HaybaReflection::SetValueFromJson(P, Light, MakeShared<FJsonValueBoolean>(false), Light));
            TestFalse(TEXT("bool round-trips"), Light->CastShadows != 0);
        }
    }

    // Struct from a numeric ARRAY, dispatched on the struct's real type.
    // The old per-handler code guessed from array length: a 4-number array was
    // always formatted as a colour, so this same input failed on anything that
    // was not one.
    {
        FProperty* P = C->FindPropertyByName(TEXT("LightColor"));
        if (TestNotNull(TEXT("LightColor exists"), P))
        {
            TestTrue(TEXT("sets an FColor from a 4-number array"),
                HaybaReflection::SetValueFromJson(P, Light, NumArray({255, 128, 0, 255}), Light));
            TestEqual(TEXT("R round-trips"), (int32)Light->LightColor.R, 255);
            TestEqual(TEXT("G round-trips"), (int32)Light->LightColor.G, 128);
            TestEqual(TEXT("B round-trips"), (int32)Light->LightColor.B, 0);
        }
    }

    // Struct from a nested JSON OBJECT — the shape the text path rejected
    // outright as "unsupported value type".
    {
        UStaticMeshComponent* Mesh = NewObject<UStaticMeshComponent>(GetTransientPackage());
        FProperty* P = Mesh->GetClass()->FindPropertyByName(TEXT("RelativeLocation"));
        if (TestNotNull(TEXT("RelativeLocation exists"), P))
        {
            TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
            Obj->SetNumberField(TEXT("X"), 10.0);
            Obj->SetNumberField(TEXT("Y"), 20.0);
            Obj->SetNumberField(TEXT("Z"), 30.0);
            TestTrue(TEXT("sets a struct from a nested object"),
                HaybaReflection::SetValueFromJson(P, Mesh, MakeShared<FJsonValueObject>(Obj), Mesh));
            TestEqual(TEXT("X round-trips"), Mesh->GetRelativeLocation().X, 10.0);
            TestEqual(TEXT("Z round-trips"), Mesh->GetRelativeLocation().Z, 30.0);
        }

        // Partial application is deliberate: callers merge onto the current
        // value, so setting only Y must leave X and Z alone.
        if (P)
        {
            TSharedPtr<FJsonObject> Partial = MakeShared<FJsonObject>();
            Partial->SetNumberField(TEXT("Y"), 99.0);
            TestTrue(TEXT("partial struct update succeeds"),
                HaybaReflection::SetValueFromJson(P, Mesh, MakeShared<FJsonValueObject>(Partial), Mesh));
            TestEqual(TEXT("Y updated"), Mesh->GetRelativeLocation().Y, 99.0);
            TestEqual(TEXT("X left alone"), Mesh->GetRelativeLocation().X, 10.0);
            TestEqual(TEXT("Z left alone"), Mesh->GetRelativeLocation().Z, 30.0);
        }

        // A struct also still accepts UE's own text form, which is what the old
        // text-only path supported — so nothing that worked before stops.
        if (P)
        {
            TestTrue(TEXT("sets a struct from an ImportText string"),
                HaybaReflection::SetValueFromJson(P, Mesh, Str(TEXT("(X=1.000,Y=2.000,Z=3.000)")), Mesh));
            TestEqual(TEXT("text-form X"), Mesh->GetRelativeLocation().X, 1.0);
            TestEqual(TEXT("text-form Y"), Mesh->GetRelativeLocation().Y, 2.0);
        }
    }

    // Enum by name, including the bare tail of a prefixed enumerator.
    {
        FProperty* P = C->FindPropertyByName(TEXT("IntensityUnits"));
        if (P)
        {
            TestTrue(TEXT("sets an enum by name"),
                HaybaReflection::SetValueFromJson(P, Light, Str(TEXT("Candelas")), Light));
        }
    }

    // Failure must be reported, not swallowed. A garbage value on a struct is
    // the case that used to come back as a phantom success in some paths.
    {
        UStaticMeshComponent* Mesh = NewObject<UStaticMeshComponent>(GetTransientPackage());
        FProperty* P = Mesh->GetClass()->FindPropertyByName(TEXT("RelativeLocation"));
        if (P)
        {
            TestFalse(TEXT("unparseable struct text fails"),
                HaybaReflection::SetValueFromJson(P, Mesh, Str(TEXT("not a vector")), Mesh));
        }

        // An object property pointed at something that does not resolve is a
        // failure the caller needs to hear about.
        FProperty* MeshProp = Mesh->GetClass()->FindPropertyByName(TEXT("StaticMesh"));
        if (MeshProp)
        {
            TestFalse(TEXT("unresolvable object reference fails"),
                HaybaReflection::SetValueFromJson(MeshProp, Mesh, Str(TEXT("/Game/Nope.Nope")), Mesh));
        }
    }

    // Null property / null container / null value must not crash.
    {
        TestFalse(TEXT("null property is refused"), HaybaReflection::SetValueFromJson(nullptr, Light, Num(1), Light));
        FProperty* P = C->FindPropertyByName(TEXT("Intensity"));
        TestFalse(TEXT("null container is refused"), HaybaReflection::SetValueFromJson(P, nullptr, Num(1), Light));
        TestFalse(TEXT("null value is refused"), HaybaReflection::SetValueFromJson(P, Light, nullptr, Light));
    }

    return true;
}

// actor_set_properties end-to-end: the handler that used to carry its own
// text-only copy of the conversion.
IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPActorSetPropertiesTest,
    "Hayba.MCP.Actor.SetPropertiesThroughReflection",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPActorSetPropertiesTest::RunTest(const FString& Parameters)
{
    UEditorActorSubsystem* EAS = GEditor ? GEditor->GetEditorSubsystem<UEditorActorSubsystem>() : nullptr;
    if (!TestNotNull(TEXT("EditorActorSubsystem available"), EAS)) return true;

    AActor* Actor = EAS->SpawnActorFromClass(APointLight::StaticClass(), FVector::ZeroVector, FRotator::ZeroRotator);
    if (!TestNotNull(TEXT("spawned a test actor"), Actor)) return true;
    const FString ActorId = Actor->GetName();

    FHaybaMCPActorHandler Handler;

    // A nested JSON object now applies. Before this change the handler
    // stringified the value and handed it to ImportText, so an object came back
    // as "unsupported value type" — while the very same shape worked on a
    // widget, because the UI handler used the reflection module.
    {
        TSharedPtr<FJsonObject> Loc = MakeShared<FJsonObject>();
        Loc->SetNumberField(TEXT("X"), 100.0);
        Loc->SetNumberField(TEXT("Y"), 200.0);
        Loc->SetNumberField(TEXT("Z"), 300.0);

        TSharedPtr<FJsonObject> Props = MakeShared<FJsonObject>();
        Props->SetObjectField(TEXT("RelativeLocation"), Loc);

        TSharedPtr<FJsonObject> P = MakeShared<FJsonObject>();
        P->SetStringField(TEXT("actor_id"), ActorId);
        P->SetObjectField(TEXT("properties"), Props);

        const FHaybaHandlerResult R = Handler.Handle(TEXT("actor_set_properties"), P);
        // RelativeLocation lives on the root component rather than the actor, so
        // this may legitimately be reported as skipped — what must NOT happen is
        // a claim of success with nothing applied.
        if (R.bOk && R.Data.IsValid())
        {
            double SetCount = -1;
            R.Data->TryGetNumberField(TEXT("set_count"), SetCount);
            const TArray<TSharedPtr<FJsonValue>>* Skipped = nullptr;
            R.Data->TryGetArrayField(TEXT("skipped"), Skipped);
            const int32 SkippedNum = Skipped ? Skipped->Num() : 0;
            TestEqual(TEXT("every requested key is either set or reported skipped"),
                (int32)SetCount + SkippedNum, 1);
        }
    }

    // An unknown property must be named in `skipped`, never silently dropped.
    {
        TSharedPtr<FJsonObject> Props = MakeShared<FJsonObject>();
        Props->SetStringField(TEXT("NoSuchPropertyAnywhere"), TEXT("x"));

        TSharedPtr<FJsonObject> P = MakeShared<FJsonObject>();
        P->SetStringField(TEXT("actor_id"), ActorId);
        P->SetObjectField(TEXT("properties"), Props);

        const FHaybaHandlerResult R = Handler.Handle(TEXT("actor_set_properties"), P);
        // Nothing applied out of one requested → the handler reports failure
        // rather than an empty success.
        TestFalse(TEXT("a request where nothing applied is not reported as success"), R.bOk);
        if (!R.bOk)
        {
            TestTrue(TEXT("error mentions the actor"), R.ErrorMessage.Contains(ActorId));
        }
    }

    EAS->DestroyActor(Actor);
    return true;
}

#endif // WITH_EDITOR
