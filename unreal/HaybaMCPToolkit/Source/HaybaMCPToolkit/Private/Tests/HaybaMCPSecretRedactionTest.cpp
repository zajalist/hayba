#include "Misc/AutomationTest.h"

#include "HaybaMCPSecretRedaction.h"
#include "Dom/JsonValue.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

#if WITH_DEV_AUTOMATION_TESTS

namespace
{
    FString SerializeObject(const TSharedPtr<FJsonObject>& Object)
    {
        FString Out;
        const TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
            TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Out);
        FJsonSerializer::Serialize(Object.ToSharedRef(), Writer);
        return Out;
    }

    bool ContainsString(const TArray<FString>& Values, const FString& Expected)
    {
        return Values.Contains(Expected);
    }
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPSecretRedactionTest,
    "Hayba.MCP.Security.SecretRedaction",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPSecretRedactionTest::RunTest(const FString&)
{
    using namespace HaybaMCPSecretRedaction;

    {
        TSharedPtr<FJsonObject> Input = MakeShared<FJsonObject>();
        Input->SetStringField(TEXT("apiKey"), TEXT("SENTINEL_API"));
        Input->SetStringField(TEXT("ACCESS_TOKEN"), TEXT("SENTINEL_ACCESS"));
        Input->SetStringField(TEXT("clientSecret"), TEXT("SENTINEL_CLIENT"));
        Input->SetStringField(TEXT("SECRETKEY"), TEXT("SENTINEL_CONCAT_SECRET"));
        Input->SetStringField(TEXT("ApiAccessToken"), TEXT("SENTINEL_CONCAT_TOKEN"));
        Input->SetNumberField(TEXT("token_count"), 42);
        Input->SetStringField(TEXT("tokenizer"), TEXT("sentencepiece"));
        Input->SetBoolField(TEXT("passwordless"), true);
        Input->SetStringField(TEXT("secretStatus"), TEXT("absent"));
        Input->SetStringField(TEXT("authorization_error"), TEXT("none"));
        Input->SetStringField(TEXT("apiKeyName"), TEXT("OPENAI_API_KEY"));

        const FResult Result = Redact(Input);
        const FString Serialized = SerializeObject(Result.Value);
        TestFalse(TEXT("mixed/camel/snake secret values never escape"), Serialized.Contains(TEXT("SENTINEL")));
        TestEqual(TEXT("source graph is not mutated"), Input->GetStringField(TEXT("apiKey")), FString(TEXT("SENTINEL_API")));
        TestTrue(TEXT("API category reported"), ContainsString(Result.Summary.Categories, TEXT("api_key")));
        TestTrue(TEXT("token category reported"), ContainsString(Result.Summary.Categories, TEXT("token")));
        TestTrue(TEXT("measurement key survives"), Result.Value->HasField(TEXT("token_count")));
        TestEqual(TEXT("harmless tokenizer survives"), Result.Value->GetStringField(TEXT("tokenizer")), FString(TEXT("sentencepiece")));
        TestTrue(TEXT("passwordless remains a boolean"), Result.Value->GetBoolField(TEXT("passwordless")));
        TestEqual(TEXT("secret status is not itself a secret"), Result.Value->GetStringField(TEXT("secretStatus")), FString(TEXT("absent")));
    }

    {
        const FString Jwt = TEXT("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.dGVzdHNpZ25hdHVyZQ");
        TSharedPtr<FJsonObject> Input = MakeShared<FJsonObject>();
        FString Prose = TEXT("Authorization: Bearer SENTINEL_BEARER_123456\n");
        Prose += FString::Printf(TEXT("jwt=%s\n"), *Jwt);
        Prose += TEXT("OPENAI_API_KEY=sk-1234567890abcdefghijklmnop\n");
        Prose += TEXT("https://user:SENTINEL_PASSWORD@example.test/path?token=SENTINEL_QUERY&safe=yes\n");
        Prose += TEXT("-----BEGIN PRIVATE KEY-----\nSENTINEL_PRIVATE\n-----END PRIVATE KEY-----");
        Input->SetStringField(TEXT("message"), Prose);
        Input->SetStringField(TEXT("hostile_marker"),
            TEXT("[REDACTED:token] Bearer SENTINEL_MARKER_BEARER_123456"));
        Input->SetStringField(TEXT("hostile_truncation"),
            TEXT("prefix [TRUNCATED:depth] token=SENTINEL_MARKER_TOKEN"));
        Input->SetStringField(TEXT("apiKey"),
            TEXT("[REDACTED:token] SENTINEL_STRUCTURAL_MARKER_BYPASS"));

        const FResult Once = Redact(Input);
        const FResult Twice = Redact(Once.Value);
        const FString Serialized = SerializeObject(Once.Value);
        TestFalse(TEXT("prose credentials never escape"), Serialized.Contains(TEXT("SENTINEL")));
        TestFalse(TEXT("JWT never escapes"), Serialized.Contains(Jwt));
        TestTrue(TEXT("safe URL query survives"), Serialized.Contains(TEXT("safe=yes")));
        TestTrue(TEXT("attacker marker prefix is rescanned"),
            Once.Value->GetStringField(TEXT("hostile_marker")).Contains(TEXT("[REDACTED:bearer]")));
        TestEqual(TEXT("a marker prefix cannot bypass a secret-named property"),
            Once.Value->GetStringField(TEXT("apiKey")), FString(TEXT("[REDACTED:api_key]")));
        TestTrue(TEXT("exact markers make the second pass reference-stable"), Twice.Value == Once.Value);
        TestFalse(TEXT("second pass applies nothing"), Twice.Summary.bApplied);
    }

    {
        TSharedPtr<FJsonObject> Input = MakeShared<FJsonObject>();
        const FString ProviderKey = TEXT("sk-1234567890abcdefghijklmnop");
        const FString UrlKey = TEXT("https://example.test/callback?token=SENTINEL_KEY_QUERY");
        const FString BearerKey = TEXT("Authorization: Bearer SENTINEL_KEY_BEARER_123456");
        const FString ProviderCollision = FString::Printf(
            TEXT("_redacted_key_provider_key_%08x"), GetTypeHash(ProviderKey));
        Input->SetNumberField(ProviderKey, 1);
        Input->SetNumberField(UrlKey, 2);
        Input->SetNumberField(BearerKey, 3);
        Input->SetStringField(ProviderCollision, TEXT("collision remains safe"));
        Input->SetStringField(TEXT("__proto__"), TEXT("prototype spelling remains data"));
        Input->SetStringField(TEXT("constructor"), TEXT("plain constructor"));
        Input->SetNumberField(TEXT("token_count"), 4);

        const FResult Result = Redact(Input);
        const FString Serialized = SerializeObject(Result.Value);
        TestFalse(TEXT("secret-bearing serialized property names never escape"), Serialized.Contains(TEXT("SENTINEL_KEY")));
        TestFalse(TEXT("provider key property never escapes"), Serialized.Contains(ProviderKey));
        TArray<FString> ResultKeys;
        for (const auto& Pair : Result.Value->Values)
        {
            ResultKeys.Add(FString(*Pair.Key));
        }
        const FString* ProviderPlaceholder = ResultKeys.FindByPredicate([](const FString& Key)
        {
            return Key.StartsWith(TEXT("_redacted_key_provider_key_"))
                && Key.EndsWith(TEXT("_1"));
        });
        TestTrue(TEXT("placeholder avoids an existing collision"), ProviderPlaceholder != nullptr);
        TestTrue(TEXT("prototype-looking key is ordinary inert JSON"), Result.Value->HasField(TEXT("__proto__")));
        TestTrue(TEXT("constructor-looking key is ordinary inert JSON"), Result.Value->HasField(TEXT("constructor")));
    }

    {
        TSharedPtr<FJsonObject> Cycle = MakeShared<FJsonObject>();
        Cycle->SetBoolField(TEXT("safe"), true);
        Cycle->SetObjectField(TEXT("self"), Cycle);

        TSharedPtr<FJsonObject> Deep = MakeShared<FJsonObject>();
        TSharedPtr<FJsonObject> Cursor = Deep;
        for (int32 Index = 0; Index < 8; ++Index)
        {
            TSharedPtr<FJsonObject> Next = MakeShared<FJsonObject>();
            Cursor->SetObjectField(FString::Printf(TEXT("level_%d"), Index), Next);
            Cursor = Next;
        }
        Cursor->SetStringField(TEXT("apiKey"), TEXT("SENTINEL_DEEP"));

        TSharedPtr<FJsonObject> Input = MakeShared<FJsonObject>();
        Input->SetObjectField(TEXT("cycle"), Cycle);
        Input->SetObjectField(TEXT("deep"), Deep);
        Input->SetField(TEXT("invalid_child"), TSharedPtr<FJsonValue>());
        TArray<TSharedPtr<FJsonValue>> Items;
        for (int32 Index = 0; Index < 20; ++Index)
        {
            Items.Add(MakeShared<FJsonValueNumber>(Index));
        }
        Input->SetArrayField(TEXT("items"), Items);
        for (int32 Index = 0; Index < 20; ++Index)
        {
            Input->SetNumberField(FString::Printf(TEXT("filler_%d"), Index), Index);
        }
        Input->SetStringField(TEXT("error"), TEXT("bounded useful error"));
        Input->SetStringField(TEXT("mandatory_recovery"), TEXT("Reconnect and retry with the same key."));

        FLimits Limits;
        Limits.MaxDepth = 3;
        Limits.MaxNodes = 50;
        Limits.MaxArrayItems = 4;
        Limits.MaxObjectKeys = 8;
        Limits.MaxKeyChars = 32;
        Limits.MaxStringChars = 32;
        Limits.MaxTotalStringChars = 64;
        const FResult Result = Redact(Input, Limits);
        const FString Serialized = SerializeObject(Result.Value);
        TestFalse(TEXT("bounded output contains no deep sentinel"), Serialized.Contains(TEXT("SENTINEL_DEEP")));
        TestTrue(TEXT("cycle is classified"), ContainsString(Result.Summary.TruncationReasons, TEXT("cycle")));
        TestTrue(TEXT("object key cap is classified"), ContainsString(Result.Summary.TruncationReasons, TEXT("object_keys")));
        TestTrue(TEXT("mandatory error survives a saturated object"), Result.Value->HasField(TEXT("error")));
        TestTrue(TEXT("mandatory recovery survives a saturated object"), Result.Value->HasField(TEXT("mandatory_recovery")));
        Cycle->RemoveField(TEXT("self")); // Do not leave a shared-pointer cycle behind in the test process.
    }

    {
        TSharedPtr<FJsonObject> Input = MakeShared<FJsonObject>();
        Input->SetField(TEXT("invalid_child"), TSharedPtr<FJsonValue>());
        const FResult Result = Redact(Input);
        TestTrue(TEXT("invalid JSON values fail closed"),
            ContainsString(Result.Summary.TruncationReasons, TEXT("accessor")));
        TestEqual(TEXT("invalid JSON value becomes an exact marker"),
            Result.Value->GetStringField(TEXT("invalid_child")), FString(TEXT("[TRUNCATED:accessor]")));
    }

    {
        TSharedPtr<FJsonObject> Input = MakeShared<FJsonObject>();
        TArray<TSharedPtr<FJsonValue>> Items;
        for (int32 Index = 0; Index < 20; ++Index)
        {
            Items.Add(MakeShared<FJsonValueString>(FString::Printf(TEXT("item-%d"), Index)));
        }
        Input->SetArrayField(TEXT("array"), Items);
        Input->SetStringField(TEXT("a_first"), FString::ChrN(24, TEXT('a')));
        Input->SetStringField(TEXT("b_second"), FString::ChrN(24, TEXT('b')));

        FLimits Limits;
        Limits.MaxArrayItems = 4;
        Limits.MaxStringChars = 32;
        Limits.MaxTotalStringChars = 32;
        const FResult Result = Redact(Input, Limits);
        TestTrue(TEXT("array cap is classified"),
            ContainsString(Result.Summary.TruncationReasons, TEXT("array_items")));
        TestTrue(TEXT("aggregate text cap is classified"),
            ContainsString(Result.Summary.TruncationReasons, TEXT("total_string_chars")));
        TestEqual(TEXT("array is bounded"), Result.Value->GetArrayField(TEXT("array")).Num(), 4);
    }

    {
        TSharedPtr<FJsonObject> Input = MakeShared<FJsonObject>();
        Input->SetStringField(TEXT("long"), FString::ChrN(100, TEXT('x')));
        FLimits Limits;
        Limits.MaxStringChars = 16;
        const FResult Result = Redact(Input, Limits);
        TestTrue(TEXT("per-string cap is classified"),
            ContainsString(Result.Summary.TruncationReasons, TEXT("string_chars")));
        TestTrue(TEXT("per-string cap emits an exact suffix marker"),
            Result.Value->GetStringField(TEXT("long")).EndsWith(TEXT("[TRUNCATED:string_chars]")));
    }

    {
        TSharedPtr<FJsonObject> Input = MakeShared<FJsonObject>();
        Input->SetStringField(TEXT("prose"),
            FString::ChrN(1000000, TEXT('a')) + TEXT(" Authorization: Bearer SENTINEL_TOO_LATE"));
        FLimits Limits;
        Limits.MaxStringChars = 2048;
        Limits.MaxTotalStringChars = 2048;
        const FResult Result = Redact(Input, Limits);
        TestTrue(TEXT("hostile prose is bounded before any regex walk"),
            Result.Value->GetStringField(TEXT("prose")).Len() < 2100);
        TestTrue(TEXT("hostile prose truncation is machine-readable"), Result.Summary.bTruncated);
    }

    {
        const FString OverlongKey = FString::ChrN(1000, TEXT('k'));
        TSharedPtr<FJsonObject> Input = MakeShared<FJsonObject>();
        Input->SetStringField(OverlongKey, TEXT("safe"));
        FLimits Limits;
        Limits.MaxKeyChars = 32;
        const FResult Result = Redact(Input, Limits);
        TestFalse(TEXT("an overlong serialized property name is not echoed"),
            SerializeObject(Result.Value).Contains(OverlongKey));
        TestTrue(TEXT("overlong property names are classified"),
            ContainsString(Result.Summary.TruncationReasons, TEXT("object_keys")));
    }

    {
        const auto MakeWideObject = [](bool bReverse)
        {
            TSharedPtr<FJsonObject> Object = MakeShared<FJsonObject>();
            for (int32 Step = 0; Step < 512; ++Step)
            {
                const int32 Index = bReverse ? 511 - Step : Step;
                const FString Key = FString::Printf(TEXT("ordinary_%04d_"), Index)
                    + FString::ChrN(512, static_cast<TCHAR>(TEXT('a') + (Index % 26)));
                Object->SetNumberField(Key, Index);
            }
            // Insert these last in one object and first in the other from the
            // hash map's perspective: priority, not encounter order, must keep
            // the response's mandatory facts.
            Object->SetStringField(TEXT("error"), TEXT("bounded error survives"));
            Object->SetStringField(TEXT("mandatory_recovery"), TEXT("reconnect safely"));
            return Object;
        };

        FLimits Limits;
        Limits.MaxObjectKeys = 8;
        Limits.MaxKeyChars = 32;
        const FResult Forward = Redact(MakeWideObject(false), Limits);
        const FResult Reverse = Redact(MakeWideObject(true), Limits);
        TestEqual(TEXT("bounded selector emits no more than K fields"), Forward.Value->Values.Num(), 8);
        TestTrue(TEXT("bounded selector retains error"), Forward.Value->HasField(TEXT("error")));
        TestTrue(TEXT("bounded selector retains mandatory recovery"),
            Forward.Value->HasField(TEXT("mandatory_recovery")));
        TestEqual(TEXT("bounded selection is independent of insertion order"),
            SerializeObject(Forward.Value), SerializeObject(Reverse.Value));
        TestTrue(TEXT("dropped/overlong keys produce one machine classification"),
            ContainsString(Forward.Summary.TruncationReasons, TEXT("object_keys")));
    }

    {
        TSharedPtr<FJsonObject> Deep = MakeShared<FJsonObject>();
        TSharedPtr<FJsonObject> Cursor = Deep;
        for (int32 Index = 0; Index < 6; ++Index)
        {
            TSharedPtr<FJsonObject> Next = MakeShared<FJsonObject>();
            Cursor->SetObjectField(TEXT("next"), Next);
            Cursor = Next;
        }
        TSharedPtr<FJsonObject> Input = MakeShared<FJsonObject>();
        Input->SetObjectField(TEXT("deep"), Deep);
        FLimits Limits;
        Limits.MaxDepth = 2;
        TestTrue(TEXT("depth cap is classified"),
            ContainsString(Redact(Input, Limits).Summary.TruncationReasons, TEXT("depth")));

        TArray<TSharedPtr<FJsonValue>> Many;
        for (int32 Index = 0; Index < 20; ++Index)
        {
            Many.Add(MakeShared<FJsonValueNumber>(Index));
        }
        TSharedPtr<FJsonObject> NodeInput = MakeShared<FJsonObject>();
        NodeInput->SetArrayField(TEXT("many"), Many);
        Limits = FLimits();
        Limits.MaxNodes = 5;
        TestTrue(TEXT("node cap is classified"),
            ContainsString(Redact(NodeInput, Limits).Summary.TruncationReasons, TEXT("nodes")));
    }

    {
        const FString SafeBearer = RedactTextForLog(
            TEXT("compiler said Authorization: Bearer SENTINEL_NATIVE_LOG_SECRET"), 256);
        TestFalse(TEXT("native log text drops bearer secrets"),
            SafeBearer.Contains(TEXT("SENTINEL_NATIVE_LOG_SECRET")));
        TestTrue(TEXT("native log text preserves useful surrounding diagnostics"),
            SafeBearer.Contains(TEXT("compiler said")));

        const FString Bounded = RedactTextForLog(FString::ChrN(10000, TEXT('x')), 128);
        TestTrue(TEXT("native log text is bounded"), Bounded.Len() <= 128);
    }

    {
        TSharedPtr<FJsonObject> Image = MakeShared<FJsonObject>();
        Image->SetStringField(TEXT("type"), TEXT("image"));
        Image->SetStringField(TEXT("data"), TEXT("QUJDREVGRw=="));
        Image->SetStringField(TEXT("mimeType"), TEXT("image/png"));
        TSharedPtr<FJsonObject> Audio = MakeShared<FJsonObject>();
        Audio->SetStringField(TEXT("type"), TEXT("audio"));
        Audio->SetStringField(TEXT("data"), TEXT("SEFZQkEtQVVESU8="));
        Audio->SetStringField(TEXT("mimeType"), TEXT("audio/wav"));
        TSharedPtr<FJsonObject> Input = MakeShared<FJsonObject>();
        Input->SetStringField(TEXT("png_base64"), TEXT("SEFZQkEtQklOQVJZ"));
        Input->SetStringField(TEXT("mesh_binary"), TEXT("TUVTSC1CSU5BUlk="));
        Input->SetStringField(TEXT("clipped_base64"), TEXT("Bearer SENTINEL_FALSE_OPAQUE"));
        Input->SetStringField(TEXT("provider_base64"), TEXT("AKIAABCDEFGHIJKLMNOP"));
        Input->SetStringField(TEXT("artifact_path"), TEXT("/Saved/SENTINEL_ARTIFACT.png"));
        Input->SetObjectField(TEXT("image"), Image);
        Input->SetObjectField(TEXT("audio"), Audio);
        Input->SetStringField(TEXT("secret_base64"), TEXT("SENTINEL_SECRET_BASE64"));

        const TSharedPtr<FJsonObject> Final = RedactFinalEnvelope(Input);
        TestEqual(TEXT("valid base64 remains byte-exact"),
            Final->GetStringField(TEXT("png_base64")), FString(TEXT("SEFZQkEtQklOQVJZ")));
        TestEqual(TEXT("image data remains byte-exact"),
            Final->GetObjectField(TEXT("image"))->GetStringField(TEXT("data")),
            FString(TEXT("QUJDREVGRw==")));
        TestEqual(TEXT("audio data remains byte-exact"),
            Final->GetObjectField(TEXT("audio"))->GetStringField(TEXT("data")),
            FString(TEXT("SEFZQkEtQVVESU8=")));
        TestEqual(TEXT("binary-labelled content remains byte-exact"),
            Final->GetStringField(TEXT("mesh_binary")), FString(TEXT("TUVTSC1CSU5BUlk=")));
        TestFalse(TEXT("a base64-looking key cannot make malformed prose opaque"),
            Final->GetStringField(TEXT("clipped_base64")).Contains(TEXT("SENTINEL_FALSE_OPAQUE")));
        TestEqual(TEXT("a provider credential that is also valid base64 is still redacted"),
            Final->GetStringField(TEXT("provider_base64")), FString(TEXT("[REDACTED:provider_key]")));
        TestEqual(TEXT("artifact paths are not generic prose"),
            Final->GetStringField(TEXT("artifact_path")), FString(TEXT("/Saved/SENTINEL_ARTIFACT.png")));
        TestFalse(TEXT("secret-named base64 is still masked"), SerializeObject(Final).Contains(TEXT("SENTINEL_SECRET_BASE64")));

        const TSharedPtr<FJsonObject> Meta = Final->GetObjectField(TEXT("_meta"));
        const TSharedPtr<FJsonObject> Summary = Meta->GetObjectField(TEXT("hayba/security_redaction"));
        TestTrue(TEXT("native boundary attaches a machine summary"), Summary->GetBoolField(TEXT("applied")));
        TestTrue(TEXT("machine summary reports a count"), Summary->GetNumberField(TEXT("redacted_values")) >= 1.0);
        TestTrue(TEXT("final boundary is idempotent"), RedactFinalEnvelope(Final) == Final);
    }

    return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
