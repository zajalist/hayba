#include "HaybaMCPLandscapeImporter.h"
#include "LandscapeProxy.h"
#include "Landscape.h"
#include "LandscapeImportHelper.h"
#include "Editor.h"
#include "Engine/World.h"
#include "HAL/PlatformFileManager.h"
#include "Logging/LogMacros.h"
#include "Misc/Paths.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPImporter, Log, All);

bool FHaybaMCPLandscapeImporter::ImportHeightmap(const FString& HeightmapPath)
{
    if (!FPlatformFileManager::Get().GetPlatformFile().FileExists(*HeightmapPath))
    {
        UE_LOG(LogHaybaMCPImporter, Error, TEXT("Heightmap not found: %s"), *HeightmapPath);
        return false;
    }

    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    if (!World)
    {
        UE_LOG(LogHaybaMCPImporter, Error, TEXT("No editor world available"));
        return false;
    }

    FLandscapeImportDescriptor OutDescriptor;
    FText OutMessage;
    ELandscapeImportResult ImportResult = FLandscapeImportHelper::GetHeightmapImportDescriptor(
        HeightmapPath, /*bSingleFile=*/true, /*bFlipYAxis=*/false, OutDescriptor, OutMessage);

    if (ImportResult == ELandscapeImportResult::Error)
    {
        UE_LOG(LogHaybaMCPImporter, Error, TEXT("Failed to read heightmap descriptor: %s"), *OutMessage.ToString());
        return false;
    }

    if (OutDescriptor.ImportResolutions.Num() == 0)
    {
        UE_LOG(LogHaybaMCPImporter, Error, TEXT("Heightmap has no valid resolutions: %s"), *HeightmapPath);
        return false;
    }

    const int32 DescriptorIndex = 0;
    int32 OutQuadsPerSection = 0, OutSectionsPerComponent = 0;
    FIntPoint OutComponentCount;
    FLandscapeImportHelper::ChooseBestComponentSizeForImport(
        OutDescriptor.ImportResolutions[DescriptorIndex].Width,
        OutDescriptor.ImportResolutions[DescriptorIndex].Height,
        OutQuadsPerSection, OutSectionsPerComponent, OutComponentCount);

    TArray<uint16> ImportData;
    ImportResult = FLandscapeImportHelper::GetHeightmapImportData(
        OutDescriptor, DescriptorIndex, ImportData, OutMessage);

    if (ImportResult == ELandscapeImportResult::Error)
    {
        UE_LOG(LogHaybaMCPImporter, Error, TEXT("Failed to load heightmap data: %s"), *OutMessage.ToString());
        return false;
    }

    const int32 QuadsPerComponent = OutSectionsPerComponent * OutQuadsPerSection;
    const int32 SizeX = OutComponentCount.X * QuadsPerComponent + 1;
    const int32 SizeY = OutComponentCount.Y * QuadsPerComponent + 1;

    TArray<uint16> FinalHeightData;
    FLandscapeImportHelper::TransformHeightmapImportData(
        ImportData, FinalHeightData,
        OutDescriptor.ImportResolutions[DescriptorIndex],
        FLandscapeImportResolution(SizeX, SizeY),
        ELandscapeImportTransformType::ExpandCentered);

    FGuid LayerGuid = FGuid::NewGuid();
    TMap<FGuid, TArray<uint16>> HeightmapDataPerLayers;
    HeightmapDataPerLayers.Add(LayerGuid, FinalHeightData);
    TMap<FGuid, TArray<FLandscapeImportLayerInfo>> MaterialLayerDataPerLayers;

    FTransform LandscapeTransform;
    LandscapeTransform.SetLocation(FVector(0.0, 0.0, 0.0));
    LandscapeTransform.SetScale3D(FVector(100.0, 100.0, 100.0));

    ALandscape* Landscape = World->SpawnActor<ALandscape>(ALandscape::StaticClass(), LandscapeTransform);
    if (!Landscape)
    {
        UE_LOG(LogHaybaMCPImporter, Error, TEXT("Failed to spawn ALandscape actor"));
        return false;
    }

    Landscape->Import(
        LayerGuid, 0, 0, SizeX - 1, SizeY - 1,
        OutSectionsPerComponent, OutQuadsPerSection,
        HeightmapDataPerLayers, *HeightmapPath,
        MaterialLayerDataPerLayers,
        ELandscapeImportAlphamapType::Additive,
        TArrayView<const FLandscapeLayer>()
    );

    Landscape->SetActorLabel(TEXT("Hayba_Terrain"));
    UE_LOG(LogHaybaMCPImporter, Log, TEXT("Landscape created: %dx%d from %s"), SizeX, SizeY, *HeightmapPath);
    return true;
}
