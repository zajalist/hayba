// SRecipeParamActorRef.cpp
#include "Recipes/SRecipeParamActorRef.h"
#include "Editor.h"
#include "Selection.h"
#include "GameFramework/Actor.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SEditableTextBox.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Text/STextBlock.h"

static FString JsonEscapeA(const FString& In)
{
    FString S = In;
    S.ReplaceInline(TEXT("\\"), TEXT("\\\\"));
    S.ReplaceInline(TEXT("\""), TEXT("\\\""));
    return S;
}

void SRecipeParamActorRef::Construct(const FArguments& InArgs)
{
    SRecipeParamWidget::FArguments BaseArgs;
    BaseArgs._Param = InArgs._Param;
    SRecipeParamWidget::Construct(BaseArgs);

    Value = Param.DefaultString.Get(FString());

    ChildSlot
    [
        SNew(SHorizontalBox)
        + SHorizontalBox::Slot().FillWidth(1.0f).Padding(2)
        [
            SNew(SEditableTextBox)
            .Text_Lambda([this]() { return FText::FromString(Value); })
            .OnTextChanged_Lambda([this](const FText& T) { Value = T.ToString(); })
        ]
        + SHorizontalBox::Slot().AutoWidth().Padding(2)
        [
            SNew(SButton)
            .Text(FText::FromString(TEXT("Pick from selection")))
            .OnClicked(this, &SRecipeParamActorRef::OnPickFromSelection)
        ]
    ];
}

FReply SRecipeParamActorRef::OnPickFromSelection()
{
    if (!GEditor) return FReply::Handled();
    TArray<AActor*> Sel;
    GEditor->GetSelectedActors()->GetSelectedObjects<AActor>(Sel);
    if (Sel.Num() > 0 && Sel[0])
    {
        Value = Sel[0]->GetPathName();
        // Let the panel mirror the world location into a sibling
        // "<id>_location" vector3 param so the recipe frames this actor.
        OnActorPicked.ExecuteIfBound(Sel[0]->GetActorLocation());
    }
    return FReply::Handled();
}

FString SRecipeParamActorRef::GetValueAsJson() const
{
    return FString::Printf(TEXT("\"%s\""), *JsonEscapeA(Value));
}
