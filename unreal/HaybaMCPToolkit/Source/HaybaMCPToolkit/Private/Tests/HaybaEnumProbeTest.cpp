// Diagnostic: what does a synthetic UEnum actually answer on UE 5.8?
//
// Hayba.MCP.DataAsset.ReadWritePreflight builds a UEnum with NewObject +
// SetEnums and looks names up with EGetByNameFlags::CheckAuthoredName. The
// resolver under test is correct by inspection -- it deliberately pairs
// GetIndexByNameString with GetValueByIndex so a legal -1 is not confused with
// INDEX_NONE -- yet the lookup fails and the value comes back 0.
//
// The hypothesis is that CheckAuthoredName does not resolve for an enum built
// this way, because authored-name metadata is emitted by UHT and a synthetic
// enum has none. That is a guess until the engine is asked directly, so this
// asks it and reports the answers rather than asserting a conclusion.
//
// Delete once the question is settled.

#include "Misc/AutomationTest.h"
#include "UObject/Package.h"

#if WITH_DEV_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaEnumProbeTest,
    "Hayba.Probe.SyntheticEnumNames",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaEnumProbeTest::RunTest(const FString&)
{
    UEnum* Signed = NewObject<UEnum>(GetTransientPackage());
    if (!Signed)
    {
        AddError(TEXT("could not create the probe enum"));
        return false;
    }

    TArray<TPair<FName, int64>> Names = {
        { FName(TEXT("EHaybaSignedProbe::MinusOne")), -1 },
        { FName(TEXT("EHaybaSignedProbe::Zero")),      0 },
    };
    const bool bInit = Signed->SetEnums(Names, UEnum::ECppForm::EnumClass, EEnumFlags::None, false);
    AddWarning(FString::Printf(TEXT("SetEnums returned %s"), bInit ? TEXT("true") : TEXT("false")));

    const FString Authored = Signed->GetAuthoredNameStringByIndex(0);
    const FString NameStr   = Signed->GetNameStringByIndex(0);
    AddWarning(FString::Printf(TEXT("GetAuthoredNameStringByIndex(0) = '%s'"), *Authored));
    AddWarning(FString::Printf(TEXT("GetNameStringByIndex(0)         = '%s'"), *NameStr));
    AddWarning(FString::Printf(TEXT("GetValueByIndex(0)              = %lld"), Signed->GetValueByIndex(0)));

    const int32 ByAuthored = Signed->GetIndexByNameString(Authored, EGetByNameFlags::CheckAuthoredName);
    const int32 ByAuthoredPlain = Signed->GetIndexByNameString(Authored, EGetByNameFlags::None);
    const int32 ByName = Signed->GetIndexByNameString(NameStr, EGetByNameFlags::CheckAuthoredName);
    const int32 ByShort = Signed->GetIndexByNameString(TEXT("MinusOne"), EGetByNameFlags::CheckAuthoredName);
    const int32 ByFull = Signed->GetIndexByNameString(
        TEXT("EHaybaSignedProbe::MinusOne"), EGetByNameFlags::CheckAuthoredName);

    AddWarning(FString::Printf(TEXT("GetIndexByNameString(authored, CheckAuthoredName) = %d"), ByAuthored));
    AddWarning(FString::Printf(TEXT("GetIndexByNameString(authored, None)              = %d"), ByAuthoredPlain));
    AddWarning(FString::Printf(TEXT("GetIndexByNameString(nameStr,  CheckAuthoredName) = %d"), ByName));
    AddWarning(FString::Printf(TEXT("GetIndexByNameString('MinusOne')                  = %d"), ByShort));
    AddWarning(FString::Printf(TEXT("GetIndexByNameString('EHaybaSignedProbe::MinusOne')= %d"), ByFull));

    // Reported as WARNINGS: the automation log does not surface AddInfo through
    // test_get_log, and the point of this file is to be readable from there.
    // Not asserted: this test exists to answer a question,
    // and a failing assertion would just restate the one already failing.
    return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
