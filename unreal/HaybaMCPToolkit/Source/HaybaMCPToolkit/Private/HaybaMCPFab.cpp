#include "HaybaMCPFab.h"
#include "HaybaMCPParams.h"
#include "HaybaMCPSecretRedaction.h"
#include "Interfaces/IPluginManager.h"
#include "HAL/PlatformProcess.h"
#include "HAL/PlatformTime.h"
#include "Internationalization/Regex.h"
#include "Misc/Guid.h"
#include "Modules/ModuleManager.h"
#include "ToolMenus.h"
#include "Framework/MultiBox/MultiBox.h"
#if HAYBA_HAS_FAB_SEARCH
#include "FabModule.h"
#endif

namespace
{
    struct FSearchJob
    {
        FString Owner;
        FString Source;
        double Started = FPlatformTime::Seconds();
        TSharedPtr<FJsonObject> Result;
    };
    TMap<FString, TSharedPtr<FSearchJob>> Jobs;

    bool FabEnabled()
    {
        const TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("Fab"));
        return Plugin.IsValid() && Plugin->IsEnabled();
    }

    bool ExecuteMenuEntry(const FToolMenuEntry& Entry)
    {
        // ToolMenuEntry's direct action is private. Generate only this copied entry,
        // then use Slate's public action accessor; do not build the whole Window menu.
        UToolMenu* Menu = NewObject<UToolMenu>();
        Menu->InitMenu(FToolMenuOwner(), NAME_None);
        Menu->AddSection(TEXT("Fab")).AddEntry(Entry);
        const TSharedRef<SWidget> Widget = UToolMenus::Get()->GenerateWidget(Menu);
        if (Widget->GetType() != FName(TEXT("SMultiBoxWidget"))) return false;
        const auto MultiBox = StaticCastSharedRef<SMultiBoxWidget>(Widget)->GetMultiBox();
        for (const auto& Block : MultiBox->GetBlocks())
            if (Block->GetExtensionHook() == Entry.Name)
                return Block->GetDirectActions().Execute();
        return false;
    }

    TSharedRef<FJsonObject> Status(const FString& State)
    {
        auto Data = MakeShared<FJsonObject>();
        Data->SetStringField(TEXT("status"), State);
        return Data;
    }

