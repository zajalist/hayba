#include "pcg/HaybaUnsatCore.h"
#include "pcg/HaybaSocketSolver.h"

#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonWriter.h"
#include "Serialization/JsonSerializer.h"
#include "Dom/JsonObject.h"

namespace
{
    static FString JoinBraced(const TArray<FString>& Items)
    {
        return FString::Printf(TEXT("{ %s }"), *FString::Join(Items, TEXT(", ")));
    }
    static FString JoinQuoted(const TArray<FString>& Items)
    {
        return FString::Join(Items, TEXT(","));
    }
}

FString HaybaUnsatCore::BuildHuman(const FHaybaBondOutcome& O)
{
    if (O.bOk && !O.bRelaxed)
    {
        return FString::Printf(TEXT("Bond OK  [%s] OK [%s]  cost %.2f"),
            *O.RequirerName.ToString(), *O.ProviderName.ToString(), O.Cost);
    }
    if (O.bRelaxed)
    {
        return FString::Printf(TEXT("Bond RELAXED  [%s] ~ [%s]:  downgraded '%s'  (seam logged)"),
            *O.RequirerName.ToString(), *O.ProviderName.ToString(), *JoinQuoted(O.MissingRequired));
    }
    return FString::Printf(TEXT("Bond REJECTED  [%s] X [%s]:  required '%s'  -  neighbor provided %s"),
        *O.RequirerName.ToString(), *O.ProviderName.ToString(),
        *JoinQuoted(O.MissingRequired), *JoinBraced(O.NeighborProvided));
}

FString HaybaUnsatCore::ResolvePath()
{
    return FPaths::Combine(FPaths::ProjectDir(), TEXT(".scratch"), TEXT("unsat-core.json"));
}

bool HaybaUnsatCore::Write(const FHaybaBondOutcome& O, const FName& Frontier, const FName& Candidate,
                           const FString& Path, FString& OutError)
{
    const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
    Root->SetStringField(TEXT("schema_version"), TEXT("0.1.0"));
    Root->SetBoolField  (TEXT("ok"),       O.bOk);
    Root->SetBoolField  (TEXT("relaxed"),  O.bRelaxed);
    Root->SetStringField(TEXT("frontier"),  Frontier.ToString());
    Root->SetStringField(TEXT("candidate"), Candidate.ToString());
    Root->SetNumberField(TEXT("cost"),     O.Cost);
    Root->SetStringField(TEXT("requirer"), O.RequirerName.ToString());
    Root->SetStringField(TEXT("provider"), O.ProviderName.ToString());

    TArray<TSharedPtr<FJsonValue>> Missing;
    for (const FString& M : O.MissingRequired) { Missing.Add(MakeShared<FJsonValueString>(M)); }
    Root->SetArrayField(TEXT("missing_required"), Missing);

    TArray<TSharedPtr<FJsonValue>> Provided;
    for (const FString& P : O.NeighborProvided) { Provided.Add(MakeShared<FJsonValueString>(P)); }
    Root->SetArrayField(TEXT("neighbor_provided"), Provided);

    Root->SetStringField(TEXT("human"), BuildHuman(O));

    FString Out;
    const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Out);
    if (!FJsonSerializer::Serialize(Root, Writer))
    {
        OutError = TEXT("failed to serialize unsat-core json");
        return false;
    }
    if (!FFileHelper::SaveStringToFile(Out, *Path))
    {
        OutError = FString::Printf(TEXT("failed to write %s"), *Path);
        return false;
    }
    return true;
}
