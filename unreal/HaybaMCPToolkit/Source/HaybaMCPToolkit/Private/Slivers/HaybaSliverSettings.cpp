// HaybaSliverSettings.cpp
#include "Slivers/HaybaSliverSettings.h"

UHaybaSliverSettings::UHaybaSliverSettings()
    : McpHttpBaseUrl(TEXT("http://127.0.0.1:3091"))
    , RunMode(EHaybaSliverRunMode::Manual)
    , MaxSliverDepth(8)
{}

const UHaybaSliverSettings* UHaybaSliverSettings::GetChecked()
{
    const UHaybaSliverSettings* S = GetDefault<UHaybaSliverSettings>();
    check(S);
    return S;
}
