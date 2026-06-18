using UnrealBuildTool;

public class HaybaMCPSequencer : ModuleRules
{
    public HaybaMCPSequencer(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

        PublicDependencyModuleNames.AddRange(new string[] {
            "Core", "CoreUObject", "Engine"
        });

        PrivateDependencyModuleNames.AddRange(new string[] {
            "HaybaMCPToolkit",
            "UnrealEd", "AssetRegistry",
            "Json", "JsonUtilities",
            // Sequencer stack. LevelSequence/MovieScene/MovieSceneTracks are
            // engine modules; LevelSequenceEditor + MovieRenderPipeline* are the
            // plugin-backed deps gated in the .uplugin.
            "LevelSequence", "LevelSequenceEditor",
            "MovieScene", "MovieSceneTracks", "MovieSceneTools", "Sequencer",
            "MovieRenderPipelineCore", "MovieRenderPipelineEditor", "MovieRenderPipelineSettings"
        });
    }
}
