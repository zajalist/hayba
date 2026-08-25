#include "HaybaMCPDiffPanel.h"
#include "HaybaMCPStyle.h"

#include "Widgets/SBoxPanel.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SScrollBox.h"
#include "Widgets/Layout/SSeparator.h"
#include "Widgets/Layout/SExpandableArea.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SSearchBox.h"
#include "Styling/AppStyle.h"

#include "ISourceControlModule.h"
#include "ISourceControlProvider.h"
#include "ISourceControlState.h"
#include "SourceControlHelpers.h"
#include "SourceControlOperations.h"
#include "Framework/Notifications/NotificationManager.h"
#include "Widgets/Notifications/SNotificationList.h"

#define LOCTEXT_NAMESPACE "HaybaMCPDiff"

namespace
{
    const FLinearColor ColorMuted    (0.55f, 0.57f, 0.65f);
    const FLinearColor ColorRemoved  (0.95f, 0.45f, 0.45f);
    const FLinearColor ColorAdded    (0.40f, 0.95f, 0.55f);
    const FLinearColor ColorAccent   (1.00f, 0.78f, 0.30f);
    const FLinearColor ColorSCOk     (0.40f, 0.95f, 0.55f);
    const FLinearColor ColorSCWarn   (1.00f, 0.78f, 0.30f);
    const FLinearColor ColorSCError  (1.00f, 0.40f, 0.40f);

    void Toast(const FText& Msg)
    {
        FNotificationInfo Info(Msg);
        Info.ExpireDuration = 2.5f;
        FSlateNotificationManager::Get().AddNotification(Info);
    }
}

// ── Construct ──────────────────────────────────────────────────────────────

void SHaybaMCPDiffPanel::Construct(const FArguments& InArgs)
{
    ChildSlot
    [
        SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight().Padding(12.f, 10.f, 12.f, 6.f)
        [ BuildHeader() ]

        + SVerticalBox::Slot().AutoHeight().Padding(12.f, 0.f)
        [ SNew(SSeparator).Thickness(1.f) ]

        + SVerticalBox::Slot().AutoHeight().Padding(12.f, 8.f)
        [ BuildToolbar() ]

        + SVerticalBox::Slot().FillHeight(1.f)
        [
            SNew(SScrollBox)
            + SScrollBox::Slot()
            [ SAssignNew(ListContainer, SVerticalBox) ]
        ]

        + SVerticalBox::Slot().AutoHeight()
        [ SNew(SSeparator).Thickness(1.f) ]

        + SVerticalBox::Slot().AutoHeight().Padding(12.f, 8.f)
        [ BuildFooter() ]
    ];

    RebuildList();
}

// ── Header (title + counts + provider chip) ────────────────────────────────

TSharedRef<SWidget> SHaybaMCPDiffPanel::BuildHeader()
{
    return SNew(SHorizontalBox)
        + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
        [
            SNew(STextBlock)
            .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("DetailsView.CategoryTextStyle"))
            .Text(LOCTEXT("DiffTitle", "Diff"))
        ]
        + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center).Padding(10.f, 0.f, 0.f, 0.f)
        [
            SNew(STextBlock)
            .ColorAndOpacity(FSlateColor(ColorMuted))
            .Text_Lambda([this]()
            {
                if (Entries.IsEmpty())
                    return LOCTEXT("DiffEmpty", "No AI mutations yet. Destructive ops will appear here with before/after values.");
                const TMap<FString, TArray<int32>> Groups = GroupByActor();
                return FText::FromString(FString::Printf(
                    TEXT("%d change%s · %d actor%s"),
                    Entries.Num(), Entries.Num() == 1 ? TEXT("") : TEXT("s"),
                    Groups.Num(),  Groups.Num()  == 1 ? TEXT("") : TEXT("s")));
            })
        ]
        + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
        [
            SNew(SBorder)
            .BorderImage(FAppStyle::GetBrush("Brushes.Panel"))
            .Padding(FMargin(8.f, 3.f))
            [
                SNew(STextBlock)
                .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("SmallText"))
                .Text_Lambda([this]()
                {
                    const bool bOn = IsSourceControlEnabled();
                    return FText::FromString(FString::Printf(
                        TEXT("Source control: %s"),
                        bOn ? *SourceControlProviderName() : TEXT("disabled")));
                })
                .ColorAndOpacity_Lambda([this]() -> FSlateColor
                {
                    return FSlateColor(IsSourceControlEnabled() ? ColorSCOk : ColorMuted);
                })
            ]
        ];
}

