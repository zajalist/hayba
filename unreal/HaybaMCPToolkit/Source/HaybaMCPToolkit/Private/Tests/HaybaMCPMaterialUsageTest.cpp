#include "Misc/AutomationTest.h"

#if WITH_EDITOR
#include "EditorAssetLibrary.h"
#include "Materials/Material.h"
#include "PackageTools.h"
#include "handlers/HaybaMCPMaterialHandler.h"
#include "UObject/GarbageCollection.h"
#endif

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPMaterialUsageTest,
    "Hayba.MCP.Material.UsageFlags.TypedAtomicPersistent",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPMaterialUsageTest::RunTest(const FString& Parameters)
{
#if WITH_EDITOR
    const FString Name = FString::Printf(TEXT("M_Usage_%s"), *FGuid::NewGuid().ToString(EGuidFormats::Digits));
    const FString PackagePath = TEXT("/Game/HaybaMCPAutomation");
    const FString AssetPath = PackagePath / Name;
    FHaybaMCPMaterialHandler Handler;

    TSharedPtr<FJsonObject> Create = MakeShared<FJsonObject>();
    Create->SetStringField(TEXT("package_path"), PackagePath);
    Create->SetStringField(TEXT("name"), Name);
    const FHaybaHandlerResult Created = Handler.Handle(TEXT("material_create"), Create);
    if (!TestTrue(TEXT("scratch material is created and saved"), Created.bOk && Created.Data.IsValid())) return true;
    const FString ObjectPath = Created.Data->GetStringField(TEXT("path"));
    UMaterial* Material = LoadObject<UMaterial>(nullptr, *ObjectPath);
    if (!TestNotNull(TEXT("scratch material loads"), Material)) return true;
    UPackage* MaterialPackage = Material->GetOutermost();

    auto SetProperties = [&](const TSharedPtr<FJsonObject>& Properties)
    {
        TSharedPtr<FJsonObject> Request = MakeShared<FJsonObject>();
        Request->SetStringField(TEXT("material_path"), ObjectPath);
        Request->SetObjectField(TEXT("properties"), Properties);
        return Handler.Handle(TEXT("material_set_property"), Request);
    };

    // Wrong token categories, unknown usage-looking names, and mixed invalid
    // requests must be rejected before the material or package is touched.
    TArray<TSharedPtr<FJsonValue>> WrongValues = {
        MakeShared<FJsonValueString>(TEXT("true")),
        MakeShared<FJsonValueNumber>(1.0),
        MakeShared<FJsonValueNull>(),
        MakeShared<FJsonValueArray>(TArray<TSharedPtr<FJsonValue>>{}),
        MakeShared<FJsonValueObject>(MakeShared<FJsonObject>()),
    };
    const bool bDirtyBeforeRejectedRequests = MaterialPackage->IsDirty();
    for (const TSharedPtr<FJsonValue>& Wrong : WrongValues)
    {
        TSharedPtr<FJsonObject> WrongCompatibilityType = MakeShared<FJsonObject>();
        WrongCompatibilityType->SetStringField(TEXT("bUsedWithSplineMeshes"), TEXT("true"));
        TestFalse(TEXT("historical spline spelling remains strictly boolean"), SetProperties(WrongCompatibilityType).bOk);

        TSharedPtr<FJsonObject> Properties = MakeShared<FJsonObject>();
        Properties->SetField(TEXT("used_with_spline_meshes"), Wrong);
        TestFalse(TEXT("wrong JSON token category is rejected"), SetProperties(Properties).bOk);
        TestFalse(TEXT("wrong-type rejection does not set spline usage"), Material->GetUsageByFlag(MATUSAGE_SplineMesh));
    }
    TestEqual(TEXT("wrong-type requests do not alter package dirty state"), MaterialPackage->IsDirty(), bDirtyBeforeRejectedRequests);
    {
        TSharedPtr<FJsonObject> Properties = MakeShared<FJsonObject>();
        Properties->SetBoolField(TEXT("used_with_spline_meshes"), true);
        Properties->SetBoolField(TEXT("used_with_hovercrafts"), true);
        TestFalse(TEXT("mixed valid and unknown usage is rejected atomically"), SetProperties(Properties).bOk);
        TestFalse(TEXT("mixed rejection does not partially set spline usage"), Material->GetUsageByFlag(MATUSAGE_SplineMesh));
    }
    {
        TSharedPtr<FJsonObject> Properties = MakeShared<FJsonObject>();
        Properties->SetBoolField(TEXT("bUsedWithSplineMeshes"), true);
        const FHaybaHandlerResult CompatibilitySet = SetProperties(Properties);
        TestTrue(TEXT("historical spline property spelling routes through typed usage API"), CompatibilitySet.bOk);
        TestTrue(TEXT("compatibility spelling sets spline usage"), Material->GetUsageByFlag(MATUSAGE_SplineMesh));
        if (CompatibilitySet.Data.IsValid())
            TestEqual(TEXT("compatibility response canonicalizes applied key"),
                CompatibilitySet.Data->GetArrayField(TEXT("applied"))[0]->AsString(), FString(TEXT("used_with_spline_meshes")));

        TSharedPtr<FJsonObject> Reset = MakeShared<FJsonObject>();
        Reset->SetBoolField(TEXT("used_with_spline_meshes"), false);
        TestTrue(TEXT("spline usage resets after compatibility check"), SetProperties(Reset).bOk);
    }
    {
        TSharedPtr<FJsonObject> DuplicateAliases = MakeShared<FJsonObject>();
        DuplicateAliases->SetBoolField(TEXT("used_with_spline_meshes"), true);
        DuplicateAliases->SetBoolField(TEXT("bUsedWithSplineMeshes"), false);
        TestFalse(TEXT("duplicate spline aliases are rejected atomically"), SetProperties(DuplicateAliases).bOk);
        TestFalse(TEXT("duplicate alias rejection leaves spline usage unchanged"), Material->GetUsageByFlag(MATUSAGE_SplineMesh));
    }
    TestFalse(TEXT("empty properties are rejected"), SetProperties(MakeShared<FJsonObject>()).bOk);

    {
        TSharedPtr<FJsonObject> AlreadyFalse = MakeShared<FJsonObject>();
        AlreadyFalse->SetBoolField(TEXT("used_with_spline_meshes"), false);
        const bool bDirtyBeforeNoOp = MaterialPackage->IsDirty();
        const FHaybaHandlerResult InitialNoOp = SetProperties(AlreadyFalse);
        TestTrue(TEXT("clean idempotent false request succeeds"), InitialNoOp.bOk);
        TestEqual(TEXT("clean no-op does not alter package dirty state"), MaterialPackage->IsDirty(), bDirtyBeforeNoOp);
    }

    struct FUsageSpec { const TCHAR* Key; EMaterialUsage Usage; };
    const FUsageSpec UsageSpecs[] = {
        { TEXT("used_with_skeletal_meshes"), MATUSAGE_SkeletalMesh },
        { TEXT("used_with_particle_sprites"), MATUSAGE_ParticleSprites },
        { TEXT("used_with_beam_trails"), MATUSAGE_BeamTrails },
        { TEXT("used_with_mesh_particles"), MATUSAGE_MeshParticles },
        { TEXT("used_with_static_lighting"), MATUSAGE_StaticLighting },
        { TEXT("used_with_morph_targets"), MATUSAGE_MorphTargets },
        { TEXT("used_with_spline_meshes"), MATUSAGE_SplineMesh },
        { TEXT("used_with_instanced_static_meshes"), MATUSAGE_InstancedStaticMeshes },
        { TEXT("used_with_geometry_collections"), MATUSAGE_GeometryCollections },
        { TEXT("used_with_clothing"), MATUSAGE_Clothing },
        { TEXT("used_with_niagara_sprites"), MATUSAGE_NiagaraSprites },
        { TEXT("used_with_niagara_ribbons"), MATUSAGE_NiagaraRibbons },
        { TEXT("used_with_niagara_mesh_particles"), MATUSAGE_NiagaraMeshParticles },
        { TEXT("used_with_geometry_cache"), MATUSAGE_GeometryCache },
        { TEXT("used_with_water"), MATUSAGE_Water },
        { TEXT("used_with_hair_strands"), MATUSAGE_HairStrands },
        { TEXT("used_with_lidar_point_cloud"), MATUSAGE_LidarPointCloud },
        { TEXT("used_with_nanite"), MATUSAGE_Nanite },
        { TEXT("used_with_voxels"), MATUSAGE_Voxels },
        { TEXT("used_with_volumetric_cloud"), MATUSAGE_VolumetricCloud },
        { TEXT("used_with_heterogeneous_volumes"), MATUSAGE_HeterogeneousVolumes },
        { TEXT("used_with_static_mesh"), MATUSAGE_StaticMesh },
        { TEXT("used_with_editor_compositing"), MATUSAGE_EditorCompositing },
        { TEXT("used_with_neural_networks"), MATUSAGE_NeuralNetworks },
        { TEXT("used_with_mesh_deformer"), MATUSAGE_MeshDeformer },
        { TEXT("used_with_instanced_skinned_meshes"), MATUSAGE_InstancedSkinnedMesh },
        { TEXT("used_with_curves"), MATUSAGE_Curves },
    };

    TSharedPtr<FJsonObject> EnableAll = MakeShared<FJsonObject>();
    for (const FUsageSpec& Spec : UsageSpecs) EnableAll->SetBoolField(Spec.Key, true);
    const FHaybaHandlerResult Enabled = SetProperties(EnableAll);
    TestTrue(TEXT("all allowlisted usage flags stage atomically"), Enabled.bOk);
    for (const FUsageSpec& Spec : UsageSpecs)
        TestTrue(FString::Printf(TEXT("%s reads back true"), Spec.Key), Material->GetUsageByFlag(Spec.Usage));
    if (Enabled.Data.IsValid())
    {
        TestTrue(TEXT("native response verifies usage readback"), Enabled.Data->GetBoolField(TEXT("usage_flags_verified")));
        TestTrue(TEXT("changed usage request reports dirty"), Enabled.Data->GetBoolField(TEXT("dirty")));
        TestTrue(TEXT("changed usage request requires compile"), Enabled.Data->GetBoolField(TEXT("requires_compile")));
        TestFalse(TEXT("setter truthfully reports unsaved"), Enabled.Data->GetBoolField(TEXT("saved")));
        TestEqual(TEXT("response correlates material path"), Enabled.Data->GetStringField(TEXT("material_path")), ObjectPath);
    }

    const FHaybaHandlerResult NoOp = SetProperties(EnableAll);
    TestTrue(TEXT("idempotent usage request succeeds"), NoOp.bOk);
    if (NoOp.Data.IsValid())
    {
        TestTrue(TEXT("repeated no-op truthfully reports the package remains dirty"), NoOp.Data->GetBoolField(TEXT("dirty")));
        TestTrue(TEXT("repeated no-op still requires the pending compile"), NoOp.Data->GetBoolField(TEXT("requires_compile")));
        TestEqual(TEXT("no-op changed list is empty"), NoOp.Data->GetArrayField(TEXT("changed")).Num(), 0);
    }

    // Leave only the production-critical spline permutation enabled, compile
    // and save through the explicit finalizer, then unload/reload from disk.
    TSharedPtr<FJsonObject> SplineOnly = MakeShared<FJsonObject>();
    for (const FUsageSpec& Spec : UsageSpecs) SplineOnly->SetBoolField(Spec.Key, Spec.Usage == MATUSAGE_SplineMesh);
    TestTrue(TEXT("usage flags can be disabled with typed false"), SetProperties(SplineOnly).bOk);

    TSharedPtr<FJsonObject> Compile = MakeShared<FJsonObject>();
    Compile->SetStringField(TEXT("material_path"), ObjectPath);
    {
        TSharedPtr<FJsonObject> AmbiguousCompile = MakeShared<FJsonObject>();
        AmbiguousCompile->SetStringField(TEXT("material_path"), ObjectPath);
        AmbiguousCompile->SetStringField(TEXT("function_path"), TEXT("/Game/NotAFunction"));
        TestFalse(TEXT("compile rejects ambiguous material and function targets"),
            Handler.Handle(TEXT("material_compile"), AmbiguousCompile).bOk);

        TSharedPtr<FJsonObject> WrongTypeCompile = MakeShared<FJsonObject>();
        WrongTypeCompile->SetNumberField(TEXT("material_path"), 1.0);
        TestFalse(TEXT("compile rejects a non-string target before loading"),
            Handler.Handle(TEXT("material_compile"), WrongTypeCompile).bOk);
    }
    const FHaybaHandlerResult Compiled = Handler.Handle(TEXT("material_compile"), Compile);
    TestTrue(TEXT("material compile/save succeeds"), Compiled.bOk && Compiled.Data.IsValid());
    if (Compiled.Data.IsValid())
    {
        TestTrue(TEXT("compiled material reports effective success"), Compiled.Data->GetBoolField(TEXT("ok")));
        TestTrue(TEXT("compiled material reports a clean compile"), Compiled.Data->GetBoolField(TEXT("compiled_clean")));
        TestTrue(TEXT("compiled material is saved"), Compiled.Data->GetBoolField(TEXT("saved")));
        TestFalse(TEXT("compiled material has no shader errors"), Compiled.Data->GetBoolField(TEXT("has_errors")));
        TestEqual(TEXT("compile response correlates material path"), Compiled.Data->GetStringField(TEXT("material_path")), ObjectPath);
    }

    Material = nullptr;
    FText UnloadError;
    TArray<UPackage*> PackagesToUnload{ MaterialPackage };
    TestTrue(TEXT("saved material package unloads"), UPackageTools::UnloadPackages(PackagesToUnload, UnloadError));
    CollectGarbage(RF_NoFlags);
    UMaterial* Reloaded = LoadObject<UMaterial>(nullptr, *ObjectPath);
    if (TestNotNull(TEXT("material reloads from saved package"), Reloaded))
    {
        TestTrue(TEXT("spline usage persists after reload"), Reloaded->GetUsageByFlag(MATUSAGE_SplineMesh));
        TestFalse(TEXT("unrequested skeletal usage remains disabled after reload"), Reloaded->GetUsageByFlag(MATUSAGE_SkeletalMesh));
        TSharedPtr<FJsonObject> PersistedSpline = MakeShared<FJsonObject>();
        PersistedSpline->SetBoolField(TEXT("used_with_spline_meshes"), true);
        const FHaybaHandlerResult PersistedNoOp = SetProperties(PersistedSpline);
        TestTrue(TEXT("persisted no-op succeeds after reload"), PersistedNoOp.bOk && PersistedNoOp.Data.IsValid());
        if (PersistedNoOp.Data.IsValid())
        {
            TestFalse(TEXT("persisted no-op reports clean package"), PersistedNoOp.Data->GetBoolField(TEXT("dirty")));
            TestFalse(TEXT("persisted no-op requires no compile"), PersistedNoOp.Data->GetBoolField(TEXT("requires_compile")));
        }
    }

    TSharedPtr<FJsonObject> Info = MakeShared<FJsonObject>();
    Info->SetStringField(TEXT("path"), ObjectPath);
    const FHaybaHandlerResult InfoResult = Handler.Handle(TEXT("material_get_info"), Info);
    TestTrue(TEXT("material_get_info succeeds after reload"), InfoResult.bOk && InfoResult.Data.IsValid());
    if (InfoResult.Data.IsValid())
    {
        const TSharedPtr<FJsonObject>* UsageFlags = nullptr;
        TestTrue(TEXT("material_get_info exposes usage flags"),
            InfoResult.Data->TryGetObjectField(TEXT("usage_flags"), UsageFlags) && UsageFlags && (*UsageFlags)->GetBoolField(TEXT("used_with_spline_meshes")));
    }

    TestTrue(TEXT("scratch material is deleted"), UEditorAssetLibrary::DeleteAsset(AssetPath));
#endif
    return true;
}
