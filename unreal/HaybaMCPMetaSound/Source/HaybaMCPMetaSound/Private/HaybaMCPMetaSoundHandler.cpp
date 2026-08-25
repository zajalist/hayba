#include "HaybaMCPMetaSoundHandler.h"
#include "Json.h"
#include "AssetToolsModule.h"
#include "IAssetTools.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/ARFilter.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "Misc/PackageName.h"
#include "UObject/UObjectGlobals.h"
#include "MetasoundSource.h"
#include "Metasound.h"
#include "MetasoundAssetBase.h"
#include "MetasoundAssetManager.h"
#include "MetasoundBuilderSubsystem.h"
#include "MetasoundBuilderBase.h"
#include "MetasoundDocumentBuilderRegistry.h"
#include "MetasoundDocumentInterface.h"
#include "MetasoundFrontendDocument.h"
#include "MetasoundFrontendNodeClassRegistry.h"
#include "MetasoundGlobals.h"
#include "Misc/DataValidation.h"
#include "UObject/SavePackage.h"

#if WITH_EDITOR
#include "MetasoundFactory.h"
#endif

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPMetaSound, Log, All);

namespace
{
    // Commands execute on the editor game thread. These are deliberately
    // conservative ceilings: an untrusted MCP caller must not be able to turn
    // one request into unbounded graph construction, compilation, or JSON.
    constexpr int32 MaxPathChars = 1024;
    constexpr int32 MaxNameChars = 256;
    constexpr int32 MaxLiteralChars = 65536;
    constexpr int32 MaxGraphPages = 64;
    constexpr int32 MaxGraphNodes = 4096;
    constexpr int32 MaxGraphEdges = 16384;
    constexpr int32 MaxGraphVertices = 65536;
    constexpr int32 MaxInspectNodes = 512;
    constexpr int32 MaxInspectEdges = 2048;
    constexpr int32 MaxInspectVertices = 8192;
    constexpr int32 MaxValidationIssues = 256;
    constexpr int32 MaxDiagnosticChars = 2048;

    struct FNodeVertexKey
    {
        FGuid NodeID;
        FGuid VertexID;

        bool operator==(const FNodeVertexKey& Other) const
        {
            return NodeID == Other.NodeID && VertexID == Other.VertexID;
        }

        friend uint32 GetTypeHash(const FNodeVertexKey& Key)
        {
            return HashCombine(GetTypeHash(Key.NodeID), GetTypeHash(Key.VertexID));
        }
    };

    bool IsBoundedNonEmpty(const FString& Value, int32 MaxChars = MaxNameChars)
    {
        return !Value.IsEmpty() && Value.Len() <= MaxChars;
    }

    bool IsGameContentPath(const FString& Path)
    {
        // Creation and enumeration are intentionally confined to project
        // content. FPackageName::IsValidLongPackageName also accepts mounted
        // engine/plugin roots, which made a payload claiming to target
        // `/Game` capable of writing into `/Engine` when permissions allowed.
        return (Path == TEXT("/Game") || Path.StartsWith(TEXT("/Game/")))
            && FPackageName::IsValidLongPackageName(Path);
    }
}

TArray<FString> FHaybaMCPMetaSoundHandler::GetCommands() const
{
    return {
        TEXT("metasound_create"),
        TEXT("metasound_add_node"),
        TEXT("metasound_connect"),
        TEXT("metasound_set_input"),
        TEXT("metasound_compile"),
        TEXT("metasound_inspect"),
        TEXT("metasound_list")
    };
}

static FString NormalizeAssetPath(FString Path)
{
    Path.TrimStartAndEndInline();
    if (Path.StartsWith(TEXT("MetaSoundSource'")) || Path.StartsWith(TEXT("MetaSoundPatch'")))
    {
        int32 Quote = INDEX_NONE;
        Path.FindChar(TEXT('\''), Quote);
        Path = Path.Mid(Quote + 1);
        Path.RemoveFromEnd(TEXT("'"));
    }
    if (!Path.Contains(TEXT(".")) && Path.StartsWith(TEXT("/")))
    {
        Path += TEXT(".") + FPackageName::GetShortName(Path);
    }
    return Path;
}

static bool IsGraphWithinLimits(const FMetasoundFrontendDocument& Doc, FString& OutError);

