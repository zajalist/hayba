using System.IO;
using UnrealBuildTool;

public class HaybaMCPToolkit : ModuleRules
{
    public HaybaMCPToolkit(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

        // FLandscapeImportHelper lives in LandscapeEditor's private headers
        var EngineDir = Path.GetFullPath(Target.RelativeEnginePath);
        PublicSystemIncludePaths.Add(
            Path.Combine(EngineDir, "Source/Editor/LandscapeEditor/Private")
        );

        PublicDependencyModuleNames.AddRange(new string[] {
            "Core", "CoreUObject", "Engine", "Slate", "SlateCore",
            "EditorStyle", "EditorWidgets", "InputCore", "EnhancedInput",
            "UMG"
        });

        PrivateDependencyModuleNames.AddRange(new string[] {
            "UnrealEd", "EditorFramework", "Projects", "ToolMenus", "WorkspaceMenuStructure",
            "ContentBrowser",
            "Sockets", "Networking", "Json", "JsonUtilities",
            "PCG", "HTTP",
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
    }
}