#if HAYBA_HAS_FAB_SEARCH
    TArray<TSharedPtr<FJsonValue>> Formats(const TArray<FFabCatalogAssetFormat>& Input)
    {
        TArray<TSharedPtr<FJsonValue>> Values;
        for (int32 Index = 0; Index < FMath::Min(Input.Num(), 16); ++Index)
        {
            const auto& Format = Input[Index];
            auto Value = MakeShared<FJsonObject>();
            Value->SetStringField(TEXT("code"), Format.Code.Left(64));
            Value->SetStringField(TEXT("distribution_method"), Format.DistributionMethod.Left(64));
            Value->SetBoolField(TEXT("text_truncated"), Format.Code.Len() > 64 || Format.DistributionMethod.Len() > 64);
            TArray<TSharedPtr<FJsonValue>> Versions;
            bool bVersionsTruncated = Format.EngineVersions.Num() > 32;
            for (int32 Version = 0; Version < FMath::Min(Format.EngineVersions.Num(), 32); ++Version)
            {
                Versions.Add(MakeShared<FJsonValueString>(Format.EngineVersions[Version].Left(64)));
                bVersionsTruncated |= Format.EngineVersions[Version].Len() > 64;
            }
            Value->SetArrayField(TEXT("engine_versions"), Versions);
            Value->SetBoolField(TEXT("engine_versions_truncated"), bVersionsTruncated);
            Values.Add(MakeShared<FJsonValueObject>(Value));
        }
        return Values;
    }

    TSharedRef<FJsonObject> Listing(const FString& Id, const FString& Title, const FString& Seller,
        const TArray<FFabCatalogAssetFormat>& AssetFormats)
    {
        auto Row = MakeShared<FJsonObject>();
        Row->SetStringField(TEXT("listing_id"), Id.Left(128));
        Row->SetStringField(TEXT("title"), Title.Left(512));
        Row->SetStringField(TEXT("seller"), Seller.Left(256));
        Row->SetArrayField(TEXT("formats"), Formats(AssetFormats));
        Row->SetBoolField(TEXT("formats_truncated"), AssetFormats.Num() > 16);
        Row->SetBoolField(TEXT("text_truncated"), Id.Len() > 128 || Title.Len() > 512 || Seller.Len() > 256);
        return Row;
    }

    void Finish(const TWeakPtr<FSearchJob>& Weak, bool bOk, const FString& Error,
        const TArray<TSharedPtr<FJsonValue>>& Rows, const FString& Cursor, bool bResultsTruncated)
    {
        const auto Job = Weak.Pin();
        if (!Job || Job->Result.IsValid() || FPlatformTime::Seconds() - Job->Started > 60.0) return;
        Job->Result = Status(bOk && Cursor.Len() <= 4096 ? TEXT("done") : TEXT("failed"));
        if (!bOk || Cursor.Len() > 4096)
        {
            Job->Result->SetStringField(TEXT("error"), Cursor.Len() > 4096 ? TEXT("Fab returned an oversized paging cursor.") :
                HaybaMCPSecretRedaction::RedactTextForLog(Error, 2048));
            return;
        }
        Job->Result->SetStringField(TEXT("source"), Job->Source);
        Job->Result->SetArrayField(TEXT("results"), Rows);
        Job->Result->SetNumberField(TEXT("count"), Rows.Num());
        Job->Result->SetBoolField(TEXT("results_truncated"), bResultsTruncated);
        Job->Result->SetStringField(TEXT("next_cursor"), Cursor);
        Job->Result->SetBoolField(TEXT("has_more"), !Cursor.IsEmpty());
        Job->Result->SetStringField(TEXT("import_flow"), TEXT("Open Fab, choose My Library, and use the product's Add to Project control. No import was started by this search."));
    }
#endif
}

bool HaybaFab::IsTrustedListingUrl(const FString& Url)
{
    if (Url.Len() > 512) return false;
    for (const TCHAR Character : Url)
        if (Character <= 0x20 || Character == 0x7f || FChar::IsWhitespace(Character)) return false;
    static const FRegexPattern Pattern(TEXT("^https://(www\\.)?fab\\.com/([a-z]{2}-[a-z]{2}/)?listings/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/?$"));
    FRegexMatcher Match(Pattern, Url);
    return Match.FindNext();
}

bool HaybaFab::ParseSearch(const TSharedPtr<FJsonObject>& Params, FSearchRequest& Out, FString& Error)
{
    Error = HaybaUnknownParamsError(Params, TEXT("fab_search"), {TEXT("source"), TEXT("query"), TEXT("cursor"), TEXT("limit"), TEXT("free_only")});
    if (!Error.IsEmpty()) return false;
    FHaybaParamReader Reader(Params, TEXT("fab_search"));
    Out.Source = Reader.OptionalString(TEXT("source"), TEXT("catalog"));
    Out.Query = Reader.OptionalString(TEXT("query"), TEXT(""));
    Out.Cursor = Reader.OptionalString(TEXT("cursor"), TEXT(""));
    Out.bFreeOnly = Reader.OptionalBool(TEXT("free_only"), false);
    const double Limit = Reader.OptionalNumber(TEXT("limit"), 12.0);
    if (Reader.HasErrors()) { Error = Reader.ErrorMessage(); return false; }
    if ((Out.Source != TEXT("catalog") && Out.Source != TEXT("library")) || Out.Query.Len() > 500 ||
        Out.Cursor.Len() > 4096 || Limit < 1 || Limit > 24 || FMath::FloorToDouble(Limit) != Limit)
    { Error = TEXT("Fab requires source catalog/library, query <=500 characters, cursor <=4096 characters and integer limit 1..24."); return false; }
    if (Out.Source == TEXT("library") && Out.bFreeOnly)
    { Error = TEXT("free_only filters the catalog, not your owned library."); return false; }
    Out.Limit = static_cast<int32>(Limit);
    return true;
}

