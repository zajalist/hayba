using UnrealBuildTool;

public class HaybaMCPGAS : ModuleRules
{
    public HaybaMCPGAS(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

        PublicDependencyModuleNames.AddRange(new string[] {
            "Core", "CoreUObject", "Engine"
        });

        PrivateDependencyModuleNames.AddRange(new string[] {
            // Core Hayba plugin — provides IHaybaMCPHandler + FHaybaMCPModule.
            "HaybaMCPToolkit",
            // Editor + asset plumbing the handler uses.
            "UnrealEd", "Kismet", "AssetRegistry",
            "Json", "JsonUtilities",
            // The optional subsystem this satellite exists to wrap. The owning
            // GameplayAbilities plugin is declared as a hard dependency in
            // HaybaMCPGAS.uplugin, so UE disables THIS plugin (not the core) when
            // GameplayAbilities is turned off.
            "GameplayAbilities", "GameplayTags", "GameplayTasks"
        });
    }
}
