#include "HaybaMCPBehaviorTreeHandler.h"
#include "Json.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "Kismet2/CompilerResultsLog.h"
#include "Logging/TokenizedMessage.h"
#include "Misc/Guid.h"
#include "UObject/UObjectGlobals.h"
#include "BehaviorTree/BehaviorTree.h"
#include "BehaviorTree/BlackboardData.h"
#include "BehaviorTree/BTNode.h"
#include "BehaviorTree/BTCompositeNode.h"
#include "BehaviorTree/BTTaskNode.h"
#include "BehaviorTree/BTDecorator.h"
#include "BehaviorTree/BTService.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPBT, Log, All);

TArray<FString> FHaybaMCPBehaviorTreeHandler::GetCommands() const
{
    return {
        TEXT("bt_get_info"),
        TEXT("bt_add_node"),
        TEXT("bt_connect"),
        TEXT("bt_compile")
    };
}

static UBehaviorTree* LoadBTByPath(const FString& Path)
{
    return LoadObject<UBehaviorTree>(nullptr, *Path);
}

// Stable GUIDs derived from node path within asset. We map UBTNode* <-> FGuid
// using NodeName + outer chain so the same node round-trips across calls.
static FGuid GuidForNode(UBTNode* Node)
{
    if (!Node) return FGuid();
    const FString Key = Node->GetPathName();
    return FGuid::NewDeterministicGuid(Key, 0);
}

static UBTNode* FindNodeByGuidRecursive(UBTNode* Node, const FGuid& Target)
{
    if (!Node) return nullptr;
    if (GuidForNode(Node) == Target) return Node;
    if (UBTCompositeNode* Comp = Cast<UBTCompositeNode>(Node))
    {
        for (const FBTCompositeChild& Child : Comp->Children)
        {
            UBTNode* ChildNode = Child.ChildComposite ? (UBTNode*)Child.ChildComposite : (UBTNode*)Child.ChildTask;
            if (UBTNode* Found = FindNodeByGuidRecursive(ChildNode, Target)) return Found;
        }
    }
    return nullptr;
}

static void WalkNode(UBTNode* Node, UBTNode* Parent, TArray<TSharedPtr<FJsonValue>>& Out)
{
    if (!Node) return;
    TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
    Entry->SetStringField(TEXT("guid"), GuidForNode(Node).ToString(EGuidFormats::DigitsWithHyphens));
    Entry->SetStringField(TEXT("name"), Node->GetNodeName().IsEmpty() ? Node->GetName() : Node->GetNodeName());
    Entry->SetStringField(TEXT("class"), Node->GetClass()->GetPathName());
    Entry->SetStringField(TEXT("parent_guid"),
        Parent ? GuidForNode(Parent).ToString(EGuidFormats::DigitsWithHyphens) : FString());

    TArray<TSharedPtr<FJsonValue>> Children;
    if (UBTCompositeNode* Comp = Cast<UBTCompositeNode>(Node))
    {
        for (const FBTCompositeChild& C : Comp->Children)
        {
            UBTNode* CN = C.ChildComposite ? (UBTNode*)C.ChildComposite : (UBTNode*)C.ChildTask;
            if (CN)
            {
                Children.Add(MakeShared<FJsonValueString>(
                    GuidForNode(CN).ToString(EGuidFormats::DigitsWithHyphens)));
            }
        }
    }
    Entry->SetArrayField(TEXT("children"), Children);
    Out.Add(MakeShared<FJsonValueObject>(Entry.ToSharedRef()));

    if (UBTCompositeNode* Comp = Cast<UBTCompositeNode>(Node))
    {
        for (const FBTCompositeChild& C : Comp->Children)
        {
            UBTNode* CN = C.ChildComposite ? (UBTNode*)C.ChildComposite : (UBTNode*)C.ChildTask;
            WalkNode(CN, Node, Out);
        }
    }
}

