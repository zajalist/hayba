#include "Misc/AutomationTest.h"

#if WITH_EDITOR
#include "Engine/TextureCollection.h"
#include "MaterialEditingLibrary.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpressionConstant.h"
#include "Materials/MaterialExpressionMakeMaterialAttributes.h"
#include "Materials/MaterialExpressionScalarParameter.h"
#include "Materials/MaterialExpressionStaticSwitchParameter.h"
#include "Materials/MaterialExpressionTextureSampleParameter2D.h"
#include "Materials/MaterialExpressionTextureCollectionParameter.h"
#include "Materials/MaterialExpressionVectorParameter.h"
#include "handlers/HaybaMCPMaterialHandler.h"
#include "UObject/Package.h"
#include <limits>
#endif

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPMaterialIntrospectionTest,
    "Hayba.MCP.Material.Introspection.ParameterDefaultsAndOutputEdges",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPMaterialIntrospectionTest::RunTest(const FString& Parameters)
{
#if WITH_EDITOR
    const FString Name = FString::Printf(TEXT("M_Info_%s"), *FGuid::NewGuid().ToString(EGuidFormats::Digits));
    const FString PackageName = TEXT("/Temp/HaybaMCPAutomation/") + Name;
    FHaybaMCPMaterialHandler Handler;

    UPackage* ScratchPackage = CreatePackage(*PackageName);
    UMaterial* Material = ScratchPackage
        ? NewObject<UMaterial>(ScratchPackage, *Name, RF_Public | RF_Standalone)
        : nullptr;
    if (!TestNotNull(TEXT("transient scratch material is created"), Material)) return true;
    const FString ObjectPath = Material->GetPathName();
    auto CleanupScratch = [&]()
    {
        ScratchPackage->SetDirtyFlag(false);
        Material->ClearFlags(RF_Public | RF_Standalone);
        Material->MarkAsGarbage();
        ScratchPackage->MarkAsGarbage();
    };

    UMaterialExpressionScalarParameter* Scalar = Cast<UMaterialExpressionScalarParameter>(
        UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionScalarParameter::StaticClass(), -600, -200));
    UMaterialExpressionVectorParameter* Vector = Cast<UMaterialExpressionVectorParameter>(
        UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionVectorParameter::StaticClass(), -600, 0));
    UMaterialExpressionStaticSwitchParameter* Switch = Cast<UMaterialExpressionStaticSwitchParameter>(
        UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionStaticSwitchParameter::StaticClass(), -600, 200));
    UMaterialExpressionTextureSampleParameter2D* Texture = Cast<UMaterialExpressionTextureSampleParameter2D>(
        UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionTextureSampleParameter2D::StaticClass(), -600, 400));
    UMaterialExpressionTextureCollectionParameter* TextureCollection = Cast<UMaterialExpressionTextureCollectionParameter>(
        UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionTextureCollectionParameter::StaticClass(), -600, 500));
    UMaterialExpressionScalarParameter* NonFinite = Cast<UMaterialExpressionScalarParameter>(
        UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionScalarParameter::StaticClass(), -600, 600));
    UMaterialExpressionScalarParameter* InactiveOpacity = Cast<UMaterialExpressionScalarParameter>(
        UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionScalarParameter::StaticClass(), -600, 700));
    UMaterialExpressionScalarParameter* Unnamed = Cast<UMaterialExpressionScalarParameter>(
        UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionScalarParameter::StaticClass(), -600, 800));
    UMaterialExpressionConstant* Constant = Cast<UMaterialExpressionConstant>(
        UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionConstant::StaticClass(), -600, 1000));
    UMaterialExpressionMakeMaterialAttributes* MakeAttributes = Cast<UMaterialExpressionMakeMaterialAttributes>(
        UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionMakeMaterialAttributes::StaticClass(), -300, 1000));
    if (!TestTrue(TEXT("all parameter and control expressions are created"),
        Scalar && Vector && Switch && Texture && TextureCollection && NonFinite && InactiveOpacity && Unnamed && Constant && MakeAttributes))
    {
        CleanupScratch();
        return true;
    }

    Scalar->ParameterName = TEXT("RouteGlow");
    Scalar->DefaultValue = -3.25f;
    Vector->ParameterName = TEXT("FlowColor");
    Vector->DefaultValue = FLinearColor(0.25f, 1.5f, -0.5f, 0.75f);
    Switch->ParameterName = TEXT("UseArmyPulse");
    Switch->DefaultValue = false;
    Texture->ParameterName = TEXT("FlowMask");
    Texture->Texture = nullptr;
    TextureCollection->ParameterName = TEXT("SeasonalMasks");
    TextureCollection->TextureCollection = NewObject<UTextureCollection>(Material, TEXT("EmbeddedCollection"));
    NonFinite->ParameterName = TEXT("BrokenDefault");
    NonFinite->DefaultValue = std::numeric_limits<float>::quiet_NaN();
    InactiveOpacity->ParameterName = TEXT("InactiveOpacity");
    InactiveOpacity->DefaultValue = 0.75f;
    Unnamed->ParameterName = NAME_None;
    Unnamed->DefaultValue = 0.5f;
    Constant->R = 0.125f;

    TestTrue(TEXT("roughness output is connected to the scalar parameter"),
        UMaterialEditingLibrary::ConnectMaterialProperty(Scalar, TEXT(""), MP_Roughness));
    TestTrue(TEXT("opaque material retains a stored opacity connection"),
        UMaterialEditingLibrary::ConnectMaterialProperty(InactiveOpacity, TEXT(""), MP_Opacity));

    TSharedPtr<FJsonObject> Request = MakeShared<FJsonObject>();
    Request->SetStringField(TEXT("path"), ObjectPath);
    const FHaybaHandlerResult Result = Handler.Handle(TEXT("material_get_info"), Request);
    if (!TestTrue(TEXT("material_get_info succeeds"), Result.bOk && Result.Data.IsValid()))
    {
        CleanupScratch();
        return true;
    }

    auto FindExpression = [&](const FString& NodeId) -> TSharedPtr<FJsonObject>
    {
        for (const TSharedPtr<FJsonValue>& Value : Result.Data->GetArrayField(TEXT("expressions")))
        {
            const TSharedPtr<FJsonObject>* Object = nullptr;
            if (Value.IsValid() && Value->TryGetObject(Object) && Object &&
                (*Object)->GetStringField(TEXT("id")) == NodeId)
                return *Object;
        }
        return nullptr;
    };

    const TSharedPtr<FJsonObject> ScalarInfo = FindExpression(Scalar->GetName());
    if (TestTrue(TEXT("scalar expression is present"), ScalarInfo.IsValid()))
    {
        TestEqual(TEXT("scalar parameter name is exact"), ScalarInfo->GetStringField(TEXT("parameter_name")), FString(TEXT("RouteGlow")));
        TestEqual(TEXT("scalar parameter type is explicit"), ScalarInfo->GetStringField(TEXT("parameter_type")), FString(TEXT("scalar")));
        TestTrue(TEXT("scalar metadata is available"), ScalarInfo->GetBoolField(TEXT("parameter_metadata_available")));
        TestTrue(TEXT("finite scalar default is available"), ScalarInfo->GetBoolField(TEXT("default_value_available")));
        TestEqual(TEXT("negative scalar default remains numeric"), ScalarInfo->GetNumberField(TEXT("default_value")), -3.25);
    }

    const TSharedPtr<FJsonObject> VectorInfo = FindExpression(Vector->GetName());
    if (TestTrue(TEXT("vector expression is present"), VectorInfo.IsValid()))
    {
        TestEqual(TEXT("vector parameter type is explicit"), VectorInfo->GetStringField(TEXT("parameter_type")), FString(TEXT("vector")));
        const TArray<TSharedPtr<FJsonValue>>& Default = VectorInfo->GetArrayField(TEXT("default_value"));
        TestEqual(TEXT("vector default has RGBA components"), Default.Num(), 4);
        if (Default.Num() == 4)
        {
            TestEqual(TEXT("vector R is exact"), Default[0]->AsNumber(), 0.25);
            TestEqual(TEXT("vector G preserves values above one"), Default[1]->AsNumber(), 1.5);
            TestEqual(TEXT("vector B preserves negative values"), Default[2]->AsNumber(), -0.5);
            TestEqual(TEXT("vector A is exact"), Default[3]->AsNumber(), 0.75);
        }
    }

    const TSharedPtr<FJsonObject> SwitchInfo = FindExpression(Switch->GetName());
    if (TestTrue(TEXT("static switch expression is present"), SwitchInfo.IsValid()))
    {
        TestEqual(TEXT("static switch type is explicit"), SwitchInfo->GetStringField(TEXT("parameter_type")), FString(TEXT("static_switch")));
        TestTrue(TEXT("false static switch remains a JSON boolean"), SwitchInfo->HasTypedField<EJson::Boolean>(TEXT("default_value")));
        TestFalse(TEXT("false static switch is not omitted or promoted to true"), SwitchInfo->GetBoolField(TEXT("default_value")));
    }

    const TSharedPtr<FJsonObject> TextureInfo = FindExpression(Texture->GetName());
    if (TestTrue(TEXT("texture parameter expression is present"), TextureInfo.IsValid()))
    {
        TestEqual(TEXT("texture type is explicit"), TextureInfo->GetStringField(TEXT("parameter_type")), FString(TEXT("texture")));
        TestTrue(TEXT("known null texture default remains available"), TextureInfo->GetBoolField(TEXT("default_value_available")));
        TestTrue(TEXT("known null texture default is JSON null"), TextureInfo->HasTypedField<EJson::Null>(TEXT("default_value")));
    }

    const TSharedPtr<FJsonObject> TextureCollectionInfo = FindExpression(TextureCollection->GetName());
    if (TestTrue(TEXT("texture collection parameter expression is present"), TextureCollectionInfo.IsValid()))
    {
        TestEqual(TEXT("texture collection type is explicit"), TextureCollectionInfo->GetStringField(TEXT("parameter_type")), FString(TEXT("texture_collection")));
        TestTrue(TEXT("texture collection default is available"), TextureCollectionInfo->GetBoolField(TEXT("default_value_available")));
        TestEqual(TEXT("texture collection default preserves its object path"),
            TextureCollectionInfo->GetStringField(TEXT("default_value")), TextureCollection->TextureCollection->GetPathName());
    }

    const TSharedPtr<FJsonObject> NonFiniteInfo = FindExpression(NonFinite->GetName());
    if (TestTrue(TEXT("non-finite scalar expression is present"), NonFiniteInfo.IsValid()))
    {
        TestFalse(TEXT("non-finite defaults fail closed"), NonFiniteInfo->GetBoolField(TEXT("default_value_available")));
        TestTrue(TEXT("non-finite defaults serialize as JSON null"), NonFiniteInfo->HasTypedField<EJson::Null>(TEXT("default_value")));
    }

    const TSharedPtr<FJsonObject> UnnamedInfo = FindExpression(Unnamed->GetName());
    if (TestTrue(TEXT("unnamed parameter expression is present"), UnnamedInfo.IsValid()))
    {
        TestFalse(TEXT("NAME_None is not reported as a valid parameter identity"), UnnamedInfo->GetBoolField(TEXT("parameter_name_valid")));
        TestTrue(TEXT("NAME_None is represented without a fabricated name"), UnnamedInfo->HasTypedField<EJson::Null>(TEXT("parameter_name")));
    }

    const TSharedPtr<FJsonObject> ConstantInfo = FindExpression(Constant->GetName());
    if (TestTrue(TEXT("non-parameter expression is present"), ConstantInfo.IsValid()))
    {
        TestFalse(TEXT("non-parameter does not claim a parameter name"), ConstantInfo->HasField(TEXT("parameter_name")));
        TestFalse(TEXT("non-parameter does not claim a default value"), ConstantInfo->HasField(TEXT("default_value")));
        const TArray<TSharedPtr<FJsonValue>>& Outputs = ConstantInfo->GetArrayField(TEXT("outputs"));
        if (TestEqual(TEXT("scalar constant has one output"), Outputs.Num(), 1))
        {
            const TSharedPtr<FJsonObject>* Output = nullptr;
            if (TestTrue(TEXT("scalar constant output is an object"), Outputs[0]->TryGetObject(Output) && Output))
            {
                TestTrue(TEXT("genuinely unnamed output has no fabricated connectable name"), (*Output)->HasTypedField<EJson::Null>(TEXT("name")));
                TestEqual(TEXT("unnamed output retains a deterministic display label"), (*Output)->GetStringField(TEXT("label")), FString(TEXT("output_0")));
                TestFalse(TEXT("unnamed output requires index-based connection"), (*Output)->GetBoolField(TEXT("connect_by_name")));
            }
        }
    }

    bool bFoundRoughness = false;
    bool bFoundDisconnectedBaseColor = false;
    bool bFoundInactiveOpacity = false;
    for (const TSharedPtr<FJsonValue>& Value : Result.Data->GetArrayField(TEXT("material_outputs")))
    {
        const TSharedPtr<FJsonObject>* Output = nullptr;
        if (!Value.IsValid() || !Value->TryGetObject(Output) || !Output) continue;
        const int32 PropertyId = static_cast<int32>((*Output)->GetNumberField(TEXT("property_id")));
        if (PropertyId == MP_Roughness)
        {
            bFoundRoughness = true;
            TestTrue(TEXT("roughness output reports connected"), (*Output)->GetBoolField(TEXT("connected")));
            TestEqual(TEXT("roughness output identifies the exact source node"), (*Output)->GetStringField(TEXT("from_node")), Scalar->GetName());
            TestEqual(TEXT("roughness output identifies source output zero"), (*Output)->GetNumberField(TEXT("from_output")), 0.0);
            TestTrue(TEXT("unnamed source output does not fabricate a connectable name"), (*Output)->HasTypedField<EJson::Null>(TEXT("from_output_name")));
            TestEqual(TEXT("unnamed source output retains a deterministic display label"), (*Output)->GetStringField(TEXT("from_output_label")), FString(TEXT("output_0")));
            TestTrue(TEXT("roughness terminal is compiler-active in property mode"), (*Output)->GetBoolField(TEXT("compiler_input_active")));
            TestTrue(TEXT("roughness connection is used in property mode"), (*Output)->GetBoolField(TEXT("connection_compiler_used")));
        }
        else if (PropertyId == MP_BaseColor)
        {
            bFoundDisconnectedBaseColor = true;
            TestFalse(TEXT("base color output truthfully reports disconnected"), (*Output)->GetBoolField(TEXT("connected")));
            TestFalse(TEXT("disconnected output does not fabricate a source node"), (*Output)->HasField(TEXT("from_node")));
            TestTrue(TEXT("base color terminal remains compiler-active in property mode"), (*Output)->GetBoolField(TEXT("compiler_input_active")));
            TestFalse(TEXT("disconnected base color has no compiler-used connection"), (*Output)->GetBoolField(TEXT("connection_compiler_used")));
        }
        else if (PropertyId == MP_Opacity)
        {
            bFoundInactiveOpacity = true;
            TestTrue(TEXT("opaque material retains stored opacity wire"), (*Output)->GetBoolField(TEXT("connected")));
            TestFalse(TEXT("opacity terminal is inactive for opaque blend mode"), (*Output)->GetBoolField(TEXT("compiler_input_active")));
            TestFalse(TEXT("stored opaque opacity wire is not compiler-used"), (*Output)->GetBoolField(TEXT("connection_compiler_used")));
        }
    }
    TestTrue(TEXT("material output map includes roughness"), bFoundRoughness);
    TestTrue(TEXT("material output map includes disconnected base color"), bFoundDisconnectedBaseColor);
    TestTrue(TEXT("material output map includes stored inactive opacity"), bFoundInactiveOpacity);
    const TSharedPtr<FJsonObject> InactiveOpacityInfo = FindExpression(InactiveOpacity->GetName());
    if (TestTrue(TEXT("inactive opacity expression is present"), InactiveOpacityInfo.IsValid()))
        TestFalse(TEXT("inactive opaque opacity source is not compiler-reachable"), InactiveOpacityInfo->GetBoolField(TEXT("reachable_from_output")));

    // UE preserves the roughness wire when Use Material Attributes is enabled,
    // but that wire is no longer a compiler root. Verify stored vs live state
    // and reachability do not collapse into a false-green.
    Material->bUseMaterialAttributes = true;
    TestTrue(TEXT("material attributes output connects"),
        UMaterialEditingLibrary::ConnectMaterialProperty(MakeAttributes, TEXT(""), MP_MaterialAttributes));
    const FHaybaHandlerResult AttributesResult = Handler.Handle(TEXT("material_get_info"), Request);
    if (TestTrue(TEXT("material_get_info succeeds in attributes mode"), AttributesResult.bOk && AttributesResult.Data.IsValid()))
    {
        TestTrue(TEXT("response exposes attributes mode"), AttributesResult.Data->GetBoolField(TEXT("uses_material_attributes")));
        bool bSawStoredRoughness = false;
        bool bSawLiveAttributes = false;
        for (const TSharedPtr<FJsonValue>& Value : AttributesResult.Data->GetArrayField(TEXT("material_outputs")))
        {
            const TSharedPtr<FJsonObject>* Output = nullptr;
            if (!Value.IsValid() || !Value->TryGetObject(Output) || !Output) continue;
            const int32 PropertyId = static_cast<int32>((*Output)->GetNumberField(TEXT("property_id")));
            if (PropertyId == MP_Roughness)
            {
                bSawStoredRoughness = true;
                TestTrue(TEXT("attributes mode retains stored roughness wire"), (*Output)->GetBoolField(TEXT("connected")));
                TestFalse(TEXT("stored roughness terminal is compiler-inactive"), (*Output)->GetBoolField(TEXT("compiler_input_active")));
                TestFalse(TEXT("stored roughness connection is not compiler-used"), (*Output)->GetBoolField(TEXT("connection_compiler_used")));
            }
            else if (PropertyId == MP_MaterialAttributes)
            {
                bSawLiveAttributes = true;
                TestTrue(TEXT("material attributes terminal is connected"), (*Output)->GetBoolField(TEXT("connected")));
                TestTrue(TEXT("material attributes terminal is compiler-active"), (*Output)->GetBoolField(TEXT("compiler_input_active")));
                TestTrue(TEXT("material attributes connection is compiler-used"), (*Output)->GetBoolField(TEXT("connection_compiler_used")));
            }
        }
        TestTrue(TEXT("attributes mode still exposes stored roughness evidence"), bSawStoredRoughness);
        TestTrue(TEXT("attributes mode exposes live material-attributes evidence"), bSawLiveAttributes);

        bool bScalarReachable = true;
        bool bMakeAttributesReachable = false;
        for (const TSharedPtr<FJsonValue>& Value : AttributesResult.Data->GetArrayField(TEXT("expressions")))
        {
            const TSharedPtr<FJsonObject>* Expression = nullptr;
            if (!Value.IsValid() || !Value->TryGetObject(Expression) || !Expression) continue;
            const FString Id = (*Expression)->GetStringField(TEXT("id"));
            if (Id == Scalar->GetName()) bScalarReachable = (*Expression)->GetBoolField(TEXT("reachable_from_output"));
            if (Id == MakeAttributes->GetName()) bMakeAttributesReachable = (*Expression)->GetBoolField(TEXT("reachable_from_output"));
        }
        TestFalse(TEXT("ignored stored roughness wire does not make its source reachable"), bScalarReachable);
        TestTrue(TEXT("material attributes source is reachable"), bMakeAttributesReachable);
    }

    Material->MaterialDomain = MD_PostProcess;
    const FHaybaHandlerResult PostProcessResult = Handler.Handle(TEXT("material_get_info"), Request);
    if (TestTrue(TEXT("material_get_info succeeds for post-process attributes"), PostProcessResult.bOk && PostProcessResult.Data.IsValid()))
    {
        bool bPostProcessAttributesActive = false;
        bool bPostProcessAttributesReachable = false;
        for (const TSharedPtr<FJsonValue>& Value : PostProcessResult.Data->GetArrayField(TEXT("material_outputs")))
        {
            const TSharedPtr<FJsonObject>* Output = nullptr;
            if (!Value.IsValid() || !Value->TryGetObject(Output) || !Output) continue;
            if (static_cast<int32>((*Output)->GetNumberField(TEXT("property_id"))) == MP_MaterialAttributes)
            {
                bPostProcessAttributesActive = (*Output)->GetBoolField(TEXT("compiler_input_active"))
                    && (*Output)->GetBoolField(TEXT("connection_compiler_used"));
                break;
            }
        }
        for (const TSharedPtr<FJsonValue>& Value : PostProcessResult.Data->GetArrayField(TEXT("expressions")))
        {
            const TSharedPtr<FJsonObject>* Expression = nullptr;
            if (!Value.IsValid() || !Value->TryGetObject(Expression) || !Expression) continue;
            if ((*Expression)->GetStringField(TEXT("id")) == MakeAttributes->GetName())
            {
                bPostProcessAttributesReachable = (*Expression)->GetBoolField(TEXT("reachable_from_output"));
                break;
            }
        }
        TestTrue(TEXT("post-process MaterialAttributes terminal remains compiler-used"), bPostProcessAttributesActive);
        TestTrue(TEXT("post-process MaterialAttributes source remains reachable"), bPostProcessAttributesReachable);
    }

    CleanupScratch();
#endif
    return true;
}