// ── Toolbar (search) ───────────────────────────────────────────────────────

TSharedRef<SWidget> SHaybaMCPDiffPanel::BuildToolbar()
{
    return SAssignNew(Search, SSearchBox)
        .HintText(LOCTEXT("DiffSearchHint", "Filter by actor or property..."))
        .OnTextChanged(this, &SHaybaMCPDiffPanel::OnSearchChanged);
}

// ── Footer (bulk source-control actions) ───────────────────────────────────

TSharedRef<SWidget> SHaybaMCPDiffPanel::BuildFooter()
{
    return SNew(SHorizontalBox)
        + SHorizontalBox::Slot().AutoWidth()
        [
            SNew(SButton)
            .ContentPadding(FMargin(12.f, 4.f))
            .ToolTipText(LOCTEXT("CheckOutAllTT",
                "Check out every level/asset touched by the AI so subsequent edits are recorded in your source control system."))
            .IsEnabled_Lambda([this]() { return IsSourceControlEnabled() && Entries.Num() > 0; })
            .OnClicked(this, &SHaybaMCPDiffPanel::OnCheckOutAll)
            [ SNew(STextBlock).Text(LOCTEXT("CheckOutAll", "Check Out All")) ]
        ]
        + SHorizontalBox::Slot().AutoWidth().Padding(6.f, 0.f, 0.f, 0.f)
        [
            SNew(SButton)
            .ContentPadding(FMargin(12.f, 4.f))
            .ToolTipText(LOCTEXT("RevertAllTT",
                "Revert every recorded AI mutation, restoring each property to its Before value."))
            .IsEnabled_Lambda([this]() { return Entries.Num() > 0; })
            .OnClicked(this, &SHaybaMCPDiffPanel::OnRevertAll)
            [ SNew(STextBlock).Text(LOCTEXT("RevertAll", "Revert All")) ]
        ]
        + SHorizontalBox::Slot().AutoWidth().Padding(6.f, 0.f, 0.f, 0.f)
        [
            SNew(SButton)
            .ButtonStyle(FAppStyle::Get(), "PrimaryButton")
            .ContentPadding(FMargin(12.f, 4.f))
            .ToolTipText(LOCTEXT("SubmitTT",
                "Submit all checked-out level/asset changes to source control with an auto-generated changelist description."))
            .IsEnabled_Lambda([this]() { return IsSourceControlEnabled() && Entries.Num() > 0; })
            .OnClicked(this, &SHaybaMCPDiffPanel::OnSubmit)
            [ SNew(STextBlock).Text(LOCTEXT("Submit", "Submit...")) ]
        ]
        + SHorizontalBox::Slot().FillWidth(1.f) [ SNew(SBox) ];
}

// ── Per-actor card ─────────────────────────────────────────────────────────

