// SHaybaValidatorPanel.cpp
#include "Slate/SHaybaValidatorPanel.h"
#include "ScopedTransaction.h"
#include "HaybaMCPStyle.h"

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
#include "Widgets/SBoxPanel.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Views/SHeaderRow.h"
#include "Widgets/Views/STableRow.h"

namespace
{
    const FName ColSeverity("Severity");
    const FName ColRuleId("RuleId");
    const FName ColMessage("Message");
    const FName ColTool("Tool");
    const FName ColTime("Time");
    const FName ColMargin("Margin");
    const FName ColActions("Actions");

    FSlateColor ColorForSeverity(const FString& Sev)
    {
        if (Sev == TEXT("error"))   return FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Status.Fail"));
        if (Sev == TEXT("warning")) return FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Status.Warn"));
        return FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Status.Info"));
    }

    /** Trim long strings for the table; full text is in the tooltip. */
    FString Truncate(const FString& S, int32 Max)
    {
        if (S.Len() <= Max) return S;
        return S.Left(Max - 1) + TEXT("…");
    }

    /** Per-row table widget. */
    class SValidatorTableRow : public SMultiColumnTableRow<TSharedPtr<FHaybaValidatorFinding>>
    {
    public:
        SLATE_BEGIN_ARGS(SValidatorTableRow) {}
            SLATE_ARGUMENT(TSharedPtr<FHaybaValidatorFinding>, Item)
            SLATE_ARGUMENT(SHaybaValidatorPanel*, Panel)
        SLATE_END_ARGS()

        void Construct(const FArguments& InArgs, const TSharedRef<STableViewBase>& Owner)
        {
            Item = InArgs._Item;
            Panel = InArgs._Panel;
            SMultiColumnTableRow::Construct(FSuperRowType::FArguments(), Owner);
        }

