// HaybaSliverTypes.h — C++ mirror of the on-disk SliverSpec JSON shape.
// The decoded param types are Float, Int, Bool, String, Enum, ActorRef
// and Vector3; other type strings parse into FHaybaSliverParam with
// Type=Unsupported and are surfaced by the panel as "not yet supported".

#pragma once

#include "CoreMinimal.h"
#include "Templates/SharedPointer.h"

class FJsonObject;

enum class EHaybaSliverParamType : uint8
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

struct FHaybaSliverEnumOption
{
    FString Value;
    FString Label;
};

struct FHaybaSliverParam
{
    FString Id;
    FString Label;
    bool bRequired = false;
    EHaybaSliverParamType Type = EHaybaSliverParamType::Unsupported;
    FString OriginalTypeString;   // verbatim from JSON, used for the Unsupported message

    // Numeric (float / int)
    TOptional<double> RangeMin;
    TOptional<double> RangeMax;
    TOptional<double> DefaultNumber;

    // Bool
    TOptional<bool>   DefaultBool;

    // String / Enum / ActorRef
    TOptional<FString> DefaultString;
    TArray<FHaybaSliverEnumOption> EnumOptions;

    // ActorRef
    FString ClassFilter;

    // Vector3
    TOptional<FVector> DefaultVector;
};

struct FHaybaSliverDeterminism
{
    bool bPure = true;
    TArray<FString> DeclaredOutputs;
    TArray<FString> SideEffects;
    TOptional<FString> SeedParam;
};

struct FHaybaSliverSpec
{
    FString Id;
    FString Version;
    FString Category;
    FString Title;
    FString Description;
    FString Author;
    FString ExecutorKind;
    TArray<FHaybaSliverParam> Params;
    FHaybaSliverDeterminism Determinism;
};

/** Returns true and fills OutSpec on success; false and OutError on validation failure. */
bool ParseHaybaSliverSpec(const TSharedRef<FJsonObject>& In, FHaybaSliverSpec& OutSpec, FString& OutError);

/** Reverse-DNS check: at least 3 dot-separated segments, lowercase + underscores. */
bool IsReverseDnsId(const FString& Id);
