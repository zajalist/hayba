// SSliverDetailPanel.h — Shows a single sliver: title, description,
// generated param widgets, Run button, output text box.

#pragma once

#include "CoreMinimal.h"
#include "Slivers/HaybaSliverTypes.h"
#include "Slivers/SSliverParamWidget.h"
#include "Widgets/SCompoundWidget.h"

class SMultiLineEditableTextBox;

class SSliverDetailPanel : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SSliverDetailPanel) {}
    SLATE_END_ARGS()
    void Construct(const FArguments& InArgs);

    /** Switch the panel to display + run this spec. Resets all param widgets. */
    void SetSpec(const FHaybaSliverSpec& InSpec);

private:
    FHaybaSliverSpec Spec;
    TArray<TSharedRef<SSliverParamWidget>> ParamWidgets;
    TSharedPtr<SMultiLineEditableTextBox> OutputBox;
    TSharedPtr<class SVerticalBox> ParamBox;
    TSharedPtr<class STextBlock> TitleText;
    TSharedPtr<class STextBlock> DescriptionText;
    bool bRunning = false;

    FReply OnRunClicked();
    FString BuildParamsJson() const;
    void RebuildParamUI();
};
