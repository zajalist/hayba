// SRecipeDetailPanel.cpp
#include "Recipes/SRecipeDetailPanel.h"

#include "Recipes/HaybaRecipeClient.h"
#include "Recipes/HaybaRecipeSettings.h"
#include "Recipes/SRecipeParamActorRef.h"
#include "Recipes/SRecipeParamVector3.h"
#include "Async/Async.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SMultiLineEditableTextBox.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SScrollBox.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Text/STextBlock.h"

void SRecipeDetailPanel::Construct(const FArguments& InArgs)
{
    ChildSlot
    [
        SNew(SVerticalBox)
        // Title — the recipe's description shows on hover as a tooltip,
        // so it doesn't eat vertical space the param list needs.
        + SVerticalBox::Slot().AutoHeight().Padding(8, 6, 8, 4)
        [
            SAssignNew(TitleText, STextBlock)
            .AutoWrapText(true)
        ]
        // Params — gets the bulk of the panel; scrollable for long lists.
        + SVerticalBox::Slot().FillHeight(1.0f).Padding(4, 2)
        [
            SNew(SScrollBox)
            + SScrollBox::Slot()
            [ SAssignNew(ParamBox, SVerticalBox) ]
        ]
        // Output (fills) with a compact Run button to its right.
        + SVerticalBox::Slot().FillHeight(0.4f).Padding(8, 4, 8, 8)
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().FillWidth(1.0f)
            [
                SNew(SBorder)
                .Padding(FMargin(4))
                [
                    SAssignNew(OutputBox, SMultiLineEditableTextBox)
                    .IsReadOnly(true)
                    .AutoWrapText(true)
                    .Text(FText::FromString(TEXT("(no run yet)")))
                ]
            ]
            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Top).Padding(6, 0, 0, 0)
            [
                SNew(SButton)
                .ContentPadding(FMargin(14, 4))
                .ToolTipText(FText::FromString(TEXT("Run this recipe with the parameters above.")))
                .Text(FText::FromString(TEXT("Run")))
                .OnClicked(this, &SRecipeDetailPanel::OnRunClicked)
            ]
        ]
    ];
}

void SRecipeDetailPanel::SetSpec(const FHaybaRecipeSpec& InSpec)
{
    Spec = InSpec;
    if (TitleText)
    {
        TitleText->SetText(FText::FromString(Spec.Title + TEXT("  (") + Spec.Id + TEXT(")")));
        // Description shows on hover instead of taking a fixed block.
        TitleText->SetToolTipText(FText::FromString(Spec.Description));
    }
    if (OutputBox)       OutputBox->SetText(FText::FromString(TEXT("(no run yet)")));
    RebuildParamUI();
}

void SRecipeDetailPanel::RebuildParamUI()
{
    if (!ParamBox.IsValid()) return;
    ParamBox->ClearChildren();
    ParamWidgets.Reset();

    for (const FHaybaRecipeParam& P : Spec.Params)
    {
        TSharedRef<SRecipeParamWidget> W = FRecipeParamWidgetRegistry::Get().Create(P);
        ParamWidgets.Add(W);

        const FString LabelText = (!P.Label.IsEmpty() ? P.Label : P.Id) + (P.bRequired ? TEXT(" *") : TEXT(""));
        ParamBox->AddSlot().AutoHeight().Padding(6, 4)
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().FillWidth(0.42f).VAlign(VAlign_Center).Padding(0, 0, 8, 0)
            [
                SNew(STextBlock)
                .Text(FText::FromString(LabelText))
                .AutoWrapText(true)
            ]
            + SHorizontalBox::Slot().FillWidth(0.58f).VAlign(VAlign_Center)
            [ W ]
        ];
    }

    // Auto-fill wiring: an actor_ref param "X" mirrors the picked actor's
    // world location into a sibling vector3 param "X_location", so a recipe
    // like frame_target actually frames the chosen actor.
    for (const TSharedRef<SRecipeParamWidget>& W : ParamWidgets)
    {
        if (W->GetParam().Type != EHaybaRecipeParamType::ActorRef) continue;
        const FString LocId = W->GetParam().Id + TEXT("_location");

        TSharedPtr<SRecipeParamVector3> VecW;
        for (const TSharedRef<SRecipeParamWidget>& V : ParamWidgets)
        {
            if (V->GetParam().Type == EHaybaRecipeParamType::Vector3 && V->GetParam().Id == LocId)
            {
                VecW = StaticCastSharedRef<SRecipeParamVector3>(V);
                break;
            }
        }
        if (!VecW.IsValid()) continue;

        TWeakPtr<SRecipeParamVector3> WeakVec = VecW;
        StaticCastSharedRef<SRecipeParamActorRef>(W)->OnActorPicked.BindLambda(
            [WeakVec](const FVector& Loc)
            {
                if (TSharedPtr<SRecipeParamVector3> V = WeakVec.Pin()) V->SetVector(Loc);
            });
    }
}

FString SRecipeDetailPanel::BuildParamsJson() const
{
    TArray<FString> Parts;
    for (const TSharedRef<SRecipeParamWidget>& W : ParamWidgets)
    {
        const FString Id = W->GetParam().Id;
        FString Esc = Id; Esc.ReplaceInline(TEXT("\""), TEXT("\\\""));
        Parts.Add(FString::Printf(TEXT("\"%s\":%s"), *Esc, *W->GetValueAsJson()));
    }
    return TEXT("{") + FString::Join(Parts, TEXT(",")) + TEXT("}");
}

FReply SRecipeDetailPanel::OnRunClicked()
{
    if (bRunning) return FReply::Handled();
    bRunning = true;
    if (OutputBox) OutputBox->SetText(FText::FromString(TEXT("(running…)")));

    const UHaybaRecipeSettings* S = UHaybaRecipeSettings::GetChecked();
    const FString BaseUrl = S->McpHttpBaseUrl;
    const FString Id = Spec.Id;
    const FString ParamsJson = BuildParamsJson();

    FHaybaRecipeRunCallback OnDone = FHaybaRecipeRunCallback::CreateLambda(
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

    FHaybaRecipeClient::RunRecipe(BaseUrl, Id, ParamsJson, OnDone);
    return FReply::Handled();
}
