// Private/HaybaMCPDeveloperSettings.cpp
#include "HaybaMCPDeveloperSettings.h"
#include "HaybaMCPSettings.h"

void UHaybaMCPDeveloperSettings::RecomputeVRAMEstimate()
{
    int32 BaseMB = 0;
    switch (ModelPreset)
    {
    case EHaybaModelPreset::Minimal:  BaseMB = 1000; break;
    case EHaybaModelPreset::Balanced: BaseMB = 2000; break;
    case EHaybaModelPreset::Full:     BaseMB = 12000; break;
    }
    if (bEnableSpatialCLIP) BaseMB += 200;
    if (bEnableOWLViT)      BaseMB += 600;
    VRAMEstimate = FString::Printf(TEXT("~%d MB VRAM"), BaseMB);
}

#if WITH_EDITOR
void UHaybaMCPDeveloperSettings::PostEditChangeProperty(FPropertyChangedEvent& Event)
{
    Super::PostEditChangeProperty(Event);
    RecomputeVRAMEstimate();
    // Persist immediately (DefaultConfig writes on SaveConfig)
    SaveConfig();
    // Re-pull into the cached FHaybaMCPSettings used by handlers
    FHaybaMCPSettings& CachedSettings = FHaybaMCPSettings::Get();
    CachedSettings.Load();
    // The Node MCP process reads this runtime mirror so TS-only tools obey the
    // same response-guidance choice as native plugin commands immediately.
    CachedSettings.WriteDisabledToolsFile();
}
#endif
