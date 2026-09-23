// SHaybaValidatorPanel.cpp
#include "Slate/SHaybaValidatorPanel.h"

#include "DirectoryWatcherModule.h"
#include "Editor.h"
#include "Engine/Selection.h"
#include "GameFramework/Actor.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformProcess.h"
#include "IDirectoryWatcher.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Modules/ModuleManager.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Subsystems/EditorActorSubsystem.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SCheckBox.h"
#include "Widgets/Input/SSearchBox.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SScrollBox.h"
#include "Widgets/Layout/SWrapBox.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Views/STableRow.h"

namespace
{
    FSlateColor ColorForSeverity(const FString& Sev)
    {
        if (Sev == TEXT("error"))   return FSlateColor(FLinearColor(1.f, 0.3f, 0.3f));
        if (Sev == TEXT("warning")) return FSlateColor(FLinearColor(1.f, 0.85f, 0.2f));
        return FSlateColor(FLinearColor(0.55f, 0.7f, 1.f));
    }

}

FReply SHaybaValidatorPanel::OnDismissClicked(TSharedPtr<FHaybaValidatorFinding> Item)
{
    if (!Item.IsValid()) return FReply::Handled();
    Item->bResolved = !Item->bResolved;
    Item->ResolvedAt = Item->bResolved ? FDateTime::UtcNow().ToIso8601() : FString();
    WriteAllFindings(AllItems);
    ApplyFilter();
    return FReply::Handled();
}
FReply SHaybaValidatorPanel::OnJumpToActorClicked(TSharedPtr<FHaybaValidatorFinding> Item)
{
    if (!Item.IsValid()) return FReply::Handled();
    if (!GEditor) return FReply::Handled();

    UEditorActorSubsystem* Sub = GEditor->GetEditorSubsystem<UEditorActorSubsystem>();
    if (!Sub) return FReply::Handled();

    AActor* Match = nullptr;
    for (AActor* A : Sub->GetAllLevelActors())
    {
        if (!A) continue;
        if (!Item->ActorId.IsEmpty() && A->GetName() == Item->ActorId) { Match = A; break; }
        if (!Item->ActorLabel.IsEmpty() && A->GetActorLabel() == Item->ActorLabel) { Match = A; break; }
    }
    if (Match)
    {
        GEditor->SelectNone(false, true);
        GEditor->SelectActor(Match, true, true, true);
        GEditor->MoveViewportCamerasToActor(*Match, false);
    }
    return FReply::Handled();
}

// ── Path helpers ───────────────────────────────────────────────────────────

FString SHaybaValidatorPanel::DefaultScratchDir()
{
    FString Override = FPlatformMisc::GetEnvironmentVariable(TEXT("HAYBA_VALIDATOR_HISTORY"));
    if (!Override.IsEmpty())
    {
        return FPaths::GetPath(Override);
    }
    return FPaths::Combine(FPaths::ProjectDir(), TEXT(".scratch"));
}

FString SHaybaValidatorPanel::DefaultHistoryPath()
{
    FString Override = FPlatformMisc::GetEnvironmentVariable(TEXT("HAYBA_VALIDATOR_HISTORY"));
    if (!Override.IsEmpty()) return Override;
    return FPaths::Combine(DefaultScratchDir(), TEXT("validator-history.jsonl"));
}

// ── Construct ──────────────────────────────────────────────────────────────

