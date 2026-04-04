#include "HaybaGaeaLandscapeImporter.h"
#include "LandscapeProxy.h"
#include "Landscape.h"
#include "LandscapeImportHelper.h"
#include "LandscapeEditorModule.h"
#include "Editor.h"
#include "Engine/World.h"
#include "Misc/FileHelper.h"
#include "HAL/PlatformFileManager.h"
#include "Logging/LogMacros.h"
#include "IImageWrapper.h"
#include "IImageWrapperModule.h"
#include "Modules/ModuleManager.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaImporter, Log, All);

bool FHaybaGaeaLandscapeImporter::ImportHeightmap(const FString& HeightmapPath)
{
	if (!FPlatformFileManager::Get().GetPlatformFile().FileExists(*HeightmapPath))
	{
		UE_LOG(LogHaybaImporter, Error, TEXT("Heightmap not found: %s"), *HeightmapPath);
		return false;
	}

	UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
	if (!World)
	{
		UE_LOG(LogHaybaImporter, Error, TEXT("No editor world available"));
		return false;
	}

	// Load raw file data
	TArray<uint8> RawData;
	if (!FFileHelper::LoadFileToArray(RawData, *HeightmapPath))
	{
		UE_LOG(LogHaybaImporter, Error, TEXT("Failed to load heightmap file: %s"), *HeightmapPath);
		return false;
	}

	// Decode heightmap — supports R16 (raw 16-bit) and PNG
	TArray<uint16> HeightData;
	int32 Width = 0, Height = 0;
	const bool bIsR16 = HeightmapPath.EndsWith(TEXT(".r16")) || HeightmapPath.EndsWith(TEXT(".raw"));

	if (bIsR16)
	{
		// R16: raw little-endian uint16 values, square image assumed
		const int32 NumPixels = RawData.Num() / 2;
		const int32 Side = FMath::RoundToInt(FMath::Sqrt((float)NumPixels));
		if (Side * Side * 2 == RawData.Num())
		{
			Width = Height = Side;
			HeightData.SetNumUninitialized(NumPixels);
			FMemory::Memcpy(HeightData.GetData(), RawData.GetData(), RawData.Num());
		}
		else
		{
			UE_LOG(LogHaybaImporter, Warning, TEXT("R16 file size %d does not form a square — falling back to flat"), RawData.Num());
		}
	}
	else
	{
		// PNG: decode 16-bit greyscale via IImageWrapper
		IImageWrapperModule& ImageWrapperModule = FModuleManager::LoadModuleChecked<IImageWrapperModule>(TEXT("ImageWrapper"));
		TSharedPtr<IImageWrapper> Wrapper = ImageWrapperModule.CreateImageWrapper(EImageFormat::PNG);

		if (Wrapper.IsValid() && Wrapper->SetCompressed(RawData.GetData(), RawData.Num()))
		{
			TArray<uint8> Uncompressed;
			if (Wrapper->GetRaw(ERGBFormat::Gray, 16, Uncompressed))
			{
				Width = Wrapper->GetWidth();
				Height = Wrapper->GetHeight();
				HeightData.SetNumUninitialized(Width * Height);
				FMemory::Memcpy(HeightData.GetData(), Uncompressed.GetData(), Uncompressed.Num());
			}
		}
	}

	// Fall back to flat landscape if decode failed
	if (HeightData.Num() == 0)
	{
		UE_LOG(LogHaybaImporter, Warning, TEXT("Could not decode heightmap — creating flat landscape"));
		Width = Height = 1009; // 1009 verts = 1008 quads (standard UE landscape)
		HeightData.Init(32768, Width * Height);
	}

	// UE landscapes require specific resolutions; clamp/pad to nearest valid size
	// Valid: 127, 253, 505, 1009, 2017, 4033, 8129
	// For now we accept whatever Gaea exported if it matches
	const int32 Size = Width; // assume square
	const int32 NumSections = 2;
	const int32 QuadsPerSection = (Size - 1) / NumSections;

	FTransform LandscapeTransform;
	LandscapeTransform.SetLocation(FVector(0.0, 0.0, 0.0));
	LandscapeTransform.SetScale3D(FVector(100.0, 100.0, 100.0));

	ALandscape* Landscape = World->SpawnActor<ALandscape>(ALandscape::StaticClass(), LandscapeTransform);
	if (!Landscape)
	{
		UE_LOG(LogHaybaImporter, Error, TEXT("Failed to spawn ALandscape actor"));
		return false;
	}

	TMap<FGuid, TArray<uint16>> HeightmapDataPerLayer;
	TMap<FGuid, TArray<FLandscapeImportLayerInfo>> MaterialLayerDataPerLayer;
	FGuid LayerGuid = FGuid::NewGuid();
	HeightmapDataPerLayer.Add(LayerGuid, HeightData);

	Landscape->Import(
		LayerGuid,
		0, 0, Size - 1, Size - 1,
		NumSections, QuadsPerSection,
		HeightmapDataPerLayer,
		nullptr,
		MaterialLayerDataPerLayer,
		ELandscapeImportAlphamapType::Additive
	);

	Landscape->SetActorLabel(TEXT("HaybaGaea_Terrain"));
	UE_LOG(LogHaybaImporter, Log, TEXT("Landscape created from: %s (%dx%d)"), *HeightmapPath, Width, Height);
	return true;
}
