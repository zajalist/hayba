#include "Misc/AutomationTest.h"

#include "Engine/DataAsset.h"
#include "Engine/PrimaryAssetLabel.h"
#include "HaybaMCPCommandHandler.h"
#include "HaybaMCPSettings.h"
#include "Misc/PackageName.h"
#include "Misc/ScopeExit.h"
#include "Modules/ModuleManager.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "UObject/SoftObjectPath.h"
#include "UObject/UnrealType.h"
#include "UObject/UObjectGlobals.h"
#include "handlers/HaybaMCPDataAssetHandler.h"

#if WITH_DEV_AUTOMATION_TESTS

namespace HaybaMCPDataAssetTestHooks
{
    bool IsReflectionTraversalBounded(
        int32 Num,
        int32 MaxIndex,
        const TCHAR* Kind,
        FString& OutReason);
    bool ParseExactUnsignedDecimal(const FString& Text, uint64& OutValue);
    bool ResolveEnumString(
        const UEnum* Enum,
        const FString& Text,
        int64& OutValue,
        FString& OutReason);
}

namespace
{
    TSharedPtr<FJsonObject> ParseResponseEnvelope(const FString& Text)
    {
        TSharedPtr<FJsonObject> Out;
        const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Text);
        FJsonSerializer::Deserialize(Reader, Out);
        return Out;
    }
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPDataAssetCreatePreflightTest,
    "Hayba.MCP.DataAsset.CreatePreflight",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPDataAssetCreatePreflightTest::RunTest(const FString& Parameters)
{
    FHaybaMCPDataAssetHandler Handler;
    const FString ProbeFolder = TEXT("/Game/__HaybaNativeTests");
    const FString ProbeName = TEXT("DA_HCR_DATA_001_MustNotExist");
    const FString ProbePackage = ProbeFolder / ProbeName;

    const auto BaseParams = [&]()
    {
        TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
        Params->SetStringField(TEXT("path"), ProbeFolder);
        Params->SetStringField(TEXT("name"), ProbeName);
        Params->SetStringField(TEXT("class_name"), UDataAsset::StaticClass()->GetPathName());
        return Params;
    };

    TestFalse(TEXT("the refusal probe must not already exist on disk"),
        FPackageName::DoesPackageExist(ProbePackage));

    // Every case below must return before ResolveClass, AssetTools, or package
    // mutation. The module-state assertion catches an accidental eager module
    // load when the test starts before AssetTools; the source-order contract
    // covers the same boundary when another editor subsystem loaded it first.
    const auto RefuseLexically = [&](const FString& Label, const TSharedPtr<FJsonObject>& Params)
    {
        const bool bAssetToolsLoadedBefore =
            FModuleManager::Get().IsModuleLoaded(TEXT("AssetTools"));
        const FHaybaHandlerResult Result = Handler.Handle(TEXT("data_create"), Params);
        TestFalse(Label + TEXT(" is rejected"), Result.bOk);
        TestEqual(Label + TEXT(" does not load AssetTools"),
            FModuleManager::Get().IsModuleLoaded(TEXT("AssetTools")),
            bAssetToolsLoadedBefore);
        TestTrue(Label + TEXT(" names data_create"),
            Result.ErrorMessage.Contains(TEXT("data_create")));
        TestFalse(Label + TEXT(" does not create the package"),
            FPackageName::DoesPackageExist(ProbePackage));
    };

    {
        TSharedPtr<FJsonObject> Params = BaseParams();
        Params->SetStringField(TEXT("path"), TEXT("/Game/") + FString::ChrN(1100, TEXT('P')));
        RefuseLexically(TEXT("oversized path"), Params);
    }
    {
        TSharedPtr<FJsonObject> Params = BaseParams();
        Params->SetStringField(TEXT("path"), TEXT("/Game/Folder.Asset"));
        RefuseLexically(TEXT("object path passed as a folder"), Params);
    }
    {
        FString EmbeddedNulPath = TEXT("/Game/Bad");
        EmbeddedNulPath.AppendChar(TEXT('\0'));
        EmbeddedNulPath += TEXT("Folder");
        TSharedPtr<FJsonObject> Params = BaseParams();
        Params->SetStringField(TEXT("path"), EmbeddedNulPath);
        RefuseLexically(TEXT("embedded NUL in path"), Params);
    }
    {
        TSharedPtr<FJsonObject> Params = BaseParams();
        Params->SetStringField(TEXT("name"), FString::ChrN(300, TEXT('N')));
        RefuseLexically(TEXT("oversized name"), Params);
    }
    {
        TSharedPtr<FJsonObject> Params = BaseParams();
        Params->SetStringField(TEXT("name"), TEXT("Bad\nName"));
        RefuseLexically(TEXT("control character in name"), Params);
    }
    {
        FString EmbeddedNul = TEXT("Bad");
        EmbeddedNul.AppendChar(TEXT('\0'));
        EmbeddedNul += TEXT("Name");
        TSharedPtr<FJsonObject> Params = BaseParams();
        Params->SetStringField(TEXT("name"), EmbeddedNul);
        RefuseLexically(TEXT("embedded NUL in name"), Params);
    }
    {
        TSharedPtr<FJsonObject> Params = BaseParams();
        Params->SetStringField(TEXT("class_name"), FString::ChrN(1100, TEXT('C')));
        RefuseLexically(TEXT("oversized class reference"), Params);
    }
    {
        TSharedPtr<FJsonObject> Params = BaseParams();
        Params->SetStringField(TEXT("class_name"), TEXT("/Script/Engine.\tDataAsset"));
        RefuseLexically(TEXT("control character in class reference"), Params);
    }
    {
        TSharedPtr<FJsonObject> Params = BaseParams();
        Params->SetStringField(TEXT("class_name"), TEXT("/Script/Engine.DataAsset.Extra"));
        RefuseLexically(TEXT("malformed class object path"), Params);
    }
    {
        TSharedPtr<FJsonObject> Params = BaseParams();
        Params->SetNumberField(TEXT("name"), 42.0);
        RefuseLexically(TEXT("wrong-typed name"), Params);
    }

    // UDataAsset itself is abstract. It resolves successfully, then must be
    // refused before the module load and CreateAsset boundary that produced
    // the observed HCR-DATA-001 crash signature.
    {
        const bool bAssetToolsLoadedBefore =
            FModuleManager::Get().IsModuleLoaded(TEXT("AssetTools"));
        const FHaybaHandlerResult Result = Handler.Handle(TEXT("data_create"), BaseParams());
        TestFalse(TEXT("abstract UDataAsset is rejected"), Result.bOk);
        TestTrue(TEXT("abstract refusal explains the concrete-class requirement"),
            Result.ErrorMessage.Contains(TEXT("concrete UDataAsset subclass")));
        TestEqual(TEXT("abstract refusal does not load AssetTools"),
            FModuleManager::Get().IsModuleLoaded(TEXT("AssetTools")),
            bAssetToolsLoadedBefore);
        TestFalse(TEXT("abstract refusal creates no package"),
            FPackageName::DoesPackageExist(ProbePackage));
    }

    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPDataAssetReadWritePreflightTest,
    "Hayba.MCP.DataAsset.ReadWritePreflight",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPDataAssetReadWritePreflightTest::RunTest(const FString& Parameters)
{
    FHaybaMCPDataAssetHandler Handler;

    const auto ExpectRefusal = [&](
        const FString& Label,
        const FString& Command,
        const TSharedPtr<FJsonObject>& Params)
    {
        const FHaybaHandlerResult Result = Handler.Handle(Command, Params);
        TestFalse(Label + TEXT(" is rejected"), Result.bOk);
        TestTrue(Label + TEXT(" names its command"),
            Result.ErrorMessage.Contains(Command));
    };

    {
        TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
        Params->SetStringField(TEXT("path"),
            TEXT("/Game/") + FString::ChrN(1100, TEXT('P')));
        ExpectRefusal(TEXT("data_get oversized path"), TEXT("data_get"), Params);
    }
    {
        TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
        Params->SetStringField(TEXT("path"), TEXT("/Game/Folder/../Asset.Asset"));
        ExpectRefusal(TEXT("data_get traversal path"), TEXT("data_get"), Params);
    }
    {
        FString EmbeddedNul = TEXT("/Game/Asset.Asset");
        EmbeddedNul.AppendChar(TEXT('\0'));
        TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
        Params->SetStringField(TEXT("path"), EmbeddedNul);
        ExpectRefusal(TEXT("data_get embedded NUL"), TEXT("data_get"), Params);
    }
    {
        TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
        Params->SetStringField(TEXT("path"), TEXT("/Game/Missing.Asset"));
        Params->SetStringField(TEXT("property_name"),
            FString::ChrN(300, TEXT('N')));
        Params->SetNumberField(TEXT("value"), 1.0);
        ExpectRefusal(TEXT("data_set oversized property name"), TEXT("data_set"), Params);
    }
    {
        TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
        Params->SetStringField(TEXT("path"), TEXT("/Game/Missing.Asset"));
        Params->SetStringField(TEXT("property_name"), TEXT("Bad.Name"));
        Params->SetNumberField(TEXT("value"), 1.0);
        ExpectRefusal(TEXT("data_set punctuated property name"), TEXT("data_set"), Params);
    }
    {
        TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
        Params->SetNumberField(TEXT("path"), 7.0);
        Params->SetStringField(TEXT("property_name"), TEXT("Bad\nName"));
        ExpectRefusal(TEXT("data_set accumulates malformed fields"), TEXT("data_set"), Params);
        const FHaybaHandlerResult Result = Handler.Handle(TEXT("data_set"), Params);
        TestTrue(TEXT("combined refusal reports path"),
            Result.ErrorMessage.Contains(TEXT("path")));
        TestTrue(TEXT("combined refusal reports property_name"),
            Result.ErrorMessage.Contains(TEXT("property_name")));
        TestTrue(TEXT("combined refusal reports value"),
            Result.ErrorMessage.Contains(TEXT("value")));
    }

    // Constructing an abstract class normally raises an engine ensure/check.
    // The test-only scope creates one unusual in-memory object so the handler
    // can prove it refuses the class flag before property lookup or staging.
    {
        const FString AbstractName = TEXT("DA_HCR_DATA_003_AbstractMustNotStage");
        const FString AbstractPackageName =
            TEXT("/Game/__HaybaNativeTests/") + AbstractName;
        UPackage* AbstractPackage = CreatePackage(*AbstractPackageName);
        UDataAsset* AbstractAsset = nullptr;
        {
            FScopedAllowAbstractClassAllocation AllowAbstractForTestOnly;
            AbstractAsset = NewObject<UDataAsset>(
                AbstractPackage, *AbstractName, RF_Transient);
        }
        TestNotNull(TEXT("abstract refusal probe was created in test-only scope"),
            AbstractAsset);
        if (AbstractAsset)
        {
            const bool bDirtyBefore = AbstractPackage->IsDirty();
            TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
            Params->SetStringField(TEXT("path"), AbstractAsset->GetPathName());
            Params->SetStringField(TEXT("property_name"), TEXT("MissingOnPurpose"));
            Params->SetBoolField(TEXT("value"), true);
            const FHaybaHandlerResult Result =
                Handler.Handle(TEXT("data_set"), Params);
            TestFalse(TEXT("abstract target is rejected"), Result.bOk);
            TestTrue(TEXT("abstract refusal occurs before missing-property lookup"),
                Result.ErrorMessage.Contains(TEXT("abstract, transient, deprecated, or superseded")));
            TestEqual(TEXT("abstract refusal does not dirty the package"),
                AbstractPackage->IsDirty(), bDirtyBefore);
            TestFalse(TEXT("abstract probe never reaches disk"),
                FPackageName::DoesPackageExist(AbstractPackageName));
            AbstractAsset->MarkAsGarbage();
        }
    }

    // A concrete engine DataAsset gives this test real reflected properties
    // without introducing a test-only UCLASS. Both fields below would enter
    // extensible JsonObjectConverter paths: a soft-object array can resolve
    // assets. Complex containers and every struct are deliberately outside the
    // scalar-only data_set contract; they must be refused while the live object
    // and package are unchanged.
    const FString ProbeName = TEXT("DA_HCR_DATA_002_UnsafePropertyMustNotChange");
    const FString ProbePackageName =
        TEXT("/Game/__HaybaNativeTests/") + ProbeName;
    UPackage* ProbePackage = CreatePackage(*ProbePackageName);
    UPrimaryAssetLabel* ProbeAsset = NewObject<UPrimaryAssetLabel>(
        ProbePackage,
        *ProbeName,
        RF_Transient);
    TestNotNull(TEXT("unsafe-property probe asset was created"), ProbeAsset);
    if (ProbeAsset)
    {
        const bool bDirtyBefore = ProbePackage->IsDirty();
        const bool bRuntimeLabelBefore = ProbeAsset->bIsRuntimeLabel;

        {
            // An unloaded soft reference is not null. data_get must not route
            // it through FObjectPropertyBase and claim a complete null value.
            ProbeAsset->ExplicitAssets.Add(TSoftObjectPtr<UObject>(
                FSoftObjectPath(TEXT("/Game/NeverLoaded.NeverLoaded"))));
            TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
            Params->SetStringField(TEXT("path"), ProbeAsset->GetPathName());
            const FHaybaHandlerResult Result =
                Handler.Handle(TEXT("data_get"), Params);
            TestTrue(TEXT("soft-reference snapshot returns bounded metadata"),
                Result.bOk && Result.Data.IsValid());
            if (Result.bOk && Result.Data.IsValid())
            {
                bool bComplete = true;
                TestTrue(TEXT("soft wrapper makes the snapshot explicitly partial"),
                    Result.Data->TryGetBoolField(TEXT("reflection_complete"), bComplete)
                    && !bComplete);
                TestTrue(TEXT("soft wrapper increments unsupported values"),
                    Result.Data->GetNumberField(TEXT("unsupported_values")) >= 1.0);
            }
            ProbeAsset->ExplicitAssets.Reset();
        }

        {
            TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
            Params->SetStringField(TEXT("path"), ProbeAsset->GetPathName());
            Params->SetStringField(TEXT("property_name"), TEXT("ExplicitAssets"));
            Params->SetArrayField(TEXT("value"), {
                MakeShared<FJsonValueString>(TEXT("/Game/MustNotLoad.MustNotLoad"))
            });
            const FHaybaHandlerResult Result =
                Handler.Handle(TEXT("data_set"), Params);
            TestFalse(TEXT("soft-object property graph is rejected"), Result.bOk);
            TestTrue(TEXT("soft-object refusal names the crash-safe converter"),
                Result.ErrorMessage.Contains(TEXT("crash-safe converter")));
            TestEqual(TEXT("soft-object refusal leaves the array unchanged"),
                ProbeAsset->ExplicitAssets.Num(), 0);
            TestEqual(TEXT("soft-object refusal does not dirty the package"),
                ProbePackage->IsDirty(), bDirtyBefore);
        }

        {
            // CPF_SkipSerialization can legally coexist with CPF_Edit. It can
            // never satisfy data_set's persisted-property contract.
            FProperty* RuntimeLabelProperty = FindFProperty<FProperty>(
                ProbeAsset->GetClass(), TEXT("bIsRuntimeLabel"));
            TestNotNull(TEXT("runtime-label property is reflected"),
                RuntimeLabelProperty);
            if (RuntimeLabelProperty)
            {
                RuntimeLabelProperty->SetPropertyFlags(CPF_SkipSerialization);
                TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
                Params->SetStringField(TEXT("path"), ProbeAsset->GetPathName());
                Params->SetStringField(TEXT("property_name"), TEXT("bIsRuntimeLabel"));
                Params->SetBoolField(TEXT("value"), !bRuntimeLabelBefore);
                const FHaybaHandlerResult Result =
                    Handler.Handle(TEXT("data_set"), Params);
                RuntimeLabelProperty->ClearPropertyFlags(CPF_SkipSerialization);

                TestFalse(TEXT("SkipSerialization editor property is rejected"),
                    Result.bOk);
                TestTrue(TEXT("SkipSerialization refusal names persisted mutability"),
                    Result.ErrorMessage.Contains(TEXT("mutable persisted")));
                TestEqual(TEXT("SkipSerialization refusal leaves value unchanged"),
                    !!ProbeAsset->bIsRuntimeLabel, bRuntimeLabelBefore);
                TestEqual(TEXT("SkipSerialization refusal leaves package clean"),
                    ProbePackage->IsDirty(), bDirtyBefore);
            }
        }

        {
            TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
            Params->SetStringField(TEXT("path"), ProbeAsset->GetPathName());
            Params->SetStringField(TEXT("property_name"), TEXT("Rules"));
            Params->SetObjectField(TEXT("value"), MakeShared<FJsonObject>());
            const FHaybaHandlerResult Result =
                Handler.Handle(TEXT("data_set"), Params);
            TestFalse(TEXT("all struct properties are rejected"), Result.bOk);
            TestTrue(TEXT("struct refusal directs callers to a domain-specific setter"),
                Result.ErrorMessage.Contains(TEXT("supported scalar property types"))
                && Result.ErrorMessage.Contains(TEXT("domain-specific setter")));
            TestEqual(TEXT("struct refusal does not dirty the package"),
                ProbePackage->IsDirty(), bDirtyBefore);
        }

        {
            TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
            Params->SetStringField(TEXT("path"), ProbeAsset->GetPathName());
            Params->SetStringField(TEXT("property_name"), TEXT("bIsRuntimeLabel"));
            Params->SetStringField(TEXT("value"), TEXT("true"));
            const FHaybaHandlerResult Result =
                Handler.Handle(TEXT("data_set"), Params);
            TestFalse(TEXT("wrong JSON kind is rejected before conversion"), Result.bOk);
            TestTrue(TEXT("wrong-kind refusal requires a JSON boolean"),
                Result.ErrorMessage.Contains(TEXT("must be a JSON boolean")));
            TestEqual(TEXT("wrong-kind refusal leaves the bool unchanged"),
                !!ProbeAsset->bIsRuntimeLabel, bRuntimeLabelBefore);
            TestEqual(TEXT("wrong-kind refusal does not dirty the package"),
                ProbePackage->IsDirty(), bDirtyBefore);
        }

        TestFalse(TEXT("unsafe-property probe never reaches disk"),
            FPackageName::DoesPackageExist(ProbePackageName));
        ProbeAsset->MarkAsGarbage();
    }

    // MarkPackageDirty broadcasts arbitrary callbacks. Prove the handler does
    // not report its pre-broadcast readback: this callback changes the scalar
    // during the broadcast, and the response must come from a freshly resolved
    // object/class/property after every staged/property temporary is gone.
    {
        const FString CallbackProbeName =
            TEXT("DA_HCR_DATA_004_DirtyCallbackInvalidatesReadback");
        const FString CallbackPackageName =
            TEXT("/Game/__HaybaNativeTests/") + CallbackProbeName;
        UPackage* CallbackPackage = CreatePackage(*CallbackPackageName);
        UPrimaryAssetLabel* CallbackAsset = NewObject<UPrimaryAssetLabel>(
            CallbackPackage, *CallbackProbeName, RF_NoFlags);
        TestNotNull(TEXT("dirty-callback probe asset was created"), CallbackAsset);
        if (CallbackAsset)
        {
            CallbackAsset->bIsRuntimeLabel = false;
            CallbackPackage->SetDirtyFlag(false);
            bool bCallbackRan = false;
            const FDelegateHandle CallbackHandle =
                UPackage::PackageMarkedDirtyEvent.AddLambda(
                    [&](UPackage* MarkedPackage, bool)
                    {
                        if (MarkedPackage == CallbackPackage)
                        {
                            bCallbackRan = true;
                            CallbackAsset->bIsRuntimeLabel = false;
                        }
                    });

            TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
            Params->SetStringField(TEXT("path"), CallbackAsset->GetPathName());
            Params->SetStringField(TEXT("property_name"), TEXT("bIsRuntimeLabel"));
            Params->SetBoolField(TEXT("value"), true);
            const FHaybaHandlerResult Result =
                Handler.Handle(TEXT("data_set"), Params);
            UPackage::PackageMarkedDirtyEvent.Remove(CallbackHandle);

            TestTrue(TEXT("dirty callback was invoked"), bCallbackRan);
            TestTrue(TEXT("callback probe returns a shaped mutation result"),
                Result.bOk && Result.Data.IsValid());
            if (Result.bOk && Result.Data.IsValid())
            {
                bool bNestedOk = true;
                bool bVerified = true;
                bool bReResolved = false;
                bool bDirtyMarked = false;
                TestTrue(TEXT("fresh target was re-resolved after callback"),
                    Result.Data->TryGetBoolField(TEXT("target_re_resolved"), bReResolved)
                    && bReResolved);
                TestTrue(TEXT("dirty request reports the broadcast boundary"),
                    Result.Data->TryGetBoolField(TEXT("dirty_marked"), bDirtyMarked)
                    && bDirtyMarked);
                TestTrue(TEXT("post-callback mutation is not falsely verified"),
                    Result.Data->TryGetBoolField(TEXT("verified"), bVerified)
                    && !bVerified);
                TestTrue(TEXT("unknown callback outcome is a nested logical failure"),
                    Result.Data->TryGetBoolField(TEXT("ok"), bNestedOk)
                    && !bNestedOk);
                TestEqual(TEXT("unknown callback outcome has a stable error"),
                    Result.Data->GetStringField(TEXT("error")),
                    FString(TEXT("data_set_unknown_outcome: scalar copy completed, but final target re-resolution, verification, or dirty marking was not trustworthy; read back the target before retrying or saving")));
                const TSharedPtr<FJsonValue> Observed =
                    Result.Data->TryGetField(TEXT("observed_value"));
                TestTrue(TEXT("observed value comes from after the callback"),
                    Observed.IsValid()
                    && Observed->Type == EJson::Boolean
                    && !Observed->AsBool());

                FHaybaMCPSettings& Settings = FHaybaMCPSettings::Get();
                const EHaybaMCPAdvisoryVerbosity OriginalVerbosity =
                    Settings.AdvisoryVerbosity;
                ON_SCOPE_EXIT
                {
                    Settings.AdvisoryVerbosity = OriginalVerbosity;
                };
                Settings.AdvisoryVerbosity =
                    EHaybaMCPAdvisoryVerbosity::ErrorsOnly;
                const TSharedPtr<FJsonObject> Envelope = ParseResponseEnvelope(
                    FHaybaMCPCommandHandler::MakeOkResponse(
                        TEXT("data-set-callback"), Result.Data, TEXT("data_set")));
                TestTrue(TEXT("unknown callback envelope parses"),
                    Envelope.IsValid());
                if (Envelope.IsValid())
                {
                    TestFalse(TEXT("unknown callback cannot remain top-level ok:true"),
                        Envelope->GetBoolField(TEXT("ok")));
                    TestEqual(TEXT("unknown callback is classified unknown_outcome"),
                        Envelope->GetObjectField(TEXT("advisory"))->GetStringField(TEXT("state")),
                        FString(TEXT("unknown_outcome")));
                    TestTrue(TEXT("ErrorsOnly keeps mandatory recovery"),
                        Envelope->GetObjectField(TEXT("advisory"))->HasField(TEXT("next_action")));
                    TestTrue(TEXT("structured observed data survives failure shaping"),
                        Envelope->GetObjectField(TEXT("data"))->HasField(TEXT("observed_value")));
                }
            }
            TestFalse(TEXT("dirty-callback probe never reaches disk"),
                FPackageName::DoesPackageExist(CallbackPackageName));
            CallbackPackage->SetDirtyFlag(false);
            CallbackAsset->MarkAsGarbage();
        }
    }

    // Ordinary direct bool assignment is the positive control: no callback
    // invalidates it, so bounded post-dirty readback produces nested and
    // top-level success without entering JsonObjectConverter/ImportText.
    {
        const FString SuccessProbeName =
            TEXT("DA_HCR_DATA_005_DirectScalarSuccess");
        const FString SuccessPackageName =
            TEXT("/Game/__HaybaNativeTests/") + SuccessProbeName;
        UPackage* SuccessPackage = CreatePackage(*SuccessPackageName);
        UPrimaryAssetLabel* SuccessAsset = NewObject<UPrimaryAssetLabel>(
            SuccessPackage, *SuccessProbeName, RF_NoFlags);
        TestNotNull(TEXT("direct-scalar success probe was created"), SuccessAsset);
        if (SuccessAsset)
        {
            SuccessAsset->bIsRuntimeLabel = false;
            SuccessPackage->SetDirtyFlag(false);
            TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
            Params->SetStringField(TEXT("path"), SuccessAsset->GetPathName());
            Params->SetStringField(TEXT("property_name"), TEXT("bIsRuntimeLabel"));
            Params->SetBoolField(TEXT("value"), true);
            const FHaybaHandlerResult Result =
                Handler.Handle(TEXT("data_set"), Params);
            TestTrue(TEXT("direct bool write returns shaped handler data"),
                Result.bOk && Result.Data.IsValid());
            if (Result.bOk && Result.Data.IsValid())
            {
                bool bNestedOk = false;
                bool bVerified = false;
                TestTrue(TEXT("direct bool write is trustworthy"),
                    Result.Data->TryGetBoolField(TEXT("ok"), bNestedOk)
                    && bNestedOk);
                TestTrue(TEXT("direct bool write verifies fresh readback"),
                    Result.Data->TryGetBoolField(TEXT("verified"), bVerified)
                    && bVerified);
                TestTrue(TEXT("copy completion is named independently of outcome"),
                    Result.Data->GetBoolField(TEXT("copy_completed")));
                const TSharedPtr<FJsonObject> Envelope = ParseResponseEnvelope(
                    FHaybaMCPCommandHandler::MakeOkResponse(
                        TEXT("data-set-success"), Result.Data, TEXT("data_set")));
                TestTrue(TEXT("verified direct scalar stays top-level success"),
                    Envelope.IsValid() && Envelope->GetBoolField(TEXT("ok")));
            }
            TestTrue(TEXT("direct typed setter changed the bool"),
                !!SuccessAsset->bIsRuntimeLabel);
            TestFalse(TEXT("direct-scalar probe never reaches disk"),
                FPackageName::DoesPackageExist(SuccessPackageName));
            SuccessPackage->SetDirtyFlag(false);
            SuccessAsset->MarkAsGarbage();
        }
    }

    // Num() is not a traversal bound for UE's sparse script containers. Build
    // real sparse storage with 512 live entries behind 2,048 physical slots and
    // exercise the exact guard used before data_get iteration. data_set now
    // rejects every container before staging, so no set/map CopyCompleteValue
    // path remains; this guard also makes any future reuse fail closed.
    {
        uint64 Parsed = 0;
        TestTrue(TEXT("maximum uint64 canonical decimal is accepted exactly"),
            HaybaMCPDataAssetTestHooks::ParseExactUnsignedDecimal(
                TEXT("18446744073709551615"), Parsed));
        TestEqual(TEXT("maximum uint64 does not round through double"),
            Parsed, MAX_uint64);
        TestFalse(TEXT("uint64 overflow is refused"),
            HaybaMCPDataAssetTestHooks::ParseExactUnsignedDecimal(
                TEXT("18446744073709551616"), Parsed));

        UEnum* SignedEnum = NewObject<UEnum>(GetTransientPackage());
        TestNotNull(TEXT("signed enum resolver fixture was created"), SignedEnum);
        if (SignedEnum)
        {
            TArray<TPair<FName, int64>> Names = {
                { FName(*(SignedEnum->GetName() + TEXT("::MinusOne"))), -1 },
                { FName(*(SignedEnum->GetName() + TEXT("::Zero"))), 0 },
            };
            TestTrue(TEXT("signed enum resolver fixture was initialized"),
                SignedEnum->SetEnums(
                    Names, UEnum::ECppForm::EnumClass, EEnumFlags::None, false));
            int64 Resolved = 0;
            FString Reason;
            const FString AuthoredMinusOne =
                SignedEnum->GetAuthoredNameStringByIndex(0);
            TestTrue(TEXT("valid enum value -1 resolves by index, not failure sentinel"),
                HaybaMCPDataAssetTestHooks::ResolveEnumString(
                    SignedEnum, AuthoredMinusOne, Resolved, Reason));
            TestEqual(TEXT("valid enum -1 round-trips exactly"), Resolved, int64(-1));
        }

        UEnum* FlagsEnum = NewObject<UEnum>(GetTransientPackage());
        TestNotNull(TEXT("enum flags resolver fixture was created"), FlagsEnum);
        if (FlagsEnum)
        {
            TArray<TPair<FName, int64>> Names = {
                { FName(*(FlagsEnum->GetName() + TEXT("::First"))), 1 },
                { FName(*(FlagsEnum->GetName() + TEXT("::Second"))), 2 },
            };
            TestTrue(TEXT("enum flags resolver fixture was initialized"),
                FlagsEnum->SetEnums(
                    Names, UEnum::ECppForm::EnumClass, EEnumFlags::Flags, false));
            int64 Resolved = 0;
            FString Reason;
            const FString First = FlagsEnum->GetAuthoredNameStringByIndex(0);
            const FString Second = FlagsEnum->GetAuthoredNameStringByIndex(1);
            TestTrue(TEXT("authored enum flag list resolves token by token"),
                HaybaMCPDataAssetTestHooks::ResolveEnumString(
                    FlagsEnum, First + TEXT("|") + Second, Resolved, Reason));
            TestEqual(TEXT("enum flag list combines exact values"), Resolved, int64(3));
        }
    }

    {
        const FScriptSetLayout Layout =
            FScriptSet::GetScriptLayout(sizeof(int32), alignof(int32));
        FScriptSet SparseSet;
        for (int32 Index = 0; Index < 2048; ++Index)
            SparseSet.AddUninitialized(Layout);
        for (int32 Index = 0; Index < 1536; ++Index)
            SparseSet.RemoveAtUninitialized(Layout, Index);

        TestTrue(TEXT("set regression fixture is genuinely sparse"),
            SparseSet.Num() < SparseSet.GetMaxIndex());
        FString Reason;
        TestFalse(TEXT("sparse set is omitted/refused before iterator or copy"),
            HaybaMCPDataAssetTestHooks::IsReflectionTraversalBounded(
                SparseSet.Num(), SparseSet.GetMaxIndex(), TEXT("set"), Reason));
        TestTrue(TEXT("sparse set refusal names the physical traversal budget"),
            Reason.Contains(TEXT("sparse-slot traversal limit")));
        SparseSet.Empty(0, Layout);
    }
    {
        const FScriptMapLayout Layout = FScriptMap::GetScriptLayout(
            sizeof(int32), alignof(int32), sizeof(int32), alignof(int32));
        FScriptMap SparseMap;
        for (int32 Index = 0; Index < 2048; ++Index)
            SparseMap.AddUninitialized(Layout);
        for (int32 Index = 0; Index < 1536; ++Index)
            SparseMap.RemoveAtUninitialized(Layout, Index);

        TestTrue(TEXT("map regression fixture is genuinely sparse"),
            SparseMap.Num() < SparseMap.GetMaxIndex());
        FString Reason;
        TestFalse(TEXT("sparse map is omitted/refused before iterator or copy"),
            HaybaMCPDataAssetTestHooks::IsReflectionTraversalBounded(
                SparseMap.Num(), SparseMap.GetMaxIndex(), TEXT("map"), Reason));
        TestTrue(TEXT("sparse map refusal names the physical traversal budget"),
            Reason.Contains(TEXT("sparse-slot traversal limit")));
        SparseMap.Empty(0, Layout);
    }

    return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