void SHaybaValidatorPanel::Construct(const FArguments& InArgs)
{
    HistoryFile = DefaultHistoryPath();
    WatchedDir  = FPaths::GetPath(HistoryFile);
    IFileManager::Get().MakeDirectory(*WatchedDir, /*Tree*/true);

    ChildSlot
    [
        SNew(SVerticalBox)

        + SVerticalBox::Slot().AutoHeight().Padding(8.f, 8.f, 8.f, 4.f)
        [ SAssignNew(HeaderText, STextBlock).AutoWrapText(true) ]
        + SVerticalBox::Slot().AutoHeight().Padding(8.f, 2.f)
        [
            SNew(SSearchBox)
            .HintText(FText::FromString(TEXT("Search findings")))
            .OnTextChanged_Lambda([this](const FText& Text) { SearchText = Text.ToString(); ApplyFilter(); })
        ]
        + SVerticalBox::Slot().AutoHeight().Padding(8.f, 4.f)
        [
            SNew(SWrapBox).UseAllottedSize(true).InnerSlotPadding(FVector2D(10.f, 4.f))
            + SWrapBox::Slot()
            [ SNew(SCheckBox).IsChecked(ECheckBoxState::Checked)
                .OnCheckStateChanged_Lambda([this](ECheckBoxState S) { bShowError = S == ECheckBoxState::Checked; ApplyFilter(); })
                [ SNew(STextBlock).Text(FText::FromString(TEXT("Errors"))) ] ]
            + SWrapBox::Slot()
            [ SNew(SCheckBox).IsChecked(ECheckBoxState::Checked)
                .OnCheckStateChanged_Lambda([this](ECheckBoxState S) { bShowWarning = S == ECheckBoxState::Checked; ApplyFilter(); })
                [ SNew(STextBlock).Text(FText::FromString(TEXT("Warnings"))) ] ]
            + SWrapBox::Slot()
            [ SNew(SCheckBox).IsChecked(ECheckBoxState::Checked)
                .OnCheckStateChanged_Lambda([this](ECheckBoxState S) { bShowInfo = S == ECheckBoxState::Checked; ApplyFilter(); })
                [ SNew(STextBlock).Text(FText::FromString(TEXT("Info"))) ] ]
            + SWrapBox::Slot()
            [ SNew(SCheckBox).IsChecked(ECheckBoxState::Unchecked)
                .OnCheckStateChanged_Lambda([this](ECheckBoxState S) { bIncludeResolved = S == ECheckBoxState::Checked; ApplyFilter(); })
                [ SNew(STextBlock).Text(FText::FromString(TEXT("Resolved"))) ] ]
        ]
        + SVerticalBox::Slot().AutoHeight().Padding(8.f, 4.f)
        [ SNew(STextBlock).AutoWrapText(true)
            .Visibility_Lambda([this]() { return FilteredItems.IsEmpty() ? EVisibility::Visible : EVisibility::Collapsed; })
            .Text_Lambda([this]() { return FText::FromString(AllItems.IsEmpty()
                ? TEXT("No recorded findings. Use Validate with Agent to run available checks.")
                : TEXT("No findings match these filters.")); }) ]

        // ── Table ──────────────────────────────────────────────────────
        + SVerticalBox::Slot().FillHeight(1.f).Padding(4)
        [
            SAssignNew(ListView, SListView<TSharedPtr<FHaybaValidatorFinding>>)
            .ListItemsSource(&FilteredItems)
            .OnGenerateRow(this, &SHaybaValidatorPanel::OnGenerateRow)
            .OnSelectionChanged(this, &SHaybaValidatorPanel::OnSelectionChanged)
            .SelectionMode(ESelectionMode::Single)
        ]
    ];

    // ── Watch the scratch dir for any change to the JSONL file. ─────
    if (FDirectoryWatcherModule* DWM =
            FModuleManager::Get().GetModulePtr<FDirectoryWatcherModule>(TEXT("DirectoryWatcher")))
    {
        if (IDirectoryWatcher* Watcher = DWM->Get())
        {
            Watcher->RegisterDirectoryChangedCallback_Handle(
                WatchedDir,
                IDirectoryWatcher::FDirectoryChanged::CreateSP(this, &SHaybaValidatorPanel::OnDirectoryChanged),
                WatcherHandle);
        }
    }

    Refresh();
}

SHaybaValidatorPanel::~SHaybaValidatorPanel()
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

// ── Refresh / parse ────────────────────────────────────────────────────────

void SHaybaValidatorPanel::Refresh()
{
    AllItems.Reset();
    FString Buffer;
    if (FFileHelper::LoadFileToString(Buffer, *HistoryFile))
    {
        TArray<FString> Lines;
        Buffer.ParseIntoArrayLines(Lines, /*CullEmpty*/true);
        for (const FString& Line : Lines)
        {
            if (TSharedPtr<FHaybaValidatorFinding> F = ParseFindingLine(Line))
            {
                AllItems.Add(F);
            }
        }
    }
    ApplyFilter();
    UpdateHeader();
}

