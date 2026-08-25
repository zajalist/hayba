// SRecipeDetailPanel.h — Shows a single recipe: title (description on
// hover), generated param widgets, output box, and a Run button.

#pragma once

#include "CoreMinimal.h"
#include "Recipes/HaybaRecipeTypes.h"
#include "Recipes/SRecipeParamWidget.h"
#include "Widgets/SCompoundWidget.h"

class SMultiLineEditableTextBox;

class SRecipeDetailPanel : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SRecipeDetailPanel) {}
    SLATE_END_ARGS()
    void Construct(const FArguments& InArgs);

    /** Switch the panel to display + run this spec. Resets all param widgets. */
    void SetSpec(const FHaybaRecipeSpec& InSpec);

private:
    FHaybaRecipeSpec Spec;
    TArray<TSharedRef<SRecipeParamWidget>> ParamWidgets;
    TSharedPtr<SMultiLineEditableTextBox> OutputBox;
    TSharedPtr<class SVerticalBox> ParamBox;
    TSharedPtr<class STextBlock> TitleText;
    bool bRunning = false;

    FReply OnRunClicked();
    FString BuildParamsJson() const;
    void RebuildParamUI();
};
