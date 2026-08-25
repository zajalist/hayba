// HaybaRecipeSettings.cpp
#include "Recipes/HaybaRecipeSettings.h"

UHaybaRecipeSettings::UHaybaRecipeSettings()
    : McpHttpBaseUrl(TEXT("http://127.0.0.1:3091"))
    , RunMode(EHaybaRecipeRunMode::Manual)
    , MaxRecipeDepth(8)
{}

const UHaybaRecipeSettings* UHaybaRecipeSettings::GetChecked()
{
    const UHaybaRecipeSettings* S = GetDefault<UHaybaRecipeSettings>();
    check(S);
    return S;
}
