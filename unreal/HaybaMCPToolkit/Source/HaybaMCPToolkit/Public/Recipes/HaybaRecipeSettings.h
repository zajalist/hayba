// HaybaRecipeSettings.h — DeveloperSettings exposing the MCP HTTP URL
// and the Recipes tab run mode. Lives in Project Settings → Plugins →
// Hayba MCP → Recipes. Per-project (DefaultEditor.ini).

#pragma once

#include "CoreMinimal.h"
#include "Engine/DeveloperSettings.h"
#include "HaybaRecipeSettings.generated.h"

UENUM(BlueprintType)
enum class EHaybaRecipeRunMode : uint8
{
    Manual           UMETA(DisplayName = "Manual"),
    // AutoDebounced — v2; placeholder enum value keeps the future widget render flat.
    AutoDebounced250 UMETA(DisplayName = "Auto (debounced 250 ms) — v2 only"),
};

UCLASS(config = EditorPerProjectUserSettings, defaultconfig, meta = (DisplayName = "Hayba Recipes"))
class HAYBAMCPTOOLKIT_API UHaybaRecipeSettings : public UDeveloperSettings
{
    GENERATED_BODY()
public:
    UHaybaRecipeSettings();

    /** Base URL of the MCP server's HTTP listener. Set by hayba-mcp on startup; default matches its default port. */
    UPROPERTY(EditAnywhere, config, Category = "Hayba Recipes")
    FString McpHttpBaseUrl;

    /** v1 ships Manual only. AutoDebounced lands in v2. */
    UPROPERTY(EditAnywhere, config, Category = "Hayba Recipes")
    EHaybaRecipeRunMode RunMode;

    /** Maximum recursion depth when recipes call each other. */
    UPROPERTY(EditAnywhere, config, Category = "Hayba Recipes", meta = (ClampMin = "1", ClampMax = "32"))
    int32 MaxRecipeDepth;

    static const UHaybaRecipeSettings* GetChecked();

    //~ UObject
    virtual void PostInitProperties() override;

private:
    /** One-time adoption of values saved under the pre-rename class name.
     *  See the .cpp for why CoreRedirects do not cover this. */
    void MigrateLegacyConfigSection();
};