        virtual TSharedRef<SWidget> GenerateWidgetForColumn(const FName& Column) override
        {
            if (!Item.IsValid()) return SNullWidget::NullWidget;

            if (Column == ColSeverity)
            {
                return SNew(SBorder)
                    .Padding(FMargin(6, 2))
                    .BorderBackgroundColor(ColorForSeverity(Item->Severity))
                    [
                        SNew(STextBlock)
                        .Text(FText::FromString(Item->Severity.ToUpper()))
                        .ColorAndOpacity(FSlateColor(FLinearColor::White))
                    ];
            }
            if (Column == ColRuleId)
            {
                return SNew(STextBlock)
                    .Margin(FMargin(6, 3))
                    .Text(FText::FromString(Item->RuleId))
                    .ToolTipText(FText::FromString(Item->Hint));
            }
            if (Column == ColMessage)
            {
                // Tool and timestamp ride along here now that they have no
                // column of their own. In a tooltip they are readable in full;
                // in a 40px column they were not readable at all.
                FString Tip = Item->Message + TEXT("\n\nHint: ") + Item->Hint;
                if (!Item->ToolName.IsEmpty())  Tip += TEXT("\n\nTool: ") + Item->ToolName;
                if (!Item->Timestamp.IsEmpty()) Tip += TEXT("\nWhen: ") + Item->Timestamp;

                return SNew(STextBlock)
                    .Margin(FMargin(6, 3))
                    .Text(FText::FromString(Truncate(Item->Message, 120)))
                    .ToolTipText(FText::FromString(Tip));
            }
            if (Column == ColTool)
            {
                return SNew(STextBlock)
                    .Margin(FMargin(6, 3))
                    .Text(FText::FromString(Item->ToolName));
            }
            if (Column == ColTime)
            {
                return SNew(STextBlock)
                    .Margin(FMargin(6, 3))
                    .Text(FText::FromString(Truncate(Item->Timestamp, 19)));
            }
            if (Column == ColMargin)
            {
                // No measurement is not zero. A producer that did not measure
                // gets an em dash, not "+0.0 m", which would read as "sitting
                // exactly on the limit" -- a different and much stronger claim.
                if (!Item->bHasMeasurement)
                {
                    return SNew(STextBlock)
                        .Margin(FMargin(6, 3))
                        .Text(FText::FromString(TEXT("\u2014")))
                        .ColorAndOpacity(FSlateColor(
                            FHaybaMCPStyle::Colour("Hayba.Color.Text.Muted")))
                        .ToolTipText(FText::FromString(
                            TEXT("This check did not report a measured margin.")));
                }

                // Always signed. The sign IS the direction, and the IA's
                // contract needs the direction as much as the amount.
                const FString Text = FString::Printf(TEXT("%+.2f %s"),
                    Item->MarginValue,
                    Item->MarginUnit.IsEmpty() ? TEXT("") : *Item->MarginUnit);

                const bool bSatisfied = Item->MarginValue >= 0.0;
                return SNew(STextBlock)
                    .Margin(FMargin(6, 3))
                    .Text(FText::FromString(Text.TrimEnd()))
                    .ColorAndOpacity(FSlateColor(bSatisfied
                        ? FHaybaMCPStyle::Colour("Hayba.Color.Text.Primary")
                        : FHaybaMCPStyle::Colour("Hayba.Color.Accent.Ochre")))
                    .ToolTipText(FText::FromString(
                        Item->MarginDetail.IsEmpty()
                            ? (bSatisfied
                                ? TEXT("Satisfied by this margin.")
                                : TEXT("Short of the constraint by this margin."))
                            : *Item->MarginDetail));
            }
            if (Column == ColActions)
            {
                TSharedRef<SHorizontalBox> ActionsBox = SNew(SHorizontalBox);

                // Fix only when a vector was actually returned. A Fix button
                // that cannot move anything teaches the user to distrust it.
                if (Item->bHasFix)
                {
                    ActionsBox->AddSlot().AutoWidth().Padding(2)
                    [
                        SNew(SButton)
                        .ContentPadding(FMargin(6, 2))
                        .ToolTipText(FText::FromString(FString::Printf(
                            TEXT("Move the actor by (%.1f, %.1f, %.1f) to satisfy this rule. Undoable."),
                            Item->FixTranslate.X, Item->FixTranslate.Y, Item->FixTranslate.Z)))
                        .OnClicked_Lambda([this]() -> FReply {
                            if (Panel) return Panel->OnApplyFixClicked_Public(Item);
                            return FReply::Handled();
                        })
                        [
                            SNew(STextBlock)
                            .Text(FText::FromString(TEXT("Fix")))
                            .ColorAndOpacity(FSlateColor(
                                FHaybaMCPStyle::Colour("Hayba.Color.Accent.Ochre")))
                        ]
                    ];
                }
                ActionsBox->AddSlot().AutoWidth().Padding(2)
                [
                    SNew(SButton)
                    .ContentPadding(FMargin(6, 2))
                    .ToolTipText(FText::FromString(TEXT("Mark this finding as resolved (or restore it).")))
                    .OnClicked_Lambda([this]() -> FReply {
                        if (Panel) return Panel->OnDismissClicked_Public(Item);
                        return FReply::Handled();
                    })
                    [ SNew(STextBlock).Text(FText::FromString(Item->bResolved ? TEXT("Restore") : TEXT("Dismiss"))) ]
                ];
                if (!Item->ActorLabel.IsEmpty() || !Item->ActorId.IsEmpty())
                {
                    ActionsBox->AddSlot().AutoWidth().Padding(2)
                    [
                        SNew(SButton)
                        .ContentPadding(FMargin(6, 2))
                        .ToolTipText(FText::FromString(TEXT("Select the actor referenced by this finding and frame it in the viewport.")))
                        .OnClicked_Lambda([this]() -> FReply {
                            if (Panel) return Panel->OnJumpToActorClicked_Public(Item);
                            return FReply::Handled();
                        })
                        [ SNew(STextBlock).Text(FText::FromString(TEXT("Jump"))) ]
                    ];
                }
                return ActionsBox;
            }
            return SNullWidget::NullWidget;
        }

