using UnrealBuildTool;

public class HaybaMCPMetaSound : ModuleRules
{
    public HaybaMCPMetaSound(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

        PublicDependencyModuleNames.AddRange(new string[] {
            "Core", "CoreUObject", "Engine"
        });

        PrivateDependencyModuleNames.AddRange(new string[] {
            "HaybaMCPToolkit",
            "UnrealEd", "AssetTools", "AssetRegistry",
            "Json", "JsonUtilities",
            // Optional subsystem — owning Metasound plugin is a hard dep in the
            // .uplugin so UE disables THIS plugin (not core) when Metasound is off.
            "MetasoundEngine", "MetasoundFrontend", "MetasoundGraphCore", "MetasoundEditor"
        });
    }
}
