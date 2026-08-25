#pragma once
#include "CoreMinimal.h"
#include "HaybaMCPStatusVocabulary.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Views/SListView.h"

enum class EHaybaRendererType : uint8
{
    Actor, Asset, Scene, Image, Script, Performance, Error, Memory, Plan, Generic
};

struct FHaybaToolCall
{
    FString ToolName;
    FString ParamsJson;
    FString ResultJson;
    EHaybaRendererType RendererType = EHaybaRendererType::Generic;
    FDateTime Timestamp;

    /** The call failed outright. */
    bool bIsError = false;

    /** The call succeeded but a rule came back with a NEGATIVE margin.
     *
     *  The IA's "needs attention", and the reason it is separate from
     *  bIsError: the tool did what was asked and the result violates a
     *  constraint. Rendering that as a green tick -- which is what happened
     *  before -- hides the verdict at the moment it matters most.
     *
     *  Computed once when the call is recorded rather than per paint: it means
     *  parsing the result JSON, and a row repaints far more often than it
     *  arrives. */
    bool bNeedsAttention = false;

    /** The worst margin behind bNeedsAttention, for the chip's tooltip. */
    double WorstMargin = 0.0;
    FString WorstMarginUnit;
    FString WorstRuleId;

    /** Derive the verdict fields from ResultJson.
     *
     *  Both places that build one of these must call this. It exists because
     *  the first version classified inside AddToolCall only, and the panel
     *  ALSO builds calls when hydrating from history -- which is the usual
     *  path, since the panel is constructed on first show. The result was a
     *  row displaying "ERROR: ..." beside a green tick.
     *
     *  Declared here and defined in the .cpp: the JSON walk needs the
     *  serializer, and the header should not drag it in. */
    void Classify();
};

struct FHaybaTurn
{
    int32 TurnIndex = 0;
    TArray<FHaybaToolCall> Calls;
    FString Summary;

    /** The turn's status in the product's shared vocabulary. Worst-wins:
     *  an error outranks needing attention, which outranks done. */
    EHaybaStatus Status() const
    {
        bool bAttention = false;
        for (const FHaybaToolCall& C : Calls)
        {
            if (C.bIsError) return EHaybaStatus::Error;
            if (C.bNeedsAttention) bAttention = true;
        }
        return bAttention ? EHaybaStatus::NeedsAttention : EHaybaStatus::Done;
    }
    // Per-turn selection — Copy / Archive bulk actions target whole turns.
    bool bSelected = false;
};

class SHaybaMCPToolStreamPanel : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SHaybaMCPToolStreamPanel) {}
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs);

    /** Append a tool call to the current turn. */
    void AddToolCall(const FString& ToolName, const FString& ParamsJson, const FString& ResultJson);

    /** Start a new turn (collapsed by default). */
    void BeginNewTurn();

    static EHaybaRendererType ResolveRenderer(const FString& ToolName);

private:
    TArray<TSharedPtr<FHaybaTurn>> Turns;
    TSharedPtr<SListView<TSharedPtr<FHaybaTurn>>> TurnList;  // kept for compat; new code uses TurnsContainer
    TSharedPtr<SVerticalBox> TurnsContainer;
    int32 CurrentTurnIndex = 0;

    void RebuildTurnsContainer();

    // Free-text filter applied across tool name / params / result; empty = show all.
    FString FilterQuery;

    TSharedRef<SWidget> BuildCallRow(const FHaybaToolCall& Call, int32 TurnIdx, int32 CallIdx);
    TSharedRef<SWidget> BuildGenericRenderer(const FHaybaToolCall& Call, int32 TurnIdx, int32 CallIdx);
    TSharedRef<SWidget> BuildToolbar();
    TSharedRef<SWidget> BuildStatsMenu();

    void RebuildSummary(TSharedPtr<FHaybaTurn> Turn) const;

    // Filter helpers.
    bool CallMatchesFilter(const FHaybaToolCall& Call) const;
    bool TurnHasAnyMatch(const TSharedPtr<FHaybaTurn>& Turn) const;

    // Toolbar handlers.
    void OnSearchChanged(const FText& InText);
    FReply OnArchive();
    FReply OnClear();
    FReply OnCopyAll();
    FReply OnSelectAllVisible();
    FReply OnClearSelection();
    void CopyCallToClipboard(const FHaybaToolCall& Call) const;
    int32 CountSelected() const;

    static const TMap<FString, EHaybaRendererType>& GetRendererMap();
};
