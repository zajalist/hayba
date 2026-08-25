// HaybaRecipeSettings.cpp
#include "Recipes/HaybaRecipeSettings.h"

#include "Misc/ConfigCacheIni.h"

namespace
{
    /** Where this class's values lived before the sliver -> Recipe rename. */
    const TCHAR* LegacySection = TEXT("/Script/HaybaMCPToolkit.HaybaSliverSettings");

    FString CurrentSection()
    {
        return UHaybaRecipeSettings::StaticClass()->GetPathName();
    }
}

UHaybaRecipeSettings::UHaybaRecipeSettings()
    : McpHttpBaseUrl(TEXT("http://127.0.0.1:3091"))
    , RunMode(EHaybaRecipeRunMode::Manual)
    , MaxRecipeDepth(8)
{}

void UHaybaRecipeSettings::PostInitProperties()
{
    Super::PostInitProperties();
    MigrateLegacyConfigSection();
}

void UHaybaRecipeSettings::MigrateLegacyConfigSection()
{
    // Renaming a config UCLASS orphans its saved values: the section is keyed
    // by the class path, so [.HaybaSliverSettings] is simply never looked at
    // again and the user quietly gets defaults back.
    //
    // CoreRedirects do NOT fix this. That was the obvious guess and it is
    // wrong -- redirects rewrite object references during serialization, and
    // the config system never consults them for a section name. Verified by
    // seeding MaxSliverDepth=17 under the old section and reading the class
    // back after a rebuild: it was 8. There is no engine-side section-rename
    // mechanism either (nothing in Runtime/Core answers to SectionsToRename).
    //
    // So the migration is explicit, which also makes it testable.
    if (!GConfig) return;

    const FString& Ini = GEditorPerProjectIni;
    const FString Section = CurrentSection();

    // Never overwrite a value the user has set since upgrading. If the current
    // section exists at all, this install has already moved on.
    if (const FConfigSection* Existing = GConfig->GetSection(*Section, /*Force*/false, Ini))
    {
        if (Existing->Num() > 0) return;
    }

    const FConfigSection* Legacy = GConfig->GetSection(LegacySection, /*Force*/false, Ini);
    if (!Legacy || Legacy->Num() == 0) return;

    bool bMigratedAnything = false;

    FString Url;
    if (GConfig->GetString(LegacySection, TEXT("McpHttpBaseUrl"), Url, Ini) && !Url.IsEmpty())
    {
        McpHttpBaseUrl = Url;
        bMigratedAnything = true;
    }

    int32 Depth = 0;
    if (GConfig->GetInt(LegacySection, TEXT("MaxSliverDepth"), Depth, Ini) && Depth > 0)
    {
        MaxRecipeDepth = Depth;
        bMigratedAnything = true;
    }

    FString Mode;
    if (GConfig->GetString(LegacySection, TEXT("RunMode"), Mode, Ini) && !Mode.IsEmpty())
    {
        // The enum's value names did not change, only its type name.
        if (Mode.Contains(TEXT("AutoDebounced"))) RunMode = EHaybaRecipeRunMode::AutoDebounced250;
        else                                      RunMode = EHaybaRecipeRunMode::Manual;
        bMigratedAnything = true;
    }

    if (!bMigratedAnything) return;

    // Write the values under the new name, then drop the old section so this
    // runs exactly once and a later edit is not shadowed by a stale entry.
    SaveConfig(CPF_Config, *Ini);
    GConfig->EmptySection(LegacySection, Ini);
    GConfig->Flush(/*bRead*/false, Ini);

    UE_LOG(LogTemp, Log,
        TEXT("HaybaRecipeSettings: migrated settings from the pre-rename config section."));
}

const UHaybaRecipeSettings* UHaybaRecipeSettings::GetChecked()
{
    const UHaybaRecipeSettings* S = GetDefault<UHaybaRecipeSettings>();
    check(S);
    return S;
}
