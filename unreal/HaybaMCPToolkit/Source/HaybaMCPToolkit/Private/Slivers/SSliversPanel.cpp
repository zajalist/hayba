// SSliversPanel.cpp
#include "Slivers/SSliversPanel.h"

#include "DesktopPlatformModule.h"
#include "DirectoryWatcherModule.h"
#include "IDesktopPlatform.h"
#include "IDirectoryWatcher.h"
#include "Framework/Application/SlateApplication.h"
#include "HAL/FileManager.h"
#include "Misc/MessageDialog.h"
#include "Misc/Paths.h"
#include "Modules/ModuleManager.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SComboBox.h"
#include "Widgets/Input/SSearchBox.h"
#include "Widgets/Layout/SSplitter.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Views/SHeaderRow.h"
#include "Widgets/Views/STableRow.h"

namespace
{
    const FName ColTitle("Title");
    const FName ColCategory("Category");
    const FName ColVersion("Version");

    // One table row, three columns.
    class SSliverTableRow : public SMultiColumnTableRow<TSharedPtr<FHaybaSliverSpec>>
    {
    public:
        SLATE_BEGIN_ARGS(SSliverTableRow) {}
            SLATE_ARGUMENT(TSharedPtr<FHaybaSliverSpec>, Item)
        SLATE_END_ARGS()

        void Construct(const FArguments& InArgs, const TSharedRef<STableViewBase>& Owner)
        {
            Item = InArgs._Item;
            SMultiColumnTableRow::Construct(FSuperRowType::FArguments(), Owner);
        }

        virtual TSharedRef<SWidget> GenerateWidgetForColumn(const FName& Column) override
        {
            FString Text;
            if (Item.IsValid())
            {
                if (Column == ColTitle)         Text = Item->Title;
                else if (Column == ColCategory) Text = Item->Category;
                else if (Column == ColVersion)  Text = Item->Version;
            }
            return SNew(STextBlock)
                .Margin(FMargin(6, 3))
                .Text(FText::FromString(Text))
                .AutoWrapText(true);
        }

    private:
        TSharedPtr<FHaybaSliverSpec> Item;
    };
}

void SSliversPanel::Construct(const FArguments& InArgs)
{
    WatchedDir = FHaybaSliverLoader::DefaultUserSliversDir();
    CategorySelected = MakeShared<FString>(TEXT("All categories"));

    ChildSlot
    [
        SNew(SVerticalBox)

        // ── Toolbar: search · category filter · import / export / delete ──
        + SVerticalBox::Slot().AutoHeight().Padding(4)
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().FillWidth(1.0f).VAlign(VAlign_Center).Padding(2)
            [
                SNew(SSearchBox)
                .HintText(FText::FromString(TEXT("Search slivers…")))
                .OnTextChanged_Lambda([this](const FText& T)
                {
                    SearchText = T.ToString();
                    ApplyFilter();
                })
            ]
            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(2)
            [
                SAssignNew(CategoryCombo, SComboBox<TSharedPtr<FString>>)
                .OptionsSource(&CategoryOptions)
                .OnGenerateWidget_Lambda([](TSharedPtr<FString> Item)
                {
                    return SNew(STextBlock).Text(FText::FromString(Item.IsValid() ? *Item : FString()));
                })
                .OnSelectionChanged_Lambda([this](TSharedPtr<FString> Item, ESelectInfo::Type)
                {
                    if (!Item.IsValid()) return;
                    CategorySelected = Item;
                    CategoryFilter = (*Item == TEXT("All categories")) ? FString() : *Item;
                    ApplyFilter();
                })
                [
                    SNew(STextBlock).Text_Lambda([this]()
                    {
                        return FText::FromString(CategorySelected.IsValid() ? *CategorySelected : FString());
                    })
                ]
            ]
            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(6, 2, 2, 2)
            [
                SNew(SButton)
                .ContentPadding(FMargin(8, 3))
                .ToolTipText(FText::FromString(TEXT("Import a .sliver.json file into the installed slivers.")))
                .OnClicked(this, &SSliversPanel::OnImportClicked)
                [ SNew(STextBlock).Text(FText::FromString(TEXT("Import"))) ]
            ]
            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(2)
            [
                SNew(SButton)
                .ContentPadding(FMargin(8, 3))
                .ToolTipText(FText::FromString(TEXT("Export the selected sliver to a .sliver.json file.")))
                .IsEnabled_Lambda([this]() { return Selected.IsValid(); })
                .OnClicked(this, &SSliversPanel::OnExportClicked)
                [ SNew(STextBlock).Text(FText::FromString(TEXT("Export"))) ]
            ]
            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(2)
            [
                SNew(SButton)
                .ContentPadding(FMargin(8, 3))
                .ToolTipText(FText::FromString(TEXT("Delete the selected sliver from disk.")))
                .IsEnabled_Lambda([this]() { return Selected.IsValid(); })
                .OnClicked(this, &SSliversPanel::OnDeleteClicked)
                [ SNew(STextBlock).Text(FText::FromString(TEXT("Delete"))) ]
            ]
        ]

        // ── Table (top) + detail (bottom), vertically resizable ──
        + SVerticalBox::Slot().FillHeight(1.0f)
        [
            SNew(SSplitter)
            .Orientation(Orient_Vertical)
            + SSplitter::Slot().Value(0.34f)
            [
                SAssignNew(ListView, SListView<TSharedPtr<FHaybaSliverSpec>>)
                .ListItemsSource(&FilteredItems)
                .OnGenerateRow(this, &SSliversPanel::OnGenerateRow)
                .OnSelectionChanged(this, &SSliversPanel::OnSelectionChanged)
                .SelectionMode(ESelectionMode::Single)
                .HeaderRow(
                    SNew(SHeaderRow)
                    + SHeaderRow::Column(ColTitle)
                      .DefaultLabel(FText::FromString(TEXT("Sliver"))).FillWidth(0.5f)
                    + SHeaderRow::Column(ColCategory)
                      .DefaultLabel(FText::FromString(TEXT("Category"))).FillWidth(0.3f)
                    + SHeaderRow::Column(ColVersion)
                      .DefaultLabel(FText::FromString(TEXT("Version"))).FillWidth(0.2f)
                )
            ]
            + SSplitter::Slot().Value(0.66f)
            [
                SAssignNew(DetailPanel, SSliverDetailPanel)
            ]
        ]
    ];

    // Live auto-refresh: watch the slivers directory for any change.
    if (FDirectoryWatcherModule* DWM =
            FModuleManager::Get().GetModulePtr<FDirectoryWatcherModule>(TEXT("DirectoryWatcher")))
    {
        if (IDirectoryWatcher* Watcher = DWM->Get())
        {
            IFileManager::Get().MakeDirectory(*WatchedDir, /*Tree*/true);
            Watcher->RegisterDirectoryChangedCallback_Handle(
                WatchedDir,
                IDirectoryWatcher::FDirectoryChanged::CreateSP(this, &SSliversPanel::OnDirectoryChanged),
                WatcherHandle);
        }
    }

    Refresh();
}

