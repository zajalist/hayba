// SSliverParamInt.cpp
#include "Slivers/SSliverParamInt.h"
#include "Widgets/Input/SSpinBox.h"

void SSliverParamInt::Construct(const FArguments& InArgs)
{
    SSliverParamWidget::FArguments BaseArgs;
    BaseArgs._Param = InArgs._Param;
    SSliverParamWidget::Construct(BaseArgs);

    Value = static_cast<int32>(Param.DefaultNumber.Get(0.0));

    // MinValue/MaxValue clamp typed entry; MinSliderValue/MaxSliderValue are
    // what give the SSpinBox a draggable slider track. Both pairs must be set
    // for the bar to scrub — clamp bounds alone leave it in unbounded mode.
    TOptional<int32> Min, Max;
    if (Param.RangeMin.IsSet()) Min = static_cast<int32>(Param.RangeMin.GetValue());
    if (Param.RangeMax.IsSet()) Max = static_cast<int32>(Param.RangeMax.GetValue());

    ChildSlot
    [
        SNew(SSpinBox<int32>)
        .MinDesiredWidth(110.f)
        .Value_Lambda([this]() { return Value; })
        .OnValueChanged_Lambda([this](int32 V) { Value = V; })
        .OnValueCommitted_Lambda([this](int32 V, ETextCommit::Type) { Value = V; })
        .MinValue(Min)
        .MaxValue(Max)
        .MinSliderValue(Min)
        .MaxSliderValue(Max)
    ];
}

FString SSliverParamInt::GetValueAsJson() const { return FString::FromInt(Value); }
