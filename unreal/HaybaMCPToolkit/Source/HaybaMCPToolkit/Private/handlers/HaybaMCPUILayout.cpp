#include "HaybaMCPUILayout.h"

#if WITH_EDITOR

#include "Editor.h"
#include "WidgetBlueprint.h"
#include "Blueprint/UserWidget.h"
#include "Blueprint/WidgetTree.h"
#include "Components/Widget.h"
#include "Components/PanelWidget.h"
#include "Components/TextBlock.h"
#include "Components/RichTextBlock.h"
#include "Components/EditableText.h"
#include "Components/EditableTextBox.h"
#include "Components/MultiLineEditableTextBox.h"
#include "Components/Button.h"
#include "Components/CheckBox.h"
#include "Framework/Application/SlateApplication.h"
#include "Fonts/FontMeasure.h"
#include "Layout/ArrangedChildren.h"
#include "Layout/Geometry.h"
#include "Widgets/SWidget.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPUILayout, Log, All);

namespace
{
    /** Reference strings for the statistical bounds. Deliberately fixed so the
     *  same font+size always reports the same numbers run to run. */
    const TCHAR* const kTypicalProse = TEXT("the quick brown fox jumps over a lazy dog and then rests");
    /** Characters a Latin UI realistically has to survive. The worst case for a
     *  variable-length field (player names, item names, localized strings) is a
     *  run of the widest of these, not the average. */
    const TCHAR* const kGlyphSample = TEXT("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#%&WM_");

    TSharedPtr<FSlateFontMeasure> GetMeasureService()
    {
        if (!FSlateApplication::IsInitialized()) return nullptr;
        FSlateRenderer* Renderer = FSlateApplication::Get().GetRenderer();
        if (!Renderer) return nullptr;
        return Renderer->GetFontMeasureService();
    }

    void ArrangeRecursive(const TSharedRef<SWidget>& Widget, const FGeometry& Geom,
        TMap<const SWidget*, FGeometry>& Out, int32 Depth)
    {
        // Deep trees are legal but a runaway recursion here would take the
        // editor down; 128 is far past any hand-authored UMG hierarchy.
        if (Depth > 128) return;

        Out.Add(&Widget.Get(), Geom);

        FArrangedChildren Arranged(EVisibility::All);
        Widget->ArrangeChildren(Geom, Arranged);
        for (int32 i = 0; i < Arranged.Num(); ++i)
        {
            const FArrangedWidget& Child = Arranged[i];
            ArrangeRecursive(Child.Widget, Child.Geometry, Out, Depth + 1);
        }
    }
}

