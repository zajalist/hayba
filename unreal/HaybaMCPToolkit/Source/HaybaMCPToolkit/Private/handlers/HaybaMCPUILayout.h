#pragma once

// Design-time layout resolution and text metrics for Widget Blueprints.
//
// Everything here answers questions that CANNOT be answered from the widget
// tree alone: how wide is this text in this font, how big is the box Slate
// actually gives this widget, and therefore at exactly which character does
// the label stop fitting. The tree says "TextBlock with Font size 24"; only a
// real Slate prepass + the font measure service can say "that label overflows
// its 220px box after 17 characters".
//
// The approach is the one the UMG designer itself uses: instantiate the
// generated widget class, take its Slate widget, prepass it, then arrange it
// inside a root geometry of the blueprint's design-time screen size and walk
// the arranged children. That yields the same rectangles the designer draws.

#include "CoreMinimal.h"

#if WITH_EDITOR

#include "Fonts/SlateFontInfo.h"

class UWidgetBlueprint;
class UWidget;

/** Resolved design-time geometry for one widget in the tree. */
struct FHaybaUIWidgetGeom
{
    FString Name;
    FString ClassName;
    /** Top-left in design space (px), origin at the root widget's top-left. */
    FVector2D Position = FVector2D::ZeroVector;
    /** Rendered size in design space (px). */
    FVector2D Size = FVector2D::ZeroVector;
    /** Depth in the widget tree (root = 0). */
    int32 Depth = 0;
    /** Name of the parent widget, empty for the root. */
    FString ParentName;

    FORCEINLINE FVector2D GetMax() const { return Position + Size; }
    FORCEINLINE bool IsDegenerate() const { return Size.X <= KINDA_SMALL_NUMBER || Size.Y <= KINDA_SMALL_NUMBER; }

    /** Overlap rectangle with another widget's box; zero-size when disjoint. */
    FVector2D OverlapExtent(const FHaybaUIWidgetGeom& Other) const
    {
        const float OverlapX = FMath::Min(GetMax().X, Other.GetMax().X) - FMath::Max(Position.X, Other.Position.X);
        const float OverlapY = FMath::Min(GetMax().Y, Other.GetMax().Y) - FMath::Max(Position.Y, Other.Position.Y);
        if (OverlapX <= 0.f || OverlapY <= 0.f) return FVector2D::ZeroVector;
        return FVector2D(OverlapX, OverlapY);
    }
};

/** Result of asking "how much of this text fits in this many pixels". */
struct FHaybaUITextFit
{
    /** Measured width of the full string, in px, at the widget's real font. */
    float MeasuredWidth = 0.f;
    float MeasuredHeight = 0.f;
    /** Width the widget actually has available for text (box minus padding). */
    float AvailableWidth = 0.f;
    /** True when MeasuredWidth already exceeds AvailableWidth. */
    bool bOverflows = false;
    /** Characters of the measured string that fit before the box runs out.
     *  Exact — computed by the Slate font measure service, kerning included. */
    int32 CharsThatFit = 0;
    /** Characters that fit assuming the WIDEST glyph in the font repeats
     *  (worst case for variable-length runtime text, e.g. a long player name). */
    int32 WorstCaseChars = 0;
    /** Characters that fit for typical mixed-case prose in this font. */
    int32 TypicalChars = 0;
    bool bValid = false;
};

namespace HaybaUILayout
{
    /** Design-time screen size the blueprint is authored against. */
    FVector2D GetDesignSize(UWidgetBlueprint* WBP);

    /**
     * A design-time instance of a Widget Blueprint, ready to lay out or draw.
     *
     * Holds the UUserWidget and its Slate widget together because they must be
     * torn down together: releasing Slate resources before the instance is
     * collected is what stops a live SWidget retaining a UObject that is about
     * to go away. The destructor does that, so callers cannot forget.
     *
     * Scope-bound on purpose. The instance is not rooted, so it must not
     * outlive the synchronous call that made it.
     */
    struct FPreviewInstance
    {
        UUserWidget* Instance = nullptr;
        TSharedPtr<SWidget> Slate;

        FPreviewInstance() = default;
        FPreviewInstance(const FPreviewInstance&) = delete;
        FPreviewInstance& operator=(const FPreviewInstance&) = delete;
        ~FPreviewInstance();

        bool IsValid() const { return Instance != nullptr && Slate.IsValid(); }
    };

    /**
     * Instantiate the blueprint's generated class, flag it as designing, take
     * its Slate widget and prepass it — everything needed before either
     * arranging the tree or drawing it.
     *
     * Returns false with a reason in `OutError` when the blueprint cannot be
     * instantiated (uncompiled, abstract, Slate unavailable). Callers must
     * degrade rather than report a clean result.
     */
    bool MakePreviewInstance(UWidgetBlueprint* WBP, FPreviewInstance& Out, FString& OutError);

    /** Instantiate + prepass + arrange the blueprint at `ScreenSize`, filling
     *  `Out` keyed by widget name. Returns false with a reason in `OutError`
     *  when the blueprint cannot be instantiated (uncompiled, abstract parent,
     *  no editor world). Callers must degrade to tree-only checks in that case
     *  rather than reporting a clean bill of health. */
    bool ComputeGeometry(UWidgetBlueprint* WBP, const FVector2D& ScreenSize,
        TMap<FString, FHaybaUIWidgetGeom>& Out, FString& OutError);

    /** Exact rendered size of `Text` in `Font`, via the Slate font measure service. */
    FVector2D MeasureText(const FString& Text, const FSlateFontInfo& Font, float FontScale = 1.0f);

    /** Largest prefix length of `Text` that fits within `MaxWidthPx`. Uses
     *  FindLastWholeCharacterIndexBeforeOffset, so it accounts for kerning and
     *  variable glyph advance rather than assuming a monospace average. */
    int32 CharsThatFit(const FString& Text, const FSlateFontInfo& Font, float MaxWidthPx, float FontScale = 1.0f);

    /** Width of the single widest glyph the font renders for the characters a
     *  caller is likely to see (used for the worst-case bound). */
    float WidestGlyphWidth(const FSlateFontInfo& Font, float FontScale = 1.0f);

    /** Average advance for typical mixed-case prose in this font. */
    float TypicalGlyphWidth(const FSlateFontInfo& Font, float FontScale = 1.0f);

    /** Full fit analysis for a string in a box of `AvailableWidth` px. */
    FHaybaUITextFit AnalyzeTextFit(const FString& Text, const FSlateFontInfo& Font, float AvailableWidth, float FontScale = 1.0f);

    /** The font a widget renders text with, if it renders text at all.
     *  Covers TextBlock / RichTextBlock / EditableText(Box) / Button-with-text. */
    bool GetWidgetFont(UWidget* W, FSlateFontInfo& OutFont);

    /** The text a widget currently displays, if any. */
    bool GetWidgetText(UWidget* W, FString& OutText);
}

#endif // WITH_EDITOR