static UObject* LoadMetaSound(
    const TSharedPtr<FJsonObject>& P,
    FString& OutPath,
    FString& OutError,
    bool bRequireGameContent = false)
{
    if (!P.IsValid())
    {
        OutError = TEXT("missing metasound_path");
        return nullptr;
    }
    const bool bHasCanonicalPath = P->HasField(TEXT("metasound_path"));
    const TCHAR* PathField = bHasCanonicalPath ? TEXT("metasound_path") : TEXT("path");
    if (!P->HasField(PathField) || !P->TryGetStringField(PathField, OutPath) || OutPath.IsEmpty())
    {
        OutError = FString::Printf(TEXT("%s must be a non-empty string"), PathField);
        return nullptr;
    }
    if (OutPath.Len() > MaxPathChars)
    {
        OutError = TEXT("metasound_path is too long");
        return nullptr;
    }
    OutPath = NormalizeAssetPath(OutPath);
    if (!FPackageName::IsValidObjectPath(OutPath))
    {
        OutError = TEXT("metasound_path must be a valid Unreal object path");
        return nullptr;
    }
    if (bRequireGameContent
        && !IsGameContentPath(FPackageName::ObjectPathToPackageName(OutPath)))
    {
        OutError = TEXT("metasound_path must reference project content under /Game for mutation");
        return nullptr;
    }
    UObject* Asset = LoadObject<UObject>(nullptr, *OutPath);
    if (!Asset || (!Asset->IsA<UMetaSoundSource>() && !Asset->IsA<UMetaSoundPatch>()))
    {
        OutError = FString::Printf(TEXT("MetaSound asset not found: %s"), *OutPath);
        return nullptr;
    }
    IMetaSoundDocumentInterface* Document = Cast<IMetaSoundDocumentInterface>(Asset);
    if (!Document)
    {
        OutError = TEXT("MetaSound document interface unavailable");
        return nullptr;
    }
    // FDocumentBuilderRegistry::FindOrBeginBuilding reaches a checkf on this
    // value after it has already begun constructing a transient builder. A
    // corrupt or partially migrated asset is untrusted input too: reject it
    // here rather than letting an MCP read/edit command terminate the editor.
    const FMetasoundFrontendDocument& ConstDocument = Document->GetConstDocument();
    if (!ConstDocument.RootGraph.Metadata.GetClassName().IsValid())
    {
        OutError = TEXT("MetaSound document has an invalid root graph class name; open and resave or migrate the asset in the MetaSound editor before using MCP graph commands");
        return nullptr;
    }
    // GetConstDefaultGraph() is a checked lookup in UE. Every builder path can
    // fall back to it when the selected platform page is absent, so a corrupt
    // document without the mandatory default page must be stopped here.
    if (!ConstDocument.RootGraph.FindConstGraph(Metasound::Frontend::DefaultPageID))
    {
        OutError = TEXT("MetaSound document has no default graph page; open and resave or migrate the asset in the MetaSound editor before using MCP graph commands");
        return nullptr;
    }
    FString LimitError;
    if (!IsGraphWithinLimits(ConstDocument, LimitError))
    {
        OutError = LimitError;
        return nullptr;
    }
    return Asset;
}

static UMetaSoundBuilderBase* AttachBuilder(UObject& Asset)
{
#if WITH_EDITORONLY_DATA
    // The subsystem AttachBuilderToAssetChecked seam was removed in UE 5.8.
    // The engine-owned document registry is the supported lifecycle owner in
    // both 5.7 and 5.8 and reuses an active builder when one already exists.
    // Its public implementation contains check() calls for every condition
    // below. An MCP request must turn violated preconditions into an ordinary
    // error rather than crossing an assertion boundary in engine code.
    if (!IsInGameThread() || !Asset.IsAsset()
        || !Cast<IMetaSoundDocumentInterface>(&Asset)
        || !Metasound::Frontend::IDocumentBuilderRegistry::Get())
    {
        return nullptr;
    }
    return &Metasound::Engine::FDocumentBuilderRegistry::GetChecked().FindOrBeginBuilding<>(Asset);
#else
    return nullptr;
#endif
}

static const FMetasoundFrontendGraph* GetActiveGraph(const UMetaSoundBuilderBase& Builder)
{
    const FMetaSoundFrontendDocumentBuilder& DocBuilder = Builder.GetConstBuilder();
    if (!DocBuilder.IsValid()) return nullptr;
    const FMetasoundFrontendDocument& Doc = DocBuilder.GetConstDocumentChecked();
    // Mutations must target exactly the page selected by the builder. Falling
    // back to DefaultPageID here would validate node IDs on one graph and then
    // let the engine's checked builder lookup mutate another (missing) page.
    return Doc.RootGraph.FindConstGraph(DocBuilder.GetBuildPageID());
}

static bool GraphContainsNode(const FMetasoundFrontendGraph& Graph, const FGuid& NodeID)
{
    return Graph.Nodes.ContainsByPredicate([&NodeID](const FMetasoundFrontendNode& Node)
    {
        return Node.GetID() == NodeID;
    });
}

