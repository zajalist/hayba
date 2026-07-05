using System.IO;
using UnrealBuildTool;

public class HaybaMCPToolkit : ModuleRules
{
    public HaybaMCPToolkit(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

        // Disable unity builds for this module. Several handler .cpp files define
        // identically-named anonymous-namespace helpers (EditorWorld/ReadVec/
        // FindActorByName); unity concatenation merges their TUs and these collide
        // ("function already has a body"). Per-file compilation keeps the helpers
        // file-local. The adaptive unity build was masking this by excluding
        // recently-edited files; making it permanent matches that known-good mode.
        bUseUnity = false;

        // FLandscapeImportHelper lives in LandscapeEditor's private headers
        var EngineDir = Path.GetFullPath(Target.RelativeEnginePath);
        PublicSystemIncludePaths.Add(
            Path.Combine(EngineDir, "Source/Editor/LandscapeEditor/Private")
        );
        // FShaderStatsInfo (material_compile optimization feedback) lives in
        // MaterialEditor's private headers; FMaterialStatsUtils::ExtractMatertialStatsInfo
        // is MATERIALEDITOR_API-exported and fills it.
        PublicSystemIncludePaths.Add(
            Path.Combine(EngineDir, "Source/Editor/MaterialEditor/Private")
        );

        PublicDependencyModuleNames.AddRange(new string[] {
            "Core", "CoreUObject", "Engine", "Slate", "SlateCore",
            "EditorStyle", "EditorWidgets", "InputCore", "EnhancedInput",
            "UMG"
        });

        PrivateDependencyModuleNames.AddRange(new string[] {
            "UnrealEd", "EditorFramework", "Projects", "ToolMenus", "WorkspaceMenuStructure",
            "ContentBrowser", "AdvancedPreviewScene", "RenderCore", "GraphEditor",
            "Sockets", "Networking", "Json", "JsonUtilities",
            "PCG", "HTTP",
            // Underground tunnel PCG node — build a continuous (seamless) swept
            // dynamic mesh from a spline. FDynamicMesh3 = GeometryCore; UDynamicMesh = GeometryFramework.
            // DynamicMesh + GeometryAlgorithms provide the CSG ops (FMeshBoolean, FMeshPlaneCut)
            // the Socket Bond node uses to cut a clean watertight socket where shells meet.
            "GeometryCore", "GeometryFramework", "DynamicMesh", "GeometryAlgorithms",
            "DirectoryWatcher", "DesktopPlatform",
            "Landscape", "LandscapeEditor", "ImageWrapper",
            "Foliage",
            "ApplicationCore",
            "Renderer", "RenderCore", "RHI",
            "HotReload",
            "PythonScriptPlugin",
            "AssetRegistry", "AssetTools", "EditorScriptingUtilities", "DataValidation",
            "Kismet", "KismetCompiler", "BlueprintGraph",
            "DeveloperSettings",
            "LevelEditor",
            "WorldPartitionEditor",
            "MaterialEditor",
            // Niagara / MovieScene moved to satellite plugins (HaybaMCPNiagara,
            // HaybaMCPSequencer).
            "WebBrowser", "WebBrowserWidget",
            "EngineSettings",
            "SourceControl",
            // GameplayAbilities moved to the optional HaybaMCPGAS satellite plugin
            // so the core loads even when GameplayAbilities is disabled.
            "GameplayTags",
            "GameplayTasks"
        });

        // Animation Blueprint handler (gh#17). Editor-only modules go inside
        // bBuildEditor; AnimGraphRuntime is available in both editor and runtime.
        PrivateDependencyModuleNames.Add("AnimGraphRuntime");
        PrivateDependencyModuleNames.Add("AIModule");
        if (Target.bBuildEditor)
        {
            PrivateDependencyModuleNames.AddRange(new string[] {
                "AnimGraph",
                "AnimationCore",
                "AnimationModifiers",
                "BehaviorTreeEditor",
                "UMGEditor",
                "AutomationController",
            });
        }

        // MetaSound (gh#18) and Sequencer (gh#9) moved to optional satellite
        // plugins (HaybaMCPMetaSound, HaybaMCPSequencer) so the core loads when
        // those plugins are disabled.

        // Windows DPAPI (CryptProtectData/CryptUnprotectData) for the BYOK API-key
        // vault in HaybaMCPSettings.cpp. Win64-only, matching the plugin's pinning;
        // guarded by #if PLATFORM_WINDOWS in the source.
        if (Target.Platform == UnrealTargetPlatform.Win64)
        {
            PublicSystemLibraries.Add("Crypt32.lib");
        }
    }
}
