// HaybaRecipeTypes.h — C++ mirror of the on-disk RecipeSpec JSON shape.
// The decoded param types are Float, Int, Bool, String, Enum, ActorRef
// and Vector3; other type strings parse into FHaybaRecipeParam with
// Type=Unsupported and are surfaced by the panel as "not yet supported".

#pragma once

#include "CoreMinimal.h"
#include "Templates/SharedPointer.h"

class FJsonObject;

enum class EHaybaRecipeParamType : uint8
{
    Float,
    Int,
    Bool,
    String,
    Enum,
    ActorRef,
    Vector3,
    Unsupported,
};

struct FHaybaRecipeEnumOption
{
    FString Value;
    FString Label;
};

struct FHaybaRecipeParam
{
    FString Id;
    FString Label;
    bool bRequired = false;
    EHaybaRecipeParamType Type = EHaybaRecipeParamType::Unsupported;
    FString OriginalTypeString;   // verbatim from JSON, used for the Unsupported message

    // Numeric (float / int)
    TOptional<double> RangeMin;
    TOptional<double> RangeMax;
    TOptional<double> DefaultNumber;

    // Bool
    TOptional<bool>   DefaultBool;

    // String / Enum / ActorRef
    TOptional<FString> DefaultString;
    TArray<FHaybaRecipeEnumOption> EnumOptions;

    // ActorRef
    FString ClassFilter;

    // Vector3
    TOptional<FVector> DefaultVector;
};

struct FHaybaRecipeDeterminism
{
    bool bPure = true;
    TArray<FString> DeclaredOutputs;
    TArray<FString> SideEffects;
    TOptional<FString> SeedParam;
};

struct FHaybaRecipeSpec
{
    FString Id;
    FString Version;
    FString Category;
    FString Title;
    FString Description;
    FString Author;
    FString ExecutorKind;
    TArray<FHaybaRecipeParam> Params;
    FHaybaRecipeDeterminism Determinism;
};

/** Returns true and fills OutSpec on success; false and OutError on validation failure. */
bool ParseHaybaRecipeSpec(const TSharedRef<FJsonObject>& In, FHaybaRecipeSpec& OutSpec, FString& OutError);

/** Reverse-DNS check: at least 3 dot-separated segments, lowercase + underscores. */
bool IsReverseDnsId(const FString& Id);
