// Plugins/Hayba_PcgEx_MCP/Source/Hayba_PcgEx_MCP/Hayba_PcgEx_MCP.Build.cs
using UnrealBuildTool;

public class Hayba_PcgEx_MCP : ModuleRules
{
    public Hayba_PcgEx_MCP(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

        PublicDependencyModuleNames.AddRange(new string[] {
            "Core",
            "CoreUObject",
            "Engine",
            "Slate",
            "SlateCore",
            "EditorStyle",
            "InputCore"
        });

        PrivateDependencyModuleNames.AddRange(new string[] {
            "UnrealEd",
            "Projects",
            "ToolMenus",
            "WorkspaceMenuStructure",
            "Sockets",
            "Networking",
            "Json",
            "JsonUtilities",
            "PCG",
            "HTTP"
        });
    }
}