TSharedPtr<FHaybaValidatorFinding> SHaybaValidatorPanel::ParseFindingLine(const FString& Line)
{
    TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Line);
    TSharedPtr<FJsonObject> Obj;
    if (!FJsonSerializer::Deserialize(Reader, Obj) || !Obj.IsValid()) return nullptr;

    TSharedRef<FHaybaValidatorFinding> F = MakeShared<FHaybaValidatorFinding>();
    F->RawJson    = Line;
    F->RuleId     = Obj->GetStringField(TEXT("ruleId"));
    F->Severity   = Obj->GetStringField(TEXT("severity"));
    F->Message    = Obj->GetStringField(TEXT("message"));
    F->Hint       = Obj->GetStringField(TEXT("hint"));
    F->Timestamp  = Obj->GetStringField(TEXT("timestamp"));
    F->ToolName   = Obj->GetStringField(TEXT("toolName"));
    F->bResolved  = Obj->HasField(TEXT("resolved")) && Obj->GetBoolField(TEXT("resolved"));
    F->ResolvedAt = Obj->HasField(TEXT("resolvedAt")) ? Obj->GetStringField(TEXT("resolvedAt")) : FString();

    const TArray<TSharedPtr<FJsonValue>>* RefsArr = nullptr;
    if (Obj->TryGetArrayField(TEXT("refs"), RefsArr))
    {
        for (const TSharedPtr<FJsonValue>& V : *RefsArr)
            if (V.IsValid() && V->Type == EJson::String) F->Refs.Add(V->AsString());
    }

    const TSharedPtr<FJsonObject>* Ctx = nullptr;
    if (Obj->TryGetObjectField(TEXT("context"), Ctx) && Ctx->IsValid())
    {
        FString S;
        if ((*Ctx)->TryGetStringField(TEXT("actor_label"), S)) F->ActorLabel = S;
        if ((*Ctx)->TryGetStringField(TEXT("actorLabel"),  S)) F->ActorLabel = S;
        if ((*Ctx)->TryGetStringField(TEXT("actor_id"),    S)) F->ActorId    = S;
        if ((*Ctx)->TryGetStringField(TEXT("actorId"),     S)) F->ActorId    = S;
        if ((*Ctx)->TryGetStringField(TEXT("graph"),       S)) F->GraphPath  = S;
    }

    return F;
}

FString SHaybaValidatorPanel::FindingToJson(const FHaybaValidatorFinding& F)
{
    TSharedRef<FJsonObject> Obj = MakeShared<FJsonObject>();
    // Start with the original JSON so we preserve fields we don't model
    // (context, refs, custom keys). Then overlay any panel-modified fields.
    if (!F.RawJson.IsEmpty())
    {
        TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(F.RawJson);
        TSharedPtr<FJsonObject> Existing;
        if (FJsonSerializer::Deserialize(Reader, Existing) && Existing.IsValid())
        {
            Obj = Existing.ToSharedRef();
        }
    }
    Obj->SetStringField(TEXT("ruleId"),    F.RuleId);
    Obj->SetStringField(TEXT("severity"),  F.Severity);
    Obj->SetStringField(TEXT("message"),   F.Message);
    Obj->SetStringField(TEXT("hint"),      F.Hint);
    Obj->SetStringField(TEXT("timestamp"), F.Timestamp);
    Obj->SetStringField(TEXT("toolName"),  F.ToolName);
    Obj->SetBoolField  (TEXT("resolved"),  F.bResolved);
    if (F.bResolved && !F.ResolvedAt.IsEmpty())
        Obj->SetStringField(TEXT("resolvedAt"), F.ResolvedAt);
    else
        Obj->RemoveField(TEXT("resolvedAt"));

    FString Out;
    TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
        TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Out);
    FJsonSerializer::Serialize(Obj, Writer);
    return Out;
}