static bool IsGraphWithinLimits(const FMetasoundFrontendDocument& Doc, FString& OutError)
{
    const TArray<FMetasoundFrontendGraph>& Pages = Doc.RootGraph.GetConstGraphPages();
    if (Pages.Num() > MaxGraphPages)
    {
        OutError = FString::Printf(TEXT("graph has %d pages; limit is %d"), Pages.Num(), MaxGraphPages);
        return false;
    }
    int64 Nodes = 0;
    int64 Edges = 0;
    int64 Vertices = 0;
    for (const FMetasoundFrontendGraph& Page : Pages)
    {
        Nodes += Page.Nodes.Num();
        Edges += Page.Edges.Num();
        for (const FMetasoundFrontendNode& Node : Page.Nodes)
        {
            Vertices += Node.Interface.Inputs.Num();
            Vertices += Node.Interface.Outputs.Num();
        }
        if (Nodes > MaxGraphNodes || Edges > MaxGraphEdges || Vertices > MaxGraphVertices)
        {
            OutError = FString::Printf(
                TEXT("graph is too large to process safely (%lld nodes, %lld edges, %lld vertices; limits %d/%d/%d)"),
                Nodes, Edges, Vertices, MaxGraphNodes, MaxGraphEdges, MaxGraphVertices);
            return false;
        }

        // UMetaSoundBuilderBase::ConnectNodes has checkf calls while replacing
        // an existing edge: it assumes the old edge's nodes and pins still
        // exist. Corrupt/mid-migration assets can violate that assumption, so
        // validate the stored topology before any MCP mutation reaches it.
        TSet<FGuid> NodeIDs;
        TSet<FNodeVertexKey> InputVertices;
        TSet<FNodeVertexKey> OutputVertices;
        for (const FMetasoundFrontendNode& Node : Page.Nodes)
        {
            const FGuid& NodeID = Node.GetID();
            if (!NodeID.IsValid() || NodeIDs.Contains(NodeID))
            {
                OutError = TEXT("graph contains an invalid or duplicate node ID; open and resave or migrate the asset in the MetaSound editor");
                return false;
            }
            NodeIDs.Add(NodeID);
            for (const FMetasoundFrontendVertex& Vertex : Node.Interface.Inputs)
            {
                const FNodeVertexKey Key { NodeID, Vertex.VertexID };
                if (!Vertex.VertexID.IsValid() || InputVertices.Contains(Key))
                {
                    OutError = TEXT("graph contains an invalid or duplicate input pin ID; open and resave or migrate the asset in the MetaSound editor");
                    return false;
                }
                InputVertices.Add(Key);
            }
            for (const FMetasoundFrontendVertex& Vertex : Node.Interface.Outputs)
            {
                const FNodeVertexKey Key { NodeID, Vertex.VertexID };
                if (!Vertex.VertexID.IsValid() || OutputVertices.Contains(Key))
                {
                    OutError = TEXT("graph contains an invalid or duplicate output pin ID; open and resave or migrate the asset in the MetaSound editor");
                    return false;
                }
                OutputVertices.Add(Key);
            }
        }

        TSet<FNodeVertexKey> ConnectedInputs;
        for (const FMetasoundFrontendEdge& Edge : Page.Edges)
        {
            const FNodeVertexKey From { Edge.FromNodeID, Edge.FromVertexID };
            const FNodeVertexKey To { Edge.ToNodeID, Edge.ToVertexID };
            if (!OutputVertices.Contains(From) || !InputVertices.Contains(To))
            {
                OutError = TEXT("graph contains an edge whose node or pin no longer exists; open and resave or migrate the asset in the MetaSound editor");
                return false;
            }
            if (ConnectedInputs.Contains(To))
            {
                OutError = TEXT("graph contains multiple edges to one input pin; open and resave or migrate the asset in the MetaSound editor");
                return false;
            }
            ConnectedInputs.Add(To);
        }
    }
    return true;
}

static bool ParseGuidField(const TSharedPtr<FJsonObject>& P, const TCHAR* Field, FGuid& Out)
{
    FString Value;
    return P.IsValid() && P->TryGetStringField(Field, Value) && Value.Len() <= 64 && FGuid::Parse(Value, Out);
}

static FMetasoundFrontendLiteral JsonLiteral(const TSharedPtr<FJsonObject>& P, const TCHAR* Field, const FString& Type, bool& bOk)
{
    FMetasoundFrontendLiteral Literal;
    bOk = true;
    if (Type.Equals(TEXT("float"), ESearchCase::IgnoreCase))
    {
        double V = 0.0;
        bOk = P.IsValid() && P->TryGetNumberField(Field, V) && FMath::IsFinite(V)
            && V >= -static_cast<double>(MAX_flt) && V <= static_cast<double>(MAX_flt);
        if (bOk) Literal.Set(static_cast<float>(V));
    }
    else if (Type.Equals(TEXT("int"), ESearchCase::IgnoreCase) || Type.Equals(TEXT("int32"), ESearchCase::IgnoreCase))
    {
        double V = 0.0;
        bOk = P.IsValid() && P->TryGetNumberField(Field, V) && FMath::IsFinite(V)
            && FMath::FloorToDouble(V) == V
            && V >= static_cast<double>(MIN_int32) && V <= static_cast<double>(MAX_int32);
        if (bOk) Literal.Set(static_cast<int32>(V));
    }
    else if (Type.Equals(TEXT("bool"), ESearchCase::IgnoreCase))
    {
        bool V = false; bOk = P->TryGetBoolField(Field, V); Literal.Set(V);
    }
    else if (Type.Equals(TEXT("string"), ESearchCase::IgnoreCase))
    {
        FString V; bOk = P.IsValid() && P->TryGetStringField(Field, V) && V.Len() <= MaxLiteralChars; if (bOk) Literal.Set(V);
    }
    else
    {
        bOk = false;
    }
    return Literal;
}

