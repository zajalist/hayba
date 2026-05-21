// SSliverParamWidget.h — Abstract base for every param widget. Each
// concrete widget knows how to (a) render a Slate row for one param
// and (b) report its current value back to the panel when Run is
// pressed.
//
// Widgets register themselves at module startup via
// FSliverParamWidgetRegistry::Register("float", &Make).

#pragma once

#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"
#include "Slivers/HaybaSliverTypes.h"

class SSliverParamWidget : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SSliverParamWidget) {}
        SLATE_ARGUMENT(FHaybaSliverParam, Param)
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs) { Param = InArgs._Param; }

    /** JSON fragment for this param's current value: e.g. `12.5`, `"hello"`, `true`. */
    virtual FString GetValueAsJson() const = 0;

    const FHaybaSliverParam& GetParam() const { return Param; }

protected:
    FHaybaSliverParam Param;
};

class FSliverParamWidgetRegistry
{
public:
    using FFactory = TFunction<TSharedRef<SSliverParamWidget>(const FHaybaSliverParam&)>;

    static FSliverParamWidgetRegistry& Get();
    void Register(EHaybaSliverParamType Type, FFactory Make);
    TSharedRef<SSliverParamWidget> Create(const FHaybaSliverParam& Param) const;

private:
    TMap<EHaybaSliverParamType, FFactory> Factories;
};

/** Called once on module startup to register all built-in widgets. */
void HaybaSliver_RegisterBuiltinParamWidgets();
