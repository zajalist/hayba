#include "HaybaMCPMemoryPanel.h"
#include "HaybaMCPModule.h"
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
#include "Modules/ModuleManager.h"

#define LOCTEXT_NAMESPACE "HaybaLibrary"

namespace
{
    FString LibScratchDir()
    {
        const FString Override = FPlatformMisc::GetEnvironmentVariable(TEXT("HAYBA_PROFILES"));
        if (!Override.IsEmpty()) return FPaths::GetPath(Override);
        return FPaths::Combine(FPaths::ProjectDir(), TEXT(".scratch"));
    }

    TSharedPtr<FJsonObject> LibReadObject(const FString& Path)
    {
        FString Raw;
        if (!FFileHelper::LoadFileToString(Raw, *Path)) return nullptr;
        TSharedPtr<FJsonObject> Obj;
        const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Raw);
        if (!FJsonSerializer::Deserialize(Reader, Obj) || !Obj.IsValid()) return nullptr;
        return Obj;
    }
}

void SHaybaMCPMemoryPanel::Construct(const FArguments& InArgs)
{
    ChildSlot
    [
        SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight().Padding(6, 6, 6, 2)
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center)
            [ SNew(SSearchBox).HintText(LOCTEXT("SearchHint", "Filter assets...")).OnTextChanged(this, &SHaybaMCPMemoryPanel::OnSearchChanged) ]
            + SHorizontalBox::Slot().AutoWidth().Padding(4, 0, 0, 0)
            [ SNew(SButton).Text(LOCTEXT("Refresh", "Refresh")).OnClicked(this, &SHaybaMCPMemoryPanel::OnRefresh) ]
        ]
        + SVerticalBox::Slot().FillHeight(1.f).Padding(6, 2)
        [
            SNew(SBorder).BorderImage(FAppStyle::Get().GetBrush("ToolPanel.GroupBorder"))
            [
                SAssignNew(EntryList, SListView<TSharedPtr<FHaybaLibraryEntry>>)
                .ListItemsSource(&Entries)
                .OnGenerateRow(this, &SHaybaMCPMemoryPanel::GenerateRow)
                .SelectionMode(ESelectionMode::Single)
            ]
        ]
    ];

    Reload();
}

void SHaybaMCPMemoryPanel::Reload()
{
    AllEntries.Reset();

    const FString Dir = LibScratchDir();

    // constraint counts per asset, from constraints.json
    TMap<FString, int32> ConstraintCounts;
    if (const TSharedPtr<FJsonObject> Constraints = LibReadObject(FPaths::Combine(Dir, TEXT("constraints.json"))))
    {
        for (const auto& Pair : Constraints->Values)
        {
            const TSharedPtr<FJsonObject> C = Pair.Value->AsObject();
            if (!C.IsValid()) continue;
            const TSharedPtr<FJsonObject>* B = nullptr;
            if (C->TryGetObjectField(TEXT("binding"), B) && B)
            {
                FString Asset;
                if ((*B)->TryGetStringField(TEXT("asset"), Asset)) ConstraintCounts.FindOrAdd(Asset)++;
            }
        }
    }

    if (const TSharedPtr<FJsonObject> Profiles = LibReadObject(FPaths::Combine(Dir, TEXT("profiles.json"))))
    {
        for (const auto& Pair : Profiles->Values)
        {
            const TSharedPtr<FJsonObject> P = Pair.Value->AsObject();
            if (!P.IsValid()) continue;
            TSharedPtr<FHaybaLibraryEntry> E = MakeShared<FHaybaLibraryEntry>();
            E->AssetId = Pair.Key;
            P->TryGetStringField(TEXT("profile"), E->Archetype);

            const TArray<TSharedPtr<FJsonValue>>* Masks = nullptr;
            if (P->TryGetArrayField(TEXT("masks"), Masks)) E->MaskCount = Masks->Num();

            if (const TSharedPtr<FJsonObject>* Prov = nullptr; P->TryGetObjectField(TEXT("provenance"), Prov) && Prov)
            {
                const TArray<TSharedPtr<FJsonValue>>* Locked = nullptr;
                if ((*Prov)->TryGetArrayField(TEXT("locked"), Locked)) E->LockedCount = Locked->Num();
            }
            E->ConstraintCount = ConstraintCounts.FindRef(E->AssetId);
            AllEntries.Add(E);
        }
    }

    AllEntries.Sort([](const TSharedPtr<FHaybaLibraryEntry>& A, const TSharedPtr<FHaybaLibraryEntry>& B)
    { return A->AssetId < B->AssetId; });

    ApplyFilter();
}

void SHaybaMCPMemoryPanel::ApplyFilter()
{
    Entries.Reset();
    for (const TSharedPtr<FHaybaLibraryEntry>& E : AllEntries)
    {
        if (Filter.IsEmpty() || E->AssetId.Contains(Filter)) Entries.Add(E);
    }
    if (EntryList.IsValid()) EntryList->RequestListRefresh();
}

FReply SHaybaMCPMemoryPanel::OnRefresh()
{
    Reload();
    return FReply::Handled();
}

void SHaybaMCPMemoryPanel::OnSearchChanged(const FText& Text)
{
    Filter = Text.ToString();
    ApplyFilter();
}

TSharedRef<ITableRow> SHaybaMCPMemoryPanel::GenerateRow(TSharedPtr<FHaybaLibraryEntry> Entry, const TSharedRef<STableViewBase>& Owner)
{
    const FString AssetId = Entry->AssetId;
    const FString Name = FPaths::GetBaseFilename(AssetId);
    const FString Counts = FString::Printf(TEXT("%d masks  ·  %d constraints%s"),
        Entry->MaskCount, Entry->ConstraintCount, Entry->LockedCount > 0 ? *FString::Printf(TEXT("  ·  %d locked"), Entry->LockedCount) : TEXT(""));

    return SNew(STableRow<TSharedPtr<FHaybaLibraryEntry>>, Owner).Padding(2)
    [
        SNew(SHorizontalBox)
        + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center).Padding(4, 2)
        [
            SNew(SVerticalBox)
            + SVerticalBox::Slot().AutoHeight()
            [ SNew(STextBlock).Text(FText::FromString(Name)).TextStyle(FAppStyle::Get(), "ButtonText") ]
            + SVerticalBox::Slot().AutoHeight()
            [ SNew(STextBlock).Text(FText::FromString(Counts)).ColorAndOpacity(FSlateColor::UseSubduedForeground()) ]
        ]
        + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(4, 0)
        [
            SNew(SButton)
            .Text(LOCTEXT("OpenInStudio", "Open in Studio"))
            .OnClicked_Lambda([AssetId]()
            {
                if (FHaybaMCPModule* M = FModuleManager::GetModulePtr<FHaybaMCPModule>("HaybaMCPToolkit"))
                    M->OpenStudioForAsset(AssetId);
                return FReply::Handled();
            })
        ]
    ];
}

#undef LOCTEXT_NAMESPACE
