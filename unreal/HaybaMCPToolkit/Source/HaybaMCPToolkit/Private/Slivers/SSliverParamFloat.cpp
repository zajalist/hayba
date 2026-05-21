// SSliverParamFloat.cpp
#include "Slivers/SSliverParamFloat.h"
#include "Widgets/Input/SSpinBox.h"

void SSliverParamFloat::Construct(const FArguments& InArgs)
{
    SSliverParamWidget::FArguments BaseArgs;
    BaseArgs._Param = InArgs._Param;
    SSliverParamWidget::Construct(BaseArgs);

    Value = static_cast<float>(Param.DefaultNumber.Get(0.0));

    auto Spin = SNew(SSpinBox<float>)
        .Value_Lambda([this]() { return Value; })
        .OnValueChanged_Lambda([this](float V) { Value = V; });
    if (Param.RangeMin.IsSet()) Spin->SetMinValue(static_cast<float>(Param.RangeMin.GetValue()));
    if (Param.RangeMax.IsSet()) Spin->SetMaxValue(static_cast<float>(Param.RangeMax.GetValue()));

    ChildSlot [ Spin ];
}

FString SSliverParamFloat::GetValueAsJson() const
{
    return FString::SanitizeFloat(Value);
}
