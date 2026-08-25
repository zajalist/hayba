// SRecipesPanel.cpp
#include "Recipes/SRecipesPanel.h"

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
    class SRecipeTableRow : public SMultiColumnTableRow<TSharedPtr<FHaybaRecipeSpec>>
    {
    public:
        SLATE_BEGIN_ARGS(SRecipeTableRow) {}
            SLATE_ARGUMENT(TSharedPtr<FHaybaRecipeSpec>, Item)
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
        TSharedPtr<FHaybaRecipeSpec> Item;
    };
}

void SRecipesPanel::Construct(const FArguments& InArgs)
{
    WatchedDir = FHaybaRecipeLoader::DefaultUserRecipesDir();
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
                .HintText(FText::FromString(TEXT("Search recipes…")))
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
                .ToolTipText(FText::FromString(TEXT("Import a .recipe.json file into the installed recipes.")))
                .OnClicked(this, &SRecipesPanel::OnImportClicked)
                [ SNew(STextBlock).Text(FText::FromString(TEXT("Import"))) ]
            ]
            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(2)
            [
                SNew(SButton)
                .ContentPadding(FMargin(8, 3))
                .ToolTipText(FText::FromString(TEXT("Export the selected recipe to a .recipe.json file.")))
                .IsEnabled_Lambda([this]() { return Selected.IsValid(); })
                .OnClicked(this, &SRecipesPanel::OnExportClicked)
                [ SNew(STextBlock).Text(FText::FromString(TEXT("Export"))) ]
            ]
            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(2)
            [
                SNew(SButton)
                .ContentPadding(FMargin(8, 3))
                .ToolTipText(FText::FromString(TEXT("Delete the selected recipe from disk.")))
                .IsEnabled_Lambda([this]() { return Selected.IsValid(); })
                .OnClicked(this, &SRecipesPanel::OnDeleteClicked)
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
                SAssignNew(ListView, SListView<TSharedPtr<FHaybaRecipeSpec>>)
                .ListItemsSource(&FilteredItems)
                .OnGenerateRow(this, &SRecipesPanel::OnGenerateRow)
                .OnSelectionChanged(this, &SRecipesPanel::OnSelectionChanged)
                .SelectionMode(ESelectionMode::Single)
                .HeaderRow(
                    SNew(SHeaderRow)
                    + SHeaderRow::Column(ColTitle)
                      .DefaultLabel(FText::FromString(TEXT("Recipe"))).FillWidth(0.5f)
                    + SHeaderRow::Column(ColCategory)
                      .DefaultLabel(FText::FromString(TEXT("Category"))).FillWidth(0.3f)
                    + SHeaderRow::Column(ColVersion)
                      .DefaultLabel(FText::FromString(TEXT("Version"))).FillWidth(0.2f)
                )
            ]
            + SSplitter::Slot().Value(0.66f)
            [
                SAssignNew(DetailPanel, SRecipeDetailPanel)
            ]
        ]
    ];

    // Live auto-refresh: watch the recipes directory for any change.
    if (FDirectoryWatcherModule* DWM =
            FModuleManager::Get().GetModulePtr<FDirectoryWatcherModule>(TEXT("DirectoryWatcher")))
    {
        if (IDirectoryWatcher* Watcher = DWM->Get())
        {
            IFileManager::Get().MakeDirectory(*WatchedDir, /*Tree*/true);
            Watcher->RegisterDirectoryChangedCallback_Handle(
                WatchedDir,
                IDirectoryWatcher::FDirectoryChanged::CreateSP(this, &SRecipesPanel::OnDirectoryChanged),
                WatcherHandle);
        }
    }

    Refresh();
}

SRecipesPanel::~SRecipesPanel()
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

void SRecipesPanel::Refresh()
{
    const FString PrevId = Selected.IsValid() ? Selected->Id : FString();

    Loader.Refresh(WatchedDir);
    AllItems.Reset();
    for (const FHaybaRecipeSpec& S : Loader.List())
        AllItems.Add(MakeShared<FHaybaRecipeSpec>(S));

    RebuildCategoryOptions();
    ApplyFilter();

    // Keep the previous selection if it still exists.
    if (!PrevId.IsEmpty())
    {
        for (const TSharedPtr<FHaybaRecipeSpec>& S : FilteredItems)
        {
            if (S.IsValid() && S->Id == PrevId)
            {
                if (ListView) ListView->SetSelection(S);
                break;
            }
        }
    }
}

void SRecipesPanel::RebuildCategoryOptions()
{
    CategoryOptions.Reset();
    CategoryOptions.Add(MakeShared<FString>(TEXT("All categories")));
    TSet<FString> Seen;
    for (const TSharedPtr<FHaybaRecipeSpec>& S : AllItems)
    {
        if (S.IsValid() && !S->Category.IsEmpty() && !Seen.Contains(S->Category))
        {
            Seen.Add(S->Category);
            CategoryOptions.Add(MakeShared<FString>(S->Category));
        }
    }
    if (CategoryCombo) CategoryCombo->RefreshOptions();
}