void SHaybaValidatorPanel::ApplyFilter()
{
    FilteredItems.Reset();
    const FString Needle = SearchText.TrimStartAndEnd().ToLower();
    for (const TSharedPtr<FHaybaValidatorFinding>& F : AllItems)
    {
        if (!F.IsValid()) continue;
        if (!bIncludeResolved && F->bResolved) continue;
        if (F->Severity == TEXT("error")   && !bShowError)   continue;
        if (F->Severity == TEXT("warning") && !bShowWarning) continue;
        if (F->Severity == TEXT("info")    && !bShowInfo)    continue;
        if (!Needle.IsEmpty())
        {
            const bool bMatch =
                F->RuleId.ToLower().Contains(Needle) ||
                F->Message.ToLower().Contains(Needle) ||
                F->ToolName.ToLower().Contains(Needle);
            if (!bMatch) continue;
        }
        FilteredItems.Add(F);
    }
    if (ListView) ListView->RequestListRefresh();
    UpdateHeader();
}

void SHaybaValidatorPanel::UpdateHeader()
{
    if (!HeaderText.IsValid()) return;
    int32 Unresolved = 0;
    for (const TSharedPtr<FHaybaValidatorFinding>& F : AllItems)
        if (F.IsValid() && !F->bResolved) ++Unresolved;
    HeaderText->SetText(FText::FromString(FString::Printf(
        TEXT("Findings: %d recorded, %d unresolved"),
        AllItems.Num(), Unresolved)));
}

TSharedRef<ITableRow> SHaybaValidatorPanel::OnGenerateRow(
    TSharedPtr<FHaybaValidatorFinding> Item, const TSharedRef<STableViewBase>& Owner)
{
    return SNew(STableRow<TSharedPtr<FHaybaValidatorFinding>>, Owner)
        .Padding(FMargin(8.f, 6.f))
        [
            SNew(SVerticalBox)
            + SVerticalBox::Slot().AutoHeight()
            [ SNew(STextBlock).Text(FText::FromString(Item->Severity + TEXT(" / ") + Item->RuleId))
                .ColorAndOpacity(ColorForSeverity(Item->Severity)).AutoWrapText(true) ]
            + SVerticalBox::Slot().AutoHeight().Padding(0.f, 4.f)
            [ SNew(STextBlock).Text(FText::FromString(Item->Message)).AutoWrapText(true)
                .ToolTipText(FText::FromString(Item->Hint)) ]
            + SVerticalBox::Slot().AutoHeight()
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().AutoWidth()
                [ SNew(SButton).Text_Lambda([Item]() { return FText::FromString(Item->bResolved ? TEXT("Restore") : TEXT("Dismiss")); })
                    .OnClicked_Lambda([this, Item]() { return OnDismissClicked(Item); }) ]
                + SHorizontalBox::Slot().AutoWidth().Padding(6.f, 0.f)
                [ SNew(SButton).Text(FText::FromString(TEXT("Locate actor")))
                    .Visibility(Item->ActorLabel.IsEmpty() && Item->ActorId.IsEmpty() ? EVisibility::Collapsed : EVisibility::Visible)
                    .OnClicked_Lambda([this, Item]() { return OnJumpToActorClicked(Item); }) ]
            ]
        ];
}

void SHaybaValidatorPanel::OnSelectionChanged(TSharedPtr<FHaybaValidatorFinding> Item, ESelectInfo::Type)
{
    Selected = Item;
}

void SHaybaValidatorPanel::OnDirectoryChanged(const TArray<FFileChangeData>& Changes)
{
    for (const FFileChangeData& C : Changes)
    {
        if (FPaths::GetCleanFilename(C.Filename).Equals(FPaths::GetCleanFilename(HistoryFile), ESearchCase::IgnoreCase))
        {
            Refresh();
            return;
        }
    }
}

bool SHaybaValidatorPanel::WriteAllFindings(const TArray<TSharedPtr<FHaybaValidatorFinding>>& Findings) const
{
    FString Buffer;
    for (const TSharedPtr<FHaybaValidatorFinding>& F : Findings)
    {
        if (!F.IsValid()) continue;
        Buffer += FindingToJson(*F);
        Buffer += LINE_TERMINATOR;
    }
    return FFileHelper::SaveStringToFile(Buffer, *HistoryFile);
}