TSharedRef<SWidget> SHaybaMCPDiffPanel::BuildActorCard(const FString& ActorLabel, const TArray<int32>& EntryIndices)
{
    if (EntryIndices.IsEmpty()) return SNullWidget::NullWidget;

    // Pull representative metadata from the first entry.
    const FHaybaDiffEntry& First = *Entries[EntryIndices[0]];
    const FString LevelPackage = First.LevelPackage;
    const FString ClassName    = First.ActorClass;

    TSharedRef<SVerticalBox> Body = SNew(SVerticalBox);
    for (int32 i : EntryIndices)
    {
        Body->AddSlot().AutoHeight().Padding(0.f, 2.f)
        [ BuildEntryRow(i) ];
    }

    TSharedRef<SHorizontalBox> Title = SNew(SHorizontalBox)
        + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
        [
            SNew(STextBlock)
            .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("NormalText"))
            .Text(FText::FromString(ActorLabel))
        ];
    if (!ClassName.IsEmpty())
    {
        Title->AddSlot().AutoWidth().VAlign(VAlign_Center).Padding(8.f, 0.f, 0.f, 0.f)
        [
            SNew(STextBlock)
            .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("SmallText"))
            .ColorAndOpacity(FSlateColor(ColorMuted))
            .Text(FText::FromString(ClassName))
        ];
    }
    Title->AddSlot().FillWidth(1.f) [ SNew(SBox) ];
    Title->AddSlot().AutoWidth().VAlign(VAlign_Center).Padding(8.f, 0.f, 0.f, 0.f)
    [
        SNew(STextBlock)
        .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("SmallText"))
        .ColorAndOpacity(FSlateColor(ColorMuted))
        .Text(FText::FromString(FString::Printf(TEXT("%d change%s"),
            EntryIndices.Num(), EntryIndices.Num() == 1 ? TEXT("") : TEXT("s"))))
    ];
    Title->AddSlot().AutoWidth().VAlign(VAlign_Center).Padding(8.f, 0.f, 0.f, 0.f)
    [ BuildSourceControlBadge(LevelPackage) ];

    return SNew(SBorder)
        .BorderImage(FAppStyle::GetBrush("Brushes.Panel"))
        .Padding(FMargin(8.f, 6.f))
        [
            SNew(SExpandableArea)
            .InitiallyCollapsed(false)
            .HeaderContent() [ Title ]
            .BodyContent()
            [
                SNew(SVerticalBox)
                + SVerticalBox::Slot().AutoHeight().Padding(0.f, 6.f, 0.f, 0.f) [ Body ]
            ]
        ];
}

// ── Per-entry row (Property: Before → After + Accept / Revert) ────────────

TSharedRef<SWidget> SHaybaMCPDiffPanel::BuildEntryRow(int32 EntryIndex)
{
    if (!Entries.IsValidIndex(EntryIndex)) return SNullWidget::NullWidget;
    const FHaybaDiffEntry& E = *Entries[EntryIndex];

    return SNew(SHorizontalBox)
        + SHorizontalBox::Slot().FillWidth(0.28f).VAlign(VAlign_Center).Padding(8.f, 0.f, 6.f, 0.f)
        [
            SNew(STextBlock)
            .Font(FCoreStyle::GetDefaultFontStyle("Mono", 9))
            .Text(FText::FromString(E.Property))
            .ColorAndOpacity(FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Text.Secondary")))
        ]
        + SHorizontalBox::Slot().FillWidth(0.30f).VAlign(VAlign_Center).Padding(6.f, 0.f, 4.f, 0.f)
        [
            SNew(STextBlock)
            .ColorAndOpacity(FSlateColor(ColorRemoved))
            .Text(FText::FromString(E.Before))
            .OverflowPolicy(ETextOverflowPolicy::Ellipsis)
        ]
        + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
        [
            SNew(STextBlock)
            .ColorAndOpacity(FSlateColor(ColorMuted))
            .Text(FText::FromString(TEXT("→")))
        ]
        + SHorizontalBox::Slot().FillWidth(0.30f).VAlign(VAlign_Center).Padding(4.f, 0.f, 8.f, 0.f)
        [
            SNew(STextBlock)
            .ColorAndOpacity(FSlateColor(ColorAdded))
            .Text(FText::FromString(E.After))
            .OverflowPolicy(ETextOverflowPolicy::Ellipsis)
        ]
        + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(0.f, 0.f, 2.f, 0.f)
        [
            SNew(SButton)
            .ContentPadding(FMargin(8.f, 2.f))
            .ToolTipText(LOCTEXT("AcceptTT", "Accept this change — mark it reviewed."))
            .OnClicked(this, &SHaybaMCPDiffPanel::OnAcceptEntry, EntryIndex)
            [ SNew(STextBlock).Text(LOCTEXT("Accept", "Accept")) ]
        ]
        + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
        [
            SNew(SButton)
            .ContentPadding(FMargin(8.f, 2.f))
            .ToolTipText(LOCTEXT("RevertTT", "Restore the Before value via UE's undo system."))
            .OnClicked(this, &SHaybaMCPDiffPanel::OnRevertEntry, EntryIndex)
            [ SNew(STextBlock).Text(LOCTEXT("Revert", "Revert")) ]
        ];
}

// ── Source control badge per actor (uses level package) ──────────────────

TSharedRef<SWidget> SHaybaMCPDiffPanel::BuildSourceControlBadge(const FString& LevelPackage) const
{
    if (!IsSourceControlEnabled() || LevelPackage.IsEmpty())
    {
        return SNew(STextBlock)
            .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("SmallText"))
            .ColorAndOpacity(FSlateColor(ColorMuted))
            .Text(LOCTEXT("SCNoTracking", "no source control"));
    }

    const FString PackageFile = USourceControlHelpers::PackageFilename(LevelPackage);
    ISourceControlProvider& Provider = ISourceControlModule::Get().GetProvider();
    FSourceControlStatePtr State = Provider.GetState(PackageFile, EStateCacheUsage::Use);

    FString Label = TEXT("unknown");
    FLinearColor Color = ColorMuted;
    if (State.IsValid())
    {
        if      (State->IsCheckedOutOther())   { Label = TEXT("locked by other"); Color = ColorSCError; }
        else if (State->IsCheckedOut())        { Label = TEXT("checked out");      Color = ColorSCOk; }
        else if (State->IsModified())          { Label = TEXT("modified locally"); Color = ColorSCWarn; }
        else if (!State->IsSourceControlled()) { Label = TEXT("untracked");        Color = ColorMuted; }
        else                                   { Label = TEXT("up to date");       Color = ColorSCOk; }
    }

    return SNew(SBorder)
        .BorderImage(FAppStyle::GetBrush("Brushes.Header"))
        .Padding(FMargin(6.f, 2.f))
        [
            SNew(STextBlock)
            .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("SmallText"))
            .ColorAndOpacity(FSlateColor(Color))
            .Text(FText::FromString(Label))
        ];
}