static FHaybaHandlerResult BTGetInfo(const TSharedPtr<FJsonObject>& P)
{
    FString Path;
    if (!P->TryGetStringField(TEXT("path"), Path) || Path.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("bt_get_info: missing path"));
    UBehaviorTree* BT = LoadBTByPath(Path);
    if (!BT) return FHaybaHandlerResult::Err(TEXT("bt_get_info: behavior tree not found"));

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("root_class"),
        BT->RootNode ? BT->RootNode->GetClass()->GetPathName() : FString());
    Out->SetStringField(TEXT("blackboard_path"),
        BT->BlackboardAsset ? BT->BlackboardAsset->GetPathName() : FString());

    TArray<TSharedPtr<FJsonValue>> Nodes;
    WalkNode(BT->RootNode, nullptr, Nodes);
    Out->SetArrayField(TEXT("nodes"), Nodes);

    TArray<TSharedPtr<FJsonValue>> Keys;
    if (BT->BlackboardAsset)
    {
        for (const FBlackboardEntry& Key : BT->BlackboardAsset->Keys)
        {
            TSharedPtr<FJsonObject> KObj = MakeShared<FJsonObject>();
            KObj->SetStringField(TEXT("name"), Key.EntryName.ToString());
            KObj->SetStringField(TEXT("type"),
                Key.KeyType ? Key.KeyType->GetClass()->GetName() : TEXT(""));
            Keys.Add(MakeShared<FJsonValueObject>(KObj.ToSharedRef()));
        }
    }
    Out->SetArrayField(TEXT("blackboard_keys"), Keys);
    return FHaybaHandlerResult::Ok(Out);
}

