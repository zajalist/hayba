#pragma once
#include "CoreMinimal.h"
#include "Styling/SlateStyle.h"

class FHaybaMCPStyle
{
public:
    static void Initialize();
    static void Shutdown();
    static const ISlateStyle& Get();
    static FName GetStyleSetName();

    /** Brush names: "Hayba.Logo", "Hayba.Wordmark". */
    static const FSlateBrush* GetBrush(const FName& Name);

private:
    static TSharedPtr<FSlateStyleSet> StyleInstance;
    static TSharedRef<FSlateStyleSet> Create();
};