static FHaybaHandlerResult MSAddNode(const TSharedPtr<FJsonObject>& P)
{
    FString Path, Error, Namespace, Name, Variant;
    UObject* Asset = LoadMetaSound(P, Path, Error, /*bRequireGameContent=*/true);
    if (!Asset) return FHaybaHandlerResult::Err(TEXT("metasound_add_node: ") + Error);
    if (!P->TryGetStringField(TEXT("class_name"), Name) || !IsBoundedNonEmpty(Name)) return FHaybaHandlerResult::Err(TEXT("metasound_add_node: class_name is missing or too long"));
    if (P->HasField(TEXT("namespace")) && !P->TryGetStringField(TEXT("namespace"), Namespace))
        return FHaybaHandlerResult::Err(TEXT("metasound_add_node: namespace must be a string"));
    if (P->HasField(TEXT("variant")) && !P->TryGetStringField(TEXT("variant"), Variant))
        return FHaybaHandlerResult::Err(TEXT("metasound_add_node: variant must be a string"));
    if (Namespace.IsEmpty()) Namespace = TEXT("UE");
    if (!IsBoundedNonEmpty(Namespace) || Variant.Len() > MaxNameChars) return FHaybaHandlerResult::Err(TEXT("metasound_add_node: namespace or variant is too long"));
    int32 Major = 1;
    if (P->HasField(TEXT("major_version")))
    {
        double RawMajor = 0.0;
        if (!P->TryGetNumberField(TEXT("major_version"), RawMajor)
            || !FMath::IsFinite(RawMajor)
            || FMath::FloorToDouble(RawMajor) != RawMajor
            || RawMajor < 1.0 || RawMajor > 1024.0)
        {
            return FHaybaHandlerResult::Err(TEXT("metasound_add_node: major_version must be an integer between 1 and 1024"));
        }
        Major = static_cast<int32>(RawMajor);
    }
    // AddNodeByClassName reaches INodeClassRegistry::GetChecked(). A request
    // can race module startup/shutdown, where that is an editor-terminating
    // assertion rather than a recoverable lookup failure.
    if (!Metasound::Frontend::INodeClassRegistry::Get())
        return FHaybaHandlerResult::Err(TEXT("metasound_add_node: node class registry is unavailable; wait for MetaSound startup to finish and retry"));
    UMetaSoundBuilderBase* Builder = AttachBuilder(*Asset);
    if (!Builder) return FHaybaHandlerResult::Err(TEXT("metasound_add_node: builder subsystem unavailable"));
    const FMetasoundFrontendGraph* ActiveGraph = GetActiveGraph(*Builder);
    if (!ActiveGraph) return FHaybaHandlerResult::Err(TEXT("metasound_add_node: active graph unavailable"));
    if (ActiveGraph->Nodes.Num() >= MaxGraphNodes) return FHaybaHandlerResult::Err(TEXT("metasound_add_node: graph node limit reached"));
    EMetaSoundBuilderResult Result = EMetaSoundBuilderResult::Failed;
    FMetaSoundNodeHandle Node = Builder->AddNodeByClassName(FMetasoundFrontendClassName(*Namespace, *Name, *Variant), Result, Major);
    if (Result != EMetaSoundBuilderResult::Succeeded || !Node.IsSet()) return FHaybaHandlerResult::Err(TEXT("metasound_add_node: class not registered or incompatible"));
    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("path"), Asset->GetPathName()); Out->SetStringField(TEXT("node_id"), Node.NodeID.ToString(EGuidFormats::DigitsWithHyphens)); Out->SetBoolField(TEXT("dirty"), true);
    Asset->MarkPackageDirty();
    return FHaybaHandlerResult::Ok(Out);
}

static FHaybaHandlerResult MSConnect(const TSharedPtr<FJsonObject>& P)
{
    FString Path, Error, OutputName, InputName; FGuid FromID, ToID;
    UObject* Asset = LoadMetaSound(P, Path, Error, /*bRequireGameContent=*/true);
    if (!Asset) return FHaybaHandlerResult::Err(TEXT("metasound_connect: ") + Error);
    if (!ParseGuidField(P, TEXT("from_node_id"), FromID) || !ParseGuidField(P, TEXT("to_node_id"), ToID) || !P->TryGetStringField(TEXT("output_name"), OutputName) || !P->TryGetStringField(TEXT("input_name"), InputName) || !IsBoundedNonEmpty(OutputName) || !IsBoundedNonEmpty(InputName))
        return FHaybaHandlerResult::Err(TEXT("metasound_connect: requires from_node_id, output_name, to_node_id, input_name"));
    UMetaSoundBuilderBase* Builder = AttachBuilder(*Asset); EMetaSoundBuilderResult Result = EMetaSoundBuilderResult::Failed;
    if (!Builder) return FHaybaHandlerResult::Err(TEXT("metasound_connect: builder unavailable"));
    const FMetasoundFrontendGraph* ActiveGraph = GetActiveGraph(*Builder);
    if (!ActiveGraph) return FHaybaHandlerResult::Err(TEXT("metasound_connect: active graph unavailable"));
    if (ActiveGraph->Edges.Num() >= MaxGraphEdges) return FHaybaHandlerResult::Err(TEXT("metasound_connect: graph edge limit reached"));
    if (!GraphContainsNode(*ActiveGraph, FromID)) return FHaybaHandlerResult::Err(TEXT("metasound_connect: from_node_id is not present on the active graph page; call metasound_inspect for current node IDs"));
    if (!GraphContainsNode(*ActiveGraph, ToID)) return FHaybaHandlerResult::Err(TEXT("metasound_connect: to_node_id is not present on the active graph page; call metasound_inspect for current node IDs"));
    Builder->ConnectNodes(FMetaSoundNodeHandle(FromID), *OutputName, FMetaSoundNodeHandle(ToID), *InputName, Result);
    if (Result != EMetaSoundBuilderResult::Succeeded) return FHaybaHandlerResult::Err(TEXT("metasound_connect: pins missing, incompatible, or already connected"));
    Asset->MarkPackageDirty(); TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>(); Out->SetBoolField(TEXT("connected"), true); Out->SetBoolField(TEXT("dirty"), true); return FHaybaHandlerResult::Ok(Out);
}

