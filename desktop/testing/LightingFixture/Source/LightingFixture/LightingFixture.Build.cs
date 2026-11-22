using UnrealBuildTool;
public class LightingFixture : ModuleRules {
    public LightingFixture(ReadOnlyTargetRules Target) : base(Target) {
        PrivateDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine", "UnrealEd", "Slate", "SlateCore" });
    }
}