static FHaybaHandlerResult BTAddNode(const TSharedPtr<FJsonObject>& P)
{
    FString Path, ParentGuidStr, Kind, ClassName;
    if (!P->TryGetStringField(TEXT("path"), Path))
        return FHaybaHandlerResult::Err(TEXT("bt_add_node: missing path"));
    if (!P->TryGetStringField(TEXT("node_kind"), Kind))
        return FHaybaHandlerResult::Err(TEXT("bt_add_node: missing node_kind"));
    if (!P->TryGetStringField(TEXT("node_class_name"), ClassName))
        return FHaybaHandlerResult::Err(TEXT("bt_add_node: missing node_class_name"));
    P->TryGetStringField(TEXT("parent_guid"), ParentGuidStr);

    UBehaviorTree* BT = LoadBTByPath(Path);
    if (!BT) return FHaybaHandlerResult::Err(TEXT("bt_add_node: behavior tree not found"));

    // Resolve subclass — accept full path or short name.
    UClass* NodeClass = LoadClass<UBTNode>(nullptr, *ClassName);
    if (!NodeClass)
    {
        NodeClass = FindFirstObjectSafe<UClass>(*ClassName, EFindFirstObjectOptions::ExactClass);
    }
    if (!NodeClass || !NodeClass->IsChildOf(UBTNode::StaticClass()))
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("bt_add_node: class not found or not UBTNode: %s"), *ClassName));

    // Kind/class sanity.
    const FString K = Kind.ToLower();
    if (K == TEXT("composite") && !NodeClass->IsChildOf(UBTCompositeNode::StaticClass()))
        return FHaybaHandlerResult::Err(TEXT("bt_add_node: class is not a composite"));
    if (K == TEXT("task") && !NodeClass->IsChildOf(UBTTaskNode::StaticClass()))
        return FHaybaHandlerResult::Err(TEXT("bt_add_node: class is not a task"));
    if (K == TEXT("decorator") && !NodeClass->IsChildOf(UBTDecorator::StaticClass()))
        return FHaybaHandlerResult::Err(TEXT("bt_add_node: class is not a decorator"));
    if (K == TEXT("service") && !NodeClass->IsChildOf(UBTService::StaticClass()))
        return FHaybaHandlerResult::Err(TEXT("bt_add_node: class is not a service"));

    UBTNode* NewNode = NewObject<UBTNode>(BT, NodeClass, NAME_None, RF_Transactional);
    if (!NewNode) return FHaybaHandlerResult::Err(TEXT("bt_add_node: NewObject failed"));

    // Attach to parent (or set as root if no parent and BT has no root).
    UBTNode* Parent = nullptr;
    if (!ParentGuidStr.IsEmpty())
    {
        FGuid ParentGuid;
        if (!FGuid::Parse(ParentGuidStr, ParentGuid))
            return FHaybaHandlerResult::Err(TEXT("bt_add_node: invalid parent_guid"));
        Parent = FindNodeByGuidRecursive(BT->RootNode, ParentGuid);
        if (!Parent) return FHaybaHandlerResult::Err(TEXT("bt_add_node: parent_guid not found"));
    }

    if (!Parent)
    {
        // Treat as new root — must be composite for a valid BT root.
        if (!NewNode->IsA(UBTCompositeNode::StaticClass()))
            return FHaybaHandlerResult::Err(TEXT("bt_add_node: root must be composite"));
        BT->RootNode = Cast<UBTCompositeNode>(NewNode);
    }
    else
    {
        UBTCompositeNode* ParentComp = Cast<UBTCompositeNode>(Parent);
        if (K == TEXT("decorator"))
        {
            // Decorators attach to a task or composite — store on the composite parent's
            // child entry pointing to the supplied parent if parent is a task.
            if (ParentComp)
            {
                // Attach a "header" decorator: add to the most-recent child's Decorators.
                if (ParentComp->Children.Num() == 0)
                    return FHaybaHandlerResult::Err(TEXT("bt_add_node: composite has no child to decorate"));
                ParentComp->Children.Last().Decorators.Add(Cast<UBTDecorator>(NewNode));
            }
            else
            {
                // Parent is a task — locate its composite parent's child entry.
                return FHaybaHandlerResult::Err(TEXT("bt_add_node: decorator on task requires composite parent — pass composite parent_guid"));
            }
        }
        else if (K == TEXT("service"))
        {
            if (!ParentComp)
                return FHaybaHandlerResult::Err(TEXT("bt_add_node: services require composite parent"));
            ParentComp->Services.Add(Cast<UBTService>(NewNode));
        }
        else // composite or task — append as child
        {
            if (!ParentComp)
                return FHaybaHandlerResult::Err(TEXT("bt_add_node: parent must be composite to add child"));
            FBTCompositeChild Child;
            if (UBTCompositeNode* AsComp = Cast<UBTCompositeNode>(NewNode))
                Child.ChildComposite = AsComp;
            else if (UBTTaskNode* AsTask = Cast<UBTTaskNode>(NewNode))
                Child.ChildTask = AsTask;
            ParentComp->Children.Add(Child);
        }
    }

    BT->MarkPackageDirty();

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("guid"), GuidForNode(NewNode).ToString(EGuidFormats::DigitsWithHyphens));
    Out->SetStringField(TEXT("class"), NodeClass->GetPathName());
    return FHaybaHandlerResult::Ok(Out);
}

static FHaybaHandlerResult BTConnect(const TSharedPtr<FJsonObject>& P)
{
    FString Path, ParentGuidStr, ChildGuidStr;
    if (!P->TryGetStringField(TEXT("path"), Path))
        return FHaybaHandlerResult::Err(TEXT("bt_connect: missing path"));
    if (!P->TryGetStringField(TEXT("parent_guid"), ParentGuidStr))
        return FHaybaHandlerResult::Err(TEXT("bt_connect: missing parent_guid"));
    if (!P->TryGetStringField(TEXT("child_guid"), ChildGuidStr))
        return FHaybaHandlerResult::Err(TEXT("bt_connect: missing child_guid"));

    UBehaviorTree* BT = LoadBTByPath(Path);
    if (!BT || !BT->RootNode) return FHaybaHandlerResult::Err(TEXT("bt_connect: behavior tree / root not found"));

    FGuid ParentGuid, ChildGuid;
    if (!FGuid::Parse(ParentGuidStr, ParentGuid) || !FGuid::Parse(ChildGuidStr, ChildGuid))
        return FHaybaHandlerResult::Err(TEXT("bt_connect: invalid guid"));

    UBTNode* Parent = FindNodeByGuidRecursive(BT->RootNode, ParentGuid);
    UBTNode* Child  = FindNodeByGuidRecursive(BT->RootNode, ChildGuid);
    if (!Parent || !Child)
        return FHaybaHandlerResult::Err(TEXT("bt_connect: parent or child guid not found"));

    UBTCompositeNode* ParentComp = Cast<UBTCompositeNode>(Parent);
    if (!ParentComp)
        return FHaybaHandlerResult::Err(TEXT("bt_connect: parent is not a composite"));

    FBTCompositeChild Entry;
    if (UBTCompositeNode* AsComp = Cast<UBTCompositeNode>(Child))
        Entry.ChildComposite = AsComp;
    else if (UBTTaskNode* AsTask = Cast<UBTTaskNode>(Child))
        Entry.ChildTask = AsTask;
    else
        return FHaybaHandlerResult::Err(TEXT("bt_connect: child must be composite or task"));

    ParentComp->Children.Add(Entry);
    BT->MarkPackageDirty();

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("ok"), true);
    return FHaybaHandlerResult::Ok(Out);
}

