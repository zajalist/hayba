// HaybaRecipeTypes.cpp
#include "Recipes/HaybaRecipeTypes.h"

#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Internationalization/Regex.h"

bool IsReverseDnsId(const FString& Id)
{
    // Mirrors src/recipes/spec-schema.ts: ^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$
    const FRegexPattern Pattern(TEXT("^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*){2,}$"));
    FRegexMatcher M(Pattern, Id);
    return M.FindNext();
}

static EHaybaRecipeParamType ParamTypeFromString(const FString& S)
{
    if (S == TEXT("float"))     return EHaybaRecipeParamType::Float;
    if (S == TEXT("int"))       return EHaybaRecipeParamType::Int;
    if (S == TEXT("bool"))      return EHaybaRecipeParamType::Bool;
    if (S == TEXT("string"))    return EHaybaRecipeParamType::String;
    if (S == TEXT("enum"))      return EHaybaRecipeParamType::Enum;
    if (S == TEXT("actor_ref")) return EHaybaRecipeParamType::ActorRef;
    if (S == TEXT("vector3"))   return EHaybaRecipeParamType::Vector3;
    return EHaybaRecipeParamType::Unsupported;
}

static bool ParseParam(const TSharedPtr<FJsonObject>& Obj, FHaybaRecipeParam& Out, FString& OutError)
{
    if (!Obj->TryGetStringField(TEXT("id"), Out.Id) || Out.Id.IsEmpty())
    { OutError = TEXT("param missing id"); return false; }
    Obj->TryGetStringField(TEXT("label"), Out.Label);
    Obj->TryGetBoolField(TEXT("required"), Out.bRequired);

    FString TypeStr;
    if (!Obj->TryGetStringField(TEXT("type"), TypeStr))
    { OutError = FString::Printf(TEXT("param %s missing type"), *Out.Id); return false; }
    Out.OriginalTypeString = TypeStr;
    Out.Type = ParamTypeFromString(TypeStr);

    // Range
    if (Out.Type == EHaybaRecipeParamType::Float || Out.Type == EHaybaRecipeParamType::Int)
    {
        const TArray<TSharedPtr<FJsonValue>>* RangeArr = nullptr;
        if (Obj->TryGetArrayField(TEXT("range"), RangeArr) && RangeArr && RangeArr->Num() == 2)
        {
            Out.RangeMin = (*RangeArr)[0]->AsNumber();
            Out.RangeMax = (*RangeArr)[1]->AsNumber();
        }
        double DefNum;
        if (Obj->TryGetNumberField(TEXT("default"), DefNum)) Out.DefaultNumber = DefNum;
    }
    if (Out.Type == EHaybaRecipeParamType::Bool)
    {
        bool DefB;
        if (Obj->TryGetBoolField(TEXT("default"), DefB)) Out.DefaultBool = DefB;
    }
    if (Out.Type == EHaybaRecipeParamType::String || Out.Type == EHaybaRecipeParamType::Enum || Out.Type == EHaybaRecipeParamType::ActorRef)
    {
        FString DefS;
        if (Obj->TryGetStringField(TEXT("default"), DefS)) Out.DefaultString = DefS;
    }
    if (Out.Type == EHaybaRecipeParamType::Enum)
    {
        const TArray<TSharedPtr<FJsonValue>>* OptArr = nullptr;
        if (Obj->TryGetArrayField(TEXT("options"), OptArr) && OptArr)
        {
            for (const TSharedPtr<FJsonValue>& Opt : *OptArr)
            {
                if (Opt->Type != EJson::Object) continue;
                FHaybaRecipeEnumOption O;
                Opt->AsObject()->TryGetStringField(TEXT("value"), O.Value);
                Opt->AsObject()->TryGetStringField(TEXT("label"), O.Label);
                Out.EnumOptions.Add(O);
            }
        }
    }
    if (Out.Type == EHaybaRecipeParamType::ActorRef)
    {
        Obj->TryGetStringField(TEXT("class_filter"), Out.ClassFilter);
    }
    if (Out.Type == EHaybaRecipeParamType::Vector3)
    {
        const TArray<TSharedPtr<FJsonValue>>* VecArr = nullptr;
        if (Obj->TryGetArrayField(TEXT("default"), VecArr) && VecArr && VecArr->Num() == 3)
        {
            Out.DefaultVector = FVector(
                (*VecArr)[0]->AsNumber(),
                (*VecArr)[1]->AsNumber(),
                (*VecArr)[2]->AsNumber());
        }
    }
    return true;
}

bool ParseHaybaRecipeSpec(const TSharedRef<FJsonObject>& In, FHaybaRecipeSpec& OutSpec, FString& OutError)
{
    if (!In->TryGetStringField(TEXT("id"), OutSpec.Id) || !IsReverseDnsId(OutSpec.Id))
    { OutError = TEXT("invalid or missing reverse-DNS id"); return false; }
    if (!In->TryGetStringField(TEXT("version"), OutSpec.Version))   { OutError = TEXT("missing version"); return false; }
    if (!In->TryGetStringField(TEXT("category"), OutSpec.Category)) { OutError = TEXT("missing category"); return false; }
    if (!In->TryGetStringField(TEXT("title"), OutSpec.Title))       { OutError = TEXT("missing title"); return false; }
    In->TryGetStringField(TEXT("description"), OutSpec.Description);
    if (!In->TryGetStringField(TEXT("author"), OutSpec.Author))     { OutError = TEXT("missing author"); return false; }

    const TSharedPtr<FJsonObject>* ExecObj = nullptr;
    if (!In->TryGetObjectField(TEXT("executor"), ExecObj) || !(*ExecObj)->TryGetStringField(TEXT("kind"), OutSpec.ExecutorKind))
    { OutError = TEXT("missing executor.kind"); return false; }

    const TArray<TSharedPtr<FJsonValue>>* ParamsArr = nullptr;
    if (In->TryGetArrayField(TEXT("params"), ParamsArr) && ParamsArr)
    {
        TSet<FString> SeenIds;
        for (const TSharedPtr<FJsonValue>& V : *ParamsArr)
        {
            if (V->Type != EJson::Object) continue;
            FHaybaRecipeParam P;
            FString Err;
            if (!ParseParam(V->AsObject(), P, Err)) { OutError = Err; return false; }
            if (SeenIds.Contains(P.Id)) { OutError = FString::Printf(TEXT("duplicate param id \"%s\""), *P.Id); return false; }
            SeenIds.Add(P.Id);
            OutSpec.Params.Add(P);
        }
    }

    const TSharedPtr<FJsonObject>* DetObj = nullptr;
    if (In->TryGetObjectField(TEXT("determinism"), DetObj))
    {
        (*DetObj)->TryGetBoolField(TEXT("pure"), OutSpec.Determinism.bPure);
        const TArray<TSharedPtr<FJsonValue>>* Outs = nullptr;
        if ((*DetObj)->TryGetArrayField(TEXT("declared_outputs"), Outs) && Outs)
            for (const TSharedPtr<FJsonValue>& V : *Outs) OutSpec.Determinism.DeclaredOutputs.Add(V->AsString());
        const TArray<TSharedPtr<FJsonValue>>* Effects = nullptr;
        if ((*DetObj)->TryGetArrayField(TEXT("side_effects"), Effects) && Effects)
            for (const TSharedPtr<FJsonValue>& V : *Effects) OutSpec.Determinism.SideEffects.Add(V->AsString());
        FString Seed;
        if ((*DetObj)->TryGetStringField(TEXT("seed_param"), Seed) && !Seed.IsEmpty())
            OutSpec.Determinism.SeedParam = Seed;
    }
    return true;
}
