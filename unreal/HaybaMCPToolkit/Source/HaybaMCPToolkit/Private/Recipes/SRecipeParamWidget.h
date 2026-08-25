// SRecipeParamWidget.h — Abstract base for every param widget. Each
// concrete widget knows how to (a) render a Slate row for one param
// and (b) report its current value back to the panel when Run is
// pressed.
//
// Widgets register themselves at module startup via
// FRecipeParamWidgetRegistry::Register("float", &Make).

#pragma once

#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"
#include "Recipes/HaybaRecipeTypes.h"

class SRecipeParamWidget : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SRecipeParamWidget) {}
        SLATE_ARGUMENT(FHaybaRecipeParam, Param)
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs) { Param = InArgs._Param; }

    /** JSON fragment for this param's current value: e.g. `12.5`, `"hello"`, `true`. */
    virtual FString GetValueAsJson() const = 0;

    const FHaybaRecipeParam& GetParam() const { return Param; }

protected:
    FHaybaRecipeParam Param;
};

class FRecipeParamWidgetRegistry
{
public:
    using FFactory = TFunction<TSharedRef<SRecipeParamWidget>(const FHaybaRecipeParam&)>;

    static FRecipeParamWidgetRegistry& Get();
    void Register(EHaybaRecipeParamType Type, FFactory Make);
    TSharedRef<SRecipeParamWidget> Create(const FHaybaRecipeParam& Param) const;

private:
    TMap<EHaybaRecipeParamType, FFactory> Factories;
};

/** Called once on module startup to register all built-in widgets. */
void HaybaRecipe_RegisterBuiltinParamWidgets();
