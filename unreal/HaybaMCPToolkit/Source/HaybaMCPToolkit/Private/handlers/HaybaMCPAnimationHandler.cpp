#include "HaybaMCPAnimationHandler.h"

#include "Animation/AnimBlueprint.h"
#include "Animation/AnimBlueprintGeneratedClass.h"
#include "Animation/AnimInstance.h"
#include "AnimationGraph.h"
#include "AnimGraphNode_StateMachineBase.h"
#include "AnimGraphNode_StateMachine.h"
#include "AnimStateNodeBase.h"
#include "AnimStateNode.h"
#include "AnimStateTransitionNode.h"
#include "AnimationStateMachineGraph.h"
#include "AnimationStateMachineSchema.h"
#include "AnimationStateGraph.h"
#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphPin.h"
#include "EdGraphSchema_K2.h"
#include "Engine/Blueprint.h"
#include "K2Node_TransitionRuleGetter.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "Kismet2/CompilerResultsLog.h"
#include "Logging/TokenizedMessage.h"
#include "UObject/UObjectGlobals.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPAnim, Log, All);

TArray<FString> FHaybaMCPAnimationHandler::GetCommands() const
{
    return {
        TEXT("anim_blueprint_get_info"),
        TEXT("anim_blueprint_add_state"),
        TEXT("anim_blueprint_add_transition"),
        TEXT("anim_blueprint_set_condition"),
        TEXT("anim_blueprint_compile"),
    };
}

FHaybaHandlerResult FHaybaMCPAnimationHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& P)
{
    if (Cmd == TEXT("anim_blueprint_get_info"))      return GetInfo(P);
    if (Cmd == TEXT("anim_blueprint_add_state"))     return AddState(P);
    if (Cmd == TEXT("anim_blueprint_add_transition")) return AddTransition(P);
    if (Cmd == TEXT("anim_blueprint_set_condition"))  return SetCondition(P);
    if (Cmd == TEXT("anim_blueprint_compile"))       return Compile(P);
    return FHaybaHandlerResult::Err(FString::Printf(TEXT("AnimationHandler: unknown command %s"), *Cmd));
}

static UAnimBlueprint* LoadAnimBPByPath(const FString& Path)
{
    return LoadObject<UAnimBlueprint>(nullptr, *Path);
}

// Walk all event/anim graphs of the AnimBlueprint and collect every
// state-machine wrapper node. In UE 5.x, AnimBlueprint state machines live
// inside `UAnimationGraph` pages (FunctionGraphs) as `UAnimGraphNode_StateMachineBase`
// nodes; each wrapper owns a `EditorStateMachineGraph` (UAnimationStateMachineGraph).
static void CollectStateMachineNodes(UAnimBlueprint* BP, TArray<UAnimGraphNode_StateMachineBase*>& Out)
{
    if (!BP) return;
    auto Scan = [&Out](UEdGraph* Graph)
    {
        if (!Graph) return;
        for (UEdGraphNode* Node : Graph->Nodes)
        {
            if (UAnimGraphNode_StateMachineBase* SM = Cast<UAnimGraphNode_StateMachineBase>(Node))
            {
                Out.Add(SM);
            }
        }
        // Recurse into sub-graphs (composite anim graphs etc.)
        for (UEdGraph* Sub : Graph->SubGraphs)
        {
            if (Sub)
            {
                for (UEdGraphNode* SubNode : Sub->Nodes)
                {
                    if (UAnimGraphNode_StateMachineBase* SM = Cast<UAnimGraphNode_StateMachineBase>(SubNode))
                    {
                        Out.Add(SM);
                    }
                }
            }
        }
    };
    for (UEdGraph* G : BP->FunctionGraphs) Scan(G);
    for (UEdGraph* G : BP->UbergraphPages) Scan(G);
}

static UAnimGraphNode_StateMachineBase* FindStateMachineByName(UAnimBlueprint* BP, const FString& Name)
{
    TArray<UAnimGraphNode_StateMachineBase*> All;
    CollectStateMachineNodes(BP, All);
    for (UAnimGraphNode_StateMachineBase* SM : All)
    {
        if (!SM) continue;
        const FString SMName = SM->GetStateMachineName();
        const FString NodeName = SM->GetName();
        if (SMName.Equals(Name, ESearchCase::IgnoreCase) || NodeName.Equals(Name, ESearchCase::IgnoreCase))
            return SM;
        if (SM->EditorStateMachineGraph && SM->EditorStateMachineGraph->GetName().Equals(Name, ESearchCase::IgnoreCase))
            return SM;
    }
    return nullptr;
}