    private:
        TSharedPtr<FHaybaValidatorFinding> Item;
        SHaybaValidatorPanel* Panel = nullptr;
    };
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

    AActor* Match = ResolveActor(Item);
    if (Match)
    {
        GEditor->SelectNone(false, true);
        GEditor->SelectActor(Match, true, true, true);
        GEditor->MoveViewportCamerasToActor(*Match, false);
    }
    return FReply::Handled();
}

AActor* SHaybaValidatorPanel::ResolveActor(const TSharedPtr<FHaybaValidatorFinding>& Item)
{
    if (!Item.IsValid() || !GEditor) return nullptr;
    UEditorActorSubsystem* Sub = GEditor->GetEditorSubsystem<UEditorActorSubsystem>();
    if (!Sub) return nullptr;

    for (AActor* A : Sub->GetAllLevelActors())
    {
        if (!A) continue;
        if (!Item->ActorId.IsEmpty() && A->GetName() == Item->ActorId) return A;
        if (!Item->ActorLabel.IsEmpty() && A->GetActorLabel() == Item->ActorLabel) return A;
    }
    return nullptr;
}

FReply SHaybaValidatorPanel::OnApplyFixClicked(TSharedPtr<FHaybaValidatorFinding> Item)
{
    if (!Item.IsValid() || !Item->bHasFix) return FReply::Handled();

    AActor* Target = ResolveActor(Item);
    if (!Target) return FReply::Handled();

    // Transacted, so the fix is undoable. An edit the user cannot take back is
    // not a next action, it is a gamble.
    const FScopedTransaction Transaction(
        NSLOCTEXT("Hayba", "ApplyRuleFix", "Apply rule fix"));
    Target->Modify();
    Target->SetActorLocation(Target->GetActorLocation() + Item->FixTranslate);

    // Show the result. Applying a fix the user cannot see is indistinguishable
    // from the button doing nothing.
    GEditor->SelectNone(false, true);
    GEditor->SelectActor(Target, true, true, true);
    GEditor->MoveViewportCamerasToActor(*Target, false);
    return FReply::Handled();
}