bool HaybaFab::OpenBrowser(FString& OutError)
{
    if (!IsInGameThread()) { OutError = TEXT("Open Fab from the editor game thread."); return false; }
    if (!FabEnabled()) { OutError = TEXT("Enable the Fab plugin in Edit > Plugins and restart the editor."); return false; }
    if (!FModuleManager::Get().LoadModulePtr<IModuleInterface>(TEXT("Fab")))
    { OutError = TEXT("The Fab plugin could not be loaded."); return false; }
    UToolMenu* Menu = UToolMenus::Get()->FindMenu(TEXT("MainFrame.MainMenu.Window"));
    FToolMenuSection* Section = Menu ? Menu->FindSection(TEXT("GetContent")) : nullptr;
    const FToolMenuEntry* Entry = Section ? Section->FindEntry(TEXT("OpenFabTab")) : nullptr;
    if (!Entry || !ExecuteMenuEntry(*Entry))
    { OutError = TEXT("Fab's editor menu is unavailable. Open Window > Fab after the editor has finished loading."); return false; }
    return true;
}

FHaybaHandlerResult HaybaFab::Execute(const FString& Command, const TSharedPtr<FJsonObject>& Params, const FString& Owner)
{
    if (!IsInGameThread()) return FHaybaHandlerResult::Err(TEXT("Fab commands require the editor game thread."));
    const double Now = FPlatformTime::Seconds();
    for (auto It = Jobs.CreateIterator(); It; ++It)
        if (Now - It.Value()->Started > 120.0) It.RemoveCurrent();
    if (Command == TEXT("fab_search_status"))
    {
        const FString Unknown = HaybaUnknownParamsError(Params, TEXT("fab_search_status"), {TEXT("job_id")});
        if (!Unknown.IsEmpty()) return FHaybaHandlerResult::Err(Unknown);
        FHaybaParamReader Reader(Params, Command);
        const FString Id = Reader.RequiredString(TEXT("job_id"), 64);
        if (Reader.HasErrors()) return FHaybaHandlerResult::Err(Reader.ErrorMessage());
        const auto* Found = Jobs.Find(Id);
        if (!Found || (*Found)->Owner != Owner) return FHaybaHandlerResult::Err(TEXT("Unknown or expired Fab search job for this caller."));
        const auto Job = *Found;
        if (!Job->Result && Now - Job->Started > 60.0)
        {
            Job->Result = Status(TEXT("failed"));
            Job->Result->SetStringField(TEXT("error"), TEXT("Fab search timed out; retry or check your connection and Fab sign-in."));
        }
        auto Data = Job->Result.IsValid() ? MakeShared<FJsonObject>(*Job->Result) : Status(TEXT("running"));
        Data->SetStringField(TEXT("job_id"), Id);
        return FHaybaHandlerResult::Ok(Data);
    }
    if (Command != TEXT("fab_search")) return FHaybaHandlerResult::Err(TEXT("Unknown Fab command."));
    FSearchRequest Request; FString Error;
    if (!ParseSearch(Params, Request, Error)) return FHaybaHandlerResult::Err(Error);
#if !HAYBA_HAS_FAB_SEARCH
    return FHaybaHandlerResult::Err(TEXT("Fab search requires UE 5.9's Fab catalog API. Use Window > Fab to browse and add content."));
#else
    if (!FabEnabled()) return FHaybaHandlerResult::Err(TEXT("Fab is disabled or missing. Enable Fab in Edit > Plugins and restart the editor."));
    IFabModule* Fab = FModuleManager::Get().LoadModulePtr<IFabModule>(TEXT("Fab"));
    if (!Fab) return FHaybaHandlerResult::Err(TEXT("Fab could not load; use Window > Fab to check its availability."));
    if (Jobs.Num() >= 32) return FHaybaHandlerResult::Err(TEXT("Fab search capacity reached; wait two minutes before retrying."));
    int32 Pending = 0;
    for (const auto& Pair : Jobs) if (Pair.Value->Owner == Owner && !Pair.Value->Result && Now - Pair.Value->Started < 60.0) ++Pending;
    if (Pending >= 4) return FHaybaHandlerResult::Err(TEXT("This caller already has four pending Fab searches. Poll them before searching again."));
    const FString Id = TEXT("fab_") + FGuid::NewGuid().ToString(EGuidFormats::Digits);
    auto Job = MakeShared<FSearchJob>(); Job->Owner = Owner; Job->Source = Request.Source;
    Jobs.Add(Id, Job);
    const TWeakPtr<FSearchJob> Weak = Job;
    if (Request.Source == TEXT("library"))
    {
        FFabOwnedListingFilter Filter; Filter.Query = Request.Query; Filter.MaxResults = Request.Limit; Filter.Cursor = Request.Cursor;
        Fab->SearchLibrary(Filter, FFabOwnedListingDelegate::CreateLambda([Weak, Limit = Request.Limit](bool bOk, const FFabOwnedListingPage& Page, const FString& Failure)
        {
            TArray<TSharedPtr<FJsonValue>> Rows;
            for (int32 Index = 0; bOk && Index < FMath::Min(Page.Listings.Num(), Limit); ++Index)
            {
                const auto& Item = Page.Listings[Index];
                auto Row = Listing(Item.ListingUid, Item.Title, Item.SellerName, Item.AssetFormats);
                Row->SetBoolField(TEXT("owned"), true);
                Row->SetBoolField(TEXT("downloadable"), Item.bCanRequestDownloadUrl);
                Row->SetBoolField(TEXT("listing_active"), Item.bIsActiveInLive);
                const FString Url = TEXT("https://www.fab.com/listings/") + Item.ListingUid;
                if (Item.bIsActiveInLive && IsTrustedListingUrl(Url)) Row->SetStringField(TEXT("url"), Url);
                Rows.Add(MakeShared<FJsonValueObject>(Row));
            }
            Finish(Weak, bOk, Failure, Rows, Page.NextCursor, Page.Listings.Num() > Limit);
        }));
    }
    else
    {
        FFabCatalogSearchFilter Filter; Filter.Query = Request.Query; Filter.MaxResults = Request.Limit;
        Filter.Cursor = Request.Cursor; Filter.bFreeOnly = Request.bFreeOnly;
        Fab->SearchCatalog(Filter, FFabCatalogSearchDelegate::CreateLambda([Weak, Limit = Request.Limit](bool bOk, const FFabCatalogPage& Page, const FString& Failure)
        {
            TArray<TSharedPtr<FJsonValue>> Rows;
            for (int32 Index = 0; bOk && Index < FMath::Min(Page.Listings.Num(), Limit); ++Index)
            {
                const auto& Item = Page.Listings[Index];
                auto Row = Listing(Item.Uid, Item.Title, Item.SellerName, Item.AssetFormats);
                Row->SetStringField(TEXT("ownership"), TEXT("unknown"));
                Row->SetBoolField(TEXT("free_license_available"), Item.bIsFree);
                Row->SetBoolField(TEXT("mature"), Item.bIsMature);
                if (IsTrustedListingUrl(Item.FabUrl)) Row->SetStringField(TEXT("url"), Item.FabUrl);
                Rows.Add(MakeShared<FJsonValueObject>(Row));
            }
            Finish(Weak, bOk, Failure, Rows, Page.NextCursor, Page.Listings.Num() > Limit);
        }));
    }
    auto Data = Status(TEXT("running")); Data->SetStringField(TEXT("job_id"), Id);
    Data->SetStringField(TEXT("source"), Request.Source);
    Data->SetNumberField(TEXT("poll_after_ms"), 500);
    return FHaybaHandlerResult::Ok(Data);
#endif
}