static UAnimStateNode* FindStateNodeByName(UAnimationStateMachineGraph* Graph, const FString& Name)
{
    if (!Graph) return nullptr;
    for (UEdGraphNode* N : Graph->Nodes)
    {
        UAnimStateNode* S = Cast<UAnimStateNode>(N);
        if (!S) continue;
        if (S->GetStateName().Equals(Name, ESearchCase::IgnoreCase)) return S;
        if (S->GetName().Equals(Name, ESearchCase::IgnoreCase)) return S;
    }
    return nullptr;
}

FHaybaHandlerResult FHaybaMCPAnimationHandler::GetInfo(const TSharedPtr<FJsonObject>& P)
{
    FString Path;
    if (!P.IsValid() || !P->TryGetStringField(TEXT("path"), Path) || Path.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("anim_blueprint_get_info: missing path"));

    UAnimBlueprint* BP = LoadAnimBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(TEXT("anim_blueprint_get_info: anim blueprint not found"));

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("name"), BP->GetName());
    Out->SetStringField(TEXT("target_skeleton"),
        BP->TargetSkeleton ? BP->TargetSkeleton->GetPathName() : TEXT(""));
    Out->SetStringField(TEXT("parent_class"),
        BP->ParentClass ? BP->ParentClass->GetPathName() : TEXT(""));

    // State machines
    TArray<UAnimGraphNode_StateMachineBase*> StateMachines;
    CollectStateMachineNodes(BP, StateMachines);
    TArray<TSharedPtr<FJsonValue>> SMJson;
    for (UAnimGraphNode_StateMachineBase* SM : StateMachines)
    {
        if (!SM) continue;
        TSharedPtr<FJsonObject> SMEntry = MakeShared<FJsonObject>();
        SMEntry->SetStringField(TEXT("name"), SM->GetStateMachineName());

        TArray<TSharedPtr<FJsonValue>> StatesJson;
        TArray<TSharedPtr<FJsonValue>> TransJson;
        if (UAnimationStateMachineGraph* SMGraph = SM->EditorStateMachineGraph)
        {
            for (UEdGraphNode* N : SMGraph->Nodes)
            {
                if (UAnimStateNode* S = Cast<UAnimStateNode>(N))
                {
                    TSharedPtr<FJsonObject> SE = MakeShared<FJsonObject>();
                    SE->SetStringField(TEXT("name"), S->GetStateName());
                    StatesJson.Add(MakeShared<FJsonValueObject>(SE.ToSharedRef()));
                }
                else if (UAnimStateTransitionNode* T = Cast<UAnimStateTransitionNode>(N))
                {
                    UAnimStateNodeBase* From = T->GetPreviousState();
                    UAnimStateNodeBase* To   = T->GetNextState();
                    TSharedPtr<FJsonObject> TE = MakeShared<FJsonObject>();
                    TE->SetStringField(TEXT("from"), From ? From->GetStateName() : TEXT(""));
                    TE->SetStringField(TEXT("to"),   To   ? To->GetStateName()   : TEXT(""));
                    TE->SetStringField(TEXT("id"),   T->GetName());
                    TransJson.Add(MakeShared<FJsonValueObject>(TE.ToSharedRef()));
                }
            }
        }
        SMEntry->SetArrayField(TEXT("states"), StatesJson);
        SMEntry->SetArrayField(TEXT("transitions"), TransJson);
        SMJson.Add(MakeShared<FJsonValueObject>(SMEntry.ToSharedRef()));
    }
    Out->SetArrayField(TEXT("state_machines"), SMJson);

    // Variables
    TArray<TSharedPtr<FJsonValue>> Vars;
    for (const FBPVariableDescription& V : BP->NewVariables)
    {
        TSharedPtr<FJsonObject> E = MakeShared<FJsonObject>();
        E->SetStringField(TEXT("name"), V.VarName.ToString());
        E->SetStringField(TEXT("type"), V.VarType.PinCategory.ToString());
        Vars.Add(MakeShared<FJsonValueObject>(E.ToSharedRef()));
    }
    Out->SetArrayField(TEXT("variables"), Vars);

    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPAnimationHandler::AddState(const TSharedPtr<FJsonObject>& P)
{
    FString Path, SMName, NewState;
    if (!P.IsValid() || !P->TryGetStringField(TEXT("path"), Path))
        return FHaybaHandlerResult::Err(TEXT("anim_blueprint_add_state: missing path"));
    if (!P->TryGetStringField(TEXT("state_machine_name"), SMName))
        return FHaybaHandlerResult::Err(TEXT("anim_blueprint_add_state: missing state_machine_name"));
    if (!P->TryGetStringField(TEXT("new_state_name"), NewState) || NewState.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("anim_blueprint_add_state: missing new_state_name"));

    UAnimBlueprint* BP = LoadAnimBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(TEXT("anim_blueprint_add_state: anim blueprint not found"));

    UAnimGraphNode_StateMachineBase* SM = FindStateMachineByName(BP, SMName);
    if (!SM || !SM->EditorStateMachineGraph)
        return FHaybaHandlerResult::Err(TEXT("anim_blueprint_add_state: state machine not found"));

    UAnimationStateMachineGraph* Graph = SM->EditorStateMachineGraph;

    // Reject duplicates.
    if (FindStateNodeByName(Graph, NewState))
        return FHaybaHandlerResult::Err(TEXT("anim_blueprint_add_state: state with that name already exists"));

    // Create the state node. UAnimStateNode is a UEdGraphNode subclass; we
    // construct via FGraphNodeCreator and let it auto-create its sub-graph
    // (the per-state UAnimationStateGraph) via AllocateDefaultPins/AutowireNewNode.
    FGraphNodeCreator<UAnimStateNode> Creator(*Graph);
    UAnimStateNode* StateNode = Creator.CreateNode(/*bSelectNewNode*/false);
    if (!StateNode)
        return FHaybaHandlerResult::Err(TEXT("anim_blueprint_add_state: CreateNode failed"));
    StateNode->StateType = EAnimStateType::AST_State;
    Creator.Finalize();

    StateNode->NodePosX = 0;
    StateNode->NodePosY = 0;

    // Rename the node and its bound graph to NewState.
    if (StateNode->BoundGraph)
    {
        FBlueprintEditorUtils::RenameGraph(StateNode->BoundGraph, NewState);
    }
    else
    {
        // Fallback: create the bound graph manually.
        UEdGraph* BoundGraph = FBlueprintEditorUtils::CreateNewGraph(
            StateNode, FName(*NewState),
            UAnimationStateGraph::StaticClass(),
            UAnimationStateMachineSchema::StaticClass());
        StateNode->BoundGraph = BoundGraph;
    }

    FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(BP);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("state_machine"), SMName);
    Out->SetStringField(TEXT("state"), StateNode->GetStateName());
    Out->SetStringField(TEXT("node_name"), StateNode->GetName());
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPAnimationHandler::AddTransition(const TSharedPtr<FJsonObject>& P)
{
    FString Path, SMName, FromName, ToName;
    if (!P.IsValid() || !P->TryGetStringField(TEXT("path"), Path))
        return FHaybaHandlerResult::Err(TEXT("anim_blueprint_add_transition: missing path"));
    P->TryGetStringField(TEXT("state_machine_name"), SMName);   // optional — we can search by state name
    if (!P->TryGetStringField(TEXT("from_state"), FromName))
        return FHaybaHandlerResult::Err(TEXT("anim_blueprint_add_transition: missing from_state"));
    if (!P->TryGetStringField(TEXT("to_state"), ToName))
        return FHaybaHandlerResult::Err(TEXT("anim_blueprint_add_transition: missing to_state"));

    UAnimBlueprint* BP = LoadAnimBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(TEXT("anim_blueprint_add_transition: anim blueprint not found"));

    UAnimationStateMachineGraph* Graph = nullptr;
    UAnimStateNode* From = nullptr;
    UAnimStateNode* To = nullptr;

    TArray<UAnimGraphNode_StateMachineBase*> All;
    CollectStateMachineNodes(BP, All);
    for (UAnimGraphNode_StateMachineBase* SM : All)
    {
        if (!SM || !SM->EditorStateMachineGraph) continue;
        if (!SMName.IsEmpty() && !SM->GetStateMachineName().Equals(SMName, ESearchCase::IgnoreCase))
            continue;
        UAnimStateNode* CandFrom = FindStateNodeByName(SM->EditorStateMachineGraph, FromName);
        UAnimStateNode* CandTo   = FindStateNodeByName(SM->EditorStateMachineGraph, ToName);
        if (CandFrom && CandTo)
        {
            Graph = SM->EditorStateMachineGraph;
            From = CandFrom; To = CandTo;
            break;
        }
    }
    if (!Graph || !From || !To)
        return FHaybaHandlerResult::Err(TEXT("anim_blueprint_add_transition: from/to state not found"));

    // Build the transition node.
    FGraphNodeCreator<UAnimStateTransitionNode> Creator(*Graph);
    UAnimStateTransitionNode* Transition = Creator.CreateNode(/*bSelectNewNode*/false);
    if (!Transition)
        return FHaybaHandlerResult::Err(TEXT("anim_blueprint_add_transition: CreateNode failed"));
    Creator.Finalize();

    // Wire output of From to input of Transition, output of Transition to input of To.
    // UAnimStateNodeBase pins: index 0 in/out are exec-like state flow pins.
    Transition->CreateConnections(From, To);

    FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(BP);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("transition_id"), Transition->GetName());
    Out->SetStringField(TEXT("from"), From->GetStateName());
    Out->SetStringField(TEXT("to"), To->GetStateName());
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPAnimationHandler::SetCondition(const TSharedPtr<FJsonObject>& P)
{
    FString Path, Expr;
    if (!P.IsValid() || !P->TryGetStringField(TEXT("path"), Path))
        return FHaybaHandlerResult::Err(TEXT("anim_blueprint_set_condition: missing path"));
    if (!P->TryGetStringField(TEXT("condition_expression"), Expr))
        return FHaybaHandlerResult::Err(TEXT("anim_blueprint_set_condition: missing condition_expression"));

    // Caller may supply either explicit transition_id (UEdGraphNode name) or
    // a from_state/to_state pair (preferred).
    FString TransitionId, FromName, ToName;
    P->TryGetStringField(TEXT("transition_id"), TransitionId);
    P->TryGetStringField(TEXT("from_state"), FromName);
    P->TryGetStringField(TEXT("to_state"), ToName);

    UAnimBlueprint* BP = LoadAnimBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(TEXT("anim_blueprint_set_condition: anim blueprint not found"));

    UAnimStateTransitionNode* Target = nullptr;
    TArray<UAnimGraphNode_StateMachineBase*> All;
    CollectStateMachineNodes(BP, All);
    for (UAnimGraphNode_StateMachineBase* SM : All)
    {
        if (!SM || !SM->EditorStateMachineGraph) continue;
        for (UEdGraphNode* N : SM->EditorStateMachineGraph->Nodes)
        {
            UAnimStateTransitionNode* T = Cast<UAnimStateTransitionNode>(N);
            if (!T) continue;
            if (!TransitionId.IsEmpty() && T->GetName().Equals(TransitionId, ESearchCase::IgnoreCase))
            { Target = T; break; }
            if (!FromName.IsEmpty() && !ToName.IsEmpty())
            {
                UAnimStateNodeBase* F = T->GetPreviousState();
                UAnimStateNodeBase* O = T->GetNextState();
                if (F && O
                    && F->GetStateName().Equals(FromName, ESearchCase::IgnoreCase)
                    && O->GetStateName().Equals(ToName,   ESearchCase::IgnoreCase))
                { Target = T; break; }
            }
        }
        if (Target) break;
    }
    if (!Target)
        return FHaybaHandlerResult::Err(TEXT("anim_blueprint_set_condition: transition not found"));

    UEdGraph* RuleGraph = Target->BoundGraph;
    if (!RuleGraph)
        return FHaybaHandlerResult::Err(TEXT("anim_blueprint_set_condition: transition rule graph missing"));

    // v1: support literal "true"/"false" only — replace the rule result pin
    // with a bool literal of the chosen value. Anything else is recorded but
    // not parsed (returned as v2_pending so the caller knows).
    const FString L = Expr.ToLower().TrimStartAndEnd();
    bool bHandled = false;
    if (L == TEXT("true") || L == TEXT("false"))
    {
        const bool bValue = (L == TEXT("true"));
        // The rule graph's TransitionResult node has a boolean input pin
        // named "bCanEnterTransition". Find it and set its DefaultValue.
        for (UEdGraphNode* N : RuleGraph->Nodes)
        {
            // The TransitionResult node is UAnimGraphNode_TransitionResult in
            // editor graphs; we identify it by having an input bool pin named
            // bCanEnterTransition so we don't need a hard include.
            for (UEdGraphPin* Pin : N->Pins)
            {
                if (Pin
                    && Pin->Direction == EGPD_Input
                    && Pin->PinName == TEXT("bCanEnterTransition")
                    && Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_Boolean)
                {
                    // Break any incoming links so the literal takes effect.
                    Pin->BreakAllPinLinks(true);
                    Pin->DefaultValue = bValue ? TEXT("true") : TEXT("false");
                    bHandled = true;
                }
            }
        }
    }

    FBlueprintEditorUtils::MarkBlueprintAsModified(BP);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("transition_id"), Target->GetName());
    Out->SetStringField(TEXT("expression"), Expr);
    Out->SetStringField(TEXT("status"), bHandled ? TEXT("applied") : TEXT("v2_pending"));
    if (!bHandled)
    {
        Out->SetStringField(TEXT("hint"),
            TEXT("Only literal 'true'/'false' expressions are supported in v1. Expression-graph wiring is deferred to v2."));
    }
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPAnimationHandler::Compile(const TSharedPtr<FJsonObject>& P)
{
    FString Path;
    if (!P.IsValid() || !P->TryGetStringField(TEXT("path"), Path))
        return FHaybaHandlerResult::Err(TEXT("anim_blueprint_compile: missing path"));
    UAnimBlueprint* BP = LoadAnimBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(TEXT("anim_blueprint_compile: anim blueprint not found"));

    FCompilerResultsLog ResultsLog;
    ResultsLog.SetSourcePath(BP->GetPathName());
    ResultsLog.BeginEvent(TEXT("Compile"));
    FKismetEditorUtilities::CompileBlueprint(BP, EBlueprintCompileOptions::None, &ResultsLog);
    ResultsLog.EndEvent();

    const bool bOk = (BP->Status == BS_UpToDate || BP->Status == BS_UpToDateWithWarnings);

    TArray<TSharedPtr<FJsonValue>> Errors, Warnings;
    FString FirstError;
    for (const TSharedRef<FTokenizedMessage>& Msg : ResultsLog.Messages)
    {
        const FString Text = Msg->ToText().ToString();
        const EMessageSeverity::Type Sev = Msg->GetSeverity();
        if (Sev == EMessageSeverity::Error)
        {
            if (FirstError.IsEmpty()) FirstError = Text;
            Errors.Add(MakeShared<FJsonValueString>(Text));
        }
        else if (Sev == EMessageSeverity::Warning)
        {
            Warnings.Add(MakeShared<FJsonValueString>(Text));
        }
    }

    UE_LOG(LogHaybaMCPAnim, Warning,
        TEXT("AnimBP compile %s: ok=%d errors=%d warnings=%d first=%s"),
        *BP->GetPathName(), bOk ? 1 : 0,
        ResultsLog.NumErrors, ResultsLog.NumWarnings,
        FirstError.IsEmpty() ? TEXT("(none)") : *FirstError);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("ok"), bOk);
    Out->SetBoolField(TEXT("compiled"), bOk);
    Out->SetNumberField(TEXT("status"), (int32)BP->Status);
    Out->SetNumberField(TEXT("error_count"),   ResultsLog.NumErrors);
    Out->SetNumberField(TEXT("warning_count"), ResultsLog.NumWarnings);
    Out->SetNumberField(TEXT("num_errors"),   ResultsLog.NumErrors);
    Out->SetNumberField(TEXT("num_warnings"), ResultsLog.NumWarnings);
    Out->SetArrayField(TEXT("errors"),   Errors);
    Out->SetArrayField(TEXT("warnings"), Warnings);
    return FHaybaHandlerResult::Ok(Out);
}