static FHaybaHandlerResult MSSetInput(const TSharedPtr<FJsonObject>& P)
{
    FString Path, Error, InputName, Type = TEXT("float"); UObject* Asset = LoadMetaSound(P, Path, Error, /*bRequireGameContent=*/true);
    if (!Asset) return FHaybaHandlerResult::Err(TEXT("metasound_set_input: ") + Error);
    if (!P->TryGetStringField(TEXT("input_name"), InputName) || !IsBoundedNonEmpty(InputName)) return FHaybaHandlerResult::Err(TEXT("metasound_set_input: input_name is missing or too long"));
    if (P->HasField(TEXT("type")) && !P->TryGetStringField(TEXT("type"), Type))
        return FHaybaHandlerResult::Err(TEXT("metasound_set_input: type must be a string"));
    if (!IsBoundedNonEmpty(Type, 32)) return FHaybaHandlerResult::Err(TEXT("metasound_set_input: type is too long"));
    bool bLiteral = false; FMetasoundFrontendLiteral Literal = JsonLiteral(P, TEXT("value"), Type, bLiteral);
    if (!bLiteral) return FHaybaHandlerResult::Err(TEXT("metasound_set_input: value missing or unsupported type (float, int32, bool, string)"));
    FGuid NodeID;
    const bool bHasNodeID = P->HasField(TEXT("node_id"));
    if (bHasNodeID && !ParseGuidField(P, TEXT("node_id"), NodeID))
    {
        return FHaybaHandlerResult::Err(TEXT("metasound_set_input: node_id must be a valid GUID when supplied"));
    }
    UMetaSoundBuilderBase* Builder = AttachBuilder(*Asset); EMetaSoundBuilderResult Result = EMetaSoundBuilderResult::Failed;
    if (!Builder) return FHaybaHandlerResult::Err(TEXT("metasound_set_input: builder unavailable"));
    if (bHasNodeID)
    {
        const FMetasoundFrontendGraph* ActiveGraph = GetActiveGraph(*Builder);
        if (!ActiveGraph) return FHaybaHandlerResult::Err(TEXT("metasound_set_input: active graph unavailable"));
        if (!GraphContainsNode(*ActiveGraph, NodeID)) return FHaybaHandlerResult::Err(TEXT("metasound_set_input: node_id is not present on the active graph page; call metasound_inspect for current node IDs"));
        FMetaSoundBuilderNodeInputHandle Input = Builder->FindNodeInputByName(FMetaSoundNodeHandle(NodeID), *InputName, Result);
        if (Result == EMetaSoundBuilderResult::Succeeded) Builder->SetNodeInputDefault(Input, Literal, Result);
    }
    else Builder->SetGraphInputDefault(*InputName, Literal, Result);
    if (Result != EMetaSoundBuilderResult::Succeeded) return FHaybaHandlerResult::Err(TEXT("metasound_set_input: input missing or type mismatch"));
    Asset->MarkPackageDirty(); TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>(); Out->SetStringField(TEXT("input_name"), InputName); Out->SetStringField(TEXT("type"), Type); Out->SetBoolField(TEXT("dirty"), true); return FHaybaHandlerResult::Ok(Out);
}

