// SSliverParamWidget.cpp
#include "Slivers/SSliverParamWidget.h"

#include "Widgets/Text/STextBlock.h"

namespace
{
    class SUnsupportedParamWidget : public SSliverParamWidget
    {
    public:
        SLATE_BEGIN_ARGS(SUnsupportedParamWidget) {}
            SLATE_ARGUMENT(FHaybaSliverParam, Param)
        SLATE_END_ARGS()

        void Construct(const FArguments& InArgs)
        {
            SSliverParamWidget::FArguments BaseArgs;
            BaseArgs._Param = InArgs._Param;
            SSliverParamWidget::Construct(BaseArgs);

            ChildSlot
            [
                SNew(STextBlock).Text(FText::FromString(FString::Printf(
                    TEXT("[unsupported param type: %s]"), *Param.OriginalTypeString)))
            ];
        }

        virtual FString GetValueAsJson() const override { return TEXT("null"); }
    };
}

FSliverParamWidgetRegistry& FSliverParamWidgetRegistry::Get()
{
    static FSliverParamWidgetRegistry Singleton;
    return Singleton;
}

void FSliverParamWidgetRegistry::Register(EHaybaSliverParamType Type, FFactory Make)
{
    Factories.Add(Type, MoveTemp(Make));
}

TSharedRef<SSliverParamWidget> FSliverParamWidgetRegistry::Create(const FHaybaSliverParam& Param) const
{
    if (const FFactory* F = Factories.Find(Param.Type)) return (*F)(Param);
    return SNew(SUnsupportedParamWidget).Param(Param);
}
