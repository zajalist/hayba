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

    // ── Scale & position ────────────────────────────────────────────────────────
    // UE landscape height: uint16 0–65535 maps to -256..+256 (512 total) * ZScale.
    // At ZScale=100, total range = 512m.  ZScale = MaxHeightM / 512 * 100.
    // XY: each quad = 1m at scale 100.  ScaleXY = WorldSizeKm * 1000 / Resolution * 100.
    const int32 Resolution = OutDescriptor.ImportResolutions[DescriptorIndex].Width;
    const float ScaleXY = (Params.WorldSizeKm * 1000.f) / static_cast<float>(Resolution) * 100.f;
    const float ScaleZ  = (Params.MaxHeightM / 512.f) * 100.f;
    const FVector Scale(ScaleXY, ScaleXY, ScaleZ);

    const FVector Offset = FTransform(FRotator::ZeroRotator, FVector::ZeroVector, Scale)
        .TransformVector(FVector(
            -OutComponentCount.X * QuadsPerComponent / 2.0,
            -OutComponentCount.Y * QuadsPerComponent / 2.0,
            0.0));
    const FVector Location = FVector(0.f, 0.f, 0.f) + Offset;

    UE_LOG(LogHaybaMCPImporter, Log,
        TEXT("Scale: XY=%.2f Z=%.2f  Resolution=%d  WorldSize=%.1fkm  MaxHeight=%.1fm"),
        ScaleXY, ScaleZ, Resolution, Params.WorldSizeKm, Params.MaxHeightM);

    // ── Spawn landscape ───────────────────────────────────────────────────────
    ALandscape* Landscape = World->SpawnActor<ALandscape>(Location, FRotator::ZeroRotator);
    if (!Landscape)
    {
        UE_LOG(LogHaybaMCPImporter, Error, TEXT("Failed to spawn ALandscape actor"));
        return false;
    }
    Landscape->SetActorRelativeScale3D(Scale);

    // Maps keyed by empty FGuid — Import() expects this convention
    // (see GaeaUnrealTools/GaeaSubsystem.cpp for reference)
    TMap<FGuid, TArray<uint16>> HeightmapDataPerLayers;
    HeightmapDataPerLayers.Add(FGuid(), MoveTemp(FinalHeightData));

    TMap<FGuid, TArray<FLandscapeImportLayerInfo>> MaterialLayerDataPerLayers;
    MaterialLayerDataPerLayers.Add(FGuid(), TArray<FLandscapeImportLayerInfo>());

    Landscape->Import(
        FGuid::NewGuid(), 0, 0, SizeX - 1, SizeY - 1,
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

    Landscape->StaticLightingLOD = FMath::DivideAndRoundUp(
        FMath::CeilLogTwo((SizeX * SizeY) / (2048 * 2048) + 1), (uint32)2);

    Landscape->SetActorLabel(Params.ActorLabel);

    UE_LOG(LogHaybaMCPImporter, Log,
        TEXT("Landscape '%s' created: %dx%d from %s"),
        *Params.ActorLabel, SizeX, SizeY, *Params.HeightmapPath);

    return true;
}
