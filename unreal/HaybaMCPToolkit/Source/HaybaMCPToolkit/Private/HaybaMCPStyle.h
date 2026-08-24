#pragma once
#include "CoreMinimal.h"
#include "Styling/SlateStyle.h"

/**
 * The plugin's style set: brushes, text styles, and the design tokens panels
 * are expected to use instead of inlining literals.
 *
 * Before the token layer there were 53 inline FLinearColor literals across nine
 * panel files, so "the panels look consistent" was a thing somebody had to keep
 * being careful about rather than a thing the code guaranteed. Colour() and
 * Metric() exist so a panel never has to invent a value.
 *
 * The ochre rule, which is a product decision and not a palette preference:
 * Hayba.Color.Accent.Ochre means *something* -- active destination, pending
 * approval, unsaved edit, or a rule needing attention. It is never decoration.
 * If a new use of it does not fall in that list, the answer is a neutral token.
 */
class FHaybaMCPStyle
{
public:
    static void Initialize();
    static void Shutdown();
    static const ISlateStyle& Get();
    static FName GetStyleSetName();

    /** Brush names: "Hayba.Logo", "Hayba.Icon.World", "Hayba.Icon.World.S". */
    static const FSlateBrush* GetBrush(const FName& Name);

    /**
     * Design token lookup. Unknown names return magenta rather than black so a
     * typo is visible on screen instead of blending into the chrome.
     */
    static FLinearColor Colour(const FName& Token);

    /** Spacing, radius, and icon-size tokens. Unknown names return 0. */
    static float Metric(const FName& Token);

private:
    static TSharedPtr<FSlateStyleSet> StyleInstance;
    static TSharedRef<FSlateStyleSet> Create();
};
