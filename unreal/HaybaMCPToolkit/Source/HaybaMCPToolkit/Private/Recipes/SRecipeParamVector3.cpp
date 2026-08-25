// SRecipeParamVector3.cpp
#include "Recipes/SRecipeParamVector3.h"
#include "HaybaMCPStyle.h"
#include "Widgets/Input/SSpinBox.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Text/STextBlock.h"

void SRecipeParamVector3::Construct(const FArguments& InArgs)
{
    SRecipeParamWidget::FArguments BaseArgs;
    BaseArgs._Param = InArgs._Param;
    SRecipeParamWidget::Construct(BaseArgs);

    const FVector Def = Param.DefaultVector.Get(FVector::ZeroVector);
    X = Def.X; Y = Def.Y; Z = Def.Z;

    // One labelled spin box per axis. Components are unbounded — vector3
    // params are world coordinates, not ranged sliders.
    auto Axis = [](const TCHAR* Label, double* Ref) -> TSharedRef<SWidget>
    {
        return SNew(SHorizontalBox)
            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(0, 0, 3, 0)
            [
                SNew(STextBlock)
                .Text(FText::FromString(Label))
                .ColorAndOpacity(FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Text.Secondary")))
            ]
            + SHorizontalBox::Slot().FillWidth(1.0f)
            [
                SNew(SSpinBox<double>)
                .MinFractionalDigits(0)
                .MaxFractionalDigits(2)
                .Value_Lambda([Ref]() { return *Ref; })
                .OnValueChanged_Lambda([Ref](double V) { *Ref = V; })
                .OnValueCommitted_Lambda([Ref](double V, ETextCommit::Type) { *Ref = V; })
            ];
    };

    ChildSlot
    [
        SNew(SHorizontalBox)
        + SHorizontalBox::Slot().FillWidth(1.0f).Padding(0, 0, 4, 0) [ Axis(TEXT("X"), &X) ]
        + SHorizontalBox::Slot().FillWidth(1.0f).Padding(0, 0, 4, 0) [ Axis(TEXT("Y"), &Y) ]
        + SHorizontalBox::Slot().FillWidth(1.0f)                     [ Axis(TEXT("Z"), &Z) ]
    ];
}

void SRecipeParamVector3::SetVector(const FVector& V)
{
    X = V.X; Y = V.Y; Z = V.Z;
}

FString SRecipeParamVector3::GetValueAsJson() const
{
    return FString::Printf(TEXT("[%.3f,%.3f,%.3f]"), X, Y, Z);
}
