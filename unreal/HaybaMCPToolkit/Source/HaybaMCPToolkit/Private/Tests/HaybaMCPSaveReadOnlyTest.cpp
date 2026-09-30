// Hayba.MCP.Save.ReadOnly.*: a read-only package is refused before anything
// changes, and the one raw save can never crash the editor (spec T5).
#include "Misc/AutomationTest.h"

#if WITH_DEV_AUTOMATION_TESTS

#include "HaybaMCPSaveVerify.h"
#include "handlers/HaybaMCPBlueprintHandler.h"
#include "handlers/HaybaMCPLegacyHandler.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "CoreGlobals.h"
#include "Curves/CurveFloat.h"
#include "EditorAssetLibrary.h"
#include "Engine/Blueprint.h"
#include "Engine/BlueprintGeneratedClass.h"
#include "GameFramework/Actor.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformFileManager.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "Misc/FileHelper.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "Misc/ScopeExit.h"
#include "PCGGraph.h"
#include "UObject/Package.h"

namespace HaybaSaveReadOnlyTest
{
	const TCHAR* const Root = TEXT("/Game/__HaybaTest__/ReadOnly");
	const TCHAR* const SiblingExtensions[] = { TEXT(".umap"), TEXT(".uasset"), TEXT(".uexp"), TEXT(".ubulk"), TEXT(".uptnl"), TEXT(".m.ubulk") };

	FString Guid8()
	{
		return FGuid::NewGuid().ToString(EGuidFormats::Digits).Left(8).ToLower();
	}

	void SetReadOnly(const FString& File, bool bReadOnly)
	{
		if (!File.IsEmpty())
		{
			FPlatformFileManager::Get().GetPlatformFile().SetReadOnly(*File, bReadOnly);
		}
	}

	/** A plain UCurveFloat asset at <Root>/<Prefix>_<guid8>, in memory and dirty. */
	UObject* NewCurve(const TCHAR* Prefix)
	{
		const FString Name = FString::Printf(TEXT("%s_%s"), Prefix, *Guid8());
		UPackage* Pkg = CreatePackage(*FString::Printf(TEXT("%s/%s"), Root, *Name));
		UCurveFloat* Curve = NewObject<UCurveFloat>(Pkg, *Name, RF_Public | RF_Standalone);
		FAssetRegistryModule::AssetCreated(Curve);
		Pkg->MarkPackageDirty();
		return Curve;
	}

	/** An Actor Blueprint at <Root>/<Prefix>_<guid8>, in memory and dirty. */
	UBlueprint* NewBlueprint(const TCHAR* Prefix)
	{
		const FString Name = FString::Printf(TEXT("%s_%s"), Prefix, *Guid8());
		UPackage* Pkg = CreatePackage(*FString::Printf(TEXT("%s/%s"), Root, *Name));
		UBlueprint* BP = FKismetEditorUtilities::CreateBlueprint(AActor::StaticClass(), Pkg, *Name, BPTYPE_Normal,
			UBlueprint::StaticClass(), UBlueprintGeneratedClass::StaticClass());
		FAssetRegistryModule::AssetCreated(BP);
		Pkg->MarkPackageDirty();
		return BP;
	}

	/**
	 * One test package on disk. The constructor saves the asset (writable) so the
	 * package has a file; MakeReadOnly sets the attribute. The destructor ALWAYS
	 * clears every read-only flag and deletes the asset and its files, so a failed
	 * test never leaves a read-only file behind for the next run.
	 */
	class FScopedReadOnlyPackage
	{
	public:
		explicit FScopedReadOnlyPackage(UObject* InAsset)
			: Asset(InAsset)
			, Package(InAsset ? InAsset->GetOutermost()->GetName() : FString())
		{
			bSaved = InAsset && HaybaSaveVerify::SaveAndVerify(InAsset).DidReachDisk();
		}

		~FScopedReadOnlyPackage()
		{
			for (const TCHAR* Extension : SiblingExtensions)
			{
				SetReadOnly(File(Extension), false);
			}
			if (UObject* Live = Asset.Get())
			{
				UEditorAssetLibrary::DeleteLoadedAsset(Live);
			}
			for (const TCHAR* Extension : SiblingExtensions)
			{
				IFileManager::Get().Delete(*File(Extension), /*RequireExists=*/false, /*EvenReadOnly=*/true, /*Quiet=*/true);
			}
		}

