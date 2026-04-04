using System.IO;
using UnrealBuildTool;

public class HaybaGaea : ModuleRules
{
	public HaybaGaea(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = ModuleRules.PCHUsageMode.UseExplicitOrSharedPCHs;

		// FLandscapeImportHelper lives in LandscapeEditor's private headers
		var EngineDir = Path.GetFullPath(Target.RelativeEnginePath);
		PublicSystemIncludePaths.Add(
			Path.Combine(EngineDir, "Source/Editor/LandscapeEditor/Private")
		);

		PublicDependencyModuleNames.AddRange(new string[] {
			"Core", "CoreUObject", "Engine", "Slate", "SlateCore"
		});

		PrivateDependencyModuleNames.AddRange(new string[] {
			"UnrealEd", "ToolMenus", "WorkspaceMenuStructure", "Projects",
			"Sockets", "Networking", "Json",
			"Landscape", "LandscapeEditor",
			"ImageWrapper"
		});
	}
}