static FHaybaHandlerResult MSInspect(const TSharedPtr<FJsonObject>& P)
{
    FString Path, Error; UObject* Asset = LoadMetaSound(P, Path, Error);
    if (!Asset) return FHaybaHandlerResult::Err(TEXT("metasound_inspect: ") + Error);
    UMetaSoundBuilderBase* Builder = AttachBuilder(*Asset);
    if (!Builder) return FHaybaHandlerResult::Err(TEXT("metasound_inspect: builder unavailable"));

    // In UE 5.8, graph mutations target the builder's selected graph page.
    // RootGraph.Graph is a legacy field and remains empty, which made this
    // command report zero nodes immediately after metasound_add_node returned
    // success. Read the same active document and page that mutations use.
    const FMetaSoundFrontendDocumentBuilder& DocBuilder = Builder->GetConstBuilder();
    if (!DocBuilder.IsValid()) return FHaybaHandlerResult::Err(TEXT("metasound_inspect: active document is invalid"));
    const FMetasoundFrontendDocument& Doc = DocBuilder.GetConstDocumentChecked();
    const FGuid RequestedPageID = DocBuilder.GetBuildPageID();
    FGuid ResolvedPageID = RequestedPageID;
    const FMetasoundFrontendGraph* Graph = Doc.RootGraph.FindConstGraph(RequestedPageID);
    bool bPageFallback = false;
    if (!Graph)
    {
        ResolvedPageID = Metasound::Frontend::DefaultPageID;
        Graph = Doc.RootGraph.FindConstGraph(ResolvedPageID);
        bPageFallback = Graph != nullptr;
    }
    if (!Graph) return FHaybaHandlerResult::Err(TEXT("metasound_inspect: default graph page became unavailable; retry after the MetaSound editor finishes updating the asset"));
    FString LimitError;
    if (!IsGraphWithinLimits(Doc, LimitError))
        return FHaybaHandlerResult::Err(TEXT("metasound_inspect: ") + LimitError);

    TArray<TSharedPtr<FJsonValue>> Nodes, Edges;
    bool bTruncated = false;
    int32 VerticesEmitted = 0;
    for (const FMetasoundFrontendNode& Node : Graph->Nodes)
    {
        if (Nodes.Num() >= MaxInspectNodes) { bTruncated = true; break; }
        TSharedPtr<FJsonObject> J = MakeShared<FJsonObject>(); J->SetStringField(TEXT("node_id"), Node.GetID().ToString(EGuidFormats::DigitsWithHyphens)); J->SetStringField(TEXT("name"), Node.Name.ToString());
        TArray<TSharedPtr<FJsonValue>> Inputs, Outputs;
        for (const FMetasoundFrontendVertex& V : Node.Interface.Inputs) { if (VerticesEmitted >= MaxInspectVertices) { bTruncated = true; break; } TSharedPtr<FJsonObject> X=MakeShared<FJsonObject>(); X->SetStringField(TEXT("name"),V.Name.ToString()); X->SetStringField(TEXT("type"),V.TypeName.ToString()); Inputs.Add(MakeShared<FJsonValueObject>(X.ToSharedRef())); ++VerticesEmitted; }
        for (const FMetasoundFrontendVertex& V : Node.Interface.Outputs) { if (VerticesEmitted >= MaxInspectVertices) { bTruncated = true; break; } TSharedPtr<FJsonObject> X=MakeShared<FJsonObject>(); X->SetStringField(TEXT("name"),V.Name.ToString()); X->SetStringField(TEXT("type"),V.TypeName.ToString()); Outputs.Add(MakeShared<FJsonValueObject>(X.ToSharedRef())); ++VerticesEmitted; }
        J->SetArrayField(TEXT("inputs"), Inputs); J->SetArrayField(TEXT("outputs"), Outputs); Nodes.Add(MakeShared<FJsonValueObject>(J.ToSharedRef()));
    }
    for (const FMetasoundFrontendEdge& Edge : Graph->Edges) { if (Edges.Num() >= MaxInspectEdges) { bTruncated = true; break; } TSharedPtr<FJsonObject> J=MakeShared<FJsonObject>(); J->SetStringField(TEXT("from_node_id"),Edge.FromNodeID.ToString()); J->SetStringField(TEXT("to_node_id"),Edge.ToNodeID.ToString()); Edges.Add(MakeShared<FJsonValueObject>(J.ToSharedRef())); }
    TSharedPtr<FJsonObject> Out=MakeShared<FJsonObject>(); Out->SetStringField(TEXT("path"),Asset->GetPathName()); Out->SetStringField(TEXT("class"),Asset->GetClass()->GetName()); Out->SetStringField(TEXT("page_id"),ResolvedPageID.ToString(EGuidFormats::DigitsWithHyphens)); Out->SetBoolField(TEXT("page_fallback"),bPageFallback); if (bPageFallback) { Out->SetStringField(TEXT("requested_page_id"),RequestedPageID.ToString(EGuidFormats::DigitsWithHyphens)); TArray<TSharedPtr<FJsonValue>> PageWarnings; PageWarnings.Add(MakeShared<FJsonValueString>(TEXT("The builder-selected graph page is missing; inspection fell back to DefaultPageID. Mutations and compile are blocked until the asset is repaired or resaved."))); Out->SetArrayField(TEXT("warnings"),PageWarnings); } Out->SetArrayField(TEXT("nodes"),Nodes); Out->SetArrayField(TEXT("edges"),Edges); Out->SetNumberField(TEXT("node_count"),Graph->Nodes.Num()); Out->SetNumberField(TEXT("edge_count"),Graph->Edges.Num()); Out->SetBoolField(TEXT("truncated"),bTruncated || Graph->Nodes.Num() > Nodes.Num() || Graph->Edges.Num() > Edges.Num()); Out->SetBoolField(TEXT("dirty"),Asset->GetOutermost()->IsDirty()); return FHaybaHandlerResult::Ok(Out);
}

