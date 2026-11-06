// Custom-node HLSL lint, tested without an editor. The first case is the one that
// shipped: an apostrophe leaked into M_UI_SandText's Custom code, material_compile
// answered ok, the platform compile failed later, and the menu text rendered as nothing.

#include "Misc/AutomationTest.h"
#include "HaybaMaterialLint.h"

#if WITH_DEV_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMaterialLintCustomHlslTest,
    "Hayba.MCP.MaterialLint.CustomHlsl",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMaterialLintCustomHlslTest::RunTest(const FString&)
{
    using HaybaMaterialLint::LintCustomHlsl;

    TestFalse(TEXT("prose with an apostrophe is refused"),
        LintCustomHlsl(TEXT("float a = 1;\nthe sand doesn't settle\nreturn a;")).IsEmpty());
    TestTrue(TEXT("and the reason names the line"),
        LintCustomHlsl(TEXT("float a = 1;\nthe sand doesn't settle\nreturn a;")).Contains(TEXT("line 2")));

    TestTrue(TEXT("apostrophes inside comments are fine"),
        LintCustomHlsl(TEXT("// the ink's edge\n/* don't touch */\nreturn saturate(UV.x);")).IsEmpty());
    TestTrue(TEXT("a balanced function body passes"),
        LintCustomHlsl(TEXT("float2 p = UV * 2 - 1;\nfloat d = length(p);\nif (d > 1) { return 0; }\nreturn float4(d, d, d, 1)[0];")).IsEmpty());

    TestFalse(TEXT("unclosed string"), LintCustomHlsl(TEXT("const char* s = \"oops;\nreturn 0;")).IsEmpty());
    TestFalse(TEXT("unclosed block comment"), LintCustomHlsl(TEXT("/* never ends\nreturn 0;")).IsEmpty());
    TestFalse(TEXT("unclosed bracket"), LintCustomHlsl(TEXT("return saturate(UV.x;")).IsEmpty());
    TestFalse(TEXT("stray closer"), LintCustomHlsl(TEXT("return 1; }")).IsEmpty());
    TestFalse(TEXT("mismatched pair"), LintCustomHlsl(TEXT("return float2(1, 2];")).IsEmpty());
    TestFalse(TEXT("empty code"), LintCustomHlsl(TEXT("   \n ")).IsEmpty());
    return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
