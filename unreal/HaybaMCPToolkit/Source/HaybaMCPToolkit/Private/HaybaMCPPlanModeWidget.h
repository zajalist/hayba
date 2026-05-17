#pragma once
#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"
#include "Input/Reply.h"
#include "Styling/SlateColor.h"

class SHaybaMCPPlanModeWidget : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SHaybaMCPPlanModeWidget) {}
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs);

private:
    FReply OnToggle();
    FText GetButtonLabel() const;
    FSlateColor GetButtonColor() const;
};