void SRecipesPanel::ApplyFilter()
{
    FilteredItems.Reset();
    const FString Needle = SearchText.TrimStartAndEnd();
    for (const TSharedPtr<FHaybaRecipeSpec>& S : AllItems)
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

TSharedRef<ITableRow> SRecipesPanel::OnGenerateRow(
    TSharedPtr<FHaybaRecipeSpec> Item, const TSharedRef<STableViewBase>& Owner)
{
    return SNew(SRecipeTableRow, Owner).Item(Item);
}

void SRecipesPanel::OnSelectionChanged(TSharedPtr<FHaybaRecipeSpec> Item, ESelectInfo::Type)
{
    Selected = Item;
    if (Item.IsValid() && DetailPanel) DetailPanel->SetSpec(*Item);
}

FString SRecipesPanel::RecipeFilePath(const FString& Id) const
{
    // Export and Delete both resolve through here, so this has to name the
    // file that is actually on disk. A recipe installed before the rename is
    // still called <id>.sliver.json, and returning only the new spelling would
    // make it impossible to export or delete from the panel -- it would look
    // present in the list and then not be found.
    const FString Current = FPaths::Combine(WatchedDir, Id + TEXT(".recipe.json"));
    if (IFileManager::Get().FileExists(*Current)) return Current;

    const FString Legacy = FPaths::Combine(WatchedDir, Id + TEXT(".sliver.json"));
    if (IFileManager::Get().FileExists(*Legacy)) return Legacy;

    // Neither exists: hand back the current spelling so callers report a
    // missing file under the name it would be written as.
    return Current;
}

FReply SRecipesPanel::OnImportClicked()
{
    IDesktopPlatform* DP = FDesktopPlatformModule::Get();
    if (!DP) return FReply::Handled();

    const void* ParentHandle =
        FSlateApplication::Get().FindBestParentWindowHandleForDialogs(AsShared());

    TArray<FString> Picked;
    const bool bOk = DP->OpenFileDialog(
        ParentHandle,
        TEXT("Import recipe"),
        FPaths::ProjectDir(),
        TEXT(""),
        TEXT("Recipe spec (*.recipe.json;*.sliver.json)|*.recipe.json;*.sliver.json"),
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
                FText::FromString(TEXT("Failed to copy the selected file into the recipes folder.")));
        }
        Refresh();
    }
    return FReply::Handled();
}

FReply SRecipesPanel::OnExportClicked()
{
    if (!Selected.IsValid()) return FReply::Handled();
    IDesktopPlatform* DP = FDesktopPlatformModule::Get();
    if (!DP) return FReply::Handled();

    const FString Src = RecipeFilePath(Selected->Id);
    if (!IFileManager::Get().FileExists(*Src))
    {
        FMessageDialog::Open(EAppMsgType::Ok,
            FText::FromString(TEXT("Could not locate the source file for this recipe.")));
        return FReply::Handled();
    }

    const void* ParentHandle =
        FSlateApplication::Get().FindBestParentWindowHandleForDialogs(AsShared());

    TArray<FString> Saved;
    const bool bOk = DP->SaveFileDialog(
        ParentHandle,
        TEXT("Export recipe"),
        FPaths::ProjectDir(),
        Selected->Id + TEXT(".recipe.json"),
        TEXT("Recipe spec (*.recipe.json;*.sliver.json)|*.recipe.json;*.sliver.json"),
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

FReply SRecipesPanel::OnDeleteClicked()
{
    if (!Selected.IsValid()) return FReply::Handled();

    const FString Id = Selected->Id;
    const EAppReturnType::Type Answer = FMessageDialog::Open(
        EAppMsgType::YesNo,
        FText::FromString(FString::Printf(
            TEXT("Delete recipe \"%s\"?\n\nThis removes %s from disk."),
            *Id, *FPaths::GetCleanFilename(RecipeFilePath(Id)))));

    if (Answer != EAppReturnType::Yes) return FReply::Handled();

    const FString Path = RecipeFilePath(Id);
    if (!IFileManager::Get().Delete(*Path, /*RequireExists*/false))
    {
        FMessageDialog::Open(EAppMsgType::Ok,
            FText::FromString(TEXT("Failed to delete the recipe file.")));
    }
    Selected.Reset();
    Refresh();
    return FReply::Handled();
}

void SRecipesPanel::OnDirectoryChanged(const TArray<FFileChangeData>& /*Changes*/)
{
    // The watcher fires on the game thread; rebuilding the table here is safe.
    Refresh();
}
