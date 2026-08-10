#include "Misc/AutomationTest.h"
#include "handlers/HaybaMCPAssetHandler.h"
#include "handlers/HaybaMCPAssetRegistryQuery.h"

#if WITH_DEV_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaMCPAssetRegistryQueryTest,
    "Hayba.MCP.Asset.RegistryQuery.Unit",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPAssetRegistryQueryTest::RunTest(const FString& Parameters)
{
    using namespace HaybaAssetRegistryQuery;
    FHaybaMCPAssetHandler Handler;
    TestTrue(TEXT("native handler advertises asset_registry_query"),
        Handler.GetCommands().Contains(TEXT("asset_registry_query")));

    FParams Parsed;
    FString Error;
    TSharedPtr<FJsonObject> Invalid = MakeShared<FJsonObject>();
    Invalid->SetNumberField(TEXT("limit"), 0);
    TestFalse(TEXT("zero limit rejected"), ParseParams(Invalid, Parsed, Error));
    Invalid = MakeShared<FJsonObject>();
    Invalid->SetNumberField(TEXT("offset"), 1.5);
    TestFalse(TEXT("fractional offset rejected"), ParseParams(Invalid, Parsed, Error));
    Invalid = MakeShared<FJsonObject>();
    Invalid->SetStringField(TEXT("path_prefix"), TEXT("Game/Bad"));
    TestFalse(TEXT("non-package path rejected"), ParseParams(Invalid, Parsed, Error));
    Invalid = MakeShared<FJsonObject>();
    Invalid->SetStringField(TEXT("class_filter"), TEXT("   "));
    TestFalse(TEXT("blank direct-native filter rejected"), ParseParams(Invalid, Parsed, Error));
    Invalid = MakeShared<FJsonObject>();
    Invalid->SetStringField(TEXT("recursive"), TEXT("true"));
    TestFalse(TEXT("wrong-type direct-native recursive rejected"), ParseParams(Invalid, Parsed, Error));
    Invalid = MakeShared<FJsonObject>();
    Invalid->SetStringField(TEXT("limit"), TEXT("50"));
    TestFalse(TEXT("numeric-looking string limit rejected"), ParseParams(Invalid, Parsed, Error));
    Invalid = MakeShared<FJsonObject>();
    Invalid->SetStringField(TEXT("offset"), TEXT("0"));
    TestFalse(TEXT("numeric-looking string offset rejected"), ParseParams(Invalid, Parsed, Error));
    Invalid = MakeShared<FJsonObject>();
    Invalid->SetBoolField(TEXT("class_filter"), true);
    TestFalse(TEXT("wrong-type direct-native class filter rejected"), ParseParams(Invalid, Parsed, Error));
    Invalid = MakeShared<FJsonObject>();
    Invalid->SetNumberField(TEXT("name_contains"), 7);
    TestFalse(TEXT("wrong-type direct-native name filter rejected"), ParseParams(Invalid, Parsed, Error));
    Invalid = MakeShared<FJsonObject>();
    Invalid->SetBoolField(TEXT("path_prefix"), true);
    TestFalse(TEXT("wrong-type direct-native path filter rejected"), ParseParams(Invalid, Parsed, Error));
    Invalid = MakeShared<FJsonObject>();
    Invalid->SetNumberField(TEXT("limit"), 501);
    TestFalse(TEXT("oversized direct-native page rejected"), ParseParams(Invalid, Parsed, Error));
    TestFalse(TEXT("failed registry reads are not success"), ValidateRegistryRead(false, Error));
    TestTrue(TEXT("successful registry reads pass"), ValidateRegistryRead(true, Error));

    FParams P;
    P.ClassFilter = TEXT("StaticMesh");
    P.NameContains = TEXT("rock");
    P.PathPrefix = TEXT("/Game/Meshes");
    P.bRecursive = true;
    P.Limit = 1;
    P.Offset = 1;
    const TArray<FRow> Rows = {
        {TEXT("SM_Rock_B"), TEXT("/Game/Meshes/Sub/SM_Rock_B"), TEXT("StaticMesh")},
        {TEXT("M_Rock"), TEXT("/Game/Meshes/M_Rock"), TEXT("Material")},
        {TEXT("SM_Tree"), TEXT("/Game/Meshes/SM_Tree"), TEXT("StaticMesh")},
        {TEXT("SM_ROCK_A"), TEXT("/Game/Meshes/SM_Rock_A"), TEXT("StaticMesh")},
        {TEXT("SM_Rock_Other"), TEXT("/Game/Other/SM_Rock_Other"), TEXT("StaticMesh")},
    };
    TArray<FRow> Page;
    int32 Total = 0, NextOffset = 0;
    bool bHasMore = false;
    FilterSortAndPage(Rows, P, Page, Total, bHasMore, NextOffset);
    TestEqual(TEXT("filters determine total before paging"), Total, 2);
    TestEqual(TEXT("one row page"), Page.Num(), 1);
    if (Page.Num() == 1) TestEqual(TEXT("stable path ordering"), Page[0].Name, FString(TEXT("SM_Rock_B")));
    TestFalse(TEXT("second page is terminal"), bHasMore);
    TestEqual(TEXT("next offset is bounded by total"), NextOffset, 2);

    P.Offset = 0;
    P.bRecursive = false;
    P.PathPrefix = TEXT("/game/meshes");
    FilterSortAndPage(Rows, P, Page, Total, bHasMore, NextOffset);
    TestEqual(TEXT("non-recursive path uses case-insensitive package semantics and excludes children"), Total, 1);
    TestEqual(TEXT("first page next offset"), NextOffset, 1);
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaMCPAssetRegistryQueryLiveContractTest,
    "Hayba.MCP.Asset.RegistryQuery.LiveContract",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPAssetRegistryQueryLiveContractTest::RunTest(const FString& Parameters)
{
    TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
    Params->SetStringField(TEXT("path_prefix"), TEXT("/Engine"));
    Params->SetBoolField(TEXT("recursive"), true);
    Params->SetNumberField(TEXT("limit"), 1);
    Params->SetNumberField(TEXT("offset"), 0);
    FHaybaMCPAssetHandler Handler;
    const FHaybaHandlerResult Result = Handler.Handle(TEXT("asset_registry_query"), Params);
    if (!Result.bOk)
    {
        TestTrue(TEXT("loading registry fails explicitly rather than returning an empty success"),
            Result.ErrorMessage.Contains(TEXT("still discovering assets")));
        return true;
    }
    if (!TestTrue(TEXT("live query returns data"), Result.Data.IsValid())) return false;
    const TArray<TSharedPtr<FJsonValue>>* Assets = nullptr;
    TestTrue(TEXT("ok is truthful"), Result.Data->GetBoolField(TEXT("ok")));
    TestTrue(TEXT("assets is an array"), Result.Data->TryGetArrayField(TEXT("assets"), Assets));
    TestTrue(TEXT("total present"), Result.Data->HasTypedField<EJson::Number>(TEXT("total")));
    TestTrue(TEXT("has_more present"), Result.Data->HasTypedField<EJson::Boolean>(TEXT("has_more")));
    TestTrue(TEXT("next_offset present"), Result.Data->HasTypedField<EJson::Number>(TEXT("next_offset")));
    TestTrue(TEXT("native limit honored"), Assets && Assets->Num() <= 1);
    const int32 Total = Result.Data->GetIntegerField(TEXT("total"));
    const int32 NextOffset = Result.Data->GetIntegerField(TEXT("next_offset"));
    TestTrue(TEXT("live Engine registry is non-empty"), Total > 0);
    TestEqual(TEXT("live first page has expected size"), Assets ? Assets->Num() : 0, FMath::Min(1, Total));
    TestEqual(TEXT("live next_offset matches returned rows"), NextOffset, Assets ? Assets->Num() : 0);
    TestEqual(TEXT("live has_more agrees with total"), Result.Data->GetBoolField(TEXT("has_more")), NextOffset < Total);
    if (Assets)
    {
        for (const TSharedPtr<FJsonValue>& Value : *Assets)
        {
            const TSharedPtr<FJsonObject>* Row = nullptr;
            if (!TestTrue(TEXT("asset row is object"), Value->TryGetObject(Row)) || !Row) continue;
            TestTrue(TEXT("row name present"), (*Row)->HasTypedField<EJson::String>(TEXT("name")));
            TestTrue(TEXT("row path present"), (*Row)->HasTypedField<EJson::String>(TEXT("path")));
            TestTrue(TEXT("row class present"), (*Row)->HasTypedField<EJson::String>(TEXT("class")));
            TestTrue(TEXT("row honors path filter"), (*Row)->GetStringField(TEXT("path")).StartsWith(TEXT("/Engine/")));
        }
    }
    return true;
}

#endif