// Public bridge methods used by the table-row class — defined here so the
// member access checker is satisfied without making the row a friend.
FReply SHaybaValidatorPanel::OnDismissClicked_Public(TSharedPtr<FHaybaValidatorFinding> Item) { return OnDismissClicked(Item); }
FReply SHaybaValidatorPanel::OnJumpToActorClicked_Public(TSharedPtr<FHaybaValidatorFinding> Item) { return OnJumpToActorClicked(Item); }
FReply SHaybaValidatorPanel::OnApplyFixClicked_Public(TSharedPtr<FHaybaValidatorFinding> Item) { return OnApplyFixClicked(Item); }

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

        // ── Header row ────────────────────────────────────────────────
        + SVerticalBox::Slot().AutoHeight().Padding(4)
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center).Padding(4, 0)
            [ SAssignNew(HeaderText, STextBlock).Text(FText::FromString(TEXT("Validator history"))) ]
            + SHorizontalBox::Slot().AutoWidth().Padding(2)
            [
                SNew(SButton)
                .ContentPadding(FMargin(8, 3))
                .ToolTipText(FText::FromString(TEXT("Re-run every validator rule with an active evaluator.")))
                .OnClicked(this, &SHaybaValidatorPanel::OnReRunAllClicked)
                [ SNew(STextBlock).Text(FText::FromString(TEXT("Re-run All"))) ]
            ]
            + SHorizontalBox::Slot().AutoWidth().Padding(2)
            [
                SNew(SButton)
                .ContentPadding(FMargin(8, 3))
                .ToolTipText(FText::FromString(TEXT("Wipe the validator history. Findings can no longer be restored after this.")))
                .OnClicked(this, &SHaybaValidatorPanel::OnClearAllClicked)
                [ SNew(STextBlock).Text(FText::FromString(TEXT("Clear All"))) ]
            ]
        ]

        // ── Filter bar ────────────────────────────────────────────────
        + SVerticalBox::Slot().AutoHeight().Padding(4)
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center).Padding(2)
            [
                SNew(SSearchBox)
                .HintText(FText::FromString(TEXT("Search rule id, message, tool…")))
                .OnTextChanged_Lambda([this](const FText& T)
                {
                    SearchText = T.ToString();
                    ApplyFilter();
                })
            ]
            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(6, 2)
            [
                SNew(SCheckBox)
                .IsChecked(ECheckBoxState::Checked)
                .ToolTipText(FText::FromString(TEXT("Show error findings.")))
                .OnCheckStateChanged_Lambda([this](ECheckBoxState S) { bShowError = (S == ECheckBoxState::Checked); ApplyFilter(); })
                [ SNew(STextBlock).Text(FText::FromString(TEXT("Errors"))) ]
            ]
            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(6, 2)
            [
                SNew(SCheckBox)
                .IsChecked(ECheckBoxState::Checked)
                .ToolTipText(FText::FromString(TEXT("Show warning findings.")))
                .OnCheckStateChanged_Lambda([this](ECheckBoxState S) { bShowWarning = (S == ECheckBoxState::Checked); ApplyFilter(); })
                [ SNew(STextBlock).Text(FText::FromString(TEXT("Warnings"))) ]
            ]
            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(6, 2)
            [
                SNew(SCheckBox)
                .IsChecked(ECheckBoxState::Checked)
                .ToolTipText(FText::FromString(TEXT("Show info findings.")))
                .OnCheckStateChanged_Lambda([this](ECheckBoxState S) { bShowInfo = (S == ECheckBoxState::Checked); ApplyFilter(); })
                [ SNew(STextBlock).Text(FText::FromString(TEXT("Info"))) ]
            ]
            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(6, 2)
            [
                SNew(SCheckBox)
                .IsChecked(ECheckBoxState::Unchecked)
                .ToolTipText(FText::FromString(TEXT("Include findings that have been dismissed.")))
                .OnCheckStateChanged_Lambda([this](ECheckBoxState S) { bIncludeResolved = (S == ECheckBoxState::Checked); ApplyFilter(); })
                [ SNew(STextBlock).Text(FText::FromString(TEXT("Include resolved"))) ]
            ]
        ]

        // ── Table ──────────────────────────────────────────────────────
        + SVerticalBox::Slot().FillHeight(1.f).Padding(4)
        [
            SAssignNew(ListView, SListView<TSharedPtr<FHaybaValidatorFinding>>)
            .ListItemsSource(&FilteredItems)
            .OnGenerateRow(this, &SHaybaValidatorPanel::OnGenerateRow)
            .OnSelectionChanged(this, &SHaybaValidatorPanel::OnSelectionChanged)
            .SelectionMode(ESelectionMode::Single)
            .HeaderRow(
                SNew(SHeaderRow)
                // Tool and When are deliberately absent. At the dock's default
                // width they truncated to "ac" and "20" while costing a fifth
                // of the table; both now live in the row tooltip, readable in
                // full. What remains is what a verdict needs: what broke, by
                // how much and which way, and what to do about it.
                + SHeaderRow::Column(ColSeverity).DefaultLabel(FText::FromString(TEXT("Severity"))).FixedWidth(64)
                + SHeaderRow::Column(ColRuleId).DefaultLabel(FText::FromString(TEXT("Rule"))).FillWidth(0.26f)
                + SHeaderRow::Column(ColMessage).DefaultLabel(FText::FromString(TEXT("Message"))).FillWidth(0.44f)
                + SHeaderRow::Column(ColMargin).DefaultLabel(FText::FromString(TEXT("Margin"))).FixedWidth(76)
                + SHeaderRow::Column(ColActions).DefaultLabel(FText::FromString(TEXT("Actions"))).FixedWidth(158)
            )
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

    // The verdict collapse renamed this field from "context" to "data" on disk
    // (one Finding shape across the whole product). This panel reads the JSONL
    // itself rather than going through the server, so it has to know both:
    // "data" for anything written since, "context" for records already on a
    // user's machine.
    // The signed margin, read as a nested object because that is the shape the
    // TS contract emits. A flat "margin" key never existed; looking for one
    // would have found nothing and reported no measurement forever.
    const TSharedPtr<FJsonObject>* Meas = nullptr;
    if (Obj->TryGetObjectField(TEXT("measurement"), Meas) && Meas && Meas->IsValid())
    {
        double V = 0.0;
        // A missing margin and a margin of exactly zero mean different things
        // -- on the limit is not the same as unmeasured -- so record whether
        // the field was present rather than leaning on the value.
        if ((*Meas)->TryGetNumberField(TEXT("value"), V))
        {
            F->bHasMeasurement = true;
            F->MarginValue = V;
        }
        FString MS;
        if ((*Meas)->TryGetStringField(TEXT("unit"),   MS)) F->MarginUnit   = MS;
        if ((*Meas)->TryGetStringField(TEXT("detail"), MS)) F->MarginDetail = MS;

        // FixVector.translate is a 3-element ARRAY. It is not {x,y,z}; reading
        // it that way finds nothing and silently offers no fix.
        const TSharedPtr<FJsonObject>* Fix = nullptr;
        if ((*Meas)->TryGetObjectField(TEXT("fix"), Fix) && Fix && Fix->IsValid())
        {
            const TArray<TSharedPtr<FJsonValue>>* T = nullptr;
            if ((*Fix)->TryGetArrayField(TEXT("translate"), T) && T && T->Num() == 3)
            {
                bool bAllNumbers = true;
                double C[3] = { 0.0, 0.0, 0.0 };
                for (int32 i = 0; i < 3; ++i)
                {
                    if (!(*T)[i].IsValid() || !(*T)[i]->TryGetNumber(C[i]))
                    {
                        bAllNumbers = false;
                        break;
                    }
                }
                // A partial vector is not a fix. Offering one would move the
                // actor somewhere nobody computed.
                if (bAllNumbers)
                {
                    F->bHasFix = true;
                    F->FixTranslate = FVector(C[0], C[1], C[2]);
                }
            }
        }
    }

    const TSharedPtr<FJsonObject>* Ctx = nullptr;
    if (!Obj->TryGetObjectField(TEXT("data"), Ctx))
    {
        Obj->TryGetObjectField(TEXT("context"), Ctx);
    }
    if (Ctx && Ctx->IsValid())
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
        TEXT("Validator history — %d findings (%d unresolved)"),
        AllItems.Num(), Unresolved)));
}

TSharedRef<ITableRow> SHaybaValidatorPanel::OnGenerateRow(
    TSharedPtr<FHaybaValidatorFinding> Item, const TSharedRef<STableViewBase>& Owner)
{
    return SNew(SValidatorTableRow, Owner).Item(Item).Panel(this);
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

FReply SHaybaValidatorPanel::OnClearAllClicked()
{
    // Truncate the file. Same effect as the validator_clear MCP tool.
    FFileHelper::SaveStringToFile(FString(), *HistoryFile);
    AllItems.Reset();
    ApplyFilter();
    UpdateHeader();
    return FReply::Handled();
}

FReply SHaybaValidatorPanel::OnReRunAllClicked()
{
    // The panel is decoupled from the MCP transport, so we leave actual rule
    // execution to the agent / validator_run MCP tool. Provide a hint via the
    // header text so the user knows the click was registered.
    if (HeaderText.IsValid())
    {
        HeaderText->SetText(FText::FromString(TEXT(
            "Validator — invoke `validator_run {scope:'all'}` from the agent to re-evaluate all rules.")));
    }
    return FReply::Handled();
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
