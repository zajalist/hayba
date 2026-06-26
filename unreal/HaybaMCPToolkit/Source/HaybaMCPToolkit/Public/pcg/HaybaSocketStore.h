// Reads .scratch/sockets.json into socket contracts + the one named bond (SP-1).
// Mirrors the grammar.json load idiom in PCGGrammarSolver.cpp.
#pragma once

#include "CoreMinimal.h"
#include "pcg/HaybaSocketContract.h"

struct FHaybaSocketSet
{
    TMap<FName, FHaybaSocketContract> Sockets;
    FName BondFrontier  = NAME_None;
    FName BondCandidate = NAME_None;
};

namespace HaybaSocketStore
{
    FString ResolvePath(const FString& SettingsPath);
    bool    Load(const FString& Path, FHaybaSocketSet& Out, FString& OutError);
}
