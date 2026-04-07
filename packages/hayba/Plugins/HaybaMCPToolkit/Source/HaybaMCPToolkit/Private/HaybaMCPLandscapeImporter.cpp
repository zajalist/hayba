#include "HaybaMCPLandscapeImporter.h"
#include "LandscapeProxy.h"
#include "Landscape.h"
#include "LandscapeImportHelper.h"
#include "Editor.h"
#include "Engine/World.h"
#include "HAL/PlatformFileManager.h"
#include "Logging/LogMacros.h"
#include "Misc/Paths.h"
#include "Materials/MaterialInterface.h"
#include "UObject/ConstructorHelpers.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPImporter, Log, All);

bool FHaybaMCPLandscapeImporter::ImportHeightmap(const FHaybaMCPImportParams& Params)
{
    if (!FPlatformFileManager::Get().GetPlatformFile().FileExists(*Params.HeightmapPath))
    {
        UE_LOG(LogHaybaMCPImporter, Error, TEXT("Heightmap not found: %s"), *Params.HeightmapPath);
        return false;
    }

    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    if (!World)
    {
        UE_LOG(LogHaybaMCPImporter, Error, TEXT("No editor world available"));
        return false;
    }

    // ── Heightmap descriptor ──────────────────────────────────────────────────
    FLandscapeImportDescriptor OutDescriptor;
    FText OutMessage;
    ELandscapeImportResult ImportResult = FLandscapeImportHelper::GetHeightmapImportDescriptor(
        Params.HeightmapPath, /*bSingleFile=*/true, /*bFlipYAxis=*/false, OutDescriptor, OutMessage);

    if (ImportResult == ELandscapeImportResult::Error)
    {
        UE_LOG(LogHaybaMCPImporter, Error, TEXT("Failed to read heightmap descriptor: %s"), *OutMessage.ToString());
        return false;
    }

    if (OutDescriptor.ImportResolutions.Num() == 0)
    {
        UE_LOG(LogHaybaMCPImporter, Error, TEXT("Heightmap has no valid resolutions: %s"), *Params.HeightmapPath);
        return false;
    }

    // ── Component sizing ──────────────────────────────────────────────────────
    const int32 DescriptorIndex = 0;
    int32 OutQuadsPerSection = 0, OutSectionsPerComponent = 0;
    FIntPoint OutComponentCount;
    FLandscapeImportHelper::ChooseBestComponentSizeForImport(
        OutDescriptor.ImportResolutions[DescriptorIndex].Width,
        OutDescriptor.ImportResolutions[DescriptorIndex].Height,
        OutQuadsPerSection, OutSectionsPerComponent, OutComponentCount);

    // ── Heightmap data ────────────────────────────────────────────────────────
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

    // ── Gaea2Unreal scale formula ─────────────────────────────────────────────
    // Source: github.com/QuadSpinner/Gaea2Unreal GaeaSubsystem.cpp
    // ScaleXY = worldSizeKm * 1000m * 100cm / resolution  (cm per pixel)
    // ScaleZ  = maxHeightM * 100cm / 512                  (Gaea's height baseline)
    // LocationZ = maxHeightM * 100cm / 2                  (center landscape vertically)
    const int32 Resolution = OutDescriptor.ImportResolutions[DescriptorIndex].Width;
    const float ScaleXY   = (Params.WorldSizeKm * 1000.f * 100.f) / static_cast<float>(Resolution);
    const float ScaleZ    = (Params.MaxHeightM  * 100.f) / 512.f;
    const float LocationZ = (Params.MaxHeightM  * 100.f) / 2.f;

    UE_LOG(LogHaybaMCPImporter, Log,
        TEXT("Scale: XY=%.2f ScaleZ=%.2f Resolution=%d WorldSize=%.1fkm MaxHeight=%.1fm"),
        ScaleXY, ScaleZ, Resolution, Params.WorldSizeKm, Params.MaxHeightM);

    // ── Spawn landscape ───────────────────────────────────────────────────────
    FTransform LandscapeTransform;
    LandscapeTransform.SetLocation(FVector(0.f, 0.f, LocationZ));
    LandscapeTransform.SetScale3D(FVector(ScaleXY, ScaleXY, ScaleZ));

    TMap<FGuid, TArray<uint16>> HeightmapDataPerLayers;
    TMap<FGuid, TArray<FLandscapeImportLayerInfo>> MaterialLayerDataPerLayers;
    const FGuid LayerGuid = FGuid::NewGuid();
    HeightmapDataPerLayers.Add(LayerGuid, FinalHeightData);

    ALandscape* Landscape = World->SpawnActor<ALandscape>(ALandscape::StaticClass(), LandscapeTransform);
    if (!Landscape)
    {
        UE_LOG(LogHaybaMCPImporter, Error, TEXT("Failed to spawn ALandscape actor"));
        return false;
    }

    Landscape->Import(
        LayerGuid, 0, 0, SizeX - 1, SizeY - 1,
        OutSectionsPerComponent, OutQuadsPerSection,
        HeightmapDataPerLayers, *Params.HeightmapPath,
        MaterialLayerDataPerLayers,
        ELandscapeImportAlphamapType::Additive,
        TArrayView<const FLandscapeLayer>()
    );

    // ── Material ──────────────────────────────────────────────────────────────
    if (!Params.LandscapeMaterial.IsEmpty())
    {
        UMaterialInterface* Mat = LoadObject<UMaterialInterface>(nullptr, *Params.LandscapeMaterial);
        if (Mat)
        {
            Landscape->LandscapeMaterial = Mat;
        }
        else
        {
            UE_LOG(LogHaybaMCPImporter, Warning,
                TEXT("Could not load landscape material: %s — landscape created without material"),
                *Params.LandscapeMaterial);
        }
    }

    Landscape->SetActorLabel(Params.ActorLabel);

    UE_LOG(LogHaybaMCPImporter, Log,
        TEXT("Landscape '%s' created: %dx%d from %s"),
        *Params.ActorLabel, SizeX, SizeY, *Params.HeightmapPath);

    return true;
}
