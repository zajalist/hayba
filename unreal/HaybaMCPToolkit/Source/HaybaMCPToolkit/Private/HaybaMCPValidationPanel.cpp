#include "HaybaMCPValidationPanel.h"
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
    switch (S)
    {
        case EHaybaSeverity::Error:   return FSlateColor(FLinearColor(1.f, 0.3f, 0.3f));
        case EHaybaSeverity::Warning: return FSlateColor(FLinearColor(1.f, 0.85f, 0.2f));
        default:                      return FSlateColor(FLinearColor(0.7f, 0.7f, 0.7f));
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
