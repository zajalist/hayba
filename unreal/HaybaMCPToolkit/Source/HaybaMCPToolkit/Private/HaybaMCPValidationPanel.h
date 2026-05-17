#pragma once
#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/Views/SListView.h"

enum class EHaybaSeverity : uint8 { Info, Warning, Error };

struct FHaybaValidationIssue
{
    FString ActorLabel;
    FString IssueType;
    FString Description;
    EHaybaSeverity Severity = EHaybaSeverity::Info;
};

class SHaybaMCPValidationPanel : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SHaybaMCPValidationPanel) {}
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs);
    void AddIssue(const FHaybaValidationIssue& Issue);
    void Clear();

private:
    TArray<TSharedPtr<FHaybaValidationIssue>> Issues;
    TSharedPtr<SListView<TSharedPtr<FHaybaValidationIssue>>> IssueList;
    TSharedRef<ITableRow> GenerateRow(TSharedPtr<FHaybaValidationIssue> Issue, const TSharedRef<STableViewBase>& Owner);
    static FSlateColor ColorForSeverity(EHaybaSeverity S);
};
