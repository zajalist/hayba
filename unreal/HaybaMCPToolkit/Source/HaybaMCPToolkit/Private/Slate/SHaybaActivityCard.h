#pragma once

#include "CoreMinimal.h"
#include "HaybaMCPActivityModel.h"
#include "Widgets/SCompoundWidget.h"

struct FHaybaActivityCardPresentation
{
    FString Title;
    FString StateLabel;
    bool bShowsApprovalActions = false;
};

DECLARE_DELEGATE_TwoParams(FOnHaybaActivityExpansionChanged, const FString&, bool);

/** A compact projection of one model-owned agent activity. It owns no activity state. */
class SHaybaActivityCard : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SHaybaActivityCard) {}
        SLATE_ARGUMENT(const FHaybaActivityModel*, ActivityModel)
        SLATE_ARGUMENT(FString, ActivityId)
        SLATE_ARGUMENT(bool, InitiallyExpanded)
        SLATE_EVENT(FOnHaybaActivityExpansionChanged, OnExpansionChanged)
        SLATE_ARGUMENT(FSimpleDelegate, OnApprove)
        SLATE_ARGUMENT(FSimpleDelegate, OnReject)
        SLATE_ARGUMENT(FSimpleDelegate, OnCancel)
        SLATE_ARGUMENT(FSimpleDelegate, OnRetry)
        SLATE_ARGUMENT(FSimpleDelegate, OnUndo)
        SLATE_ARGUMENT(FSimpleDelegate, OnSaveAsRecipe)
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs);
    static FHaybaActivityCardPresentation Describe(const FHaybaActivity& Activity);

private:
    const FHaybaActivity* Activity() const;
    void Rebuild();
    FReply ToggleExpanded();
    FReply Execute(FSimpleDelegate Action);
    TSharedRef<SWidget> BuildAction(const FText& Label, const FText& Tooltip, FSimpleDelegate Action);
    TSharedRef<SWidget> BuildDetails(const FHaybaActivity& Activity);

    const FHaybaActivityModel* ActivityModel = nullptr;
    FString ActivityId;
    FSimpleDelegate OnApprove;
    FSimpleDelegate OnReject;
    FSimpleDelegate OnCancel;
    FSimpleDelegate OnRetry;
    FSimpleDelegate OnUndo;
    FSimpleDelegate OnSaveAsRecipe;
    FOnHaybaActivityExpansionChanged OnExpansionChanged;
    bool bExpanded = false;
};
