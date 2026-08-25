#include "HaybaMCPValidationPanel.h"
#include "HaybaMCPStyle.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/SBoxPanel.h"

void SHaybaMCPValidationPanel::Construct(const FArguments& InArgs)
{
    ChildSlot
    [
        SAssignNew(IssueList, SListView<TSharedPtr<FHaybaValidationIssue>>)
        .ListItemsSource(&Issues)
        .OnGenerateRow(this, &SHaybaMCPValidationPanel::GenerateRow)
    ];
}

void SHaybaMCPValidationPanel::AddIssue(const FHaybaValidationIssue& Issue)
{
    Issues.Add(MakeShared<FHaybaValidationIssue>(Issue));
    if (IssueList.IsValid()) IssueList->RequestListRefresh();
}

void SHaybaMCPValidationPanel::Clear()
{
    Issues.Reset();
    if (IssueList.IsValid()) IssueList->RequestListRefresh();
}

FSlateColor SHaybaMCPValidationPanel::ColorForSeverity(EHaybaSeverity S)
{
    // Warning is the ochre: it means "this needs you", which is precisely what
    // that token is reserved for. The hand-rolled 1.0/0.85/0.2 sat 17 degrees
    // from it -- close enough to read as the accent, far enough to look like a
    // second, slightly-wrong accent sitting beside it.
    switch (S)
    {
        case EHaybaSeverity::Error:   return FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Status.Fail"));
        case EHaybaSeverity::Warning: return FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Accent.Ochre"));
        default:                      return FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Text.Secondary"));
    }
}

TSharedRef<ITableRow> SHaybaMCPValidationPanel::GenerateRow(TSharedPtr<FHaybaValidationIssue> Issue, const TSharedRef<STableViewBase>& Owner)
{
    return SNew(STableRow<TSharedPtr<FHaybaValidationIssue>>, Owner)
    [
        SNew(SHorizontalBox)
        + SHorizontalBox::Slot().AutoWidth().Padding(4)
        [ SNew(STextBlock).ColorAndOpacity(ColorForSeverity(Issue->Severity)).Text(FText::FromString(Issue->IssueType)) ]
        + SHorizontalBox::Slot().FillWidth(1.f).Padding(4)
        [ SNew(STextBlock).Text(FText::FromString(FString::Printf(TEXT("%s — %s"), *Issue->ActorLabel, *Issue->Description))) ]
    ];
}
