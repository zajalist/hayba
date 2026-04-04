using UnrealBuildTool;

public class HaybaGaea : ModuleRules
{
	public HaybaGaea(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = ModuleRules.PCHUsageMode.UseExplicitOrSharedPCHs;

		PublicDependencyModuleNames.AddRange(new string[] {
			"Core", "CoreUObject", "Engine", "Slate", "SlateCore"
		});

		PrivateDependencyModuleNames.AddRange(new string[] {
			"UnrealEd", "ToolMenus", "WorkspaceMenuStructure",
			"Sockets", "Networking", "Json",
			"Landscape", "LandscapeEditor",
			"ImageWrapper"
		});
	}
}
