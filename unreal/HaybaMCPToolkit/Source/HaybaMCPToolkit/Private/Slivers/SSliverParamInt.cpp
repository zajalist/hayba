// SSliverParamInt.cpp
#include "Slivers/SSliverParamInt.h"
#include "Widgets/Input/SSpinBox.h"

void SSliverParamInt::Construct(const FArguments& InArgs)
{
    SSliverParamWidget::FArguments BaseArgs;
    BaseArgs._Param = InArgs._Param;
    SSliverParamWidget::Construct(BaseArgs);

    Value = static_cast<int32>(Param.DefaultNumber.Get(0.0));

    auto Spin = SNew(SSpinBox<int32>)
        .Value_Lambda([this]() { return Value; })
        .OnValueChanged_Lambda([this](int32 V) { Value = V; });
    if (Param.RangeMin.IsSet()) Spin->SetMinValue(static_cast<int32>(Param.RangeMin.GetValue()));
    if (Param.RangeMax.IsSet()) Spin->SetMaxValue(static_cast<int32>(Param.RangeMax.GetValue()));

    ChildSlot [ Spin ];
}

FString SSliverParamInt::GetValueAsJson() const { return FString::FromInt(Value); }