		bool WasSaved() const { return bSaved; }

		/** Absolute path of one of the package's files, e.g. File(TEXT(".uasset")). */
		FString File(const TCHAR* Extension) const
		{
			FString Base;
			return FPackageName::TryConvertLongPackageNameToFilename(Package, Base)
				? FPaths::ConvertRelativePathToFull(Base) + Extension
				: FString();
		}

		void MakeReadOnly(const TCHAR* Extension = TEXT(".uasset")) const { SetReadOnly(File(Extension), true); }

	private:
		TWeakObjectPtr<UObject> Asset;
		FString Package;
		bool bSaved = false;
	};

	FString DataString(const FHaybaHandlerResult& R, const TCHAR* Field)
	{
		FString Value;
		if (R.Data.IsValid()) R.Data->TryGetStringField(Field, Value);
		return Value;
	}

	TArray<FString> DataFiles(const FHaybaHandlerResult& R)
	{
		TArray<FString> Out;
		const TArray<TSharedPtr<FJsonValue>>* Files = nullptr;
		if (R.Data.IsValid() && R.Data->TryGetArrayField(TEXT("read_only_files"), Files) && Files)
		{
			for (const TSharedPtr<FJsonValue>& V : *Files) Out.Add(V->AsString());
		}
		return Out;
	}

