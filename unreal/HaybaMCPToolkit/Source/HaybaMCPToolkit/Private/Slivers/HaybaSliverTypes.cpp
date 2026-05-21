// HaybaSliverTypes.cpp
#include "Slivers/HaybaSliverTypes.h"

#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Internationalization/Regex.h"

bool IsReverseDnsId(const FString& Id)
{
    // Mirrors src/slivers/spec-schema.ts: ^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$
    const FRegexPattern Pattern(TEXT("^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*){2,}$"));
    FRegexMatcher M(Pattern, Id);
    return M.FindNext();
}

static EHaybaSliverParamType ParamTypeFromString(const FString& S)
{
    if (S == TEXT("float"))     return EHaybaSliverParamType::Float;
    if (S == TEXT("int"))       return EHaybaSliverParamType::Int;
    if (S == TEXT("bool"))      return EHaybaSliverParamType::Bool;
    if (S == TEXT("string"))    return EHaybaSliverParamType::String;
    if (S == TEXT("enum"))      return EHaybaSliverParamType::Enum;
    if (S == TEXT("actor_ref")) return EHaybaSliverParamType::ActorRef;
    return EHaybaSliverParamType::Unsupported;
}

static bool ParseParam(const TSharedPtr<FJsonObject>& Obj, FHaybaSliverParam& Out, FString& OutError)
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
    if (Out.Type == EHaybaSliverParamType::Float || Out.Type == EHaybaSliverParamType::Int)
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
    if (Out.Type == EHaybaSliverParamType::Bool)
    {
        bool DefB;
        if (Obj->TryGetBoolField(TEXT("default"), DefB)) Out.DefaultBool = DefB;
    }
    if (Out.Type == EHaybaSliverParamType::String || Out.Type == EHaybaSliverParamType::Enum || Out.Type == EHaybaSliverParamType::ActorRef)
    {
        FString DefS;
        if (Obj->TryGetStringField(TEXT("default"), DefS)) Out.DefaultString = DefS;
    }
    if (Out.Type == EHaybaSliverParamType::Enum)
    {
        const TArray<TSharedPtr<FJsonValue>>* OptArr = nullptr;
        if (Obj->TryGetArrayField(TEXT("options"), OptArr) && OptArr)
        {
            for (const TSharedPtr<FJsonValue>& Opt : *OptArr)
            {
                if (Opt->Type != EJson::Object) continue;
                FHaybaSliverEnumOption O;
                Opt->AsObject()->TryGetStringField(TEXT("value"), O.Value);
                Opt->AsObject()->TryGetStringField(TEXT("label"), O.Label);
                Out.EnumOptions.Add(O);
            }
        }
    }
    if (Out.Type == EHaybaSliverParamType::ActorRef)
    {
        Obj->TryGetStringField(TEXT("class_filter"), Out.ClassFilter);
    }
    return true;
}

bool ParseHaybaSliverSpec(const TSharedRef<FJsonObject>& In, FHaybaSliverSpec& OutSpec, FString& OutError)
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
            FHaybaSliverParam P;
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
