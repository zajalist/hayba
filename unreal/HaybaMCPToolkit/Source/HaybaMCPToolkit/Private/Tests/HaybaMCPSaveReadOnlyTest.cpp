// Hayba.MCP.Save.ReadOnly.*: a read-only package is refused before anything
// changes, and the one raw save can never crash the editor (spec T5).
#include "Misc/AutomationTest.h"

#if WITH_DEV_AUTOMATION_TESTS

#include "HaybaMCPSaveVerify.h"
#include "handlers/HaybaMCPBlueprintHandler.h"
#include "handlers/HaybaMCPLegacyHandler.h"
#include "HaybaMCPUnattendedProbe.h"
#include "HaybaMCPCommandHandler.h"
#include "HaybaMCPModule.h"
#include "HaybaMCPSettings.h"
#include "handlers/HaybaMCPAudioHandler.h"
#include "handlers/HaybaMCPDataAssetHandler.h"
#include "handlers/HaybaMCPEditorHandler.h"
#include "handlers/HaybaMCPLevelHandler.h"
#include "handlers/HaybaMCPMaterialHandler.h"
#include "handlers/HaybaMCPUIHandler.h"
#include "Editor.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/StaticMesh.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/World.h"
#include "Factories/MaterialFactoryNew.h"
#include "Factories/MaterialFunctionFactoryNew.h"
#include "FileHelpers.h"
#include "Materials/Material.h"
#include "Materials/MaterialFunction.h"
#include "Materials/MaterialInstanceConstant.h"
#include "Modules/ModuleManager.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Sound/SoundAttenuation.h"
#include "WidgetBlueprint.h"
#include "Engine/Level.h"
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
	FString Str(const TSharedPtr<FJsonObject>& Object, const TCHAR* Field)
	{
		FString Value;
		if (Object.IsValid()) Object->TryGetStringField(Field, Value);
		return Value;
	}

	/** One request through the router (ProcessCommand), as a TCP client sends it. */
	TSharedPtr<FJsonObject> SendCommand(FAutomationTestBase& Test, const FString& Cmd, const TSharedPtr<FJsonObject>& Params, int32 ConnId)
	{
		FHaybaMCPModule* Module = FModuleManager::GetModulePtr<FHaybaMCPModule>(TEXT("HaybaMCPToolkit"));
		const TSharedPtr<FHaybaMCPCommandHandler> Router = Module ? Module->GetCommandHandler() : nullptr;
		if (!Test.TestTrue(TEXT("the command router exists"), Router.IsValid())) return MakeShared<FJsonObject>();
		TSharedPtr<FJsonObject> Envelope = MakeShared<FJsonObject>();
		Envelope->SetStringField(TEXT("cmd"), Cmd);
		Envelope->SetStringField(TEXT("id"), TEXT("save-ro-") + Guid8());
		Envelope->SetStringField(TEXT("owner"), TEXT("hayba-test-") + Guid8());
		Envelope->SetObjectField(TEXT("params"), Params);
		const FString& Auth = FHaybaMCPSettings::Get().CapabilityToken;
		if (!Auth.IsEmpty()) Envelope->SetStringField(TEXT("auth"), Auth);
		FString Json;
		const TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
			TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Json);
		FJsonSerializer::Serialize(Envelope.ToSharedRef(), Writer);
		TSharedPtr<FJsonObject> Reply;
		const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Router->ProcessCommand(Json, ConnId));
		FJsonSerializer::Deserialize(Reader, Reply);
		return Reply.IsValid() ? Reply : MakeShared<FJsonObject>();
	}

	/** Plan Mode off for the test (python_run and blueprint_compile are plan-gated). */
	class FScopedPlanModeOff
	{
	public:
		FScopedPlanModeOff() : bWas(FHaybaMCPSettings::Get().bPlanModeEnabled) { FHaybaMCPSettings::Get().bPlanModeEnabled = false; }
		~FScopedPlanModeOff() { FHaybaMCPSettings::Get().bPlanModeEnabled = bWas; }

	private:
		bool bWas;
	};

	/**
	 * A saved test map under <Root> with one external (one-file-per-actor)
	 * actor, both on disk and clean. The destructor clears every read-only
	 * flag, loads a blank map, and deletes the map and its external actors.
	 */
	class FScopedTestMap
	{
	public:
		explicit FScopedTestMap(const TCHAR* Prefix)
			: MapName(FString::Printf(TEXT("L_%s_%s"), Prefix, *Guid8()))
			, MapPackage(FString::Printf(TEXT("%s/%s"), Root, *MapName))
		{
			TGuardValue<bool> Unattended(GIsRunningUnattendedScript, true);   // the fixture's own saves never prompt
			UWorld* NewWorld = UEditorLoadingAndSavingUtils::NewBlankMap(/*bSaveExistingMap=*/false);
			if (!NewWorld || !UEditorLoadingAndSavingUtils::SaveMap(NewWorld, MapPackage)) return;
			UWorld* Saved = World();
			Saved->PersistentLevel->SetUseExternalActors(true);
			AStaticMeshActor* Spawned = Saved->SpawnActor<AStaticMeshActor>();
			UPackage* External = Spawned ? Spawned->GetExternalPackage() : nullptr;
			if (!External) return;
			Actor = Spawned;
			bReady = UEditorLoadingAndSavingUtils::SavePackages(TArray<UPackage*>{ External }, /*bOnlyDirty=*/false)
				&& UEditorLoadingAndSavingUtils::SaveMap(Saved, MapPackage)
				&& IFileManager::Get().FileExists(*MapFile())
				&& IFileManager::Get().FileExists(*ExternalActorFile());
		}

		~FScopedTestMap()
		{
			SetReadOnly(MapFile(), false);
			SetReadOnly(ExternalActorFile(), false);
			UEditorLoadingAndSavingUtils::NewBlankMap(/*bSaveExistingMap=*/false);
			UEditorAssetLibrary::DeleteAsset(MapPackage);
			IFileManager::Get().Delete(*MapFile(), false, true, true);
			IFileManager::Get().DeleteDirectory(*ExternalActorsDir(), false, true);
		}

		bool IsReady() const { return bReady; }
		UWorld* World() const { return GEditor->GetEditorWorldContext().World(); }
		AActor* GetActor() const { return Actor.Get(); }
		FString MapFile() const { return HaybaSaveVerify::PackageFilename(MapPackage, /*bIsMap=*/true); }
		FString ExternalActorFile() const
		{
			const UPackage* External = Actor.IsValid() ? Actor->GetExternalPackage() : nullptr;
			return External ? HaybaSaveVerify::PackageFilename(External->GetName(), /*bIsMap=*/false) : FString();
		}
		FString ExternalActorsDir() const
		{
			return FPaths::ConvertRelativePathToFull(FPaths::ProjectContentDir() / TEXT("__ExternalActors__/__HaybaTest__/ReadOnly") / MapName);
		}
		void MarkMapDirty() const { World()->PersistentLevel->MarkPackageDirty(); }
		void MarkMapClean() const { World()->PersistentLevel->GetOutermost()->SetDirtyFlag(false); }

	private:
		FString MapName;
		FString MapPackage;
		TWeakObjectPtr<AActor> Actor;
		bool bReady = false;
	};
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
	TestTrue(TEXT("object lookups still work after a refused read-only save"),
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

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPSaveReadOnlyWidgetTest,
	"Hayba.MCP.Save.ReadOnly.WidgetSaveAndCompileRefuse",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPSaveReadOnlyWidgetTest::RunTest(const FString& Parameters)
{
	namespace RO = HaybaSaveReadOnlyTest;
	FHaybaMCPUIHandler Handler;
	TSharedPtr<FJsonObject> Create = MakeShared<FJsonObject>();
	Create->SetStringField(TEXT("path"), RO::Root);
	Create->SetStringField(TEXT("name"), FString::Printf(TEXT("WBP_RO_%s"), *RO::Guid8()));
	Create->SetStringField(TEXT("parent_class"), TEXT("UserWidget"));
	const FHaybaHandlerResult Created = Handler.Handle(TEXT("ui_create_widget"), Create);
	const FString ObjectPath = RO::DataString(Created, TEXT("path"));
	UWidgetBlueprint* WBP = ObjectPath.IsEmpty() ? nullptr : LoadObject<UWidgetBlueprint>(nullptr, *ObjectPath);
	if (!TestNotNull(TEXT("the test widget blueprint exists"), WBP)) return false;
	RO::FScopedReadOnlyPackage Fixture(WBP);
	if (!TestTrue(TEXT("the fixture reached disk"), Fixture.WasSaved())) return false;
	Fixture.MakeReadOnly();
	const bool bDirtyBefore = WBP->GetOutermost()->IsDirty();
	const int32 StatusBefore = static_cast<int32>(WBP->Status.GetValue());

	TSharedPtr<FJsonObject> Save = MakeShared<FJsonObject>();
	Save->SetStringField(TEXT("widget_blueprint_path"), ObjectPath);
	RO::ExpectRefusal(*this, TEXT("ui_save_widget"), Handler.Handle(TEXT("ui_save_widget"), Save));
	TestEqual(TEXT("ui_save_widget: nothing was reconciled or dirtied"), WBP->GetOutermost()->IsDirty(), bDirtyBefore);

	TSharedPtr<FJsonObject> Compile = MakeShared<FJsonObject>();
	Compile->SetStringField(TEXT("widget_blueprint_path"), ObjectPath);
	Compile->SetBoolField(TEXT("save_on_success"), true);
	const FHaybaHandlerResult Refused = Handler.Handle(TEXT("ui_compile_widget"), Compile);
	RO::ExpectRefusal(*this, TEXT("ui_compile_widget"), Refused);
	TestTrue(TEXT("ui_compile_widget: the hint offers save_on_success:false"),
		RO::DataString(Refused, TEXT("make_writable_hint")).EndsWith(TEXT("Or pass save_on_success:false to compile without saving.")));
	TestEqual(TEXT("ui_compile_widget: nothing was compiled"), static_cast<int32>(WBP->Status.GetValue()), StatusBefore);

	Compile->SetBoolField(TEXT("save_on_success"), false);
	TestTrue(TEXT("ui_compile_widget {save_on_success:false} still compiles a read-only widget"),
		Handler.Handle(TEXT("ui_compile_widget"), Compile).bOk);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPSaveReadOnlyMaterialTest,
	"Hayba.MCP.Save.ReadOnly.MaterialRefusesBeforeEdit",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPSaveReadOnlyMaterialTest::RunTest(const FString& Parameters)
{
	namespace RO = HaybaSaveReadOnlyTest;
	auto NewPackage = [](const TCHAR* Prefix, FString& OutName) -> UPackage*
	{
		OutName = FString::Printf(TEXT("%s_%s"), Prefix, *RO::Guid8());
		return CreatePackage(*FString::Printf(TEXT("%s/%s"), RO::Root, *OutName));
	};

	FString Name;
	UPackage* MicPkg = NewPackage(TEXT("MI_RO"), Name);
	UMaterialInstanceConstant* MIC = NewObject<UMaterialInstanceConstant>(MicPkg, *Name, RF_Public | RF_Standalone);
	MIC->SetParentEditorOnly(UMaterial::GetDefaultMaterial(MD_Surface));
	FAssetRegistryModule::AssetCreated(MIC);
	UPackage* MatPkg = NewPackage(TEXT("M_RO"), Name);
	UMaterial* Mat = Cast<UMaterial>(NewObject<UMaterialFactoryNew>()->FactoryCreateNew(
		UMaterial::StaticClass(), MatPkg, *Name, RF_Public | RF_Standalone, nullptr, GWarn));
	FAssetRegistryModule::AssetCreated(Mat);
	UPackage* FnPkg = NewPackage(TEXT("MF_RO"), Name);
	UMaterialFunction* Fn = Cast<UMaterialFunction>(NewObject<UMaterialFunctionFactoryNew>()->FactoryCreateNew(
		UMaterialFunction::StaticClass(), FnPkg, *Name, RF_Public | RF_Standalone, nullptr, GWarn));
	FAssetRegistryModule::AssetCreated(Fn);

	RO::FScopedReadOnlyPackage MicFixture(MIC);
	RO::FScopedReadOnlyPackage MatFixture(Mat);
	RO::FScopedReadOnlyPackage FnFixture(Fn);
	if (!TestTrue(TEXT("the fixtures reached disk"), MicFixture.WasSaved() && MatFixture.WasSaved() && FnFixture.WasSaved())) return false;
	MicFixture.MakeReadOnly();
	MatFixture.MakeReadOnly();
	FnFixture.MakeReadOnly();

	FHaybaMCPMaterialHandler Handler;
	TSharedPtr<FJsonObject> SetParam = MakeShared<FJsonObject>();
	SetParam->SetStringField(TEXT("instance_path"), MIC->GetPathName());
	SetParam->SetStringField(TEXT("param_name"), TEXT("HaybaNoSuchParam"));
	SetParam->SetNumberField(TEXT("value"), 0.5);
	RO::ExpectRefusal(*this, TEXT("material_set_param"), Handler.Handle(TEXT("material_set_param"), SetParam));
	TestFalse(TEXT("material_set_param: the refusal precedes MIC->Modify()"), MIC->GetOutermost()->IsDirty());

	TSharedPtr<FJsonObject> CompileFn = MakeShared<FJsonObject>();
	CompileFn->SetStringField(TEXT("function_path"), Fn->GetPathName());
	RO::ExpectRefusal(*this, TEXT("material_compile"), Handler.Handle(TEXT("material_compile"), CompileFn));
	TestFalse(TEXT("material_compile(function): refused before UpdateMaterialFunction"), Fn->GetOutermost()->IsDirty());

	TSharedPtr<FJsonObject> CompileMat = MakeShared<FJsonObject>();
	CompileMat->SetStringField(TEXT("material_path"), Mat->GetPathName());
	RO::ExpectRefusal(*this, TEXT("material_compile"), Handler.Handle(TEXT("material_compile"), CompileMat));
	TestFalse(TEXT("material_compile(material): refused before RecompileMaterial"), Mat->GetOutermost()->IsDirty());
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPSaveReadOnlyAudioAndSaveAllTest,
	"Hayba.MCP.Save.ReadOnly.AudioAndSaveAllRefuse",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPSaveReadOnlyAudioAndSaveAllTest::RunTest(const FString& Parameters)
{
	namespace RO = HaybaSaveReadOnlyTest;
	const FString AttName = FString::Printf(TEXT("ATT_RO_%s"), *RO::Guid8());
	UPackage* AttPkg = CreatePackage(*FString::Printf(TEXT("%s/%s"), RO::Root, *AttName));
	USoundAttenuation* Att = NewObject<USoundAttenuation>(AttPkg, *AttName, RF_Public | RF_Standalone);
	FAssetRegistryModule::AssetCreated(Att);
	RO::FScopedReadOnlyPackage AttFixture(Att);
	UObject* Other = RO::NewCurve(TEXT("SaveAllOther"));
	RO::FScopedReadOnlyPackage OtherFixture(Other);
	if (!TestTrue(TEXT("the fixtures reached disk"), AttFixture.WasSaved() && OtherFixture.WasSaved())) return false;
	AttFixture.MakeReadOnly();
	Att->MarkPackageDirty();
	Other->MarkPackageDirty();   // writable and dirty: save-all must not save it either

	FHaybaMCPAudioHandler Audio;
	TSharedPtr<FJsonObject> AudioSave = MakeShared<FJsonObject>();
	AudioSave->SetStringField(TEXT("path"), Att->GetPathName());
	RO::ExpectRefusal(*this, TEXT("audio_asset_save"), Audio.Handle(TEXT("audio_asset_save"), AudioSave));

	FHaybaMCPEditorHandler Editor;
	TSharedPtr<FJsonObject> SaveAll = MakeShared<FJsonObject>();
	SaveAll->SetBoolField(TEXT("quit"), false);
	RO::ExpectRefusal(*this, TEXT("editor_save_all_and_quit"), Editor.Handle(TEXT("editor_save_all_and_quit"), SaveAll));
	TestTrue(TEXT("save-all: the read-only package is still dirty"), Att->GetOutermost()->IsDirty());
	TestTrue(TEXT("save-all: nothing was saved, not even the writable package"), Other->GetOutermost()->IsDirty());

	// Positive helper paths prove both the unattended scope and persistence.
	RO::SetReadOnly(AttFixture.File(TEXT(".uasset")), false);
	{
		HaybaMCPUnattendedProbe::FScopedRecorder Probe;
		const FHaybaHandlerResult Saved = Audio.Handle(TEXT("audio_asset_save"), AudioSave);
		TestTrue(TEXT("writable audio saves"), Saved.bOk);
		TestFalse(TEXT("audio package is clean after save"), AttPkg->IsDirty());
		TestTrue(TEXT("audio helper ran unattended"), Probe.Records.Num() == 1
			&& Probe.Records[0].Site == TEXT("audio_asset_save") && Probe.Records[0].bUnattended);
	}
	{
		HaybaMCPUnattendedProbe::FScopedRecorder Probe;
		const FHaybaHandlerResult Saved = Editor.Handle(TEXT("editor_save_all_and_quit"), SaveAll);
		TestTrue(TEXT("writable save-all succeeds without scheduling quit"), Saved.bOk);
		TestFalse(TEXT("save-all persisted the other package"), Other->GetOutermost()->IsDirty());
		TestTrue(TEXT("save-all helper ran unattended"), Probe.Records.Num() == 1
			&& Probe.Records[0].Site == TEXT("editor_save_all_and_quit") && Probe.Records[0].bUnattended);
	}
	{
		const FString Name = TEXT("DA_Unattended_") + RO::Guid8();
		const FString ObjectPath = FString(RO::Root) / Name + TEXT(".") + Name;
		ON_SCOPE_EXIT { if (UEditorAssetLibrary::DoesAssetExist(ObjectPath)) UEditorAssetLibrary::DeleteAsset(ObjectPath); };
		TSharedPtr<FJsonObject> Create = MakeShared<FJsonObject>();
		Create->SetStringField(TEXT("path"), RO::Root);
		Create->SetStringField(TEXT("name"), Name);
		Create->SetStringField(TEXT("class_name"), TEXT("/Script/Engine.PrimaryAssetLabel"));
		HaybaMCPUnattendedProbe::FScopedRecorder Probe;
		FHaybaMCPDataAssetHandler Data;
		const FHaybaHandlerResult Created = Data.Handle(TEXT("data_create"), Create);
		UObject* Asset = LoadObject<UObject>(nullptr, *ObjectPath);
		TestTrue(TEXT("data_create persists its new asset"), Created.bOk && Asset
			&& !Asset->GetOutermost()->IsDirty() && FPackageName::DoesPackageExist(Asset->GetOutermost()->GetName()));
		TestTrue(TEXT("data_create helper ran unattended"), Probe.Records.Num() == 1
			&& Probe.Records[0].Site == TEXT("data_create") && Probe.Records[0].bUnattended);
	}
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPSaveReadOnlyLevelTest,
	"Hayba.MCP.Save.ReadOnly.LevelSaveRefusesWithoutModal",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPSaveReadOnlyLevelTest::RunTest(const FString& Parameters)
{
	namespace RO = HaybaSaveReadOnlyTest;
	RO::FScopedTestMap Map(TEXT("Level"));
	if (!TestTrue(TEXT("the test map and its external actor are on disk"), Map.IsReady())) return false;
	FHaybaMCPLevelHandler Handler;
	const TSharedPtr<FJsonObject> NoParams = MakeShared<FJsonObject>();

	// (a) A dirty map whose .umap is read-only.
	Map.MarkMapDirty();
	RO::SetReadOnly(Map.MapFile(), true);
	{
		HaybaMCPUnattendedProbe::FScopedRecorder Probe;
		const FHaybaHandlerResult R = Handler.Handle(TEXT("level_save"), NoParams);
		RO::ExpectRefusal(*this, TEXT("level_save"), R);
		TestTrue(TEXT("(a) read_only_files names the .umap"), RO::DataFiles(R).Contains(Map.MapFile()));
		TestEqual(TEXT("(a) SaveCurrentLevel was never reached"), Probe.Records.Num(), 0);
		TestTrue(TEXT("(a) the map is still dirty"), Map.World()->PersistentLevel->GetOutermost()->IsDirty());
	}
	RO::SetReadOnly(Map.MapFile(), false);

	// (b) R-16: a clean map, and a dirty external actor package that is read-only.
	Map.MarkMapClean();
	Map.GetActor()->MarkPackageDirty();
	RO::SetReadOnly(Map.ExternalActorFile(), true);
	{
		HaybaMCPUnattendedProbe::FScopedRecorder Probe;
		const FHaybaHandlerResult R = Handler.Handle(TEXT("level_save"), NoParams);
		RO::ExpectRefusal(*this, TEXT("level_save"), R);
		TestTrue(TEXT("(b) read_only_files names the external actor package"), RO::DataFiles(R).Contains(Map.ExternalActorFile()));
		TestEqual(TEXT("(b) SaveCurrentLevel was never reached"), Probe.Records.Num(), 0);
	}
	RO::SetReadOnly(Map.ExternalActorFile(), false);

	// (c) Writable: the save runs, unattended. Under -unattended, SaveCurrentLevel
	// without GIsRunningUnattendedScript answers PR_Cancelled (FileHelpers.cpp
	// PromptForCheckoutAndSave), so this also fails when the guard is missing.
	{
		HaybaMCPUnattendedProbe::FScopedRecorder Probe;
		const FHaybaHandlerResult R = Handler.Handle(TEXT("level_save"), NoParams);
		TestTrue(FString::Printf(TEXT("(c) level_save on writable files succeeds (%s)"), *R.ErrorMessage), R.bOk);
		TestTrue(TEXT("(c) SaveCurrentLevel ran once, with GIsRunningUnattendedScript set"),
			Probe.Records.Num() == 1 && Probe.Records[0].Site == TEXT("level_save") && Probe.Records[0].bUnattended);
		TestFalse(TEXT("(c) the external actor package was saved"), Map.GetActor()->GetExternalPackage()->IsDirty());
	}

	// (d) The deliberate departure from spec T5 Task B: a clean map whose .umap is
	// read-only does not block a dirty, writable external actor package, because
	// SaveCurrentLevel only writes a dirty or newly created level package
	// (FileHelpers.cpp:4438).
	Map.MarkMapClean();
	Map.GetActor()->MarkPackageDirty();
	RO::SetReadOnly(Map.MapFile(), true);
	{
		HaybaMCPUnattendedProbe::FScopedRecorder Probe;
		const FDateTime MapStamp = IFileManager::Get().GetTimeStamp(*Map.MapFile());
		const FHaybaHandlerResult R = Handler.Handle(TEXT("level_save"), NoParams);
		TestTrue(FString::Printf(TEXT("(d) a clean read-only map does not refuse the save (%s)"), *R.ErrorMessage), R.bOk);
		TestEqual(TEXT("(d) SaveCurrentLevel ran once"), Probe.Records.Num(), 1);
		TestFalse(TEXT("(d) the external actor package was saved"), Map.GetActor()->GetExternalPackage()->IsDirty());
		TestTrue(TEXT("(d) the read-only .umap was not rewritten"), IFileManager::Get().GetTimeStamp(*Map.MapFile()) == MapStamp);
	}
	RO::SetReadOnly(Map.MapFile(), false);
	// SaveLevel expects a filesystem filename, not a long package name.
	{
		const FString Package = FString(RO::Root) / (TEXT("L_Create_") + RO::Guid8());
		const FString File = HaybaSaveVerify::PackageFilename(Package, true);
		ON_SCOPE_EXIT
		{
			UEditorLoadingAndSavingUtils::NewBlankMap(false);
			if (UEditorAssetLibrary::DoesAssetExist(Package)) UEditorAssetLibrary::DeleteAsset(Package);
			IFileManager::Get().Delete(*File, false, true, true);
		};
		TSharedPtr<FJsonObject> Create = MakeShared<FJsonObject>();
		Create->SetStringField(TEXT("path"), Package);
		HaybaMCPUnattendedProbe::FScopedRecorder Probe;
		const FHaybaHandlerResult Created = Handler.Handle(TEXT("level_create"), Create);
		TestTrue(TEXT("level_create persists its new map in project Content"), Created.bOk
			&& IFileManager::Get().FileExists(*File) && FPackageName::DoesPackageExist(Package)
			&& File.StartsWith(FPaths::ConvertRelativePathToFull(FPaths::ProjectContentDir())));
		TestEqual(TEXT("level_create preserves the requested asset path"), RO::DataString(Created, TEXT("path")), Package);
		TestTrue(TEXT("level_create helper ran unattended"), Probe.Records.Num() == 1
			&& Probe.Records[0].Site == TEXT("level_create") && Probe.Records[0].bUnattended);
	}
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPSaveReadOnlyPythonTest,
	"Hayba.MCP.Save.ReadOnly.PythonMapSaveReturnsWithoutModal",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPSaveReadOnlyPythonTest::RunTest(const FString& Parameters)
{
	namespace RO = HaybaSaveReadOnlyTest;
	RO::FScopedTestMap Map(TEXT("Py"));
	if (!TestTrue(TEXT("the test map is on disk"), Map.IsReady())) return false;
	RO::FScopedPlanModeOff PlanOff;
	TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
	Params->SetStringField(TEXT("script"),
		TEXT("import unreal\nprint('saved=%s' % unreal.EditorLevelLibrary.save_current_level())"));

	auto RunSave = [this, &Params](const TCHAR* What, const TCHAR* Expected)
	{
		HaybaMCPUnattendedProbe::FScopedRecorder Probe;
		const TSharedPtr<FJsonObject> Reply = RO::SendCommand(*this, TEXT("python_run"), Params, 900502);
		bool bOk = false;
		Reply->TryGetBoolField(TEXT("ok"), bOk);
		TestTrue(FString::Printf(TEXT("%s: python_run returned (%s)"), What, *RO::Str(Reply, TEXT("error"))), bOk);
		const TSharedPtr<FJsonObject>* Data = nullptr;
		const FString StdOut = Reply->TryGetObjectField(TEXT("data"), Data) && Data ? RO::Str(*Data, TEXT("stdout")) : FString();
		TestTrue(FString::Printf(TEXT("%s: the script printed %s (stdout: %s)"), What, Expected, *StdOut), StdOut.Contains(Expected));
		// RunCmd, four EvalB64 readbacks (out, err, capture meta, corruption), OkCmd, TimeoutCmd, CleanupCmd.
		TestEqual(FString::Printf(TEXT("%s: the 8 Python commands of one python_run were all probed"), What), Probe.Records.Num(), 8);
		bool bAllUnattended = Probe.Records.Num() > 0;
		for (const HaybaMCPUnattendedProbe::FRecord& Record : Probe.Records)
		{
			bAllUnattended &= Record.bUnattended && Record.Site == TEXT("python_run");
		}
		TestTrue(FString::Printf(TEXT("%s: every FPythonCommandEx carried EPythonCommandFlags::Unattended"), What), bAllUnattended);
	};

	// A read-only map: the script gets False back, and no modal hangs the run (the watchdog would kill it).
	Map.MarkMapDirty();
	RO::SetReadOnly(Map.MapFile(), true);
	const FDateTime Before = IFileManager::Get().GetTimeStamp(*Map.MapFile());
	RunSave(TEXT("read-only map"), TEXT("saved=False"));
	TestTrue(TEXT("read-only map: the .umap was not rewritten"), IFileManager::Get().GetTimeStamp(*Map.MapFile()) == Before);
	RO::SetReadOnly(Map.MapFile(), false);

	// A writable map saves. Under -unattended this proves the flag reached the
	// engine: without it SaveCurrentLevel answers PR_Cancelled and prints False.
	Map.MarkMapDirty();
	RunSave(TEXT("writable map"), TEXT("saved=True"));
	return true;
}


IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPSaveReadOnlySanitizerTest,
	"Hayba.MCP.Save.ReadOnly.SanitizerPackagesRefuseBeforeMutation",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPSaveReadOnlySanitizerTest::RunTest(const FString& Parameters)
{
	namespace RO = HaybaSaveReadOnlyTest;
	for (const bool bExternal : { false, true })
	{
		const FString Case = bExternal ? TEXT("external actor") : TEXT("map-owned actor");
		RO::FScopedTestMap Map(bExternal ? TEXT("SanitizeExternal") : TEXT("SanitizeMap"));
		if (!TestTrue(Case + TEXT(": fixture map and writable external actor exist"), Map.IsReady())) return false;
		FActorSpawnParameters Spawn;
		Spawn.bCreateActorPackage = bExternal;
		AStaticMeshActor* RepairActor = Map.World()->SpawnActor<AStaticMeshActor>(Spawn);
		if (!TestNotNull(Case + TEXT(": repair actor exists"), RepairActor)) return false;
		UStaticMeshComponent* Component = RepairActor->GetStaticMeshComponent();
		UPackage* RepairPackage = Component->GetPackage();
		UPackage* OtherPackage = Map.GetActor()->GetExternalPackage();
		UPackage* MapPackage = Map.World()->PersistentLevel->GetPackage();
		TestTrue(Case + TEXT(": actual owning package matches actor external mode"),
			bExternal ? RepairPackage == RepairActor->GetExternalPackage() : RepairPackage == MapPackage);
		{
			TGuardValue<bool> Unattended(GIsRunningUnattendedScript, true);
			if (bExternal && !TestTrue(Case + TEXT(": repair actor package saved"),
				UEditorLoadingAndSavingUtils::SavePackages({ RepairPackage }, false))) return false;
			if (!TestTrue(Case + TEXT(": map saved before adding transient reference"),
				UEditorLoadingAndSavingUtils::SaveMap(Map.World(), MapPackage->GetName()))) return false;
		}
		UStaticMesh* Mesh = NewObject<UStaticMesh>(GetTransientPackage(), NAME_None, RF_Transient);
		Component->SetStaticMesh(Mesh);
		RepairPackage->SetDirtyFlag(false);
		MapPackage->SetDirtyFlag(false);
		// A saved test map may retain PKG_NewlyCreated in this editor session.
		// Model an existing clean package: the ordinary engine save predicates
		// must exclude the repair target before the sanitizer touches it.
		RepairPackage->ClearPackageFlags(PKG_NewlyCreated);
		MapPackage->ClearPackageFlags(PKG_NewlyCreated);
		TestFalse(Case + TEXT(": repair target starts clean and existing"),
			RepairPackage->IsDirty() || RepairPackage->HasAnyPackageFlags(PKG_NewlyCreated) || UPackage::IsEmptyPackage(RepairPackage));
		OtherPackage->SetDirtyFlag(true);
		const FString RepairFile = HaybaSaveVerify::PackageFilename(RepairPackage->GetName(), !bExternal);
		const FString OtherFile = Map.ExternalActorFile();
		const FDateTime RepairStamp = IFileManager::Get().GetTimeStamp(*RepairFile);
		const FDateTime OtherStamp = IFileManager::Get().GetTimeStamp(*OtherFile);
		RO::SetReadOnly(RepairFile, true);
		ON_SCOPE_EXIT
		{
			RO::SetReadOnly(RepairFile, false);
			Component->SetStaticMesh(nullptr);
		};
		FHaybaMCPLevelHandler Handler;
		HaybaMCPUnattendedProbe::FScopedRecorder Probe;
		const FHaybaHandlerResult R = Handler.Handle(TEXT("level_save"), MakeShared<FJsonObject>());
		RO::ExpectRefusal(*this, TEXT("level_save"), R);
		TestTrue(Case + TEXT(": refusal names the clean repair package"), RO::DataFiles(R).Contains(RepairFile));
		TestEqual(Case + TEXT(": no engine save was entered"), Probe.Records.Num(), 0);
		TestTrue(Case + TEXT(": transient mesh reference is unchanged"), Component->GetStaticMesh() == Mesh);
		TestFalse(Case + TEXT(": repair package stays clean"), RepairPackage->IsDirty());
		TestFalse(Case + TEXT(": map stays clean"), MapPackage->IsDirty());
		TestTrue(Case + TEXT(": separate writable candidate stays dirty"), OtherPackage->IsDirty());
		TestTrue(Case + TEXT(": repair file unchanged"), IFileManager::Get().GetTimeStamp(*RepairFile) == RepairStamp);
		TestTrue(Case + TEXT(": separate writable file unchanged"), IFileManager::Get().GetTimeStamp(*OtherFile) == OtherStamp);
		// Once writable, the same planned repair must still run and persist.
		RO::SetReadOnly(RepairFile, false);
		Probe.Records.Reset();
		const FHaybaHandlerResult Saved = Handler.Handle(TEXT("level_save"), MakeShared<FJsonObject>());
		TestTrue(Case + TEXT(": writable repair save succeeds"), Saved.bOk && Saved.Data.IsValid()
			&& Saved.Data->GetBoolField(TEXT("saved")));
		TestTrue(Case + TEXT(": writable repair runs unattended"), Probe.Records.Num() == 1
			&& Probe.Records[0].Site == TEXT("level_save") && Probe.Records[0].bUnattended);
		TestNull(Case + TEXT(": writable transient reference was repaired"), Component->GetStaticMesh());
		TestFalse(Case + TEXT(": writable repair persisted"), RepairPackage->IsDirty());
		TestFalse(Case + TEXT(": writable separate candidate persisted"), OtherPackage->IsDirty());
	}
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPSaveReadOnlyEnvelopeTest,
	"Hayba.MCP.Save.ReadOnly.EnvelopeCarriesCodeAndHint",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPSaveReadOnlyEnvelopeTest::RunTest(const FString& Parameters)
{
	namespace RO = HaybaSaveReadOnlyTest;
	RO::FScopedPlanModeOff PlanOff;
	TGuardValue<EHaybaMCPAdvisoryVerbosity> ErrorsOnly(FHaybaMCPSettings::Get().AdvisoryVerbosity, EHaybaMCPAdvisoryVerbosity::ErrorsOnly);
	UBlueprint* BP = RO::NewBlueprint(TEXT("BP_Env"));
	RO::FScopedReadOnlyPackage Fixture(BP);
	if (!TestTrue(TEXT("the fixture reached disk"), Fixture.WasSaved())) return false;
	FBlueprintEditorUtils::MarkBlueprintAsModified(BP);
	Fixture.MakeReadOnly();

	TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
	Params->SetStringField(TEXT("path"), BP->GetPathName());
	Params->SetBoolField(TEXT("save"), true);
	const TSharedPtr<FJsonObject> Reply = RO::SendCommand(*this, TEXT("blueprint_compile"), Params, 900503);

	bool bOk = true;
	Reply->TryGetBoolField(TEXT("ok"), bOk);
	TestFalse(TEXT("envelope ok is false"), bOk);
	TestEqual(TEXT("IsWireRefusalCode promotes data.code to the envelope code"), RO::Str(Reply, TEXT("code")), FString(TEXT("package_read_only")));
	TestTrue(TEXT("the envelope error carries [package_read_only]"), RO::Str(Reply, TEXT("error")).Contains(TEXT("[package_read_only]")));

	const TSharedPtr<FJsonObject>* Advisory = nullptr;
	if (TestTrue(TEXT("the envelope has an advisory"), Reply->TryGetObjectField(TEXT("advisory"), Advisory) && Advisory))
	{
		TestEqual(TEXT("advisory.state"), RO::Str(*Advisory, TEXT("state")), FString(TEXT("policy_blocked")));
		TestEqual(TEXT("advisory.mutation_status"), RO::Str(*Advisory, TEXT("mutation_status")), FString(TEXT("not_started")));
		const FString RecoveryStep = TEXT("Make the package file writable (take its source-control lock), then retry; see data.make_writable_hint. Retrying unchanged will fail again.");
		TestEqual(TEXT("advisory.next_action survives ErrorsOnly"), RO::Str(*Advisory, TEXT("next_action")), RecoveryStep);
		const TArray<TSharedPtr<FJsonValue>>* Recovery = nullptr;
		bool bNextAction = false;
		if ((*Advisory)->TryGetArrayField(TEXT("mandatory_recovery"), Recovery) && Recovery)
		{
			for (const TSharedPtr<FJsonValue>& Step : *Recovery)
			{
				bNextAction |= Step->AsString() == RecoveryStep;
			}
		}
		TestTrue(TEXT("the make-writable step is mandatory recovery (survives ErrorsOnly)"), bNextAction);
	}

	const TSharedPtr<FJsonObject>* Data = nullptr;
	if (TestTrue(TEXT("the envelope keeps data"), Reply->TryGetObjectField(TEXT("data"), Data) && Data))
	{
		const FString Hint = RO::Str(*Data, TEXT("make_writable_hint"));
		TestTrue(TEXT("data.make_writable_hint names git lfs lock"), Hint.Contains(TEXT("git lfs lock")));
		TestTrue(TEXT("data.make_writable_hint keeps the save:false alternative"), Hint.EndsWith(TEXT("Or pass save:false to compile without saving.")));
		const TArray<TSharedPtr<FJsonValue>>* Files = nullptr;
		TestTrue(TEXT("data.read_only_files"), (*Data)->TryGetArrayField(TEXT("read_only_files"), Files) && Files && Files->Num() > 0);
	}
	TestEqual(TEXT("nothing was compiled"), static_cast<int32>(BP->Status.GetValue()), static_cast<int32>(BS_Dirty));
	return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
