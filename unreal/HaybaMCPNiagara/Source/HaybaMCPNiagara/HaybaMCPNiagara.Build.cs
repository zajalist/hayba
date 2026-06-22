using UnrealBuildTool;

public class HaybaMCPNiagara : ModuleRules
{
    public HaybaMCPNiagara(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

        PublicDependencyModuleNames.AddRange(new string[] {
            "Core", "CoreUObject", "Engine"
        });

        PrivateDependencyModuleNames.AddRange(new string[] {
            "HaybaMCPToolkit",
            "UnrealEd", "AssetRegistry",
            "Json", "JsonUtilities",
            // Optional subsystem — owning Niagara plugin is a hard dep in the
            // .uplugin so UE disables THIS plugin (not core) when Niagara is off.
            "Niagara", "NiagaraCore"
        });
    }
}
