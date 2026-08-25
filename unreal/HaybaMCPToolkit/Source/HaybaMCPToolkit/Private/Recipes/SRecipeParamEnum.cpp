// SRecipeParamEnum.cpp
#include "Recipes/SRecipeParamEnum.h"
#include "Widgets/Text/STextBlock.h"

static FString JsonEscape2(const FString& In)
{
    FString S = In;
    S.ReplaceInline(TEXT("\\"), TEXT("\\\\"));
    S.ReplaceInline(TEXT("\""), TEXT("\\\""));
    return S;
}

void SRecipeParamEnum::Construct(const FArguments& InArgs)
{
    SRecipeParamWidget::FArguments BaseArgs;
    BaseArgs._Param = InArgs._Param;
    SRecipeParamWidget::Construct(BaseArgs);

    for (const FHaybaRecipeEnumOption& O : Param.EnumOptions)
        Options.Add(MakeShared<FString>(O.Value));

    const FString Def = Param.DefaultString.Get(Options.Num() > 0 ? *Options[0] : FString());
    for (const TSharedPtr<FString>& Opt : Options) if (*Opt == Def) { Selected = Opt; break; }
    if (!Selected.IsValid() && Options.Num() > 0) Selected = Options[0];

    ChildSlot
    [
        SNew(SComboBox<TSharedPtr<FString>>)
        .OptionsSource(&Options)
        .OnGenerateWidget_Lambda([](TSharedPtr<FString> Item)
        { return SNew(STextBlock).Text(FText::FromString(*Item)); })
        .OnSelectionChanged_Lambda([this](TSharedPtr<FString> Item, ESelectInfo::Type)
        { Selected = Item; })
        .InitiallySelectedItem(Selected)
        [
            SNew(STextBlock).Text_Lambda([this]()
            { return Selected.IsValid() ? FText::FromString(*Selected) : FText::GetEmpty(); })
        ]
    ];
}

FString SRecipeParamEnum::GetValueAsJson() const
{
    if (!Selected.IsValid()) return TEXT("null");
    return FString::Printf(TEXT("\"%s\""), *JsonEscape2(*Selected));
}
