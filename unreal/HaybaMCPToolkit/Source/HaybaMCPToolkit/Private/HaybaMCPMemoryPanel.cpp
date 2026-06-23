#include "HaybaMCPMemoryPanel.h"
#include "HaybaMCPModule.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SCheckBox.h"
#include "Widgets/Input/SComboBox.h"
#include "Widgets/Input/SSearchBox.h"
#include "Widgets/Images/SImage.h"
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
    FString ProfilesFile()    { return FPaths::Combine(LibScratchDir(), TEXT("profiles.json")); }
    FString ConstraintsFile() { return FPaths::Combine(LibScratchDir(), TEXT("constraints.json")); }

    TSharedPtr<FJsonObject> ReadObj(const FString& Path)
    {
        FString Raw; if (!FFileHelper::LoadFileToString(Raw, *Path)) return MakeShared<FJsonObject>();
        TSharedPtr<FJsonObject> Obj;
        const TSharedRef<TJsonReader<>> R = TJsonReaderFactory<>::Create(Raw);
        if (!FJsonSerializer::Deserialize(R, Obj) || !Obj.IsValid()) return MakeShared<FJsonObject>();
        return Obj;
    }
    void WriteObj(const FString& Path, const TSharedPtr<FJsonObject>& Obj)
    {
        FString Out; const TSharedRef<TJsonWriter<>> W = TJsonWriterFactory<>::Create(&Out);
        FJsonSerializer::Serialize(Obj.ToSharedRef(), W);
        FFileHelper::SaveStringToFile(Out, *Path);
    }
    const TCHAR* GPrims[] = { TEXT("grounded"), TEXT("clearance"), TEXT("support_margin"), TEXT("upright"),
        TEXT("scale_range"), TEXT("count_per_m2"), TEXT("proximity"), TEXT("inside_outside"),
        TEXT("facing"), TEXT("affordance_clear"), TEXT("surface_contact") };
}

void SHaybaMCPMemoryPanel::Construct(const FArguments& InArgs)
{
    for (const TCHAR* P : GPrims) PrimitiveOptions.Add(MakeShared<FString>(P));
    SelectedPrimitive = PrimitiveOptions[0];

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
        // ── Bulk action bar ──────────────────────────────────────────────
        + SVerticalBox::Slot().AutoHeight().Padding(6, 2)
        [
            SNew(SBorder).BorderImage(FAppStyle::Get().GetBrush("Brushes.Header")).Padding(FMargin(6, 3))
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)[ SNew(SButton).Text(LOCTEXT("All", "All")).OnClicked(this, &SHaybaMCPMemoryPanel::OnCheckAll) ]
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(2, 0)[ SNew(SButton).Text(LOCTEXT("None", "None")).OnClicked(this, &SHaybaMCPMemoryPanel::OnCheckNone) ]
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(12, 0, 2, 0)
                [
                    SNew(SComboBox<TSharedPtr<FString>>)
                    .OptionsSource(&PrimitiveOptions)
                    .OnGenerateWidget_Lambda([](TSharedPtr<FString> S){ return SNew(STextBlock).Text(FText::FromString(*S)); })
                    .OnSelectionChanged_Lambda([this](TSharedPtr<FString> S, ESelectInfo::Type){ if (S.IsValid()) SelectedPrimitive = S; })
                    .InitiallySelectedItem(SelectedPrimitive)
                    [ SNew(STextBlock).Text_Lambda([this](){ return FText::FromString(SelectedPrimitive.IsValid() ? *SelectedPrimitive : FString()); }) ]
                ]
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(2, 0)[ SNew(SButton).Text(LOCTEXT("ApplyTmpl", "Apply to checked")).OnClicked(this, &SHaybaMCPMemoryPanel::OnApplyTemplate) ]
                + SHorizontalBox::Slot().FillWidth(1.f)[ SNullWidget::NullWidget ]
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)[ SNew(SButton).Text(LOCTEXT("RemoveChecked", "Remove checked")).OnClicked(this, &SHaybaMCPMemoryPanel::OnRemoveChecked) ]
            ]
        ]
        + SVerticalBox::Slot().FillHeight(1.f).Padding(6, 2)
        [
            SNew(SBorder).BorderImage(FAppStyle::Get().GetBrush("ToolPanel.GroupBorder"))
            [
                SAssignNew(Tree, STreeView<TSharedPtr<FHaybaLibraryNode>>)
                .TreeItemsSource(&RootNodes)
                .OnGenerateRow(this, &SHaybaMCPMemoryPanel::GenerateRow)
                .OnGetChildren(this, &SHaybaMCPMemoryPanel::GetChildren)
                .SelectionMode(ESelectionMode::Single)
            ]
        ]
    ];

    Reload();
}

