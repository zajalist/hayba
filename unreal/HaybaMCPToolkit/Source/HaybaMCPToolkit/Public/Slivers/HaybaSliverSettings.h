// HaybaSliverSettings.h — DeveloperSettings exposing the MCP HTTP URL
// and the Slivers tab run mode. Lives in Project Settings → Plugins →
// Hayba MCP → Slivers. Per-project (DefaultEditor.ini).

#pragma once

#include "CoreMinimal.h"
#include "Engine/DeveloperSettings.h"
#include "HaybaSliverSettings.generated.h"

UENUM(BlueprintType)
enum class EHaybaSliverRunMode : uint8
{
    Manual           UMETA(DisplayName = "Manual"),
    // AutoDebounced — v2; placeholder enum value keeps the future widget render flat.
    AutoDebounced250 UMETA(DisplayName = "Auto (debounced 250 ms) — v2 only"),
};

UCLASS(config = EditorPerProjectUserSettings, defaultconfig, meta = (DisplayName = "Hayba Slivers"))
class HAYBAMCPTOOLKIT_API UHaybaSliverSettings : public UDeveloperSettings
{
    GENERATED_BODY()
public:
    UHaybaSliverSettings();

    /** Base URL of the MCP server's HTTP listener. Set by hayba-mcp on startup; default matches its default port. */
    UPROPERTY(EditAnywhere, config, Category = "Hayba Slivers")
    FString McpHttpBaseUrl;

    /** v1 ships Manual only. AutoDebounced lands in v2. */
    UPROPERTY(EditAnywhere, config, Category = "Hayba Slivers")
    EHaybaSliverRunMode RunMode;

    /** Maximum recursion depth when slivers call each other. */
    UPROPERTY(EditAnywhere, config, Category = "Hayba Slivers", meta = (ClampMin = "1", ClampMax = "32"))
    int32 MaxSliverDepth;

    static const UHaybaSliverSettings* GetChecked();
};