SSliversPanel::~SSliversPanel()
{
    if (WatcherHandle.IsValid())
    {
        if (FDirectoryWatcherModule* DWM =
                FModuleManager::Get().GetModulePtr<FDirectoryWatcherModule>(TEXT("DirectoryWatcher")))
        {
            if (IDirectoryWatcher* Watcher = DWM->Get())
            {
                Watcher->UnregisterDirectoryChangedCallback_Handle(WatchedDir, WatcherHandle);
            }
        }
    }
}

void SSliversPanel::Refresh()
{
    const FString PrevId = Selected.IsValid() ? Selected->Id : FString();

    Loader.Refresh(WatchedDir);
    AllItems.Reset();
    for (const FHaybaSliverSpec& S : Loader.List())
        AllItems.Add(MakeShared<FHaybaSliverSpec>(S));

    RebuildCategoryOptions();
    ApplyFilter();

    // Keep the previous selection if it still exists.
    if (!PrevId.IsEmpty())
    {
        for (const TSharedPtr<FHaybaSliverSpec>& S : FilteredItems)
        {
            if (S.IsValid() && S->Id == PrevId)
            {
                if (ListView) ListView->SetSelection(S);
                break;
            }
        }
    }
}

void SSliversPanel::RebuildCategoryOptions()
{
    CategoryOptions.Reset();
    CategoryOptions.Add(MakeShared<FString>(TEXT("All categories")));
    TSet<FString> Seen;
    for (const TSharedPtr<FHaybaSliverSpec>& S : AllItems)
    {
        if (S.IsValid() && !S->Category.IsEmpty() && !Seen.Contains(S->Category))
        {
            Seen.Add(S->Category);
            CategoryOptions.Add(MakeShared<FString>(S->Category));
        }
    }
    if (CategoryCombo) CategoryCombo->RefreshOptions();
}

void SSliversPanel::ApplyFilter()
{
    FilteredItems.Reset();
    const FString Needle = SearchText.TrimStartAndEnd();
    for (const TSharedPtr<FHaybaSliverSpec>& S : AllItems)
    {
        if (!S.IsValid()) continue;
        if (!CategoryFilter.IsEmpty() && S->Category != CategoryFilter) continue;
        if (!Needle.IsEmpty())
        {
            const bool bMatch =
                S->Title.Contains(Needle) ||
                S->Id.Contains(Needle) ||
                S->Category.Contains(Needle) ||
                S->Description.Contains(Needle);
            if (!bMatch) continue;
        }
        FilteredItems.Add(S);
    }
    if (ListView) ListView->RequestListRefresh();
}