void SHaybaMCPMemoryPanel::Reload()
{
    AllEntries.Reset();

    TMap<FString, int32> ConstraintCounts;
    for (const auto& Pair : ReadObj(ConstraintsFile())->Values)
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

    TSet<FString> Seen;
    for (const auto& Pair : ReadObj(ProfilesFile())->Values)
    {
        const TSharedPtr<FJsonObject> P = Pair.Value->AsObject();
        if (!P.IsValid()) continue;
        TSharedPtr<FHaybaLibraryEntry> E = MakeShared<FHaybaLibraryEntry>();
        E->AssetId = Pair.Key;
        P->TryGetStringField(TEXT("profile"), E->Archetype);
        const TArray<TSharedPtr<FJsonValue>>* Masks = nullptr;
        if (P->TryGetArrayField(TEXT("masks"), Masks)) E->MaskCount = Masks->Num();
        const TSharedPtr<FJsonObject>* Prov = nullptr;
        if (P->TryGetObjectField(TEXT("provenance"), Prov) && Prov)
        {
            const TArray<TSharedPtr<FJsonValue>>* Locked = nullptr;
            if ((*Prov)->TryGetArrayField(TEXT("locked"), Locked)) E->LockedCount = Locked->Num();
        }
        E->ConstraintCount = ConstraintCounts.FindRef(E->AssetId);
        Seen.Add(E->AssetId);
        AllEntries.Add(E);
    }

    // Also list assets that have ONLY constraints (no baked profile yet) — they
    // are still "in the library", so the panel must show every SM with any entry.
    for (const TPair<FString, int32>& CC : ConstraintCounts)
    {
        if (Seen.Contains(CC.Key)) continue;
        TSharedPtr<FHaybaLibraryEntry> E = MakeShared<FHaybaLibraryEntry>();
        E->AssetId = CC.Key;
        E->ConstraintCount = CC.Value;
        AllEntries.Add(E);
    }
    RebuildTree();
}

void SHaybaMCPMemoryPanel::RebuildTree()
{
    RootNodes.Reset();
    for (const TSharedPtr<FHaybaLibraryEntry>& E : AllEntries)
    {
        if (!Filter.IsEmpty() && !E->AssetId.Contains(Filter)) continue;

        // Split "/Game/Props/SM_Door.SM_Door" into folder segments + leaf.
        FString Path = E->AssetId;
        Path.RemoveFromStart(TEXT("/"));
        TArray<FString> Segments; Path.ParseIntoArray(Segments, TEXT("/"), true);
        if (Segments.Num() == 0) continue;

        TArray<TSharedPtr<FHaybaLibraryNode>>* Level = &RootNodes;
        for (int32 i = 0; i < Segments.Num() - 1; ++i)
        {
            const FString& Seg = Segments[i];
            TSharedPtr<FHaybaLibraryNode>* Found = Level->FindByPredicate([&](const TSharedPtr<FHaybaLibraryNode>& N){ return N->bFolder && N->Name == Seg; });
            TSharedPtr<FHaybaLibraryNode> Folder = Found ? *Found : nullptr;
            if (!Folder) { Folder = MakeShared<FHaybaLibraryNode>(); Folder->bFolder = true; Folder->Name = Seg; Level->Add(Folder); }
            Level = &Folder->Children;
        }
        TSharedPtr<FHaybaLibraryNode> Leaf = MakeShared<FHaybaLibraryNode>();
        Leaf->Name = FPaths::GetBaseFilename(E->AssetId);
        Leaf->Asset = E;
        Level->Add(Leaf);
    }
    if (Tree.IsValid())
    {
        Tree->RequestTreeRefresh();
        for (const TSharedPtr<FHaybaLibraryNode>& N : RootNodes) Tree->SetItemExpansion(N, true);
    }
}

void SHaybaMCPMemoryPanel::GetChildren(TSharedPtr<FHaybaLibraryNode> Node, TArray<TSharedPtr<FHaybaLibraryNode>>& Out)
{
    if (Node.IsValid() && Node->bFolder) Out = Node->Children;
}

FReply SHaybaMCPMemoryPanel::OnRefresh() { Reload(); return FReply::Handled(); }
void SHaybaMCPMemoryPanel::OnSearchChanged(const FText& Text) { Filter = Text.ToString(); RebuildTree(); }