	/** A handler-level package_read_only refusal: the R3 data channel, never Err(). */
	void ExpectRefusal(FAutomationTestBase& Test, const TCHAR* Cmd, const FHaybaHandlerResult& R)
	{
		Test.TestTrue(FString::Printf(TEXT("%s: the refusal is a structured Ok result, not Err (%s)"), Cmd, *R.ErrorMessage),
			R.bOk && R.Data.IsValid());
		if (!R.Data.IsValid()) return;
		bool bOk = true;
		R.Data->TryGetBoolField(TEXT("ok"), bOk);
		Test.TestFalse(FString::Printf(TEXT("%s: data.ok is false"), Cmd), bOk);
		Test.TestEqual(FString::Printf(TEXT("%s: code"), Cmd), DataString(R, TEXT("code")), FString(TEXT("package_read_only")));
		Test.TestEqual(FString::Printf(TEXT("%s: phase"), Cmd), DataString(R, TEXT("phase")), FString(TEXT("preflight")));
		Test.TestEqual(FString::Printf(TEXT("%s: mutation_status"), Cmd), DataString(R, TEXT("mutation_status")), FString(TEXT("not_started")));
		Test.TestEqual(FString::Printf(TEXT("%s: failure_kind"), Cmd), DataString(R, TEXT("failure_kind")), FString(TEXT("policy_blocked")));
		Test.TestTrue(FString::Printf(TEXT("%s: error starts with '<cmd> [package_read_only]: '"), Cmd),
			DataString(R, TEXT("error")).StartsWith(FString::Printf(TEXT("%s [package_read_only]: "), Cmd)));
		const FString Hint = DataString(R, TEXT("make_writable_hint"));
		Test.TestTrue(FString::Printf(TEXT("%s: the hint names git lfs lock"), Cmd), Hint.Contains(TEXT("git lfs lock")));
		Test.TestTrue(FString::Printf(TEXT("%s: the hint fits 480 characters"), Cmd), Hint.Len() <= HaybaSaveVerify::MaxHintChars);
		Test.TestTrue(FString::Printf(TEXT("%s: read_only_files is not empty"), Cmd), DataFiles(R).Num() > 0);
		bool bAttempted = true;
		R.Data->TryGetBoolField(TEXT("save_attempted"), bAttempted);
		Test.TestFalse(FString::Printf(TEXT("%s: save_attempted is false"), Cmd), bAttempted);
	}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPSaveReadOnlyFindFilesTest,
	"Hayba.MCP.Save.ReadOnly.FindReadOnlyPackageFiles",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPSaveReadOnlyFindFilesTest::RunTest(const FString& Parameters)
{
	namespace RO = HaybaSaveReadOnlyTest;
	const FString Package = FString::Printf(TEXT("%s/Files_%s"), RO::Root, *RO::Guid8());
	FString Base;
	if (!TestTrue(TEXT("the test package maps to a file"), FPackageName::TryConvertLongPackageNameToFilename(Package, Base)))
	{
		return false;
	}
	Base = FPaths::ConvertRelativePathToFull(Base);
	ON_SCOPE_EXIT
	{
		for (const TCHAR* Extension : RO::SiblingExtensions)
		{
			RO::SetReadOnly(Base + Extension, false);
			IFileManager::Get().Delete(*(Base + Extension), false, true, true);
		}
	};

	TestEqual(TEXT("R-16: a package with no files (a new asset) is not read-only"),
		HaybaSaveVerify::FindReadOnlyPackageFiles(Package).Num(), 0);
	for (const TCHAR* Extension : RO::SiblingExtensions)
	{
		FFileHelper::SaveStringToFile(TEXT("hayba"), *(Base + Extension));
	}
	TestEqual(TEXT("writable files are not reported"), HaybaSaveVerify::FindReadOnlyPackageFiles(Package).Num(), 0);

	// R-16: a read-only sibling while the header is writable.
	for (const TCHAR* Extension : { TEXT(".uexp"), TEXT(".ubulk"), TEXT(".uptnl"), TEXT(".m.ubulk") })
	{
		RO::SetReadOnly(Base + Extension, true);
		const TArray<FString> Found = HaybaSaveVerify::FindReadOnlyPackageFiles(Package);
		TestTrue(FString::Printf(TEXT("a read-only %s is reported, alone, as an absolute path"), Extension),
			Found.Num() == 1 && Found[0] == Base + Extension && !FPaths::IsRelative(Found[0]));
		RO::SetReadOnly(Base + Extension, false);
	}

	// C12: a map's header is .umap, not .uasset.
	RO::SetReadOnly(Base + TEXT(".umap"), true);
	TestTrue(TEXT("a read-only .umap is reported"), HaybaSaveVerify::FindReadOnlyPackageFiles(Package).Contains(Base + TEXT(".umap")));
	RO::SetReadOnly(Base + TEXT(".umap"), false);
	TestEqual(TEXT("PackageFilename picks .umap for a world package"), HaybaSaveVerify::PackageFilename(Package, true), Base + TEXT(".umap"));
	TestEqual(TEXT("PackageFilename picks .uasset otherwise"), HaybaSaveVerify::PackageFilename(Package, false), Base + TEXT(".uasset"));

	// The hint.
	const FString Alternative = TEXT("Or pass save:false to compile without saving.");
	const FString Hint = HaybaSaveVerify::MakeWritableHint({ Base + TEXT(".uasset") }, Alternative);
	TestTrue(TEXT("the hint fits 480 characters"), Hint.Len() <= HaybaSaveVerify::MaxHintChars);
	TestTrue(TEXT("the hint gives git lfs lock with the project-relative file"),
		Hint.Contains(TEXT("git lfs lock \"Content/__HaybaTest__/ReadOnly/Files_")));
	TestTrue(TEXT("the hint says Hayba never clears read-only flags"), Hint.Contains(TEXT("Hayba never clears read-only flags.")));
	TestTrue(TEXT("the hint ends with the no-save alternative"), Hint.EndsWith(Alternative));
	const FString LongHint = HaybaSaveVerify::MakeWritableHint({ Base + FString::ChrN(600, TEXT('x')) + TEXT(".uasset") }, Alternative);
	TestTrue(TEXT("a very long path still fits and keeps the alternative"),
		LongHint.Len() <= HaybaSaveVerify::MaxHintChars && LongHint.EndsWith(Alternative));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPSaveReadOnlySaveAndVerifyTest,
	"Hayba.MCP.Save.ReadOnly.SaveAndVerifyRefusesWithoutSaving",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPSaveReadOnlySaveAndVerifyTest::RunTest(const FString& Parameters)
{
	namespace RO = HaybaSaveReadOnlyTest;
	UCurveFloat* Curve = CastChecked<UCurveFloat>(RO::NewCurve(TEXT("Verify")));
	RO::FScopedReadOnlyPackage Fixture(Curve);
	if (!TestTrue(TEXT("the fixture reached disk"), Fixture.WasSaved())) return false;
	const FString File = Fixture.File(TEXT(".uasset"));
	const FDateTime Before = IFileManager::Get().GetTimeStamp(*File);
	Fixture.MakeReadOnly();
	Curve->FloatCurve.AddKey(0.f, 1.f);
	Curve->MarkPackageDirty();

	const HaybaSaveVerify::FResult R = HaybaSaveVerify::SaveAndVerify(Curve);
	TestTrue(TEXT("refused as read-only"), R.bRefusedReadOnly);
	TestFalse(TEXT("SavePackage was not called"), R.bSaveCallSucceeded);
	TestFalse(TEXT("nothing reached disk"), R.DidReachDisk());
	TestEqual(TEXT("save_error_code"), R.SaveErrorCode, FString(TEXT("package_read_only")));
	TestTrue(TEXT("read_only_files names the .uasset"), R.ReadOnlyFiles.Contains(File));
	TestTrue(TEXT("the note says NOT persisted"), R.Note.Contains(TEXT("NOT persisted")));
	TestFalse(TEXT("the note never claims the file was written"), R.Note.Contains(TEXT("Written to disk")));
	TestTrue(TEXT("the file on disk is unchanged"), IFileManager::Get().GetTimeStamp(*File) == Before);
	TestTrue(TEXT("the package is still dirty"), Curve->GetOutermost()->IsDirty());

	const TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
	HaybaSaveVerify::Describe(R, Out);
	TestFalse(TEXT("Describe: saved false"), Out->GetBoolField(TEXT("saved")));
	TestEqual(TEXT("Describe: save_error_code"), Out->GetStringField(TEXT("save_error_code")), FString(TEXT("package_read_only")));
	TestTrue(TEXT("Describe: make_writable_hint"), Out->GetStringField(TEXT("make_writable_hint")).Contains(TEXT("git lfs lock")));
	TestTrue(TEXT("Describe: read_only_files"), Out->HasField(TEXT("read_only_files")));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPSaveReadOnlyNoErrorTest,
	"Hayba.MCP.Save.ReadOnly.NoErrorSaveSurvivesMissedPreflight",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPSaveReadOnlyNoErrorTest::RunTest(const FString& Parameters)
{
	namespace RO = HaybaSaveReadOnlyTest;
	// The one test that reaches SavePackage on a read-only file, on purpose:
	// the engine logs this Error even under SAVE_NoError (SavePackageUtilities.cpp).
	AddExpectedError(TEXT("as it is read only"), EAutomationExpectedErrorFlags::Contains, 1);
	UCurveFloat* Curve = CastChecked<UCurveFloat>(RO::NewCurve(TEXT("NoError")));
	RO::FScopedReadOnlyPackage Fixture(Curve);
	if (!TestTrue(TEXT("the fixture reached disk"), Fixture.WasSaved())) return false;
	Fixture.MakeReadOnly();
	Curve->FloatCurve.AddKey(0.f, 2.f);
	Curve->MarkPackageDirty();

	const bool bSaved = HaybaSaveVerify::Detail::SavePackageNoError(Curve->GetOutermost(), Curve, Fixture.File(TEXT(".uasset")));
	TestFalse(TEXT("a read-only target fails softly under SAVE_NoError"), bSaved);
	TestFalse(TEXT("GIsCriticalError stays unset: no appError"), GIsCriticalError);
	TestTrue(TEXT("object lookups still work afterwards (I-3 died in StaticFindObjectFast on the next frame)"),
		StaticFindObject(UObject::StaticClass(), nullptr, *Curve->GetPathName()) == Curve);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPSaveReadOnlyBlueprintCompileTest,
	"Hayba.MCP.Save.ReadOnly.BlueprintCompileRefusesBeforeCompiling",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPSaveReadOnlyBlueprintCompileTest::RunTest(const FString& Parameters)
{
	namespace RO = HaybaSaveReadOnlyTest;
	UBlueprint* BP = RO::NewBlueprint(TEXT("BP_RO"));
	RO::FScopedReadOnlyPackage Fixture(BP);
	if (!TestTrue(TEXT("the fixture reached disk"), Fixture.WasSaved())) return false;
	FBlueprintEditorUtils::MarkBlueprintAsModified(BP);
	if (!TestEqual(TEXT("precondition: BS_Dirty"), static_cast<int32>(BP->Status.GetValue()), static_cast<int32>(BS_Dirty))) return false;
	Fixture.MakeReadOnly();

	FHaybaMCPBlueprintHandler Handler;
	TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
	Params->SetStringField(TEXT("path"), BP->GetPathName());
	Params->SetBoolField(TEXT("save"), true);
	const FHaybaHandlerResult Refused = Handler.Handle(TEXT("blueprint_compile"), Params);
	RO::ExpectRefusal(*this, TEXT("blueprint_compile"), Refused);
	TestTrue(TEXT("the hint offers save:false"),
		RO::DataString(Refused, TEXT("make_writable_hint")).EndsWith(TEXT("Or pass save:false to compile without saving.")));
	TestEqual(TEXT("BS_Dirty is kept: nothing was compiled"), static_cast<int32>(BP->Status.GetValue()), static_cast<int32>(BS_Dirty));

	Params->SetBoolField(TEXT("save"), false);
	const FHaybaHandlerResult Compiled = Handler.Handle(TEXT("blueprint_compile"), Params);
	bool bCompiled = false;
	if (Compiled.Data.IsValid()) Compiled.Data->TryGetBoolField(TEXT("compiled"), bCompiled);
	TestTrue(TEXT("save:false still compiles a read-only Blueprint"), Compiled.bOk && bCompiled);
	TestEqual(TEXT("... to BS_UpToDate"), static_cast<int32>(BP->Status.GetValue()), static_cast<int32>(BS_UpToDate));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPSaveReadOnlyCreateGraphTest,
	"Hayba.MCP.Save.ReadOnly.CreateGraphKeepsExistingGraph",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPSaveReadOnlyCreateGraphTest::RunTest(const FString& Parameters)
{
	namespace RO = HaybaSaveReadOnlyTest;
	FHaybaMCPLegacyHandler Handler;
	const FString Name = FString::Printf(TEXT("HaybaRO_%s"), *RO::Guid8());
	TSharedPtr<FJsonObject> Graph = MakeShared<FJsonObject>();
	Graph->SetArrayField(TEXT("nodes"), TArray<TSharedPtr<FJsonValue>>());
	Graph->SetArrayField(TEXT("edges"), TArray<TSharedPtr<FJsonValue>>());
	TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
	Params->SetStringField(TEXT("name"), Name);
	Params->SetObjectField(TEXT("graph"), Graph);

	const FHaybaHandlerResult First = Handler.Handle(TEXT("create_graph"), Params);
	bool bSaved = false;
	if (First.Data.IsValid()) First.Data->TryGetBoolField(TEXT("saved"), bSaved);
	if (!TestTrue(TEXT("the first create_graph creates and saves the graph"), First.bOk && bSaved)) return false;
	const FString PackageName = TEXT("/Game/Hayba/Generated/") + Name;
	const FString ObjectPath = PackageName + TEXT(".") + Name;
	UPCGGraph* Original = FindObject<UPCGGraph>(nullptr, *ObjectPath);
	if (!TestNotNull(TEXT("the graph is loaded"), Original)) return false;
	RO::FScopedReadOnlyPackage Fixture(Original);
	Fixture.MakeReadOnly();

	RO::ExpectRefusal(*this, TEXT("create_graph"), Handler.Handle(TEXT("create_graph"), Params));
	TestTrue(TEXT("the existing graph is still the package's graph"), FindObject<UPCGGraph>(nullptr, *ObjectPath) == Original);
	TestEqual(TEXT("... and was not renamed into the transient package"), Original->GetOutermost()->GetName(), PackageName);
	return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
