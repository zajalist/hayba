// SSliverParamBool.cpp
#include "Slivers/SSliverParamBool.h"
#include "Widgets/Input/SCheckBox.h"

void SSliverParamBool::Construct(const FArguments& InArgs)
{
    SSliverParamWidget::FArguments BaseArgs;
    BaseArgs._Param = InArgs._Param;
    SSliverParamWidget::Construct(BaseArgs);

    bValue = Param.DefaultBool.Get(false);

    ChildSlot
    [
        SNew(SCheckBox)
        .IsChecked_Lambda([this]() { return bValue ? ECheckBoxState::Checked : ECheckBoxState::Unchecked; })
        .OnCheckStateChanged_Lambda([this](ECheckBoxState S) { bValue = (S == ECheckBoxState::Checked); })
    ];
}

FString SSliverParamBool::GetValueAsJson() const { return bValue ? TEXT("true") : TEXT("false"); }
