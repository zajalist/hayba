#include "HaybaMCPToolStreamPanel.h"
#include "Widgets/Layout/SExpandableArea.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/SBoxPanel.h"

const TMap<FString, EHaybaRendererType>& SHaybaMCPToolStreamPanel::GetRendererMap()
{
    static TMap<FString, EHaybaRendererType> Map = {
        { TEXT("actor_spawn"),            EHaybaRendererType::Actor },
        { TEXT("actor_delete"),           EHaybaRendererType::Actor },
        { TEXT("actor_set_transform"),    EHaybaRendererType::Actor },
        { TEXT("actor_list"),             EHaybaRendererType::Actor },
        { TEXT("scene_get_graph"),        EHaybaRendererType::Scene },
        { TEXT("scene_validate_physics"), EHaybaRendererType::Scene },
        { TEXT("editor_capture_viewport"),EHaybaRendererType::Image },
        { TEXT("editor_execute_console"), EHaybaRendererType::Script },
        { TEXT("editor_stream_log"),      EHaybaRendererType::Script },
        { TEXT("python_exec"),            EHaybaRendererType::Script },
        { TEXT("visual_moodboard"),       EHaybaRendererType::Image },
        { TEXT("visual_clip_compare"),    EHaybaRendererType::Image },
        { TEXT("memory_write"),           EHaybaRendererType::Memory },
        { TEXT("memory_query"),           EHaybaRendererType::Memory },
        { TEXT("hayba_propose_plan"),     EHaybaRendererType::Plan },
    };
    return Map;
}

EHaybaRendererType SHaybaMCPToolStreamPanel::ResolveRenderer(const FString& ToolName)
{
    const auto& Map = GetRendererMap();
    if (const EHaybaRendererType* T = Map.Find(ToolName)) return *T;
    if (ToolName.StartsWith(TEXT("visual_"))) return EHaybaRendererType::Image;
    if (ToolName.StartsWith(TEXT("memory_"))) return EHaybaRendererType::Memory;
    if (ToolName.StartsWith(TEXT("actor_")))  return EHaybaRendererType::Actor;
    if (ToolName.StartsWith(TEXT("scene_")))  return EHaybaRendererType::Scene;
    if (ToolName.StartsWith(TEXT("editor_"))) return EHaybaRendererType::Script;
    return EHaybaRendererType::Generic;
}

void SHaybaMCPToolStreamPanel::Construct(const FArguments& InArgs)
{
    auto FirstTurn = MakeShared<FHaybaTurn>();
    FirstTurn->TurnIndex = 0;
    FirstTurn->Summary = TEXT("Turn 1");
    Turns.Add(FirstTurn);

    ChildSlot
    [
        SNew(SVerticalBox)
        + SVerticalBox::Slot().FillHeight(1.f)
        [
            SAssignNew(TurnList, SListView<TSharedPtr<FHaybaTurn>>)
            .ListItemsSource(&Turns)
            .OnGenerateRow(this, &SHaybaMCPToolStreamPanel::GenerateTurnRow)
        ]
    ];
}

void SHaybaMCPToolStreamPanel::BeginNewTurn()
{
    CurrentTurnIndex++;
    auto Turn = MakeShared<FHaybaTurn>();
    Turn->TurnIndex = CurrentTurnIndex;
    Turn->Summary = FString::Printf(TEXT("Turn %d"), CurrentTurnIndex + 1);
    Turns.Add(Turn);
    if (TurnList.IsValid()) TurnList->RequestListRefresh();
}

void SHaybaMCPToolStreamPanel::AddToolCall(const FString& ToolName, const FString& ParamsJson, const FString& ResultJson)
{
    if (Turns.IsEmpty()) BeginNewTurn();
    FHaybaToolCall Call;
    Call.ToolName = ToolName;
    Call.ParamsJson = ParamsJson;
    Call.ResultJson = ResultJson;
    Call.RendererType = ResolveRenderer(ToolName);
    Call.Timestamp = FDateTime::Now();
    Turns.Last()->Calls.Add(Call);
    RebuildSummary(Turns.Last());
    if (TurnList.IsValid()) TurnList->RequestListRefresh();
}

void SHaybaMCPToolStreamPanel::RebuildSummary(TSharedPtr<FHaybaTurn> Turn) const
{
    TArray<FString> Names;
    for (const auto& C : Turn->Calls)
    {
        Names.AddUnique(C.ToolName);
        if (Names.Num() >= 3) break;
    }
    Turn->Summary = FString::Printf(TEXT("Turn %d  -  %d call%s  (%s)"),
        Turn->TurnIndex + 1,
        Turn->Calls.Num(),
        Turn->Calls.Num() == 1 ? TEXT("") : TEXT("s"),
        *FString::Join(Names, TEXT(", ")));
}

TSharedRef<ITableRow> SHaybaMCPToolStreamPanel::GenerateTurnRow(TSharedPtr<FHaybaTurn> Turn, const TSharedRef<STableViewBase>& Owner)
{
    TSharedRef<SVerticalBox> Body = SNew(SVerticalBox);
    for (const auto& Call : Turn->Calls)
    {
        Body->AddSlot().AutoHeight().Padding(4)
        [ BuildCallRow(Call) ];
    }

    return SNew(STableRow<TSharedPtr<FHaybaTurn>>, Owner)
    [
        SNew(SExpandableArea)
        .InitiallyCollapsed(true)
        .HeaderContent()
        [ SNew(STextBlock).Text(FText::FromString(Turn->Summary)) ]
        .BodyContent()
        [ Body ]
    ];
}

TSharedRef<SWidget> SHaybaMCPToolStreamPanel::BuildCallRow(const FHaybaToolCall& Call) const
{
    return BuildGenericRenderer(Call);
}

TSharedRef<SWidget> SHaybaMCPToolStreamPanel::BuildGenericRenderer(const FHaybaToolCall& Call) const
{
    const FString PreviewParams = Call.ParamsJson.Left(120);
    const FString PreviewResult = Call.ResultJson.Left(200);
    return SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight()
        [ SNew(STextBlock).Text(FText::FromString(FString::Printf(TEXT("> %s"), *Call.ToolName))) ]
        + SVerticalBox::Slot().AutoHeight()
        [ SNew(STextBlock).ColorAndOpacity(FSlateColor(FLinearColor(0.6f, 0.6f, 0.7f))).Text(FText::FromString(PreviewParams)) ]
        + SVerticalBox::Slot().AutoHeight()
        [ SNew(STextBlock).Text(FText::FromString(PreviewResult)) ];
}
