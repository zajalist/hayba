// Plugins/PCGExBridge/Source/PCGExBridge/PCGExBridge.Build.cs
using UnrealBuildTool;

public class PCGExBridge : ModuleRules
{
    public PCGExBridge(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

        PublicDependencyModuleNames.AddRange(new string[] {
            "Core",
            "CoreUObject",
            "Engine",
            "Slate",
            "SlateCore",
            "EditorStyle"
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
