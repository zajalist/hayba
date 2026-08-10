#include "HaybaMCPMetaSoundHandler.h"
#include "Json.h"
#include "AssetToolsModule.h"
#include "IAssetTools.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "Misc/PackageName.h"
#include "UObject/UObjectGlobals.h"
#include "MetasoundSource.h"
#include "Metasound.h"
#include "MetasoundBuilderSubsystem.h"
#include "MetasoundBuilderBase.h"
#include "MetasoundDocumentInterface.h"
#include "MetasoundFrontendDocument.h"
#include "UObject/SavePackage.h"

#if WITH_EDITOR
#include "MetasoundFactory.h"
#endif

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPMetaSound, Log, All);

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

static UObject* LoadMetaSound(const TSharedPtr<FJsonObject>& P, FString& OutPath, FString& OutError)
{
    if (!P.IsValid() || (!P->TryGetStringField(TEXT("metasound_path"), OutPath) && !P->TryGetStringField(TEXT("path"), OutPath)) || OutPath.IsEmpty())
    {
        OutError = TEXT("missing metasound_path");
        return nullptr;
    }
    OutPath = NormalizeAssetPath(OutPath);
    UObject* Asset = LoadObject<UObject>(nullptr, *OutPath);
    if (!Asset || (!Asset->IsA<UMetaSoundSource>() && !Asset->IsA<UMetaSoundPatch>()))
    {
        OutError = FString::Printf(TEXT("MetaSound asset not found: %s"), *OutPath);
        return nullptr;
    }
    return Asset;
}

static UMetaSoundBuilderBase* AttachBuilder(UObject& Asset)
{
    UMetaSoundBuilderSubsystem* Subsystem = GEngine ? GEngine->GetEngineSubsystem<UMetaSoundBuilderSubsystem>() : nullptr;
    return Subsystem ? &Subsystem->AttachBuilderToAssetChecked(Asset) : nullptr;
}

static bool ParseGuidField(const TSharedPtr<FJsonObject>& P, const TCHAR* Field, FGuid& Out)
{
    FString Value;
    return P->TryGetStringField(Field, Value) && FGuid::Parse(Value, Out);
}