static FHaybaHandlerResult MSCompile(const TSharedPtr<FJsonObject>& P)
{
    bool bSave = true;
    if (P.IsValid() && P->HasField(TEXT("save")))
    {
        // Check the declared JSON type, not just whether a read succeeds.
        // UE converts "yes", "on", "1" and "true" to a boolean, so
        // TryGetBoolField reports SUCCESS for save:"yes" and this guard never
        // fired -- a string silently decided whether the asset was written.
        const TSharedPtr<FJsonValue> Field = P->TryGetField(TEXT("save"));
        if (!Field.IsValid() || Field->Type != EJson::Boolean)
            return FHaybaHandlerResult::Err(TEXT("metasound_compile: save must be a boolean"));
        if (!P->TryGetBoolField(TEXT("save"), bSave))
            return FHaybaHandlerResult::Err(TEXT("metasound_compile: save must be a boolean"));
    }
    FString Path, Error; UObject* Asset = LoadMetaSound(P, Path, Error, /*bRequireGameContent=*/true); if (!Asset) return FHaybaHandlerResult::Err(TEXT("metasound_compile: ") + Error);
    UMetaSoundBuilderBase* Builder=AttachBuilder(*Asset); if (!Builder) return FHaybaHandlerResult::Err(TEXT("metasound_compile: builder unavailable"));
    const FMetaSoundFrontendDocumentBuilder& DocBuilder = Builder->GetConstBuilder();
    if (!DocBuilder.IsValid()) return FHaybaHandlerResult::Err(TEXT("metasound_compile: active document is invalid"));
    const FMetasoundFrontendDocument& Doc = DocBuilder.GetConstDocumentChecked();
    const FGuid BuildPageID = DocBuilder.GetBuildPageID();
    if (!Doc.RootGraph.FindConstGraph(BuildPageID))
        return FHaybaHandlerResult::Err(TEXT("metasound_compile: builder-selected graph page is missing; open and resave or migrate the asset before compiling"));
    FString LimitError;
    if (!IsGraphWithinLimits(Doc, LimitError)) return FHaybaHandlerResult::Err(TEXT("metasound_compile: ") + LimitError);
    // The engine registration implementation uses checkf here, not a
    // recoverable error. Check before InitNodeLocations/conformance so a
    // rejected commandlet request is also mutation-free.
    if (!Metasound::CanEverExecuteGraph())
        return FHaybaHandlerResult::Err(TEXT("metasound_compile: runtime graph execution is unavailable in this editor process; run the command in a normal audio-capable editor session"));
    // UpdateAndRegisterForExecution uses IMetaSoundAssetManager::GetChecked().
    // During module startup/shutdown that is an assertion boundary, not a
    // recoverable failure. A TCP request can race those lifecycle edges, so
    // check the nullable accessor before crossing into engine registration.
    if (!Metasound::Frontend::IMetaSoundAssetManager::Get())
        return FHaybaHandlerResult::Err(TEXT("metasound_compile: MetaSound asset manager is unavailable; wait for editor startup to finish and retry"));

    FDataValidationContext ValidationContext;
    const EDataValidationResult ValidationResult = Asset->IsDataValid(ValidationContext);
    TArray<FString> ValidationErrors;
    TArray<TSharedPtr<FJsonValue>> ValidationWarnings;
    int32 IssueCount = 0;
    for (const FDataValidationContext::FIssue& Issue : ValidationContext.GetIssues())
    {
        if (IssueCount++ >= MaxValidationIssues) break;
        const FString Message = Issue.Message.ToString().Left(MaxDiagnosticChars);
        if (Issue.Severity == EMessageSeverity::Error) ValidationErrors.Add(Message);
        else if (Issue.Severity == EMessageSeverity::Warning) ValidationWarnings.Add(MakeShared<FJsonValueString>(Message));
    }
    if (ValidationResult == EDataValidationResult::Invalid || !ValidationErrors.IsEmpty())
    {
        const FString Details = ValidationErrors.IsEmpty()
            ? TEXT("asset validation returned Invalid without a diagnostic; inspect the editor log")
            : FString::Join(ValidationErrors, TEXT("; "));
        return FHaybaHandlerResult::Err(TEXT("metasound_compile: validation failed: ") + Details);
    }

    // UpdateAndRegisterForExecution is the engine's real compile boundary. It
    // transforms editor-only template nodes on a local document copy before
    // creating the runtime graph; calling FGraphBuilder::CreateGraph directly
    // on an editor document rejects valid UE.Input.Template nodes.
    // ConformObjectToDocument() is NOT validation: its bool only says whether
    // UObject-side data changed. The former implementation exposed that bool
    // as `valid`, so an unchanged valid graph came back ok:true, valid:false.
    Builder->InitNodeLocations();
    const bool bConformed = Builder->ConformObjectToDocument();
    FMetasoundAssetBase* MetaSoundAsset = nullptr;
    if (UMetaSoundSource* Source = Cast<UMetaSoundSource>(Asset)) MetaSoundAsset = static_cast<FMetasoundAssetBase*>(Source);
    else if (UMetaSoundPatch* Patch = Cast<UMetaSoundPatch>(Asset)) MetaSoundAsset = static_cast<FMetasoundAssetBase*>(Patch);
    if (!MetaSoundAsset) return FHaybaHandlerResult::Err(TEXT("metasound_compile: asset registry interface unavailable"));
    Metasound::Frontend::FMetaSoundAssetRegistrationOptions RegistrationOptions;
    // Compile exactly the page the editor/builder is authoring. A fallback can
    // register a different graph successfully while the requested page remains
    // corrupt, turning a false success into a later checked-lookup crash.
    TArray<FGuid> PageOrder({ BuildPageID });
    RegistrationOptions.PageOrder = PageOrder;
    MetaSoundAsset->UpdateAndRegisterForExecution(RegistrationOptions);
    if (!MetaSoundAsset->GetGraphRegistryKey().IsValid())
        return FHaybaHandlerResult::Err(TEXT("metasound_compile: runtime graph registration failed; see the editor log for node-level diagnostics"));
    Asset->MarkPackageDirty();
    bool bSaved=false;
    if (bSave) { UPackage* Package=Asset->GetOutermost(); const FString Filename=FPackageName::LongPackageNameToFilename(Package->GetName(),FPackageName::GetAssetPackageExtension()); FSavePackageArgs Args; Args.TopLevelFlags=RF_Public|RF_Standalone; bSaved=UPackage::SavePackage(Package,Asset,*Filename,Args); if(!bSaved) return FHaybaHandlerResult::Err(TEXT("metasound_compile: validation passed but SavePackage failed")); }
    TSharedPtr<FJsonObject> Out=MakeShared<FJsonObject>(); Out->SetBoolField(TEXT("valid"),true); Out->SetBoolField(TEXT("conformed_object_data"),bConformed); Out->SetBoolField(TEXT("saved"),bSaved); Out->SetStringField(TEXT("path"),Asset->GetPathName()); Out->SetArrayField(TEXT("warnings"),ValidationWarnings); return FHaybaHandlerResult::Ok(Out);
}