namespace HaybaUILayout
{

FVector2D GetDesignSize(UWidgetBlueprint* WBP)
{
    if (!WBP) return FVector2D(1920.0, 1080.0);

#if WITH_EDITORONLY_DATA
    // The authored design size is stored on the generated widget class's CDO,
    // not on the blueprint asset — and it is only a real screen size when the
    // designer is in one of the Custom modes.
    //
    // In FillScreen / Desired mode DesignTimeSize keeps its (100,100)
    // placeholder. Treating that as the screen makes every widget on a normal
    // screen look wildly off-canvas, which would fire the safe-area and
    // off-screen rules on essentially every blueprint.
    if (WBP->GeneratedClass)
    {
        if (const UUserWidget* CDO = Cast<UUserWidget>(WBP->GeneratedClass->GetDefaultObject()))
        {
            const bool bCustomSize =
                CDO->DesignSizeMode == EDesignPreviewSizeMode::Custom ||
                CDO->DesignSizeMode == EDesignPreviewSizeMode::CustomOnScreen;

            const FVector2D Declared(CDO->DesignTimeSize.X, CDO->DesignTimeSize.Y);
            if (bCustomSize && Declared.X > 1.0 && Declared.Y > 1.0)
            {
                return Declared;
            }
        }
    }
#endif
    // Fill-screen and desired-size blueprints are authored against the whole
    // viewport, so 1080p is the honest default to reason about. Callers that
    // care about a different target pass screen_width/screen_height.
    return FVector2D(1920.0, 1080.0);
}

bool ComputeGeometry(UWidgetBlueprint* WBP, const FVector2D& ScreenSize,
    TMap<FString, FHaybaUIWidgetGeom>& Out, FString& OutError)
{
    Out.Reset();

    if (!WBP)
    {
        OutError = TEXT("no widget blueprint");
        return false;
    }
    if (!FSlateApplication::IsInitialized())
    {
        OutError = TEXT("Slate is not initialized (running headless?) — layout-dependent checks are unavailable");
        return false;
    }
    if (!WBP->GeneratedClass)
    {
        OutError = TEXT("widget blueprint has no GeneratedClass — compile it first (ui_compile_widget)");
        return false;
    }
    if (WBP->GeneratedClass->HasAnyClassFlags(CLASS_Abstract))
    {
        OutError = TEXT("widget blueprint class is abstract and cannot be instantiated for layout");
        return false;
    }
    if (ScreenSize.X <= 1.0 || ScreenSize.Y <= 1.0)
    {
        OutError = TEXT("screen size must be at least 1x1");
        return false;
    }

    // Outer to the editor world when there is one (that is what the designer
    // preview uses). Never a PIE world — a retained reference into a PIE
    // GameInstance is what crashes the editor on PIE stop.
    UWorld* World = nullptr;
    if (GEditor)
    {
        UWorld* EditorWorld = GEditor->GetEditorWorldContext().World();
        if (EditorWorld && !EditorWorld->IsPlayInEditor())
        {
            World = EditorWorld;
        }
    }

    UUserWidget* Instance = World
        ? NewObject<UUserWidget>(World, WBP->GeneratedClass)
        : NewObject<UUserWidget>(GetTransientPackage(), WBP->GeneratedClass);
    if (!Instance)
    {
        OutError = TEXT("failed to instantiate the widget class");
        return false;
    }

    // Designing flag keeps the instance from running BeginPlay-style logic and
    // matches how the UMG designer evaluates layout.
    Instance->SetDesignerFlags(EWidgetDesignFlags::Designing);

    bool bOk = false;
    {
        TSharedPtr<SWidget> SlateWidget;
        SlateWidget = Instance->TakeWidget();
        if (SlateWidget.IsValid())
        {
            const TSharedRef<SWidget> SlateRef = SlateWidget.ToSharedRef();
            SlateRef->SlatePrepass(1.0f);

            const FGeometry Root = FGeometry::MakeRoot(ScreenSize, FSlateLayoutTransform());

            TMap<const SWidget*, FGeometry> BySlate;
            ArrangeRecursive(SlateRef, Root, BySlate, 0);

            // Map the arranged Slate widgets back to the UMG widgets by identity
            // of the cached SWidget each UWidget produced during TakeWidget.
            if (Instance->WidgetTree)
            {
                Instance->WidgetTree->ForEachWidget([&](UWidget* W)
                {
                    if (!W) return;

                    FHaybaUIWidgetGeom G;
                    G.Name = W->GetName();
                    G.ClassName = W->GetClass()->GetName();

                    int32 Depth = 0;
                    for (UPanelWidget* P = W->GetParent(); P; P = P->GetParent()) ++Depth;
                    G.Depth = Depth;
                    G.ParentName = W->GetParent() ? W->GetParent()->GetName() : FString();

                    const TSharedPtr<SWidget> Cached = W->GetCachedWidget();
                    if (Cached.IsValid())
                    {
                        if (const FGeometry* Found = BySlate.Find(Cached.Get()))
                        {
                            const FVector2D Min(Found->GetAbsolutePosition());
                            const FVector2D Max(Found->GetAbsolutePositionAtCoordinates(FVector2D(1.0, 1.0)));
                            G.Position = Min;
                            G.Size = Max - Min;
                        }
                    }
                    // A widget with no arranged entry is genuinely not laid out
                    // (collapsed, or in an inactive WidgetSwitcher slot). It is
                    // reported with a zero size rather than omitted, so callers
                    // can tell "not laid out" from "absent from the tree".
                    Out.Add(G.Name, G);
                });
            }

            bOk = Out.Num() > 0;
            if (!bOk) OutError = TEXT("layout produced no widgets (empty widget tree?)");
        }
        else
        {
            OutError = TEXT("TakeWidget() returned no Slate widget");
        }

        // Drop Slate resources before the instance goes out of scope so nothing
        // retains a live SWidget for a UObject that is about to be collected.
        Instance->ReleaseSlateResources(true);
    }

    Instance->MarkAsGarbage();
    return bOk;
}

FVector2D MeasureText(const FString& Text, const FSlateFontInfo& Font, float FontScale)
{
    const TSharedPtr<FSlateFontMeasure> Measure = GetMeasureService();
    if (!Measure.IsValid()) return FVector2D::ZeroVector;
    return FVector2D(Measure->Measure(Text, Font, FontScale));
}

int32 CharsThatFit(const FString& Text, const FSlateFontInfo& Font, float MaxWidthPx, float FontScale)
{
    if (Text.IsEmpty()) return 0;
    if (MaxWidthPx <= 0.f) return 0;

    const TSharedPtr<FSlateFontMeasure> Measure = GetMeasureService();
    if (!Measure.IsValid()) return 0;

    // Whole string already fits — report its real length rather than a clipped
    // index, so callers can say "fits with N characters of headroom".
    if (FVector2D(Measure->Measure(Text, Font, FontScale)).X <= MaxWidthPx)
    {
        return Text.Len();
    }

    const int32 LastIndex = Measure->FindLastWholeCharacterIndexBeforeOffset(
        Text, Font, FMath::FloorToInt(MaxWidthPx), FontScale);
    return FMath::Max(0, LastIndex + 1);
}

float WidestGlyphWidth(const FSlateFontInfo& Font, float FontScale)
{
    const TSharedPtr<FSlateFontMeasure> Measure = GetMeasureService();
    if (!Measure.IsValid()) return 0.f;

    const FString Sample(kGlyphSample);
    float Widest = 0.f;
    for (int32 i = 0; i < Sample.Len(); ++i)
    {
        const float W = (float)FVector2D(Measure->Measure(Sample.Mid(i, 1), Font, FontScale)).X;
        Widest = FMath::Max(Widest, W);
    }
    return Widest;
}

float TypicalGlyphWidth(const FSlateFontInfo& Font, float FontScale)
{
    const TSharedPtr<FSlateFontMeasure> Measure = GetMeasureService();
    if (!Measure.IsValid()) return 0.f;

    const FString Sample(kTypicalProse);
    if (Sample.Len() == 0) return 0.f;
    // Measured as one run so kerning and inter-character advance are included,
    // then averaged — a per-character sum would overstate the width.
    const float Total = (float)FVector2D(Measure->Measure(Sample, Font, FontScale)).X;
    return Total / (float)Sample.Len();
}

FHaybaUITextFit AnalyzeTextFit(const FString& Text, const FSlateFontInfo& Font, float AvailableWidth, float FontScale)
{
    FHaybaUITextFit Fit;
    const TSharedPtr<FSlateFontMeasure> Measure = GetMeasureService();
    if (!Measure.IsValid()) return Fit;

    Fit.bValid = true;
    Fit.AvailableWidth = AvailableWidth;

    const FVector2D Measured = FVector2D(Measure->Measure(Text, Font, FontScale));
    Fit.MeasuredWidth = (float)Measured.X;
    Fit.MeasuredHeight = (float)Measured.Y;
    Fit.bOverflows = AvailableWidth > 0.f && Fit.MeasuredWidth > AvailableWidth;
    Fit.CharsThatFit = CharsThatFit(Text, Font, AvailableWidth, FontScale);

    const float Widest = WidestGlyphWidth(Font, FontScale);
    const float Typical = TypicalGlyphWidth(Font, FontScale);
    Fit.WorstCaseChars = Widest > 0.f ? FMath::FloorToInt(AvailableWidth / Widest) : 0;
    Fit.TypicalChars = Typical > 0.f ? FMath::FloorToInt(AvailableWidth / Typical) : 0;

    return Fit;
}

bool GetWidgetFont(UWidget* W, FSlateFontInfo& OutFont)
{
    if (!W) return false;

    if (UTextBlock* TB = Cast<UTextBlock>(W))                    { OutFont = TB->GetFont(); return true; }
    if (UEditableText* ET = Cast<UEditableText>(W))              { OutFont = ET->GetFont(); return true; }
    if (UEditableTextBox* ETB = Cast<UEditableTextBox>(W))       { OutFont = ETB->GetWidgetStyle().TextStyle.Font; return true; }
    if (UMultiLineEditableTextBox* ML = Cast<UMultiLineEditableTextBox>(W)) { OutFont = ML->WidgetStyle.TextStyle.Font; return true; }
    if (URichTextBlock* RT = Cast<URichTextBlock>(W))
    {
        // RichTextBlock resolves its font per text-run from a style set, so
        // there is no single authoritative font. The default style is the
        // honest answer for a whole-widget estimate.
        OutFont = RT->GetDefaultTextStyle().Font;
        return true;
    }
    // A Button's label lives in its child; fall through to that child's font.
    if (UButton* Btn = Cast<UButton>(W))
    {
        if (Btn->GetChildrenCount() > 0)
        {
            return GetWidgetFont(Btn->GetChildAt(0), OutFont);
        }
    }
    if (UCheckBox* CB = Cast<UCheckBox>(W))
    {
        if (CB->GetChildrenCount() > 0)
        {
            return GetWidgetFont(CB->GetChildAt(0), OutFont);
        }
    }
    return false;
}

bool GetWidgetText(UWidget* W, FString& OutText)
{
    if (!W) return false;

    if (UTextBlock* TB = Cast<UTextBlock>(W))               { OutText = TB->GetText().ToString(); return true; }
    if (URichTextBlock* RT = Cast<URichTextBlock>(W))       { OutText = RT->GetText().ToString(); return true; }
    if (UEditableText* ET = Cast<UEditableText>(W))         { OutText = ET->GetText().ToString(); return true; }
    if (UEditableTextBox* ETB = Cast<UEditableTextBox>(W))  { OutText = ETB->GetText().ToString(); return true; }
    if (UMultiLineEditableTextBox* ML = Cast<UMultiLineEditableTextBox>(W)) { OutText = ML->GetText().ToString(); return true; }
    if (UButton* Btn = Cast<UButton>(W))
    {
        if (Btn->GetChildrenCount() > 0) return GetWidgetText(Btn->GetChildAt(0), OutText);
    }
    if (UCheckBox* CB = Cast<UCheckBox>(W))
    {
        if (CB->GetChildrenCount() > 0) return GetWidgetText(CB->GetChildAt(0), OutText);
    }
    return false;
}

} // namespace HaybaUILayout

#endif // WITH_EDITOR
