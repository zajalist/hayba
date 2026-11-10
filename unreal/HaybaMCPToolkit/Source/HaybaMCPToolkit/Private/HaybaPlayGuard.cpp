#include "HaybaPlayGuard.h"
#include "Engine/Blueprint.h"
#include "UObject/Package.h"
#include "UObject/UObjectIterator.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "HaybaMCPEditorStatePolicy.h"

namespace HaybaPlayGuard
{
    TArray<FString> BlueprintsFailingToCompile()
    {
        // The same rule as editor_start_pie's preflight (HaybaMCPState::PlayModalFor, mirroring
        // PlayLevel.cpp): an errored Blueprint with its PIE warning, or a dirty code Blueprint.
        TArray<FString> Out;
        for (TObjectIterator<UBlueprint> It; It; ++It)
        {
            UBlueprint* Blueprint = *It;
            if (!IsValid(Blueprint)) continue;
            const UPackage* Package = Blueprint->GetPackage();
            if (!Package || Package == GetTransientPackage()) continue;
            HaybaMCPState::FBlueprintPlayFacts Facts;
            Facts.bUpToDate = Blueprint->IsUpToDate();
            Facts.bForDiffing = Package->HasAnyPackageFlags(PKG_ForDiffing);
            Facts.bDirty = Blueprint->Status == BS_Dirty;
            Facts.bError = Blueprint->Status == BS_Error;
            Facts.bDisplayCompilePIEWarning = Blueprint->bDisplayCompilePIEWarning;
            Facts.bDataOnly = Facts.bDirty && !Facts.bUpToDate && FBlueprintEditorUtils::IsDataOnlyBlueprint(Blueprint);
            if (HaybaMCPState::PlayModalFor(Facts) != HaybaMCPState::EPlayModal::None)
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
            "%s refused [HCR-PIE-001]: %d loaded Blueprint(s) fail to compile or have uncompiled edits, and starting PIE "
            "now could open UE's modal compile prompt, which blocks the editor until someone answers it: %s. Compile them "
            "(blueprint_compile lists any errors) and retry. PIE was not started."),
            Cmd, Total, *FString::Join(Failing, TEXT(", ")));
    }
}