static FHaybaHandlerResult BTCompile(const TSharedPtr<FJsonObject>& P)
{
    FString Path;
    if (!P->TryGetStringField(TEXT("path"), Path))
        return FHaybaHandlerResult::Err(TEXT("bt_compile: missing path"));
    UBehaviorTree* BT = LoadBTByPath(Path);
    if (!BT) return FHaybaHandlerResult::Err(TEXT("bt_compile: behavior tree not found"));

    // UBehaviorTree is a UDataAsset, not a UBlueprint — there is no kismet compile.
    // We validate root + children and surface errors/warnings in the Blueprint handler shape.
    TArray<TSharedPtr<FJsonValue>> Errors;
    TArray<TSharedPtr<FJsonValue>> Warnings;

    if (!BT->RootNode)
        Errors.Add(MakeShared<FJsonValueString>(TEXT("Behavior tree has no root node")));
    else if (!BT->BlackboardAsset)
        Warnings.Add(MakeShared<FJsonValueString>(TEXT("Behavior tree has no blackboard asset")));

    // Best-effort: if a generated-class blueprint exists for the BT (rare),
    // run the kismet compile path. Otherwise just mark package dirty + save state.
    if (UBlueprint* BP = Cast<UBlueprint>(BT->GetOuter()))
    {
        FCompilerResultsLog Log;
        Log.SetSourcePath(BP->GetPathName());
        Log.BeginEvent(TEXT("Compile"));
        FKismetEditorUtilities::CompileBlueprint(BP, EBlueprintCompileOptions::None, &Log);
        Log.EndEvent();
        for (const TSharedRef<FTokenizedMessage>& Msg : Log.Messages)
        {
            const FString Text = Msg->ToText().ToString();
            if (Msg->GetSeverity() == EMessageSeverity::Error)
                Errors.Add(MakeShared<FJsonValueString>(Text));
            else if (Msg->GetSeverity() == EMessageSeverity::Warning)
                Warnings.Add(MakeShared<FJsonValueString>(Text));
        }
    }

    BT->MarkPackageDirty();

    const bool bOk = Errors.Num() == 0;
    UE_LOG(LogHaybaMCPBT, Warning,
        TEXT("BT compile %s: ok=%d errors=%d warnings=%d"),
        *BT->GetPathName(), bOk ? 1 : 0, Errors.Num(), Warnings.Num());

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("ok"), bOk);
    Out->SetArrayField(TEXT("errors"), Errors);
    Out->SetArrayField(TEXT("warnings"), Warnings);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPBehaviorTreeHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& P)
{
    if (!P.IsValid()) return FHaybaHandlerResult::Err(TEXT("BehaviorTreeHandler: missing params"));
    if (Cmd == TEXT("bt_get_info"))  return BTGetInfo(P);
    if (Cmd == TEXT("bt_add_node"))  return BTAddNode(P);
    if (Cmd == TEXT("bt_connect"))   return BTConnect(P);
    if (Cmd == TEXT("bt_compile"))   return BTCompile(P);
    return FHaybaHandlerResult::Err(FString::Printf(TEXT("BehaviorTreeHandler: unknown command %s"), *Cmd));
}