// ── Build the list (grouped by actor) ────────────────────────────────────

void SHaybaMCPDiffPanel::RebuildList()
{
    if (!ListContainer.IsValid()) return;
    ListContainer->ClearChildren();

    if (Entries.IsEmpty())
    {
        ListContainer->AddSlot().AutoHeight().Padding(12.f, 12.f)
        [
            SNew(STextBlock)
            .ColorAndOpacity(FSlateColor(ColorMuted))
            .AutoWrapText(true)
            .Text(LOCTEXT("EmptyHint",
                "When the AI runs a destructive operation (spawn / set_property / etc.), each property change shows up here grouped by actor. Source control state per asset is shown alongside so you can route AI edits through Git / Perforce / SVN like a human's edits."))
        ];
        return;
    }

    const TMap<FString, TArray<int32>> Groups = GroupByActor();
    for (const auto& KV : Groups)
    {
        // Respect search filter.
        if (!FilterQuery.IsEmpty())
        {
            const bool bActorMatches = KV.Key.Contains(FilterQuery, ESearchCase::IgnoreCase);
            bool bPropMatches = false;
            for (int32 i : KV.Value)
            {
                if (Entries[i]->Property.Contains(FilterQuery, ESearchCase::IgnoreCase)) { bPropMatches = true; break; }
            }
            if (!bActorMatches && !bPropMatches) continue;
        }
        ListContainer->AddSlot().AutoHeight().Padding(8.f, 4.f)
        [ BuildActorCard(KV.Key, KV.Value) ];
    }
}

TMap<FString, TArray<int32>> SHaybaMCPDiffPanel::GroupByActor() const
{
    TMap<FString, TArray<int32>> Out;
    for (int32 i = 0; i < Entries.Num(); ++i)
    {
        Out.FindOrAdd(Entries[i]->ActorLabel).Add(i);
    }
    return Out;
}

// ── Public API ────────────────────────────────────────────────────────────

void SHaybaMCPDiffPanel::AddEntry(const FHaybaDiffEntry& Entry)
{
    Entries.Add(MakeShared<FHaybaDiffEntry>(Entry));
    RebuildList();
}

void SHaybaMCPDiffPanel::Clear()
{
    Entries.Reset();
    RebuildList();
}

// ── Toolbar handlers ──────────────────────────────────────────────────────

void SHaybaMCPDiffPanel::OnSearchChanged(const FText& InText)
{
    FilterQuery = InText.ToString().TrimStartAndEnd();
    RebuildList();
}

