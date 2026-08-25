// SRecipeParamWidget.cpp
#include "Recipes/SRecipeParamWidget.h"

#include "Widgets/Text/STextBlock.h"

namespace
{
    class SUnsupportedParamWidget : public SRecipeParamWidget
    {
    public:
        SLATE_BEGIN_ARGS(SUnsupportedParamWidget) {}
            SLATE_ARGUMENT(FHaybaRecipeParam, Param)
        SLATE_END_ARGS()

        void Construct(const FArguments& InArgs)
        {
            SRecipeParamWidget::FArguments BaseArgs;
            BaseArgs._Param = InArgs._Param;
            SRecipeParamWidget::Construct(BaseArgs);

            ChildSlot
            [
                SNew(STextBlock).Text(FText::FromString(FString::Printf(
                    TEXT("[unsupported param type: %s]"), *Param.OriginalTypeString)))
            ];
        }

        virtual FString GetValueAsJson() const override { return TEXT("null"); }
    };
}

FRecipeParamWidgetRegistry& FRecipeParamWidgetRegistry::Get()
{
    static FRecipeParamWidgetRegistry Singleton;
    return Singleton;
}

void FRecipeParamWidgetRegistry::Register(EHaybaRecipeParamType Type, FFactory Make)
{
    Factories.Add(Type, MoveTemp(Make));
}

TSharedRef<SRecipeParamWidget> FRecipeParamWidgetRegistry::Create(const FHaybaRecipeParam& Param) const
{
    if (const FFactory* F = Factories.Find(Param.Type)) return (*F)(Param);
    return SNew(SUnsupportedParamWidget).Param(Param);
}

#include "Recipes/SRecipeParamFloat.h"
#include "Recipes/SRecipeParamInt.h"
#include "Recipes/SRecipeParamBool.h"
#include "Recipes/SRecipeParamString.h"
#include "Recipes/SRecipeParamEnum.h"
#include "Recipes/SRecipeParamActorRef.h"
#include "Recipes/SRecipeParamVector3.h"

void HaybaRecipe_RegisterBuiltinParamWidgets()
{
    FRecipeParamWidgetRegistry& R = FRecipeParamWidgetRegistry::Get();
    R.Register(EHaybaRecipeParamType::Float,    [](const FHaybaRecipeParam& P) -> TSharedRef<SRecipeParamWidget>
        { return SNew(SRecipeParamFloat).Param(P); });
    R.Register(EHaybaRecipeParamType::Int,      [](const FHaybaRecipeParam& P) -> TSharedRef<SRecipeParamWidget>
        { return SNew(SRecipeParamInt).Param(P); });
    R.Register(EHaybaRecipeParamType::Bool,     [](const FHaybaRecipeParam& P) -> TSharedRef<SRecipeParamWidget>
        { return SNew(SRecipeParamBool).Param(P); });
    R.Register(EHaybaRecipeParamType::String,   [](const FHaybaRecipeParam& P) -> TSharedRef<SRecipeParamWidget>
        { return SNew(SRecipeParamString).Param(P); });
    R.Register(EHaybaRecipeParamType::Enum,     [](const FHaybaRecipeParam& P) -> TSharedRef<SRecipeParamWidget>
        { return SNew(SRecipeParamEnum).Param(P); });
    R.Register(EHaybaRecipeParamType::ActorRef, [](const FHaybaRecipeParam& P) -> TSharedRef<SRecipeParamWidget>
        { return SNew(SRecipeParamActorRef).Param(P); });
    R.Register(EHaybaRecipeParamType::Vector3,  [](const FHaybaRecipeParam& P) -> TSharedRef<SRecipeParamWidget>
        { return SNew(SRecipeParamVector3).Param(P); });
}
