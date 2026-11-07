#include "HaybaMCPAnimationHandler.h"
#include "HaybaMCPParams.h"

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
#include "AnimGraphNode_Base.h"
#include "AnimGraphNode_StateResult.h"
#include "K2Node_FunctionEntry.h"
#include "Animation/AnimSequence.h"
#include "Animation/BlendSpace.h"
#include "Animation/BlendSpace1D.h"
#include "Animation/Skeleton.h"
#include "Engine/MemberReference.h"
#include "Misc/Paths.h"
#include "Editor.h"
#include "HaybaBlueprintOps.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPAnim, Log, All);

TArray<FString> FHaybaMCPAnimationHandler::GetCommands() const
{
    return {
        TEXT("anim_blueprint_get_info"),
        TEXT("anim_blueprint_add_state"),
        TEXT("anim_blueprint_add_transition"),
        TEXT("anim_blueprint_set_condition"),
        TEXT("anim_blueprint_compile"),
        TEXT("anim_blueprint_add_node_function"),
        TEXT("anim_graph_node_bind_function"),
        TEXT("blendspace_set_samples"),
    };
}

FHaybaHandlerResult FHaybaMCPAnimationHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& P)
{
    if (Cmd == TEXT("anim_blueprint_get_info"))      return GetInfo(P);
    if (Cmd == TEXT("anim_blueprint_add_state"))     return AddState(P);
    if (Cmd == TEXT("anim_blueprint_add_transition")) return AddTransition(P);
    if (Cmd == TEXT("anim_blueprint_set_condition"))  return SetCondition(P);
    if (Cmd == TEXT("anim_blueprint_compile"))       return Compile(P);
    // These compile or resample assets that a running PIE's anim instances evaluate on worker threads.
    if ((Cmd == TEXT("anim_blueprint_add_node_function") || Cmd == TEXT("anim_graph_node_bind_function")
         || Cmd == TEXT("blendspace_set_samples")) && GEditor && GEditor->IsPlaySessionInProgress())
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("%s: a Play-In-Editor session is running; stop it (editor_stop_pie) first. Nothing was changed."), *Cmd));
    if (Cmd == TEXT("anim_blueprint_add_node_function")) return AddNodeFunction(P);
    if (Cmd == TEXT("anim_graph_node_bind_function"))    return BindNodeFunction(P);
    if (Cmd == TEXT("blendspace_set_samples"))           return BlendSpaceSetSamples(P);
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
    FHaybaParamReader ParamR(P, TEXT("anim_blueprint_add_state"));
    SMName = ParamR.RequiredString(TEXT("state_machine_name"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());
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
    // UE 5.7: EAnimStateType::AST_State was removed; the enum now has only
    // AST_SingleAnimation and AST_BlendGraph. We always allocate a bound
    // sub-graph below, so AST_BlendGraph is the correct replacement.
    StateNode->StateType = EAnimStateType::AST_BlendGraph;
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
    FHaybaParamReader ParamR(P, TEXT("anim_blueprint_add_transition"));
    FromName = ParamR.RequiredString(TEXT("from_state"));
    ToName = ParamR.RequiredString(TEXT("to_state"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

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
    FHaybaParamReader ParamR(P, TEXT("anim_blueprint_set_condition"));
    Expr = ParamR.RequiredString(TEXT("condition_expression"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

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

/** Compile BP and write compiled / status / error_count / warning_count / errors / warnings into Out. */
static bool HaybaCompileAnimBP(UAnimBlueprint* BP, const TSharedPtr<FJsonObject>& Out)
{
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

    Out->SetBoolField(TEXT("compiled"), bOk);
    Out->SetNumberField(TEXT("status"), (int32)BP->Status);
    Out->SetNumberField(TEXT("error_count"),   ResultsLog.NumErrors);
    Out->SetNumberField(TEXT("warning_count"), ResultsLog.NumWarnings);
    Out->SetArrayField(TEXT("errors"),   Errors);
    Out->SetArrayField(TEXT("warnings"), Warnings);
    return bOk;
}

FHaybaHandlerResult FHaybaMCPAnimationHandler::Compile(const TSharedPtr<FJsonObject>& P)
{
    FString Path;
    if (!P.IsValid() || !P->TryGetStringField(TEXT("path"), Path))
        return FHaybaHandlerResult::Err(TEXT("anim_blueprint_compile: missing path"));
    UAnimBlueprint* BP = LoadAnimBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(TEXT("anim_blueprint_compile: anim blueprint not found"));

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    const bool bOk = HaybaCompileAnimBP(BP, Out);
    Out->SetBoolField(TEXT("ok"), bOk);
    Out->SetNumberField(TEXT("num_errors"),   Out->GetNumberField(TEXT("error_count")));
    Out->SetNumberField(TEXT("num_warnings"), Out->GetNumberField(TEXT("warning_count")));
    return FHaybaHandlerResult::Ok(Out);
}

// ---------------------------------------------------------------------------
// Anim node functions. An anim graph node's On Initial Update / On Become Relevant / On Update (and a state result's
// On State Entry ...) is an FMemberReference to a function whose signature matches the property's PrototypeFunction,
// (const FAnimUpdateContext&, const FAnimNodeReference&), and that carries BlueprintThreadSafe. Editor Python reaches
// neither the const-ref signature, FKismetUserDeclaredFunctionMetadata::bThreadSafe, nor the member reference.
// ---------------------------------------------------------------------------

static const TCHAR* const GHaybaAnimUpdatePrototype =
    TEXT("/Script/AnimGraphRuntime.AnimExecutionContextLibrary.Prototype_ThreadSafeAnimUpdateCall");

/** "StateFullyBlendedInFunction" -> "state_fully_blended_in": the slot names callers pass. */
static FString HaybaFunctionSlotName(const FString& PropertyName)
{
    FString Base = PropertyName;
    Base.RemoveFromEnd(TEXT("Function"));
    FString Out;
    for (int32 I = 0; I < Base.Len(); ++I)
    {
        if (I > 0 && FChar::IsUpper(Base[I])) Out += TEXT("_");
        Out += FChar::ToLower(Base[I]);
    }
    return Out;
}

/** Entry pins of a function graph as {name, type, by_ref, const}, so callers can see the signature they got. */
static TArray<TSharedPtr<FJsonValue>> HaybaEntryPins(UEdGraph* Graph, UK2Node_FunctionEntry*& OutEntry)
{
    TArray<TSharedPtr<FJsonValue>> Pins;
    OutEntry = nullptr;
    for (UEdGraphNode* N : Graph->Nodes)
        if ((OutEntry = Cast<UK2Node_FunctionEntry>(N)) != nullptr) break;
    if (!OutEntry) return Pins;
    for (const UEdGraphPin* Pin : OutEntry->Pins)
    {
        if (!Pin || Pin->Direction != EGPD_Output || Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_Exec) continue;
        TSharedPtr<FJsonObject> O = MakeShared<FJsonObject>();
        O->SetStringField(TEXT("name"), Pin->PinName.ToString());
        O->SetStringField(TEXT("type"), Pin->PinType.PinSubCategoryObject.IsValid()
            ? Pin->PinType.PinSubCategoryObject->GetPathName() : Pin->PinType.PinCategory.ToString());
        O->SetBoolField(TEXT("by_ref"), Pin->PinType.bIsReference);
        O->SetBoolField(TEXT("const"), Pin->PinType.bIsConst);
        Pins.Add(MakeShared<FJsonValueObject>(O));
    }
    return Pins;
}

FHaybaHandlerResult FHaybaMCPAnimationHandler::AddNodeFunction(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader R(P, TEXT("anim_blueprint_add_node_function"));
    const FString Path = R.RequiredString(TEXT("path"));
    const FString Name = R.RequiredString(TEXT("name"), 256);
    if (R.HasErrors()) return FHaybaHandlerResult::Err(R.ErrorMessage());

    UAnimBlueprint* BP = LoadAnimBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(TEXT("anim_blueprint_add_node_function: anim blueprint not found"));
    {
        TArray<UEdGraph*> Graphs;
        BP->GetAllGraphs(Graphs);
        TArray<FString> Names;
        for (const UEdGraph* G : Graphs) if (G) Names.Add(G->GetName());
        const FString Conflict = HaybaBlueprintOps::FunctionNameConflict(Names, Name);
        if (!Conflict.IsEmpty())
            return FHaybaHandlerResult::Err(Conflict.Replace(TEXT("blueprint_add_function"), TEXT("anim_blueprint_add_node_function")));
    }
    UFunction* Prototype = FindObject<UFunction>(nullptr, GHaybaAnimUpdatePrototype);
    if (!Prototype)
        return FHaybaHandlerResult::Err(TEXT("anim_blueprint_add_node_function: the engine prototype Prototype_ThreadSafeAnimUpdateCall is not loaded (AnimGraphRuntime). Nothing was changed."));

    // The details panel's "Create Binding" (BlueprintMemberReferenceCustomization.cpp): a user function graph whose
    // entry pins are copied from the prototype, then marked thread safe.
    UEdGraph* Graph = FBlueprintEditorUtils::CreateNewGraph(BP, FName(*Name), UEdGraph::StaticClass(), UEdGraphSchema_K2::StaticClass());
    if (!Graph) return FHaybaHandlerResult::Err(TEXT("anim_blueprint_add_node_function: CreateNewGraph failed. Nothing was changed."));
    FBlueprintEditorUtils::AddFunctionGraph(BP, Graph, /*bIsUserCreated*/ true, Prototype);

    UK2Node_FunctionEntry* Entry = nullptr;
    const TArray<TSharedPtr<FJsonValue>> Pins = HaybaEntryPins(Graph, Entry);
    if (Entry)
    {
        Entry->Modify();
        Entry->MetaData.bThreadSafe = true;
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    const bool bClean = HaybaCompileAnimBP(BP, Out);
    Out->SetStringField(TEXT("function_name"), Graph->GetName());
    Out->SetStringField(TEXT("graph"), Graph->GetName());
    Out->SetStringField(TEXT("entry_node_id"), Entry ? Entry->NodeGuid.ToString() : FString());
    Out->SetArrayField(TEXT("inputs"), Pins);
    Out->SetBoolField(TEXT("thread_safe"), Entry && Entry->MetaData.bThreadSafe);
    // Read back from the compiled skeleton class, the one a binding resolves against.
    const UFunction* Compiled = BP->SkeletonGeneratedClass ? BP->SkeletonGeneratedClass->FindFunctionByName(Graph->GetFName()) : nullptr;
    const bool bCompatible = Compiled && Prototype->IsSignatureCompatibleWith(Compiled)
        && FBlueprintEditorUtils::HasFunctionBlueprintThreadSafeMetaData(Compiled);
    Out->SetBoolField(TEXT("bindable"), bCompatible);
    Out->SetBoolField(TEXT("verified"), bClean && bCompatible && Pins.Num() == 2);
    Out->SetBoolField(TEXT("dirty"), BP->GetOutermost()->IsDirty());
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPAnimationHandler::BindNodeFunction(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader R(P, TEXT("anim_graph_node_bind_function"));
    const FString Path = R.RequiredString(TEXT("path"));
    const FString NodeKey = R.RequiredString(TEXT("node"), 512);
    const FString Slot = R.RequiredString(TEXT("slot"), 128);
    const FString FunctionName = R.RequiredString(TEXT("function"), 256);
    const FString GraphName = R.OptionalString(TEXT("graph_name"));
    if (R.HasErrors()) return FHaybaHandlerResult::Err(R.ErrorMessage());

    UAnimBlueprint* BP = LoadAnimBPByPath(Path);
    if (!BP) return FHaybaHandlerResult::Err(TEXT("anim_graph_node_bind_function: anim blueprint not found"));

    // The node: an anim graph node by GUID or object name, or a state by name (its bindings live on its result node).
    TArray<UEdGraph*> Graphs;
    BP->GetAllGraphs(Graphs);
    TArray<UAnimGraphNode_Base*> Matches;
    for (UEdGraph* G : Graphs)
    {
        if (!G || (!GraphName.IsEmpty() && !G->GetName().Equals(GraphName, ESearchCase::IgnoreCase))) continue;
        for (UEdGraphNode* N : G->Nodes)
        {
            if (!N) continue;
            const bool bKey = N->NodeGuid.ToString().Equals(NodeKey, ESearchCase::IgnoreCase)
                || N->GetName().Equals(NodeKey, ESearchCase::IgnoreCase);
            if (UAnimGraphNode_Base* A = Cast<UAnimGraphNode_Base>(N))
            {
                if (bKey) Matches.AddUnique(A);
            }
            else if (UAnimStateNode* S = Cast<UAnimStateNode>(N))
            {
                if (bKey || S->GetStateName().Equals(NodeKey, ESearchCase::IgnoreCase))
                    if (UAnimGraphNode_StateResult* Result = S->GetResultNodeInsideState()) Matches.AddUnique(Result);
            }
        }
    }
    if (Matches.Num() == 0)
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("anim_graph_node_bind_function: no anim graph node or state '%s'%s. Node GUIDs come from blueprint_inspect_graph (graph_name = the AnimGraph, a state machine or a state); a state can be named directly. Nothing was changed."),
            *NodeKey, GraphName.IsEmpty() ? TEXT("") : *FString::Printf(TEXT(" in graph '%s'"), *GraphName)));
    if (Matches.Num() > 1)
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("anim_graph_node_bind_function: '%s' matches %d nodes; pass graph_name or the node GUID. Nothing was changed."),
            *NodeKey, Matches.Num()));
    UAnimGraphNode_Base* Node = Matches[0];

    FStructProperty* SlotProp = nullptr;
    TArray<FString> Slots;
    for (TFieldIterator<FStructProperty> It(Node->GetClass()); It; ++It)
    {
        if (It->Struct->GetFName() != TEXT("MemberReference") // FMemberReference::StaticStruct() is not exported
            || !It->HasMetaData(TEXT("FunctionReference"))) continue;
        Slots.Add(HaybaFunctionSlotName(It->GetName()));
        if (Slots.Last().Equals(Slot, ESearchCase::IgnoreCase)) SlotProp = *It;
    }
    if (!SlotProp)
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("anim_graph_node_bind_function: %s has no slot '%s'. Its slots: %s. Nothing was changed."),
            *Node->GetClass()->GetName(), *Slot, *FString::Join(Slots, TEXT(", "))));

    UClass* Skeleton = BP->SkeletonGeneratedClass;
    UFunction* Fn = Skeleton ? Skeleton->FindFunctionByName(FName(*FunctionName)) : nullptr;
    if (!Fn)
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("anim_graph_node_bind_function: '%s' is not a function of the compiled blueprint. Create it with anim_blueprint_add_node_function (or compile after adding it). Nothing was changed."),
            *FunctionName));
    // The compiler's own checks (UAnimGraphNode_Base::ValidateFunctionRef), refused here instead of after the edit.
    const FString PrototypeName = SlotProp->GetMetaData(TEXT("PrototypeFunction"));
    const UFunction* Prototype = PrototypeName.IsEmpty() ? nullptr : FindObject<UFunction>(nullptr, *PrototypeName);
    const bool bSignatureOk = !Prototype || Prototype->IsSignatureCompatibleWith(Fn);
    const bool bThreadSafe = FBlueprintEditorUtils::HasFunctionBlueprintThreadSafeMetaData(Fn);
    if (!bSignatureOk || !bThreadSafe)
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("anim_graph_node_bind_function: '%s' cannot be bound to %s:%s%s. The compiler would report it. Make it with anim_blueprint_add_node_function, or blueprint_add_function with thread_safe:true and inputs Context (struct:/Script/Engine.AnimUpdateContext) and Node (struct:/Script/Engine.AnimNodeReference), both by_ref and const. Nothing was changed."),
            *FunctionName, *Slot,
            bSignatureOk ? TEXT("") : TEXT(" its signature is not (const FAnimUpdateContext& Context, const FAnimNodeReference& Node);"),
            bThreadSafe ? TEXT("") : TEXT(" it is not thread safe;")));

    // PostEditChangeProperty below can regenerate the skeleton class, so Fn is not read after the edit.
    const FName FnName = Fn->GetFName();
    Node->Modify();
    FMemberReference* Ref = SlotProp->ContainerPtrToValuePtr<FMemberReference>(Node);
    const bool bSelfContext = Fn->GetOwnerClass() && Skeleton->IsChildOf(Fn->GetOwnerClass());
    Ref->SetFromField<UFunction>(Fn, bSelfContext);
    FPropertyChangedEvent Changed(SlotProp, EPropertyChangeType::ValueSet);
    Node->PostEditChangeProperty(Changed);
    FBlueprintEditorUtils::MarkBlueprintAsModified(BP);
    const bool bSet = Ref->GetMemberName() == FnName;

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    const bool bClean = HaybaCompileAnimBP(BP, Out);
    const bool bResolves = Ref->ResolveMember<UFunction>(BP->SkeletonGeneratedClass) != nullptr;
    Out->SetStringField(TEXT("node_id"), Node->NodeGuid.ToString());
    Out->SetStringField(TEXT("node_class"), Node->GetClass()->GetName());
    Out->SetStringField(TEXT("graph"), Node->GetGraph() ? Node->GetGraph()->GetName() : FString());
    Out->SetStringField(TEXT("slot"), HaybaFunctionSlotName(SlotProp->GetName()));
    Out->SetStringField(TEXT("property"), SlotProp->GetName());
    Out->SetStringField(TEXT("bound_function"), Ref->GetMemberName().ToString());
    Out->SetBoolField(TEXT("resolves_after_compile"), bResolves);
    Out->SetBoolField(TEXT("verified"), bSet && bResolves && bClean);
    Out->SetBoolField(TEXT("dirty"), BP->GetOutermost()->IsDirty());
    return FHaybaHandlerResult::Ok(Out);
}