TSharedRef<ITableRow> SHaybaMCPMemoryPanel::GenerateRow(TSharedPtr<FHaybaLibraryNode> Node, const TSharedRef<STableViewBase>& Owner)
{
    if (Node->bFolder)
    {
        return SNew(STableRow<TSharedPtr<FHaybaLibraryNode>>, Owner)
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(0, 0, 4, 0)
            [ SNew(SImage).Image(FAppStyle::Get().GetBrush("Icons.FolderClosed")) ]
            + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center)
            [ SNew(STextBlock).TextStyle(FAppStyle::Get(), "ButtonText").Text(FText::FromString(Node->Name)) ]
        ];
    }

    const TSharedPtr<FHaybaLibraryEntry> E = Node->Asset;
    const FString AssetId = E->AssetId;
    const FString Counts = FString::Printf(TEXT("%d masks  ·  %d constraints%s"), E->MaskCount, E->ConstraintCount,
        E->LockedCount > 0 ? *FString::Printf(TEXT("  ·  %d locked"), E->LockedCount) : TEXT(""));

    return SNew(STableRow<TSharedPtr<FHaybaLibraryNode>>, Owner).Padding(2)
    [
        SNew(SHorizontalBox)
        + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(2, 0)
        [
            SNew(SCheckBox)
            .IsChecked_Lambda([this, AssetId](){ return Checked.Contains(AssetId) ? ECheckBoxState::Checked : ECheckBoxState::Unchecked; })
            .OnCheckStateChanged_Lambda([this, AssetId](ECheckBoxState S){ if (S == ECheckBoxState::Checked) Checked.Add(AssetId); else Checked.Remove(AssetId); })
        ]
        + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center).Padding(4, 2)
        [
            SNew(SVerticalBox)
            + SVerticalBox::Slot().AutoHeight()[ SNew(STextBlock).Text(FText::FromString(Node->Name)).TextStyle(FAppStyle::Get(), "ButtonText") ]
            + SVerticalBox::Slot().AutoHeight()[ SNew(STextBlock).Text(FText::FromString(Counts)).ColorAndOpacity(FSlateColor::UseSubduedForeground()) ]
        ]
        + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(4, 0)
        [
            SNew(SButton).Text(LOCTEXT("OpenInStudio", "Open in Studio"))
            .OnClicked_Lambda([AssetId]()
            {
                if (FHaybaMCPModule* M = FModuleManager::GetModulePtr<FHaybaMCPModule>("HaybaMCPToolkit")) M->OpenStudioForAsset(AssetId);
                return FReply::Handled();
            })
        ]
    ];
}

void SHaybaMCPMemoryPanel::CollectAssets(const TSharedPtr<FHaybaLibraryNode>& Node, TArray<FString>& Out) const
{
    if (!Node.IsValid()) return;
    if (Node->bFolder) { for (const auto& C : Node->Children) CollectAssets(C, Out); }
    else if (Node->Asset.IsValid()) Out.Add(Node->Asset->AssetId);
}

FReply SHaybaMCPMemoryPanel::OnCheckAll()
{
    for (const TSharedPtr<FHaybaLibraryEntry>& E : AllEntries) Checked.Add(E->AssetId);
    if (Tree.IsValid()) Tree->RequestTreeRefresh();
    return FReply::Handled();
}

FReply SHaybaMCPMemoryPanel::OnCheckNone()
{
    Checked.Reset();
    if (Tree.IsValid()) Tree->RequestTreeRefresh();
    return FReply::Handled();
}

FReply SHaybaMCPMemoryPanel::OnApplyTemplate()
{
    if (Checked.Num() == 0 || !SelectedPrimitive.IsValid()) return FReply::Handled();
    const FString Prim = *SelectedPrimitive;

    TSharedPtr<FJsonObject> Root = ReadObj(ConstraintsFile());
    for (const FString& Asset : Checked)
    {
        const FString Base = FPaths::GetBaseFilename(Asset);
        const FString Id = FString::Printf(TEXT("%s_%s_tmpl"), *Base, *Prim);
        TSharedPtr<FJsonObject> C = MakeShared<FJsonObject>();
        C->SetStringField(TEXT("id"), Id);
        C->SetStringField(TEXT("primitive"), Prim);
        C->SetObjectField(TEXT("params"), MakeShared<FJsonObject>());
        TSharedPtr<FJsonObject> B = MakeShared<FJsonObject>();
        B->SetStringField(TEXT("asset"), Asset);
        C->SetObjectField(TEXT("binding"), B);
        C->SetBoolField(TEXT("enabled"), true);
        Root->SetObjectField(Id, C);
    }
    WriteObj(ConstraintsFile(), Root);
    UE_LOG(LogTemp, Log, TEXT("[Hayba Library] applied '%s' to %d asset(s)"), *Prim, Checked.Num());
    Reload();
    return FReply::Handled();
}

FReply SHaybaMCPMemoryPanel::OnRemoveChecked()
{
    if (Checked.Num() == 0) return FReply::Handled();

    TSharedPtr<FJsonObject> Profiles = ReadObj(ProfilesFile());
    for (const FString& Asset : Checked) Profiles->RemoveField(Asset);
    WriteObj(ProfilesFile(), Profiles);

    // Drop constraints bound to removed assets.
    TSharedPtr<FJsonObject> Constraints = ReadObj(ConstraintsFile());
    TArray<FString> ToRemove;
    for (const auto& Pair : Constraints->Values)
    {
        const TSharedPtr<FJsonObject> C = Pair.Value->AsObject();
        const TSharedPtr<FJsonObject>* B = nullptr;
        FString Asset;
        if (C.IsValid() && C->TryGetObjectField(TEXT("binding"), B) && B) (*B)->TryGetStringField(TEXT("asset"), Asset);
        if (Checked.Contains(Asset)) ToRemove.Add(Pair.Key);
    }
    for (const FString& K : ToRemove) Constraints->RemoveField(K);
    WriteObj(ConstraintsFile(), Constraints);

    Checked.Reset();
    Reload();
    return FReply::Handled();
}

#undef LOCTEXT_NAMESPACE
