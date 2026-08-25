// SRecipeParamBool.cpp
#include "Recipes/SRecipeParamBool.h"
#include "Widgets/Input/SCheckBox.h"

void SRecipeParamBool::Construct(const FArguments& InArgs)
{
    SRecipeParamWidget::FArguments BaseArgs;
    BaseArgs._Param = InArgs._Param;
    SRecipeParamWidget::Construct(BaseArgs);

    bValue = Param.DefaultBool.Get(false);

    ChildSlot
    [
        SNew(SCheckBox)
        .IsChecked_Lambda([this]() { return bValue ? ECheckBoxState::Checked : ECheckBoxState::Unchecked; })
        .OnCheckStateChanged_Lambda([this](ECheckBoxState S) { bValue = (S == ECheckBoxState::Checked); })
    ];
}

FString SRecipeParamBool::GetValueAsJson() const { return bValue ? TEXT("true") : TEXT("false"); }
