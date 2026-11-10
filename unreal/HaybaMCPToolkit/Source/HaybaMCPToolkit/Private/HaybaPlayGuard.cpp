#include "HaybaPlayGuard.h"
#include "Engine/Blueprint.h"
#include "UObject/Package.h"
#include "UObject/UObjectIterator.h"

namespace HaybaPlayGuard
{
    TArray<FString> BlueprintsFailingToCompile()
    {
        TArray<FString> Out;
        for (TObjectIterator<UBlueprint> It; It; ++It)
        {
            const UBlueprint* Blueprint = *It;
            if (!IsValid(Blueprint) || Blueprint->IsUpToDate()) continue;
            const UPackage* Package = Blueprint->GetPackage();
            if (!Package || Package == GetTransientPackage() || Package->HasAnyPackageFlags(PKG_ForDiffing)) continue;
            // UE prompts on an errored Blueprint it won't recompile (bDisplayCompilePIEWarning) and on one it
            // recompiles first because it is dirty (FInternalPlayLevelUtils::ResolveDirtyBlueprints, PlayLevel.cpp).
            // shortcut: a dirty Blueprint whose last compile was clean but whose next one fails is not caught;
            // compile it (blueprint_compile) before PIE if that matters.
            if (Blueprint->Status == BS_Error && (Blueprint->bDisplayCompilePIEWarning || Blueprint->IsPossiblyDirty()))
            {
                Out.Add(Blueprint->GetPathName());
            }
        }
        Out.Sort();
        return Out;
    }

    FString RefusalFor(const TCHAR* Cmd)
    {
        TArray<FString> Failing = BlueprintsFailingToCompile();
        if (Failing.IsEmpty()) return FString();
        const int32 Total = Failing.Num();
        constexpr int32 MaxListed = 20;
        if (Total > MaxListed)
        {
            Failing.SetNum(MaxListed);
            Failing.Add(FString::Printf(TEXT("and %d more"), Total - MaxListed));
        }
        return FString::Printf(TEXT(
            "%s refused [HCR-PIE-001]: %d loaded Blueprint(s) fail to compile, and starting PIE now would open UE's modal "
            "\"Blueprint Compilation Errors\" prompt, which blocks the editor until someone answers it: %s. Fix them "
            "(blueprint_compile lists the errors) and retry. PIE was not started."),
            Cmd, Total, *FString::Join(Failing, TEXT(", ")));
    }
}