/** Load by object path, or by package path "/Game/X/BS" -> "/Game/X/BS.BS". */
template <typename T>
static T* HaybaLoadAsset(const FString& Path)
{
    if (T* Obj = LoadObject<T>(nullptr, *Path)) return Obj;
    if (Path.Contains(TEXT("."))) return nullptr;
    return LoadObject<T>(nullptr, *(Path + TEXT(".") + FPaths::GetBaseFilename(Path)));
}

FHaybaHandlerResult FHaybaMCPAnimationHandler::BlendSpaceSetSamples(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader R(P, TEXT("blendspace_set_samples"));
    const FString Path = R.RequiredString(TEXT("path"));
    const TArray<TSharedPtr<FJsonValue>>* SampleList = R.RequiredArray(TEXT("samples"), 1, 256);
    const TArray<TSharedPtr<FJsonValue>>* AxisList = R.OptionalArray(TEXT("axes"), 2);
    if (R.HasErrors()) return FHaybaHandlerResult::Err(R.ErrorMessage());

    UBlendSpace* BS = HaybaLoadAsset<UBlendSpace>(Path);
    if (!BS) return FHaybaHandlerResult::Err(FString::Printf(TEXT("blendspace_set_samples: no blend space at '%s'"), *Path));
    const bool b1D = BS->IsA<UBlendSpace1D>();
    const int32 AxisCount = b1D ? 1 : 2;
    auto Fail = [](const FString& Why) { return FHaybaHandlerResult::Err(TEXT("blendspace_set_samples: ") + Why + TEXT(" Nothing was changed.")); };

    // Validate everything before the first edit: the engine's AddSample silently widens the axes or drops a sample.
    TArray<FBlendParameter> Axes;
    for (int32 I = 0; I < 3; ++I) Axes.Add(BS->GetBlendParameter(I));
    if (AxisList)
    {
        if (AxisList->Num() > AxisCount)
            return Fail(FString::Printf(TEXT("this is a %s blend space; it has %d axis entr%s, got %d."),
                b1D ? TEXT("1D") : TEXT("2D"), AxisCount, AxisCount == 1 ? TEXT("y") : TEXT("ies"), AxisList->Num()));
        for (int32 I = 0; I < AxisList->Num(); ++I)
        {
            const TSharedPtr<FJsonObject>* A = nullptr;
            if (!(*AxisList)[I].IsValid() || !(*AxisList)[I]->TryGetObject(A)) return Fail(TEXT("each axes entry must be an object."));
            FString Name;
            double Value = 0.0;
            if ((*A)->TryGetStringField(TEXT("name"), Name)) Axes[I].DisplayName = Name;
            if ((*A)->TryGetNumberField(TEXT("min"), Value)) Axes[I].Min = (float)Value;
            if ((*A)->TryGetNumberField(TEXT("max"), Value)) Axes[I].Max = (float)Value;
            if ((*A)->TryGetNumberField(TEXT("grid_divisions"), Value)) Axes[I].GridNum = (int32)Value;
            if (!(Axes[I].Min < Axes[I].Max) || Axes[I].GridNum < 1)
                return Fail(FString::Printf(TEXT("axis %d needs min < max and grid_divisions >= 1 (got %g..%g, %d)."),
                    I, Axes[I].Min, Axes[I].Max, Axes[I].GridNum));
        }
    }
    struct FSampleIn { UAnimSequence* Anim; FVector Value; };
    TArray<FSampleIn> Samples;
    for (int32 I = 0; I < SampleList->Num(); ++I)
    {
        const TSharedPtr<FJsonObject>* S = nullptr;
        FString AnimPath;
        double X = 0.0, Y = 0.0;
        if (!(*SampleList)[I].IsValid() || !(*SampleList)[I]->TryGetObject(S) || !(*S)->TryGetStringField(TEXT("anim"), AnimPath)
            || !(*S)->TryGetNumberField(TEXT("x"), X))
            return Fail(FString::Printf(TEXT("samples[%d] needs anim and x."), I));
        if (!(*S)->TryGetNumberField(TEXT("y"), Y) && !b1D)
            return Fail(FString::Printf(TEXT("samples[%d] needs y on a 2D blend space."), I));
        UAnimSequence* Anim = HaybaLoadAsset<UAnimSequence>(AnimPath);
        if (!Anim) return Fail(FString::Printf(TEXT("samples[%d]: no animation sequence at '%s'."), I, *AnimPath));
        if (!BS->IsAnimationCompatibleWithSkeleton(Anim))
            return Fail(FString::Printf(TEXT("samples[%d]: '%s' is for skeleton %s; this blend space uses %s."), I, *AnimPath,
                Anim->GetSkeleton() ? *Anim->GetSkeleton()->GetPathName() : TEXT("(none)"),
                BS->GetSkeleton() ? *BS->GetSkeleton()->GetPathName() : TEXT("(none)")));
        if (!BS->IsAnimationCompatible(Anim) || (Samples.Num() > 0 && Anim->AdditiveAnimType != Samples[0].Anim->AdditiveAnimType))
            return Fail(FString::Printf(TEXT("samples[%d]: '%s' has an additive type the other samples or this blend space do not share."), I, *AnimPath));
        const FVector Value(X, b1D ? 0.0 : Y, 0.0);
        for (int32 Axis = 0; Axis < AxisCount && AxisList; ++Axis)
            if (Value[Axis] < Axes[Axis].Min || Value[Axis] > Axes[Axis].Max)
                return Fail(FString::Printf(TEXT("samples[%d] lies outside axis %d (%g..%g)."), I, Axis, Axes[Axis].Min, Axes[Axis].Max));
        for (const FSampleIn& Prev : Samples)
            if (Prev.Value.Equals(Value)) return Fail(FString::Printf(TEXT("samples[%d] repeats the position of an earlier sample."), I));
        Samples.Add({ Anim, Value });
    }

    FStructProperty* AxesProp = FindFProperty<FStructProperty>(UBlendSpace::StaticClass(), TEXT("BlendParameters"));
    if (AxisList && !AxesProp) return Fail(TEXT("this engine has no UBlendSpace::BlendParameters property."));

    BS->Modify();
    const TArray<FBlendSample> OldSamples = BS->GetBlendSamples();
    TArray<FBlendParameter> OldAxes;
    for (int32 I = 0; I < 3; ++I) OldAxes.Add(BS->GetBlendParameter(I));
    auto Apply = [BS, AxesProp](const TArray<FBlendParameter>& NewAxes, const TArray<FSampleIn>& NewSamples) -> int32
    {
        for (int32 I = BS->GetNumberOfBlendSamples() - 1; I >= 0; --I) BS->DeleteSample(I);
        if (AxesProp)
            for (int32 I = 0; I < 3; ++I) *AxesProp->ContainerPtrToValuePtr<FBlendParameter>(BS, I) = NewAxes[I];
        for (int32 I = 0; I < NewSamples.Num(); ++I)
            if (BS->AddSample(NewSamples[I].Anim, NewSamples[I].Value) == INDEX_NONE) return I;
        return INDEX_NONE;
    };
    const int32 Refused = Apply(Axes, Samples);
    if (Refused != INDEX_NONE)
    {
        TArray<FSampleIn> Old;
        for (const FBlendSample& S : OldSamples) Old.Add({ S.Animation.Get(), S.SampleValue });
        Apply(OldAxes, Old);
    }
    BS->ValidateSampleData();
    BS->ResampleData();
    BS->PostEditChange();
    BS->MarkPackageDirty();
    if (Refused != INDEX_NONE)
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("blendspace_set_samples: the engine refused samples[%d] (too close to another sample, or an invalid animation); the previous samples and axes were restored."),
            Refused));

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("path"), BS->GetPathName());
    Out->SetStringField(TEXT("kind"), b1D ? TEXT("1d") : TEXT("2d"));
    TArray<TSharedPtr<FJsonValue>> SamplesOut;
    for (const FBlendSample& S : BS->GetBlendSamples())
    {
        TSharedPtr<FJsonObject> O = MakeShared<FJsonObject>();
        O->SetStringField(TEXT("anim"), S.Animation ? S.Animation->GetPathName() : FString());
        O->SetNumberField(TEXT("x"), S.SampleValue.X);
        O->SetNumberField(TEXT("y"), S.SampleValue.Y);
        O->SetBoolField(TEXT("valid"), S.bIsValid);
        SamplesOut.Add(MakeShared<FJsonValueObject>(O));
    }
    TArray<TSharedPtr<FJsonValue>> AxesOut;
    for (int32 I = 0; I < AxisCount; ++I)
    {
        const FBlendParameter& A = BS->GetBlendParameter(I);
        TSharedPtr<FJsonObject> O = MakeShared<FJsonObject>();
        O->SetStringField(TEXT("name"), A.DisplayName);
        O->SetNumberField(TEXT("min"), A.Min);
        O->SetNumberField(TEXT("max"), A.Max);
        O->SetNumberField(TEXT("grid_divisions"), A.GridNum);
        AxesOut.Add(MakeShared<FJsonValueObject>(O));
    }
    Out->SetArrayField(TEXT("samples"), SamplesOut);
    Out->SetNumberField(TEXT("sample_count"), SamplesOut.Num());
    Out->SetArrayField(TEXT("axes"), AxesOut);
    Out->SetBoolField(TEXT("verified"), SamplesOut.Num() == Samples.Num());
    Out->SetBoolField(TEXT("dirty"), BS->GetOutermost()->IsDirty());
    return FHaybaHandlerResult::Ok(Out);
}