static FHaybaHandlerResult MSCreate(const TSharedPtr<FJsonObject>& P)
{
#if WITH_EDITOR
    FString PkgPath, Name;
    if (!P.IsValid()) return FHaybaHandlerResult::Err(TEXT("metasound_create: missing params"));
    if (!P->TryGetStringField(TEXT("package_path"), PkgPath) || PkgPath.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("metasound_create: missing package_path"));
    if (!P->TryGetStringField(TEXT("name"), Name) || Name.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("metasound_create: missing name"));
    if (PkgPath.Len() > MaxPathChars || !IsBoundedNonEmpty(Name))
        return FHaybaHandlerResult::Err(TEXT("metasound_create: package_path or name is too long"));

    FAssetToolsModule* AssetToolsModule = FModuleManager::LoadModulePtr<FAssetToolsModule>(TEXT("AssetTools"));
    if (!AssetToolsModule)
        return FHaybaHandlerResult::Err(TEXT("metasound_create: AssetTools module unavailable"));
    IAssetTools& Tools = AssetToolsModule->Get();
    UMetaSoundSourceFactory* Factory = NewObject<UMetaSoundSourceFactory>();
    if (!Factory)
        return FHaybaHandlerResult::Err(TEXT("metasound_create: source factory unavailable"));
    // Accept the intuitive folder spelling (/Game/Audio) and the historic
    // full intended asset path (/Game/Audio/MS_Name).
    FString Dir = FPackageName::GetShortName(PkgPath).Equals(Name)
        ? FPackageName::GetLongPackagePath(PkgPath)
        : PkgPath;
    if (!IsGameContentPath(Dir))
        return FHaybaHandlerResult::Err(TEXT("metasound_create: package_path must be a /Game folder or full intended asset path"));
    const FString ObjectPath = FString::Printf(TEXT("%s/%s.%s"), *Dir, *Name, *Name);
    if (!FPackageName::IsValidObjectPath(ObjectPath))
        return FHaybaHandlerResult::Err(TEXT("metasound_create: name does not form a valid Unreal object path"));
    UObject* Created = Tools.CreateAsset(Name, Dir, UMetaSoundSource::StaticClass(), Factory);
    if (!Created) return FHaybaHandlerResult::Err(TEXT("metasound_create: CreateAsset failed"));

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("path"), Created->GetPathName());
    Out->SetStringField(TEXT("name"), Name);
    Out->SetStringField(TEXT("class"), TEXT("MetaSoundSource"));
    return FHaybaHandlerResult::Ok(Out);
#else
    return FHaybaHandlerResult::Err(TEXT("metasound_create: editor-only"));
#endif
}

static FHaybaHandlerResult MSList(const TSharedPtr<FJsonObject>& P)
{
    FString Path = TEXT("/Game");
    if (P.IsValid() && P->HasField(TEXT("path_prefix"))
        && !P->TryGetStringField(TEXT("path_prefix"), Path))
    {
        return FHaybaHandlerResult::Err(TEXT("metasound_list: path_prefix must be a string"));
    }
    if (Path.Len() > MaxPathChars || !IsGameContentPath(Path))
        return FHaybaHandlerResult::Err(TEXT("metasound_list: path_prefix must be a valid bounded /Game path"));

    FAssetRegistryModule* AssetRegistryModule = FModuleManager::LoadModulePtr<FAssetRegistryModule>(TEXT("AssetRegistry"));
    if (!AssetRegistryModule)
        return FHaybaHandlerResult::Err(TEXT("metasound_list: AssetRegistry module unavailable"));
    IAssetRegistry& AR = AssetRegistryModule->Get();
    const int32 Cap = 200;
    TArray<TSharedPtr<FJsonValue>> Out;
    bool bCapped = false;
    FARFilter Filter;
    Filter.PackagePaths.Add(FName(*Path));
    Filter.ClassPaths.Add(UMetaSoundSource::StaticClass()->GetClassPathName());
    Filter.ClassPaths.Add(UMetaSoundPatch::StaticClass()->GetClassPathName());
    Filter.bRecursivePaths = true;
    Filter.bRecursiveClasses = true;
    const bool bEnumerated = AR.EnumerateAssets(Filter, [&Out, &bCapped, Cap](const FAssetData& A)
    {
        if (Out.Num() >= Cap)
        {
            bCapped = true;
            return false;
        }
        TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
        Entry->SetStringField(TEXT("name"),  A.AssetName.ToString());
        Entry->SetStringField(TEXT("path"),  A.GetObjectPathString());
        Entry->SetStringField(TEXT("class"), A.AssetClassPath.GetAssetName().ToString());
        Out.Add(MakeShared<FJsonValueObject>(Entry.ToSharedRef()));
        return true;
    });
    if (!bEnumerated)
        return FHaybaHandlerResult::Err(TEXT("metasound_list: AssetRegistry rejected the path/class filter"));

    TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
    Result->SetArrayField(TEXT("metasounds"), Out);
    Result->SetNumberField(TEXT("count"), Out.Num());
    Result->SetBoolField(TEXT("capped"), bCapped);
    return FHaybaHandlerResult::Ok(Result);
}

FHaybaHandlerResult FHaybaMCPMetaSoundHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& P)
{
    // Builder/asset-registry editor APIs contain check(IsInGameThread()). The
    // central dispatcher currently guarantees this, but the satellite keeps
    // its own boundary so a future direct caller cannot crash the editor.
    if (!IsInGameThread())
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("%s: MetaSound commands must execute on the editor game thread"), *Cmd));

    if (Cmd == TEXT("metasound_create")) return MSCreate(P);
    if (Cmd == TEXT("metasound_list"))   return MSList(P);
    if (Cmd == TEXT("metasound_add_node")) return MSAddNode(P);
    if (Cmd == TEXT("metasound_connect")) return MSConnect(P);
    if (Cmd == TEXT("metasound_set_input")) return MSSetInput(P);
    if (Cmd == TEXT("metasound_compile")) return MSCompile(P);
    if (Cmd == TEXT("metasound_inspect")) return MSInspect(P);

    return FHaybaHandlerResult::Err(FString::Printf(TEXT("MetaSoundHandler: unknown command %s"), *Cmd));
}