FReply SHaybaMCPDiffPanel::OnAcceptEntry(int32 Index)
{
    if (Entries.IsValidIndex(Index))
    {
        Entries[Index]->bAccepted = true;
        RebuildList();
    }
    return FReply::Handled();
}

FReply SHaybaMCPDiffPanel::OnRevertEntry(int32 Index)
{
    // We don't directly write the Before value back — instead trigger UE's
    // undo system (Initiative #1 transactions wrap every mutating op, so
    // a single Undo step rolls back the corresponding edit).
    if (GEditor)
    {
        GEditor->UndoTransaction();
        Toast(LOCTEXT("Reverted", "Undone the most recent AI mutation."));
    }
    if (Entries.IsValidIndex(Index)) { Entries[Index]->bReverted = true; RebuildList(); }
    return FReply::Handled();
}

// ── Source control bulk actions ───────────────────────────────────────────

FReply SHaybaMCPDiffPanel::OnCheckOutAll()
{
    if (!IsSourceControlEnabled()) return FReply::Handled();
    TSet<FString> Packages;
    for (const auto& E : Entries) if (!E->LevelPackage.IsEmpty()) Packages.Add(E->LevelPackage);

    TArray<FString> Files;
    for (const FString& P : Packages) Files.Add(USourceControlHelpers::PackageFilename(P));
    if (Files.IsEmpty()) { Toast(LOCTEXT("NoPackages", "No tracked packages to check out.")); return FReply::Handled(); }

    ISourceControlProvider& Provider = ISourceControlModule::Get().GetProvider();
    const ECommandResult::Type Result = Provider.Execute(ISourceControlOperation::Create<FCheckOut>(), Files);
    Toast(FText::FromString(FString::Printf(TEXT("Check Out: %s (%d files)"),
        Result == ECommandResult::Succeeded ? TEXT("ok") : TEXT("failed"), Files.Num())));
    return FReply::Handled();
}

FReply SHaybaMCPDiffPanel::OnRevertAll()
{
    if (GEditor)
    {
        // Repeated undo unwinds every transaction we wrapped this session.
        for (int32 i = 0; i < Entries.Num(); ++i) GEditor->UndoTransaction();
    }
    Toast(LOCTEXT("RevertAllDone", "Reverted all AI mutations via undo stack."));
    Clear();
    return FReply::Handled();
}

FReply SHaybaMCPDiffPanel::OnSubmit()
{
    if (!IsSourceControlEnabled()) return FReply::Handled();
    TSet<FString> Packages;
    for (const auto& E : Entries) if (!E->LevelPackage.IsEmpty()) Packages.Add(E->LevelPackage);

    TArray<FString> Files;
    for (const FString& P : Packages) Files.Add(USourceControlHelpers::PackageFilename(P));
    if (Files.IsEmpty()) { Toast(LOCTEXT("NothingToSubmit", "Nothing to submit.")); return FReply::Handled(); }

    ISourceControlProvider& Provider = ISourceControlModule::Get().GetProvider();
    TSharedRef<FCheckIn> Op = ISourceControlOperation::Create<FCheckIn>();
    const TMap<FString, TArray<int32>> Groups = GroupByActor();
    Op->SetDescription(FText::FromString(FString::Printf(
        TEXT("Hayba MCP — %d AI mutation%s across %d actor%s"),
        Entries.Num(), Entries.Num() == 1 ? TEXT("") : TEXT("s"),
        Groups.Num(),  Groups.Num()  == 1 ? TEXT("") : TEXT("s"))));

    const ECommandResult::Type Result = Provider.Execute(Op, Files);
    Toast(FText::FromString(FString::Printf(TEXT("Submit: %s (%d files)"),
        Result == ECommandResult::Succeeded ? TEXT("ok") : TEXT("failed"), Files.Num())));
    if (Result == ECommandResult::Succeeded) Clear();
    return FReply::Handled();
}

bool SHaybaMCPDiffPanel::IsSourceControlEnabled() const
{
    return ISourceControlModule::Get().IsEnabled();
}

FString SHaybaMCPDiffPanel::SourceControlProviderName() const
{
    if (!IsSourceControlEnabled()) return TEXT("none");
    return ISourceControlModule::Get().GetProvider().GetName().ToString();
}

#undef LOCTEXT_NAMESPACE
