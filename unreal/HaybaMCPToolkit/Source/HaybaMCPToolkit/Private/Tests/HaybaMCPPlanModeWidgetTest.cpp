#include "Misc/AutomationTest.h"
#include "HaybaMCPPlanModeWidget.h"
#include "Layout/ArrangedChildren.h"
#include "Layout/Geometry.h"
#include "Widgets/Input/SButton.h"

#if WITH_DEV_AUTOMATION_TESTS
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaPlanModeLabelAlignmentTest, "Hayba.MCP.Workspace.PlanModeLabelAlignment",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaPlanModeLabelAlignmentTest::RunTest(const FString&)
{
    const TSharedRef<SHaybaMCPPlanModeWidget> Widget = SNew(SHaybaMCPPlanModeWidget);
    Widget->SlatePrepass(1.f);

    // A toolbar can allot more width/height than the button requests. The
    // label itself must remain centered in that space, not just fill it.
    FArrangedChildren Outer(EVisibility::Visible);
    Widget->ArrangeChildren(FGeometry::MakeRoot(FVector2D(180.f, 36.f), FSlateLayoutTransform()), Outer);
    TestEqual(TEXT("one toolbar button"), Outer.Num(), 1);
    if (Outer.Num() != 1) return false;

    const TSharedRef<SButton> Button = StaticCastSharedRef<SButton>(Outer[0].Widget);
    FArrangedChildren Content(EVisibility::Visible);
    Button->ArrangeChildren(Outer[0].Geometry, Content);
    TestEqual(TEXT("one label"), Content.Num(), 1);
    if (Content.Num() != 1) return false;

    const FGeometry& ButtonGeometry = Outer[0].Geometry;
    const FGeometry& LabelGeometry = Content[0].Geometry;
    const FVector2D LabelDesired = Content[0].Widget->GetDesiredSize();
    const FVector2D ButtonCenter = ButtonGeometry.GetAbsolutePosition() + ButtonGeometry.GetLocalSize() * 0.5;
    const FVector2D LabelCenter = LabelGeometry.GetAbsolutePosition() + LabelGeometry.GetLocalSize() * 0.5;
    TestTrue(TEXT("label keeps its intrinsic width"), LabelGeometry.GetLocalSize().X <= LabelDesired.X + 1.f);
    TestTrue(TEXT("label keeps its intrinsic height"), LabelGeometry.GetLocalSize().Y <= LabelDesired.Y + 1.f);
    TestTrue(TEXT("label is horizontally centered"), FMath::IsNearlyEqual(ButtonCenter.X, LabelCenter.X, 1.f));
    TestTrue(TEXT("label is vertically centered"), FMath::IsNearlyEqual(ButtonCenter.Y, LabelCenter.Y, 1.f));
    return true;
}
#endif
