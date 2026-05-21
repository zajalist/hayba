// SSliverDetailPanel.cpp
#include "Slivers/SSliverDetailPanel.h"

#include "Slivers/HaybaSliverClient.h"
#include "Slivers/HaybaSliverSettings.h"
#include "Async/Async.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SMultiLineEditableTextBox.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Text/STextBlock.h"

void SSliverDetailPanel::Construct(const FArguments& InArgs)
{
    ChildSlot
    [
        SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight().Padding(4)
        [ SAssignNew(TitleText, STextBlock) ]
        + SVerticalBox::Slot().AutoHeight().Padding(4)
        [ SAssignNew(DescriptionText, STextBlock) ]
        + SVerticalBox::Slot().AutoHeight().Padding(4)
        [ SAssignNew(ParamBox, SVerticalBox) ]
        + SVerticalBox::Slot().AutoHeight().Padding(4)
        [
            SNew(SButton)
            .Text(FText::FromString(TEXT("Run")))
            .OnClicked(this, &SSliverDetailPanel::OnRunClicked)
        ]
        + SVerticalBox::Slot().FillHeight(1.0f).Padding(4)
        [
            SNew(SBorder)
            [
                SAssignNew(OutputBox, SMultiLineEditableTextBox)
                .IsReadOnly(true)
                .Text(FText::FromString(TEXT("(no run yet)")))
            ]
        ]
    ];
}

void SSliverDetailPanel::SetSpec(const FHaybaSliverSpec& InSpec)
{
    Spec = InSpec;
    if (TitleText)       TitleText->SetText(FText::FromString(Spec.Title + TEXT("  (") + Spec.Id + TEXT(")")));
    if (DescriptionText) DescriptionText->SetText(FText::FromString(Spec.Description));
    if (OutputBox)       OutputBox->SetText(FText::FromString(TEXT("(no run yet)")));
    RebuildParamUI();
}

void SSliverDetailPanel::RebuildParamUI()
{
    if (!ParamBox.IsValid()) return;
    ParamBox->ClearChildren();
    ParamWidgets.Reset();

    for (const FHaybaSliverParam& P : Spec.Params)
    {
        TSharedRef<SSliverParamWidget> W = FSliverParamWidgetRegistry::Get().Create(P);
        ParamWidgets.Add(W);

        const FString LabelText = (!P.Label.IsEmpty() ? P.Label : P.Id) + (P.bRequired ? TEXT(" *") : TEXT(""));
        ParamBox->AddSlot().AutoHeight().Padding(2)
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().FillWidth(0.4f).VAlign(VAlign_Center)
            [ SNew(STextBlock).Text(FText::FromString(LabelText)) ]
            + SHorizontalBox::Slot().FillWidth(0.6f)
            [ W ]
        ];
    }
}

FString SSliverDetailPanel::BuildParamsJson() const
{
    TArray<FString> Parts;
    for (const TSharedRef<SSliverParamWidget>& W : ParamWidgets)
    {
        const FString Id = W->GetParam().Id;
        FString Esc = Id; Esc.ReplaceInline(TEXT("\""), TEXT("\\\""));
        Parts.Add(FString::Printf(TEXT("\"%s\":%s"), *Esc, *W->GetValueAsJson()));
    }
    return TEXT("{") + FString::Join(Parts, TEXT(",")) + TEXT("}");
}

FReply SSliverDetailPanel::OnRunClicked()
{
    if (bRunning) return FReply::Handled();
    bRunning = true;
    if (OutputBox) OutputBox->SetText(FText::FromString(TEXT("(running…)")));

    const UHaybaSliverSettings* S = UHaybaSliverSettings::GetChecked();
    const FString BaseUrl = S->McpHttpBaseUrl;
    const FString Id = Spec.Id;
    const FString ParamsJson = BuildParamsJson();

    FHaybaSliverRunCallback OnDone = FHaybaSliverRunCallback::CreateLambda(
        [this](bool bOk, const FString& Body)
        {
            AsyncTask(ENamedThreads::GameThread, [this, bOk, Body]()
            {
                bRunning = false;
                if (OutputBox)
                {
                    OutputBox->SetText(FText::FromString(bOk ? Body : (TEXT("HTTP error:\n") + Body)));
                }
            });
        });

    FHaybaSliverClient::RunSliver(BaseUrl, Id, ParamsJson, OnDone);
    return FReply::Handled();
}
