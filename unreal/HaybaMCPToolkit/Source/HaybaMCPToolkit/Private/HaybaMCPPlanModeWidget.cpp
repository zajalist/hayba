#include "HaybaMCPPlanModeWidget.h"
#include "HaybaMCPSettings.h"
#include "HaybaMCPStyle.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Text/STextBlock.h"

void SHaybaMCPPlanModeWidget::Construct(const FArguments& InArgs)
{
    ChildSlot
    [
        SNew(SButton)
        .OnClicked(this, &SHaybaMCPPlanModeWidget::OnToggle)
        .ButtonColorAndOpacity(this, &SHaybaMCPPlanModeWidget::GetButtonColor)
        .ToolTipText(NSLOCTEXT("Hayba", "PlanModeTooltip", "Plan Mode: when ON, the AI must propose a plan before any destructive action."))
        [ SNew(STextBlock).Text(this, &SHaybaMCPPlanModeWidget::GetButtonLabel) ]
    ];
}

FReply SHaybaMCPPlanModeWidget::OnToggle()
{
    auto& S = FHaybaMCPSettings::Get();
    S.bPlanModeEnabled = !S.bPlanModeEnabled;
    S.Save();
    return FReply::Handled();
}

FText SHaybaMCPPlanModeWidget::GetButtonLabel() const
{
    return FHaybaMCPSettings::Get().bPlanModeEnabled
        ? NSLOCTEXT("Hayba", "PlanOn", "Plan Mode: ON")
        : NSLOCTEXT("Hayba", "PlanOff", "Plan Mode: OFF");
}

FSlateColor SHaybaMCPPlanModeWidget::GetButtonColor() const
{
    return FHaybaMCPSettings::Get().bPlanModeEnabled
        ? FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Status.Pass"))
        : FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Text.Muted"));
}
