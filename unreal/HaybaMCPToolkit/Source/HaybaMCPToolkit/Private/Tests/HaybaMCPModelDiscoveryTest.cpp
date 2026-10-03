#include "HaybaMCPModelDiscovery.h"
#include "Misc/AutomationTest.h"

#if WITH_DEV_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaMCPModelDiscoveryTest,
    "Hayba.MCP.Settings.ModelDiscoveryContract",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPModelDiscoveryTest::RunTest(const FString&)
{
    FString Base;
    TestTrue(TEXT("default localhost sidecar is accepted"),
        FHaybaMCPModelDiscoveryClient::TryCanonicalLoopbackBase(TEXT("http://localhost:7821"), Base));
    TestEqual(TEXT("localhost is sent to numeric loopback"), Base, FString(TEXT("http://127.0.0.1:7821")));
    TestTrue(TEXT("IPv6 loopback is accepted"),
        FHaybaMCPModelDiscoveryClient::TryCanonicalLoopbackBase(TEXT("http://[::1]:7821/"), Base));
    TestEqual(TEXT("IPv6 loopback remains numeric"), Base, FString(TEXT("http://[::1]:7821")));
    TestTrue(TEXT("IPv4 loopback is accepted"),
        FHaybaMCPModelDiscoveryClient::TryCanonicalLoopbackBase(TEXT("http://127.0.0.1:7821"), Base));

    for (const TCHAR* Unsafe : {
        TEXT("https://localhost:7821"), TEXT("http://localhost.evil:7821"),
        TEXT("http://localhost@evil:7821"), TEXT("http://127.0.0.2:7821"),
        TEXT("http://localhost:0"), TEXT("http://localhost:65536"),
        TEXT("http://localhost:7821/path"), TEXT("http://localhost:7821?x=1"),
        TEXT("http://localhost:7821#fragment"), TEXT("http://localhost%2eevil:7821"),
        TEXT("http://[::1]evil:7821") })
    {
        TestFalse(*FString::Printf(TEXT("reject non-loopback or non-origin URL: %s"), Unsafe),
            FHaybaMCPModelDiscoveryClient::TryCanonicalLoopbackBase(Unsafe, Base));
        TestTrue(TEXT("unsafe URL has no usable base"), Base.IsEmpty());
    }

    FHaybaMCPModelDiscoveryResult Found;
    const FString Live = TEXT("{\"provider\":\"deepseek\",\"status\":\"ok\",\"models\":["
        "{\"id\":\"vendor/Model.A-1\",\"name\":\"Model A\",\"chat_capable\":false,"
        "\"tool_use\":\"no\",\"reasoning_efforts\":[\"low\",\"high\"]},"
        "{\"id\":\"deepseek-flash\",\"name\":\"Flash\",\"chat_capable\":true,"
        "\"tool_use\":\"conditional\",\"reasoning_efforts\":[\"minimal\"]}],"
        "\"fetched_at\":\"2026-10-02T00:00:00.000Z\",\"stale\":false,\"cached\":false,"
        "\"partial\":false,\"manual_entry_allowed\":true,"
        "\"configured_model\":\"vendor/Model.A-1\",\"default_model\":\"deepseek-flash\","
        "\"api_key\":\"synthetic-secret-must-not-return\"}");
    TestTrue(TEXT("parse live catalog"), FHaybaMCPModelDiscoveryClient::TryParseModels(Live, TEXT("deepseek"), Found));
    TestTrue(TEXT("live status is typed"), Found.Status == EHaybaMCPModelDiscoveryStatus::Ok);
    TestEqual(TEXT("exact model count"), Found.Models.Num(), 2);
    if (Found.Models.Num() == 2)
    {
        TestEqual(TEXT("model ID case and punctuation preserved"), Found.Models[0].Id,
            FString(TEXT("vendor/Model.A-1")));
        TestEqual(TEXT("model display name separate from ID"), Found.Models[0].Name, FString(TEXT("Model A")));
        TestTrue(TEXT("non-chat model remains explicitly non-chat"),
            Found.Models[0].ChatCapability == EHaybaMCPModelChatCapability::No);
        TestTrue(TEXT("no tool use remains explicit"), Found.Models[0].ToolUse == EHaybaMCPModelToolUse::No);
        TestEqual(TEXT("reasoning efforts are preserved"), Found.Models[0].ReasoningEfforts.Num(), 2);
        TestTrue(TEXT("chat-capable model remains explicit"),
            Found.Models[1].ChatCapability == EHaybaMCPModelChatCapability::Yes);
        TestTrue(TEXT("conditional tool use is not reported as proven"),
            Found.Models[1].ToolUse == EHaybaMCPModelToolUse::Conditional);
    }
    TestFalse(TEXT("live result is not stale"), Found.bStale);
    TestFalse(TEXT("live result is not cached"), Found.bCached);
    TestFalse(TEXT("raw key is not returned in note"), Found.Note.Contains(TEXT("synthetic-secret")));
    TestFalse(TEXT("raw key is not returned in error"), Found.Error.Contains(TEXT("synthetic-secret")));

    const FString Stale = TEXT("{\"provider\":\"ollama\",\"status\":\"unavailable\","
        "\"models\":[{\"id\":\"qwen2.5:latest\",\"chat_capable\":null,\"tool_use\":\"unknown\"}],"
        "\"fetched_at\":\"2026-10-01T00:00:00.000Z\","
        "\"stale\":true,\"cached\":true,\"partial\":false,\"manual_entry_allowed\":true,"
        "\"reason\":\"network\",\"note\":\"Previously listed models are stale\","
        "\"configured_model\":null,\"default_model\":null}");
    TestTrue(TEXT("parse stale fallback"), FHaybaMCPModelDiscoveryClient::TryParseModels(Stale, TEXT("ollama"), Found));
    TestTrue(TEXT("stale fallback remains unavailable"), Found.Status == EHaybaMCPModelDiscoveryStatus::Unavailable);
    TestTrue(TEXT("stale flag is preserved"), Found.bStale);
    TestTrue(TEXT("cached flag is preserved"), Found.bCached);
    TestEqual(TEXT("stale model count"), Found.Models.Num(), 1);
    if (Found.Models.Num() == 1)
    {
        TestEqual(TEXT("stale model ID remains selectable only with a warning"), Found.Models[0].Id,
            FString(TEXT("qwen2.5:latest")));
        TestTrue(TEXT("null chat capability remains unknown"),
            Found.Models[0].ChatCapability == EHaybaMCPModelChatCapability::Unknown);
        TestTrue(TEXT("unknown tool use remains unknown"), Found.Models[0].ToolUse == EHaybaMCPModelToolUse::Unknown);
        TestTrue(TEXT("omitted reasoning efforts stay empty"), Found.Models[0].ReasoningEfforts.IsEmpty());
    }

    const FString Manual = TEXT("{\"provider\":\"custom\",\"status\":\"manual\",\"models\":[],"
        "\"fetched_at\":null,\"stale\":false,\"cached\":false,\"partial\":false,"
        "\"manual_entry_allowed\":true,\"reason\":\"custom_endpoint\","
        "\"configured_model\":null,\"default_model\":null}");
    TestTrue(TEXT("custom endpoint is manual"), FHaybaMCPModelDiscoveryClient::TryParseModels(Manual, TEXT("custom"), Found));
    TestTrue(TEXT("manual status is typed"), Found.Status == EHaybaMCPModelDiscoveryStatus::Manual);
    TestTrue(TEXT("manual entry stays available"), Found.bManualEntryAllowed);
    TestTrue(TEXT("manual result has no fabricated models"), Found.Models.IsEmpty());

    TestFalse(TEXT("reject response for a different provider"),
        FHaybaMCPModelDiscoveryClient::TryParseModels(Live, TEXT("openai"), Found));
    TestFalse(TEXT("reject malformed model ID"), FHaybaMCPModelDiscoveryClient::TryParseModels(
        Live.Replace(TEXT("vendor/Model.A-1"), TEXT("bad id")), TEXT("deepseek"), Found));
    TestFalse(TEXT("reject missing freshness flag"), FHaybaMCPModelDiscoveryClient::TryParseModels(
        Live.Replace(TEXT("\"cached\":false,"), TEXT("")), TEXT("deepseek"), Found));
    TestFalse(TEXT("reject a non-boolean chat capability"), FHaybaMCPModelDiscoveryClient::TryParseModels(
        Live.Replace(TEXT("\"chat_capable\":false"), TEXT("\"chat_capable\":\"yes\"")),
        TEXT("deepseek"), Found));
    TestTrue(TEXT("null tool support remains unknown"), FHaybaMCPModelDiscoveryClient::TryParseModels(
        Stale.Replace(TEXT("\"tool_use\":\"unknown\""), TEXT("\"tool_use\":null")),
        TEXT("ollama"), Found));
    if (Found.Models.Num() == 1)
        TestTrue(TEXT("null tool support is not guessed"), Found.Models[0].ToolUse == EHaybaMCPModelToolUse::Unknown);
    FString TooManyEfforts = TEXT("[");
    for (int32 Index = 0; Index < 17; ++Index)
        TooManyEfforts += Index == 0 ? TEXT("\"low\"") : TEXT(",\"low\"");
    TooManyEfforts += TEXT("]");
    TestFalse(TEXT("reject unbounded reasoning efforts"), FHaybaMCPModelDiscoveryClient::TryParseModels(
        Live.Replace(TEXT("[\"low\",\"high\"]"), *TooManyEfforts), TEXT("deepseek"), Found));
    return true;
}

#endif
