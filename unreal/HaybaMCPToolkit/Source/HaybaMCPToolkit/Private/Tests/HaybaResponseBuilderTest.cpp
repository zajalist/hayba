// The response limiter, and the field it must never touch.
//
// FHaybaMCPResponseBuilder caps every string in every reply at 512 characters.
// That is right for a property dump and catastrophic for a base64 image: the
// clip does not produce a smaller image, it produces a non-empty string that is
// not valid base64. The MCP SDK rejects the content block outright ("Invalid
// Base64 string") and the WHOLE reply is lost, metadata included.
//
// ui_render_widget_to_png was unusable for at least a week because of this, and
// editor_capture_viewport was reported failing the same way earlier with a
// "_truncated: image_base64" marker naming the culprit. The exemption is by
// FIELD, not by command, because the previous mechanism was a per-command
// override that only protected the command somebody remembered.

#include "Misc/AutomationTest.h"
#include "HaybaMCPResponseBuilder.h"
#include "Dom/JsonObject.h"

#if WITH_DEV_AUTOMATION_TESTS

namespace
{
    /** A base64-ish payload comfortably over the 512-char cap. */
    FString FakeImagePayload()
    {
        FString S;
        while (S.Len() < 4000) S += TEXT("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk");
        return S;
    }
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaResponseBuilderImageExemptionTest,
    "Hayba.MCP.ResponseBuilder.ImageIsNeverTrimmed",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaResponseBuilderImageExemptionTest::RunTest(const FString&)
{
    const FString Payload = FakeImagePayload();

    {
        TSharedRef<FJsonObject> In = MakeShared<FJsonObject>();
        In->SetStringField(TEXT("image_base64"), Payload);
        In->SetStringField(TEXT("note"), Payload);   // control: not exempt

        FHaybaMCPResponseBuilder Builder{FHaybaResponseLimits()};
        TSharedRef<FJsonObject> Out = Builder.Build(In);

        TestEqual(TEXT("the image survives byte for byte"),
                  Out->GetStringField(TEXT("image_base64")), Payload);
        TestTrue(TEXT("an ordinary field is still capped, so the limiter still works"),
                 Out->GetStringField(TEXT("note")).Len() <= 512);
        TestTrue(TEXT("and the trimmed one is marked as such"),
                 Out->GetStringField(TEXT("note")).EndsWith(TEXT("...")));
    }

    {
        // The exact failure shape: a clipped payload is NON-EMPTY, which is why
        // an empty-string guard on the TS side never caught it.
        FHaybaResponseLimits Limits;
        Limits.NeverTrimFields.Empty();          // simulate the old behaviour
        TSharedRef<FJsonObject> In = MakeShared<FJsonObject>();
        In->SetStringField(TEXT("image_base64"), Payload);

        FHaybaMCPResponseBuilder Builder{Limits};
        TSharedRef<FJsonObject> Out = Builder.Build(In);
        const FString Clipped = Out->GetStringField(TEXT("image_base64"));

        TestTrue(TEXT("without the exemption it IS clipped"), Clipped.Len() < Payload.Len());
        TestFalse(TEXT("and clipping leaves it non-empty — which is why it read as valid"), Clipped.IsEmpty());
    }

    return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
