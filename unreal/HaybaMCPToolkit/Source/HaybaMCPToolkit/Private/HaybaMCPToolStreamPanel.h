#pragma once
#include "CoreMinimal.h"
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
};

struct FHaybaTurn
{
    int32 TurnIndex = 0;
    TArray<FHaybaToolCall> Calls;
    FString Summary;
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