#if WITH_DEV_AUTOMATION_TESTS
#include "Misc/AutomationTest.h"
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaFabMenuActionTest, "Hayba.Fab.MenuAction",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FHaybaFabMenuActionTest::RunTest(const FString&)
{
    int32 Calls = 0;
    const FToolMenuEntry Entry = FToolMenuEntry::InitMenuEntry(TEXT("FabActionTest"),
        FText::FromString(TEXT("Fab action test")), FText(), FSlateIcon(),
        FUIAction(FExecuteAction::CreateLambda([&Calls]() { ++Calls; })));
    TestTrue(TEXT("Public menu adapter invokes the registered direct action"), ExecuteMenuEntry(Entry));
    TestEqual(TEXT("Action executed once"), Calls, 1);
    const FToolMenuEntry Disabled = FToolMenuEntry::InitMenuEntry(TEXT("FabDisabledTest"),
        FText::FromString(TEXT("Disabled")), FText(), FSlateIcon(),
        FUIAction(FExecuteAction::CreateLambda([&Calls]() { ++Calls; }),
            FCanExecuteAction::CreateLambda([]() { return false; })));
    TestFalse(TEXT("Disabled actions remain disabled"), ExecuteMenuEntry(Disabled));
    TestEqual(TEXT("Disabled action did not execute"), Calls, 1);
    return true;
}
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaFabJobOwnershipTest, "Hayba.Fab.JobOwnership",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FHaybaFabJobOwnershipTest::RunTest(const FString&)
{
    const FString Id = TEXT("fab_") + FGuid::NewGuid().ToString(EGuidFormats::Digits);
    auto Job = MakeShared<FSearchJob>(); Job->Owner = TEXT("fab-test-owner"); Job->Source = TEXT("library");
    Jobs.Add(Id, Job);
    auto Params = MakeShared<FJsonObject>(); Params->SetStringField(TEXT("job_id"), Id);
    TestFalse(TEXT("Other caller cannot read an owned query"), HaybaFab::Execute(TEXT("fab_search_status"), Params, TEXT("other")).bOk);
    auto Result = HaybaFab::Execute(TEXT("fab_search_status"), Params, Job->Owner);
    TestTrue(TEXT("Owner can poll"), Result.bOk);
    TestEqual(TEXT("Pending is not success"), Result.Data->GetStringField(TEXT("status")), FString(TEXT("running")));
    Job->Started = FPlatformTime::Seconds() - 61.0;
    Result = HaybaFab::Execute(TEXT("fab_search_status"), Params, Job->Owner);
    TestEqual(TEXT("Missing callback becomes failure"), Result.Data->GetStringField(TEXT("status")), FString(TEXT("failed")));
    Job->Started = FPlatformTime::Seconds() - 121.0;
    TestFalse(TEXT("Expired query is removed"), HaybaFab::Execute(TEXT("fab_search_status"), Params, Job->Owner).bOk);
    TestFalse(TEXT("Registry no longer retains expired data"), Jobs.Contains(Id));
    Jobs.Remove(Id);
#if HAYBA_HAS_FAB_SEARCH
    TArray<FFabCatalogAssetFormat> InputFormats; InputFormats.SetNum(17);
    InputFormats[0].Code = TEXT("unreal-engine"); InputFormats[0].EngineVersions.SetNum(33);
    const auto Row = Listing(TEXT("listing"), TEXT("Title"), TEXT("Seller"), InputFormats);
    TestTrue(TEXT("Format cap is explicit"), Row->GetBoolField(TEXT("formats_truncated")));
    const auto& OutputFormats = Row->GetArrayField(TEXT("formats"));
    TestEqual(TEXT("Format count bounded"), OutputFormats.Num(), 16);
    TestTrue(TEXT("Version cap is explicit"), OutputFormats[0]->AsObject()->GetBoolField(TEXT("engine_versions_truncated")));
    auto Completed = MakeShared<FSearchJob>(); Completed->Source = TEXT("catalog");
    Finish(Completed, true, FString(), {}, FString(), true);
    TestTrue(TEXT("Result truncation is explicit"), Completed->Result->GetBoolField(TEXT("results_truncated")));
    TestEqual(TEXT("Search completion only"), Completed->Result->GetStringField(TEXT("status")), FString(TEXT("done")));
#endif
    return true;
}
#endif
