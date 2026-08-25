// SRecipeParamString.cpp
#include "Recipes/SRecipeParamString.h"
#include "Widgets/Input/SEditableTextBox.h"

static FString JsonEscape(const FString& In)
{
    FString S = In;
    S.ReplaceInline(TEXT("\\"), TEXT("\\\\"));
    S.ReplaceInline(TEXT("\""), TEXT("\\\""));
    S.ReplaceInline(TEXT("\n"), TEXT("\\n"));
    S.ReplaceInline(TEXT("\r"), TEXT("\\r"));
    S.ReplaceInline(TEXT("\t"), TEXT("\\t"));
    return S;
}

void SRecipeParamString::Construct(const FArguments& InArgs)
{
    SRecipeParamWidget::FArguments BaseArgs;
    BaseArgs._Param = InArgs._Param;
    SRecipeParamWidget::Construct(BaseArgs);

    Value = Param.DefaultString.Get(FString());

    ChildSlot
    [
        SNew(SEditableTextBox)
        .Text_Lambda([this]() { return FText::FromString(Value); })
        .OnTextChanged_Lambda([this](const FText& T) { Value = T.ToString(); })
    ];
}

FString SRecipeParamString::GetValueAsJson() const
{
    return FString::Printf(TEXT("\"%s\""), *JsonEscape(Value));
}