TSharedRef<ITableRow> SSliversPanel::OnGenerateRow(
    TSharedPtr<FHaybaSliverSpec> Item, const TSharedRef<STableViewBase>& Owner)
{
    return SNew(SSliverTableRow, Owner).Item(Item);
}

void SSliversPanel::OnSelectionChanged(TSharedPtr<FHaybaSliverSpec> Item, ESelectInfo::Type)
{
    Selected = Item;
    if (Item.IsValid() && DetailPanel) DetailPanel->SetSpec(*Item);
}

FString SSliversPanel::SliverFilePath(const FString& Id) const
{
    return FPaths::Combine(WatchedDir, Id + TEXT(".sliver.json"));
}

FReply SSliversPanel::OnImportClicked()
{
    IDesktopPlatform* DP = FDesktopPlatformModule::Get();
    if (!DP) return FReply::Handled();

    const void* ParentHandle =
        FSlateApplication::Get().FindBestParentWindowHandleForDialogs(AsShared());

    TArray<FString> Picked;
    const bool bOk = DP->OpenFileDialog(
        ParentHandle,
        TEXT("Import sliver"),
        FPaths::ProjectDir(),
        TEXT(""),
        TEXT("Sliver spec (*.sliver.json)|*.sliver.json"),
        EFileDialogFlags::None,
        Picked);

    if (bOk && Picked.Num() > 0)
    {
        const FString Src = Picked[0];
        IFileManager::Get().MakeDirectory(*WatchedDir, /*Tree*/true);
        const FString Dst = FPaths::Combine(WatchedDir, FPaths::GetCleanFilename(Src));
        if (IFileManager::Get().Copy(*Dst, *Src) != COPY_OK)
        {
            FMessageDialog::Open(EAppMsgType::Ok,
                FText::FromString(TEXT("Failed to copy the selected file into the slivers folder.")));
        }
        Refresh();
    }
    return FReply::Handled();
}

FReply SSliversPanel::OnExportClicked()
{
    if (!Selected.IsValid()) return FReply::Handled();
    IDesktopPlatform* DP = FDesktopPlatformModule::Get();
    if (!DP) return FReply::Handled();

    const FString Src = SliverFilePath(Selected->Id);
    if (!IFileManager::Get().FileExists(*Src))
    {
        FMessageDialog::Open(EAppMsgType::Ok,
            FText::FromString(TEXT("Could not locate the source file for this sliver.")));
        return FReply::Handled();
    }

    const void* ParentHandle =
        FSlateApplication::Get().FindBestParentWindowHandleForDialogs(AsShared());

    TArray<FString> Saved;
    const bool bOk = DP->SaveFileDialog(
        ParentHandle,
        TEXT("Export sliver"),
        FPaths::ProjectDir(),
        Selected->Id + TEXT(".sliver.json"),
        TEXT("Sliver spec (*.sliver.json)|*.sliver.json"),
        EFileDialogFlags::None,
        Saved);

    if (bOk && Saved.Num() > 0)
    {
        if (IFileManager::Get().Copy(*Saved[0], *Src) != COPY_OK)
        {
            FMessageDialog::Open(EAppMsgType::Ok,
                FText::FromString(TEXT("Failed to write the export file.")));
        }
    }
    return FReply::Handled();
}

FReply SSliversPanel::OnDeleteClicked()
{
    if (!Selected.IsValid()) return FReply::Handled();

    const FString Id = Selected->Id;
    const EAppReturnType::Type Answer = FMessageDialog::Open(
        EAppMsgType::YesNo,
        FText::FromString(FString::Printf(
            TEXT("Delete sliver \"%s\"?\n\nThis removes %s from disk."),
            *Id, *(Id + TEXT(".sliver.json")))));

    if (Answer != EAppReturnType::Yes) return FReply::Handled();

    const FString Path = SliverFilePath(Id);
    if (!IFileManager::Get().Delete(*Path, /*RequireExists*/false))
    {
        FMessageDialog::Open(EAppMsgType::Ok,
            FText::FromString(TEXT("Failed to delete the sliver file.")));
    }
    Selected.Reset();
    Refresh();
    return FReply::Handled();
}

void SSliversPanel::OnDirectoryChanged(const TArray<FFileChangeData>& /*Changes*/)
{
    // The watcher fires on the game thread; rebuilding the table here is safe.
    Refresh();
}
