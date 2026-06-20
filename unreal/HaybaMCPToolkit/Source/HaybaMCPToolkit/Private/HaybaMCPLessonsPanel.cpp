#include "HaybaMCPLessonsPanel.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SSearchBox.h"
#include "Widgets/Views/STableRow.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Layout/SBorder.h"
#include "Styling/AppStyle.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "HAL/PlatformMisc.h"

#define LOCTEXT_NAMESPACE "HaybaLessons"

namespace
{
    FString LessonsPath()
    {
        const FString Override = FPlatformMisc::GetEnvironmentVariable(TEXT("HAYBA_LESSONS"));
        if (!Override.IsEmpty()) return Override;
        // default mirrors the lesson store: <profiles dir>/lessons.json or ProjectDir/.scratch
        const FString ProfilesOverride = FPlatformMisc::GetEnvironmentVariable(TEXT("HAYBA_PROFILES"));
        const FString Dir = ProfilesOverride.IsEmpty()
            ? FPaths::Combine(FPaths::ProjectDir(), TEXT(".scratch"))
            : FPaths::GetPath(ProfilesOverride);
        return FPaths::Combine(Dir, TEXT("lessons.json"));
    }
}

void SHaybaLessonsPanel::Construct(const FArguments& InArgs)
{
    ChildSlot
    [
        SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight().Padding(6, 6, 6, 2)
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center)
            [ SNew(SSearchBox).HintText(LOCTEXT("SearchHint", "Filter lessons...")).OnTextChanged(this, &SHaybaLessonsPanel::OnSearchChanged) ]
            + SHorizontalBox::Slot().AutoWidth().Padding(4, 0, 0, 0)
            [ SNew(SButton).Text(LOCTEXT("Refresh", "Refresh")).OnClicked(this, &SHaybaLessonsPanel::OnRefresh) ]
        ]
        + SVerticalBox::Slot().FillHeight(1.f).Padding(6, 2)
        [
            SNew(SBorder).BorderImage(FAppStyle::Get().GetBrush("ToolPanel.GroupBorder"))
            [
                SAssignNew(EntryList, SListView<TSharedPtr<FHaybaLessonEntry>>)
                .ListItemsSource(&Entries)
                .OnGenerateRow(this, &SHaybaLessonsPanel::GenerateRow)
                .SelectionMode(ESelectionMode::Single)
            ]
        ]
    ];

    Reload();
}

void SHaybaLessonsPanel::Reload()
{
    AllEntries.Reset();
    FString Raw;
    if (FFileHelper::LoadFileToString(Raw, *LessonsPath()))
    {
        TSharedPtr<FJsonObject> Root;
        const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Raw);
        if (FJsonSerializer::Deserialize(Reader, Root) && Root.IsValid())
        {
            for (const auto& Pair : Root->Values)
            {
                const TSharedPtr<FJsonObject> L = Pair.Value->AsObject();
                if (!L.IsValid()) continue;
                TSharedPtr<FHaybaLessonEntry> E = MakeShared<FHaybaLessonEntry>();
                E->Slug = Pair.Key;
                L->TryGetStringField(TEXT("title"), E->Title);
                L->TryGetStringField(TEXT("body"), E->Body);
                const TArray<TSharedPtr<FJsonValue>>* Refs = nullptr;
                if (L->TryGetArrayField(TEXT("refs"), Refs))
                    for (const auto& V : *Refs) E->Refs.Add(V->AsString());
                AllEntries.Add(E);
            }
        }
    }
    AllEntries.Sort([](const TSharedPtr<FHaybaLessonEntry>& A, const TSharedPtr<FHaybaLessonEntry>& B){ return A->Slug < B->Slug; });
    ApplyFilter();
}

void SHaybaLessonsPanel::ApplyFilter()
{
    Entries.Reset();
    for (const TSharedPtr<FHaybaLessonEntry>& E : AllEntries)
    {
        if (Filter.IsEmpty() || E->Slug.Contains(Filter) || E->Title.Contains(Filter)) Entries.Add(E);
    }
    if (EntryList.IsValid()) EntryList->RequestListRefresh();
}

FReply SHaybaLessonsPanel::OnRefresh() { Reload(); return FReply::Handled(); }

void SHaybaLessonsPanel::OnSearchChanged(const FText& Text) { Filter = Text.ToString(); ApplyFilter(); }

TSharedRef<ITableRow> SHaybaLessonsPanel::GenerateRow(TSharedPtr<FHaybaLessonEntry> Entry, const TSharedRef<STableViewBase>& Owner)
{
    const FString Refs = Entry->Refs.Num() > 0 ? FString::Printf(TEXT("refs: %s"), *FString::Join(Entry->Refs, TEXT(", "))) : FString();
    return SNew(STableRow<TSharedPtr<FHaybaLessonEntry>>, Owner).Padding(2)
    [
        SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight().Padding(4, 2, 4, 0)
        [ SNew(STextBlock).TextStyle(FAppStyle::Get(), "ButtonText").Text(FText::FromString(FString::Printf(TEXT("[[%s]]  %s"), *Entry->Slug, *Entry->Title))) ]
        + SVerticalBox::Slot().AutoHeight().Padding(4, 0)
        [ SNew(STextBlock).AutoWrapText(true).Text(FText::FromString(Entry->Body)) ]
        + SVerticalBox::Slot().AutoHeight().Padding(4, 0, 4, 4)
        [ SNew(STextBlock).Visibility(Refs.IsEmpty() ? EVisibility::Collapsed : EVisibility::Visible).ColorAndOpacity(FSlateColor::UseSubduedForeground()).Text(FText::FromString(Refs)) ]
    ];
}

#undef LOCTEXT_NAMESPACE
