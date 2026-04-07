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
            "EditorStyle", "InputCore"
        });

        PrivateDependencyModuleNames.AddRange(new string[] {
            "UnrealEd", "Projects", "ToolMenus", "WorkspaceMenuStructure",
            "Sockets", "Networking", "Json", "JsonUtilities",
            "PCG", "HTTP",
            "Landscape", "LandscapeEditor", "ImageWrapper",
            "ApplicationCore"
        });
    }
}
