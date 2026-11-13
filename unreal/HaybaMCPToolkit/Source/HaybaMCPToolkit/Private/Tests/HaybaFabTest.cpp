#include "Misc/AutomationTest.h"
#include "HaybaMCPFab.h"
#include "HaybaMCPAccessPolicy.h"

#if WITH_DEV_AUTOMATION_TESTS
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaFabBoundaryTest, "Hayba.Fab.InputBoundary",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FHaybaFabBoundaryTest::RunTest(const FString&)
{
    const FString Valid = TEXT("https://www.fab.com/listings/12345678-1234-1234-1234-123456789abc");
    TestTrue(TEXT("Exact Fab listing accepted"), HaybaFab::IsTrustedListingUrl(Valid));
    TestFalse(TEXT("Trailing newline rejected"), HaybaFab::IsTrustedListingUrl(Valid + TEXT("\n")));
    TestFalse(TEXT("Trailing tab rejected"), HaybaFab::IsTrustedListingUrl(Valid + TEXT("\t")));
    for (const FString& Url : { TEXT("file:///C:/secret"), TEXT("https://www.fab.com.evil.test/listings/123"),
        TEXT("https://www.fab.com@evil.test/listings/123"), TEXT("https://www.fab.com/listings/../checkout") })
        TestFalse(TEXT("Untrusted URL rejected"), HaybaFab::IsTrustedListingUrl(Url));
    auto Params = MakeShared<FJsonObject>(); HaybaFab::FSearchRequest Request; FString Error;
    for (const FString& Command : { TEXT("fab_search"), TEXT("fab_search_status") })
        TestTrue(TEXT("Fab query needs no write lease"), HaybaMCPAccess::ClassifyCommand(Command, false).Class == HaybaMCPAccess::EAccessClass::Read);
    TestTrue(TEXT("Defaults accepted"), HaybaFab::ParseSearch(Params, Request, Error));
    TestEqual(TEXT("Bounded default"), Request.Limit, 12);
    Params->SetNumberField(TEXT("limit"), 24.5);
    TestFalse(TEXT("Fractional limit rejected"), HaybaFab::ParseSearch(Params, Request, Error));
    Params->SetNumberField(TEXT("limit"), 25);
    TestFalse(TEXT("Oversized page rejected"), HaybaFab::ParseSearch(Params, Request, Error));
    Params->RemoveField(TEXT("limit")); Params->SetStringField(TEXT("download_url"), TEXT("https://evil.test"));
    TestFalse(TEXT("Arbitrary download parameters rejected"), HaybaFab::ParseSearch(Params, Request, Error));
    Params->RemoveField(TEXT("download_url")); Params->SetStringField(TEXT("source"), TEXT("library")); Params->SetBoolField(TEXT("free_only"), true);
    TestFalse(TEXT("Unsupported library filter rejected"), HaybaFab::ParseSearch(Params, Request, Error));
    auto Poll = MakeShared<FJsonObject>(); Poll->SetStringField(TEXT("job_id"), TEXT("fab_missing"));
    TestFalse(TEXT("Unknown query cannot report completion"), HaybaFab::Execute(TEXT("fab_search_status"), Poll, TEXT("test-owner")).bOk);
    return true;
}
#endif
