// SSliverParamActorRef.cpp
#include "Slivers/SSliverParamActorRef.h"
#include "Editor.h"
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

void SSliverParamActorRef::Construct(const FArguments& InArgs)
{
    SSliverParamWidget::FArguments BaseArgs;
    BaseArgs._Param = InArgs._Param;
    SSliverParamWidget::Construct(BaseArgs);

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
            .OnClicked(this, &SSliverParamActorRef::OnPickFromSelection)
        ]
    ];
}

FReply SSliverParamActorRef::OnPickFromSelection()
{
    if (!GEditor) return FReply::Handled();
    TArray<AActor*> Sel;
    GEditor->GetSelectedActors()->GetSelectedObjects<AActor>(Sel);
    if (Sel.Num() > 0 && Sel[0]) Value = Sel[0]->GetPathName();
    return FReply::Handled();
}

FString SSliverParamActorRef::GetValueAsJson() const
{
    return FString::Printf(TEXT("\"%s\""), *JsonEscapeA(Value));
}
