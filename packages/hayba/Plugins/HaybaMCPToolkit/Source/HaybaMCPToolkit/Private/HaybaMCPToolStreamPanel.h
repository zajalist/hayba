#pragma once
#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"
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
    TSharedPtr<SListView<TSharedPtr<FHaybaTurn>>> TurnList;
    int32 CurrentTurnIndex = 0;

    TSharedRef<ITableRow> GenerateTurnRow(TSharedPtr<FHaybaTurn> Turn, const TSharedRef<STableViewBase>& Owner);
    TSharedRef<SWidget> BuildCallRow(const FHaybaToolCall& Call) const;
    TSharedRef<SWidget> BuildGenericRenderer(const FHaybaToolCall& Call) const;

    void RebuildSummary(TSharedPtr<FHaybaTurn> Turn) const;

    static const TMap<FString, EHaybaRendererType>& GetRendererMap();
};