static FMetasoundFrontendLiteral JsonLiteral(const TSharedPtr<FJsonObject>& P, const TCHAR* Field, const FString& Type, bool& bOk)
{
    FMetasoundFrontendLiteral Literal;
    bOk = true;
    if (Type.Equals(TEXT("float"), ESearchCase::IgnoreCase))
    {
        double V = 0.0; bOk = P->TryGetNumberField(Field, V); Literal.Set(static_cast<float>(V));
    }
    else if (Type.Equals(TEXT("int"), ESearchCase::IgnoreCase) || Type.Equals(TEXT("int32"), ESearchCase::IgnoreCase))
    {
        int32 V = 0; bOk = P->TryGetNumberField(Field, V); Literal.Set(V);
    }
    else if (Type.Equals(TEXT("bool"), ESearchCase::IgnoreCase))
    {
        bool V = false; bOk = P->TryGetBoolField(Field, V); Literal.Set(V);
    }
    else if (Type.Equals(TEXT("string"), ESearchCase::IgnoreCase))
    {
        FString V; bOk = P->TryGetStringField(Field, V); Literal.Set(V);
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
    UObject* Asset = LoadMetaSound(P, Path, Error);
    if (!Asset) return FHaybaHandlerResult::Err(TEXT("metasound_add_node: ") + Error);
    if (!P->TryGetStringField(TEXT("class_name"), Name) || Name.IsEmpty()) return FHaybaHandlerResult::Err(TEXT("metasound_add_node: missing class_name"));
    P->TryGetStringField(TEXT("namespace"), Namespace); P->TryGetStringField(TEXT("variant"), Variant);
    if (Namespace.IsEmpty()) Namespace = TEXT("UE");
    int32 Major = 1; P->TryGetNumberField(TEXT("major_version"), Major);
    UMetaSoundBuilderBase* Builder = AttachBuilder(*Asset);
    if (!Builder) return FHaybaHandlerResult::Err(TEXT("metasound_add_node: builder subsystem unavailable"));
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
    UObject* Asset = LoadMetaSound(P, Path, Error);
    if (!Asset) return FHaybaHandlerResult::Err(TEXT("metasound_connect: ") + Error);
    if (!ParseGuidField(P, TEXT("from_node_id"), FromID) || !ParseGuidField(P, TEXT("to_node_id"), ToID) || !P->TryGetStringField(TEXT("output_name"), OutputName) || !P->TryGetStringField(TEXT("input_name"), InputName))
        return FHaybaHandlerResult::Err(TEXT("metasound_connect: requires from_node_id, output_name, to_node_id, input_name"));
    UMetaSoundBuilderBase* Builder = AttachBuilder(*Asset); EMetaSoundBuilderResult Result = EMetaSoundBuilderResult::Failed;
    Builder->ConnectNodes(FMetaSoundNodeHandle(FromID), *OutputName, FMetaSoundNodeHandle(ToID), *InputName, Result);
    if (Result != EMetaSoundBuilderResult::Succeeded) return FHaybaHandlerResult::Err(TEXT("metasound_connect: pins missing, incompatible, or already connected"));
    Asset->MarkPackageDirty(); TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>(); Out->SetBoolField(TEXT("connected"), true); Out->SetBoolField(TEXT("dirty"), true); return FHaybaHandlerResult::Ok(Out);
}

static FHaybaHandlerResult MSSetInput(const TSharedPtr<FJsonObject>& P)
{
    FString Path, Error, InputName, Type = TEXT("float"); UObject* Asset = LoadMetaSound(P, Path, Error);
    if (!Asset) return FHaybaHandlerResult::Err(TEXT("metasound_set_input: ") + Error);
    if (!P->TryGetStringField(TEXT("input_name"), InputName) || InputName.IsEmpty()) return FHaybaHandlerResult::Err(TEXT("metasound_set_input: missing input_name"));
    P->TryGetStringField(TEXT("type"), Type); bool bLiteral = false; FMetasoundFrontendLiteral Literal = JsonLiteral(P, TEXT("value"), Type, bLiteral);
    if (!bLiteral) return FHaybaHandlerResult::Err(TEXT("metasound_set_input: value missing or unsupported type (float, int32, bool, string)"));
    UMetaSoundBuilderBase* Builder = AttachBuilder(*Asset); EMetaSoundBuilderResult Result = EMetaSoundBuilderResult::Failed; FGuid NodeID;
    if (ParseGuidField(P, TEXT("node_id"), NodeID))
    {
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
    IMetaSoundDocumentInterface* Interface = Cast<IMetaSoundDocumentInterface>(Asset);
    if (!Interface) return FHaybaHandlerResult::Err(TEXT("metasound_inspect: document interface unavailable"));
    const FMetasoundFrontendDocument& Doc = Interface->GetConstDocument();
    TArray<TSharedPtr<FJsonValue>> Nodes, Edges;
    for (const FMetasoundFrontendNode& Node : Doc.RootGraph.Graph.Nodes)
    {
        TSharedPtr<FJsonObject> J = MakeShared<FJsonObject>(); J->SetStringField(TEXT("node_id"), Node.GetID().ToString(EGuidFormats::DigitsWithHyphens)); J->SetStringField(TEXT("name"), Node.Name.ToString());
        TArray<TSharedPtr<FJsonValue>> Inputs, Outputs;
        for (const FMetasoundFrontendVertex& V : Node.Interface.Inputs) { TSharedPtr<FJsonObject> X=MakeShared<FJsonObject>(); X->SetStringField(TEXT("name"),V.Name.ToString()); X->SetStringField(TEXT("type"),V.TypeName.ToString()); Inputs.Add(MakeShared<FJsonValueObject>(X.ToSharedRef())); }
        for (const FMetasoundFrontendVertex& V : Node.Interface.Outputs) { TSharedPtr<FJsonObject> X=MakeShared<FJsonObject>(); X->SetStringField(TEXT("name"),V.Name.ToString()); X->SetStringField(TEXT("type"),V.TypeName.ToString()); Outputs.Add(MakeShared<FJsonValueObject>(X.ToSharedRef())); }
        J->SetArrayField(TEXT("inputs"), Inputs); J->SetArrayField(TEXT("outputs"), Outputs); Nodes.Add(MakeShared<FJsonValueObject>(J.ToSharedRef()));
    }
    for (const FMetasoundFrontendEdge& Edge : Doc.RootGraph.Graph.Edges) { TSharedPtr<FJsonObject> J=MakeShared<FJsonObject>(); J->SetStringField(TEXT("from_node_id"),Edge.FromNodeID.ToString()); J->SetStringField(TEXT("to_node_id"),Edge.ToNodeID.ToString()); Edges.Add(MakeShared<FJsonValueObject>(J.ToSharedRef())); }
    TSharedPtr<FJsonObject> Out=MakeShared<FJsonObject>(); Out->SetStringField(TEXT("path"),Asset->GetPathName()); Out->SetStringField(TEXT("class"),Asset->GetClass()->GetName()); Out->SetArrayField(TEXT("nodes"),Nodes); Out->SetArrayField(TEXT("edges"),Edges); Out->SetNumberField(TEXT("node_count"),Nodes.Num()); Out->SetNumberField(TEXT("edge_count"),Edges.Num()); Out->SetBoolField(TEXT("dirty"),Asset->GetOutermost()->IsDirty()); return FHaybaHandlerResult::Ok(Out);
}

static FHaybaHandlerResult MSCompile(const TSharedPtr<FJsonObject>& P)
{
    FString Path, Error; UObject* Asset = LoadMetaSound(P, Path, Error); if (!Asset) return FHaybaHandlerResult::Err(TEXT("metasound_compile: ") + Error);
    UMetaSoundBuilderBase* Builder=AttachBuilder(*Asset); if (!Builder) return FHaybaHandlerResult::Err(TEXT("metasound_compile: builder unavailable"));
    Builder->InitNodeLocations(); const bool bConformed=Builder->ConformObjectToDocument(); Asset->MarkPackageDirty();
    bool bSave=true; P->TryGetBoolField(TEXT("save"),bSave); bool bSaved=false;
    if (bSave) { UPackage* Package=Asset->GetOutermost(); const FString Filename=FPackageName::LongPackageNameToFilename(Package->GetName(),FPackageName::GetAssetPackageExtension()); FSavePackageArgs Args; Args.TopLevelFlags=RF_Public|RF_Standalone; bSaved=UPackage::SavePackage(Package,Asset,*Filename,Args); if(!bSaved) return FHaybaHandlerResult::Err(TEXT("metasound_compile: validation passed but SavePackage failed")); }
    TSharedPtr<FJsonObject> Out=MakeShared<FJsonObject>(); Out->SetBoolField(TEXT("valid"),bConformed); Out->SetBoolField(TEXT("saved"),bSaved); Out->SetStringField(TEXT("path"),Asset->GetPathName()); return FHaybaHandlerResult::Ok(Out);
}

static FHaybaHandlerResult MSCreate(const TSharedPtr<FJsonObject>& P)
{
#if WITH_EDITOR
    FString PkgPath, Name;
    if (!P->TryGetStringField(TEXT("package_path"), PkgPath) || PkgPath.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("metasound_create: missing package_path"));
    if (!P->TryGetStringField(TEXT("name"), Name) || Name.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("metasound_create: missing name"));

    IAssetTools& Tools = FModuleManager::LoadModuleChecked<FAssetToolsModule>(TEXT("AssetTools")).Get();
    UMetaSoundSourceFactory* Factory = NewObject<UMetaSoundSourceFactory>();
    // Accept the intuitive folder spelling (/Game/Audio) and the historic
    // full intended asset path (/Game/Audio/MS_Name).
    FString Dir = FPackageName::GetShortName(PkgPath).Equals(Name)
        ? FPackageName::GetLongPackagePath(PkgPath)
        : PkgPath;
    if (!FPackageName::IsValidLongPackageName(Dir))
        return FHaybaHandlerResult::Err(TEXT("metasound_create: package_path must be a /Game folder or full intended asset path"));
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
    if (P.IsValid()) P->TryGetStringField(TEXT("path_prefix"), Path);

    IAssetRegistry& AR = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get();
    TArray<FAssetData> Assets;
    AR.GetAssetsByPath(FName(*Path), Assets, /*Recursive*/true);

    const int32 Cap = 200;
    TArray<TSharedPtr<FJsonValue>> Out;
    bool bCapped = false;
    for (const FAssetData& A : Assets)
    {
        UClass* Cls = A.GetClass();
        if (!Cls) continue;
        const bool bIsSource = Cls->IsChildOf(UMetaSoundSource::StaticClass());
        const bool bIsPatch  = Cls->IsChildOf(UMetaSoundPatch::StaticClass());
        if (!bIsSource && !bIsPatch) continue;
        if (Out.Num() >= Cap) { bCapped = true; break; }

        TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
        Entry->SetStringField(TEXT("name"),  A.AssetName.ToString());
        Entry->SetStringField(TEXT("path"),  A.GetObjectPathString());
        Entry->SetStringField(TEXT("class"), A.AssetClassPath.GetAssetName().ToString());
        Out.Add(MakeShared<FJsonValueObject>(Entry.ToSharedRef()));
    }

    TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
    Result->SetArrayField(TEXT("metasounds"), Out);
    Result->SetNumberField(TEXT("count"), Out.Num());
    Result->SetBoolField(TEXT("capped"), bCapped);
    return FHaybaHandlerResult::Ok(Result);
}

FHaybaHandlerResult FHaybaMCPMetaSoundHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& P)
{
    if (Cmd == TEXT("metasound_create")) return MSCreate(P);
    if (Cmd == TEXT("metasound_list"))   return MSList(P);
    if (Cmd == TEXT("metasound_add_node")) return MSAddNode(P);
    if (Cmd == TEXT("metasound_connect")) return MSConnect(P);
    if (Cmd == TEXT("metasound_set_input")) return MSSetInput(P);
    if (Cmd == TEXT("metasound_compile")) return MSCompile(P);
    if (Cmd == TEXT("metasound_inspect")) return MSInspect(P);

    return FHaybaHandlerResult::Err(FString::Printf(TEXT("MetaSoundHandler: unknown command %s"), *Cmd));
}
