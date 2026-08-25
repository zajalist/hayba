// SRecipeParamFloat.cpp
#include "Recipes/SRecipeParamFloat.h"
#include "Widgets/Input/SSpinBox.h"

void SRecipeParamFloat::Construct(const FArguments& InArgs)
{
    SRecipeParamWidget::FArguments BaseArgs;
    BaseArgs._Param = InArgs._Param;
    SRecipeParamWidget::Construct(BaseArgs);

    Value = static_cast<float>(Param.DefaultNumber.Get(0.0));

    // MinValue/MaxValue clamp typed entry; MinSliderValue/MaxSliderValue are
    // what give the SSpinBox a draggable slider track. Both pairs must be set
    // for the bar to scrub — clamp bounds alone leave it in unbounded mode.
    TOptional<float> Min, Max;
    if (Param.RangeMin.IsSet()) Min = static_cast<float>(Param.RangeMin.GetValue());
    if (Param.RangeMax.IsSet()) Max = static_cast<float>(Param.RangeMax.GetValue());

    ChildSlot
    [
        SNew(SSpinBox<float>)
        .MinDesiredWidth(110.f)
        .MinFractionalDigits(0)
        .MaxFractionalDigits(2)
        .Value_Lambda([this]() { return Value; })
        .OnValueChanged_Lambda([this](float V) { Value = V; })
        .OnValueCommitted_Lambda([this](float V, ETextCommit::Type) { Value = V; })
        .MinValue(Min)
        .MaxValue(Max)
        .MinSliderValue(Min)
        .MaxSliderValue(Max)
    ];
}

FString SRecipeParamFloat::GetValueAsJson() const
{
    return FString::SanitizeFloat(Value);
}
