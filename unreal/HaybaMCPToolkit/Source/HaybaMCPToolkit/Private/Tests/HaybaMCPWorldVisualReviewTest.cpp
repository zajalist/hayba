#include "Misc/AutomationTest.h"

#if WITH_DEV_AUTOMATION_TESTS

#include "HaybaMCPLatentTest.h"
#include "HaybaMCPSceneMapWebPanel.h"
#include "HaybaMCPWorldDepth.h"
#include "HaybaMCPWorldGeometry.h"
#include "HaybaMCPWorldTileCapture.h"
#include "HaybaMCPWorldTileSnapshot.h"
#include "handlers/HaybaMCPSceneGraphHandler.h"
#include "FileHelpers.h"
#include "Editor.h"
#include "EngineUtils.h"
#include "Components/StaticMeshComponent.h"
#include "Framework/Application/SlateApplication.h"
#include "HAL/PlatformTime.h"
#include "ImageUtils.h"
#include "Misc/CommandLine.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "RHI.h"
#include "Widgets/SWindow.h"

namespace
{
struct FWorldVisualReviewContext
{
    TSharedPtr<SHaybaMCPSceneMapWebPanel> Panel;
    TSharedPtr<SWindow> Window;
    double ScanCompletedAt = 0.0;
    FString TileId;
    FString ServiceCaptureId;
    double TileCapturedAt = 0.0;
    bool bTileFocusIssued = false;
};
}

// Opt-in scratch-editor capture. A latent wait lets CEF load the local page and
// the real world scan advance; the general VisualReview test captures only its
// initial loading state and must not be mistaken for a loaded-world review.
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaWorldVisualReview,
    "Hayba.MCP.Workspace.WorldVisualReview",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaWorldVisualReview::RunTest(const FString&)
{
    if (!FParse::Param(FCommandLine::Get(), TEXT("HaybaWorldVisualReview")) || GUsingNullRHI)
    {
        AddInfo(TEXT("Loaded-world visual capture requires an opted-in scratch editor with a renderer."));
        return true;
    }

    FString MapPath;
    if (!FParse::Value(FCommandLine::Get(), TEXT("HaybaWorldVisualMap="), MapPath) ||
        !FPaths::FileExists(MapPath))
    {
        AddError(TEXT("Pass -HaybaWorldVisualMap=<scratch .umap path> for the loaded-world review."));
        return false;
    }
    if (!FEditorFileUtils::LoadMap(MapPath, false, false))
    {
        AddError(TEXT("The scratch visual-review level could not be loaded."));
        return false;
    }

    TSharedRef<FWorldVisualReviewContext> Context = MakeShared<FWorldVisualReviewContext>();
    Context->Panel = SNew(SHaybaMCPSceneMapWebPanel);
    Context->Window = SNew(SWindow).ClientSize(FVector2D(1000, 720))
        .Title(FText::FromString(TEXT("Hayba World visual review")))
        .SupportsMaximize(false).SupportsMinimize(false)[Context->Panel.ToSharedRef()];
    FSlateApplication::Get().AddWindow(Context->Window.ToSharedRef());

    ADD_LATENT_AUTOMATION_COMMAND(FHaybaWaitUntilLatentCommand(this,
        TEXT("the loaded World preview has completed mesh and depth scans"), [Context]()
        {
            if (!Context->Panel.IsValid() || Context->Panel->GetCellCount() == 0 ||
                !Context->Panel->IsScanDone()) return false;
            if (Context->ScanCompletedAt <= 0.0) Context->ScanCompletedAt = FPlatformTime::Seconds();
            return FPlatformTime::Seconds() - Context->ScanCompletedAt >= 2.0;
        }, 60.0));

    ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Context]()
    {
        TestTrue(TEXT("World scan produced actor metadata"),
            Context->Panel.IsValid() && Context->Panel->GetCellCount() > 0);
        if (Context->Panel.IsValid())
        {
            AddInfo(FString::Printf(TEXT("World native depth: status=%s, points=%d, pixels=%d, readback=%.2f ms, processing=%.2f ms, maxTick=%.2f ms"),
                *Context->Panel->GetDepthStatus(), Context->Panel->GetDepthPointCount(),
                Context->Panel->GetDepthProcessedPixelCount(), Context->Panel->GetDepthReadbackMs(),
                Context->Panel->GetDepthProcessingCpuMs(), Context->Panel->GetDepthMaxTickCpuMs()));
            if (Context->Panel->DidDepthReadbackExceedBudget())
                AddWarning(FString::Printf(TEXT("World depth readback stalled the editor thread for %.2f ms (%.0f ms warning threshold); valid captured pixels were retained."),
                    Context->Panel->GetDepthReadbackMs(), HaybaWorldDepth::ReadbackWarningMs));
            TestTrue(TEXT("World scan completed before screenshot"), Context->Panel->IsScanDone());
            TestTrue(TEXT("actual scene-depth points reached World"),
                Context->Panel->GetDepthPointCount() > HaybaWorldDepth::MaxPoints / 2);
            TestEqual(TEXT("scratch World processed the complete depth raster"),
                Context->Panel->GetDepthProcessedPixelCount(), HaybaWorldDepth::MaxPoints);
            TestEqual(TEXT("scratch World depth capture completed within its CPU budget"),
                Context->Panel->GetDepthStatus(), FString(TEXT("complete_visible_subset")));
        }
        if (Context->Panel.IsValid() && Context->Window.IsValid())
        {
            FSlateApplication::Get().ForceRedrawWindow(Context->Window.ToSharedRef());
            TArray<FColor> Pixels;
            FIntVector Size;
            const bool bCaptured = FSlateApplication::Get().TakeScreenshot(
                Context->Panel.ToSharedRef(), Pixels, Size);
            TestTrue(TEXT("loaded World screenshot captured"), bCaptured);
            if (bCaptured)
            {
                const FString Dir = FPaths::ProjectSavedDir() / TEXT("Screenshots/HaybaReview");
                IFileManager::Get().MakeDirectory(*Dir, true);
                TArray64<uint8> Png;
                FImageUtils::PNGCompressImageArray(Size.X, Size.Y, Pixels, Png);
                TestTrue(TEXT("loaded World screenshot saved"),
                    FFileHelper::SaveArrayToFile(Png, *(Dir / TEXT("World-Loaded-1000.png"))));
            }
            // A second capture must show real zoom-local mesh detail, not just
            // the overview/depth image above. Choose the busiest tile in the
            // synthetic scratch level so the fixture stays deterministic.
            UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
            TMap<FString, int32> TileCounts;
            TMap<FString, FIntVector> TileCoords;
            if (IsValid(World))
            {
                for (TActorIterator<AActor> It(World); It; ++It)
                {
                    AActor* Actor = *It;
                    if (!IsValid(Actor) || !Actor->FindComponentByClass<UStaticMeshComponent>()) continue;
                    const FVector Center = Actor->GetComponentsBoundingBox(true).GetCenter();
                    const FIntVector Coord(FMath::FloorToInt(Center.X / 1000.0),
                        FMath::FloorToInt(Center.Y / 1000.0),
                        FMath::FloorToInt(Center.Z / 1000.0));
                    FBox Bounds(EForceInit::ForceInit);
                    if (!HaybaWorldGeometry::TileBounds(2, Coord.X, Coord.Y, Coord.Z, Bounds)) continue;
                    const FString Id = HaybaWorldGeometry::TileId(2, Coord.X, Coord.Y, Coord.Z);
                    TileCounts.FindOrAdd(Id)++;
                    TileCoords.Add(Id, Coord);
                }
            }
            int32 BestCount = 0;
            for (const TPair<FString, int32>& Entry : TileCounts)
            {
                if (Entry.Value <= BestCount) continue;
                BestCount = Entry.Value;
                Context->TileId = Entry.Key;
            }
            if (!TestTrue(TEXT("scratch level has a mesh tile to refine"), !Context->TileId.IsEmpty()))
                return true;
            const FIntVector Coord = TileCoords[Context->TileId];
            Context->bTileFocusIssued = Context->Panel->FocusTile(2, Coord.X, Coord.Y, Coord.Z);
            TestTrue(TEXT("World focused a fine geometry tile"), Context->bTileFocusIssued);
        }
        return true;
    }));

    ADD_LATENT_AUTOMATION_COMMAND(FHaybaWaitUntilLatentCommand(this,
        TEXT("the focused World tile has published real mesh points"), [Context]()
        {
            if (!Context->bTileFocusIssued) return true;
            UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
            const TSharedPtr<const HaybaWorldTileSnapshot::FTile> Tile =
                HaybaWorldTileSnapshot::GetForWorld(World, Context->TileId);
            if (!Tile.IsValid() || Tile->PointCount == 0) return false;
            if (Context->TileCapturedAt <= 0.0) Context->TileCapturedAt = FPlatformTime::Seconds();
            return FPlatformTime::Seconds() - Context->TileCapturedAt >= 2.0;
        }, 90.0));

    ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Context]()
    {
        if (Context->bTileFocusIssued && Context->Panel.IsValid() && Context->Window.IsValid())
        {
            const TSharedPtr<const HaybaWorldTileSnapshot::FTile> Tile =
                HaybaWorldTileSnapshot::GetForWorld(GEditor->GetEditorWorldContext().World(), Context->TileId);
            TestTrue(TEXT("focused tile remains queryable"), Tile.IsValid());
            if (Tile.IsValid())
            {
                TestTrue(TEXT("focused tile has geometry-derived points"), Tile->PointCount > 0);
                AddInfo(FString::Printf(TEXT("World fine tile: %s, points=%d, pages=%d, partial=%s"),
                    *Context->TileId, Tile->PointCount, Tile->Pages.Num(),
                    Tile->bPartial ? TEXT("true") : TEXT("false")));
            }
            FSlateApplication::Get().ForceRedrawWindow(Context->Window.ToSharedRef());
            TArray<FColor> Pixels;
            FIntVector Size;
            const bool bCaptured = FSlateApplication::Get().TakeScreenshot(
                Context->Panel.ToSharedRef(), Pixels, Size);
            TestTrue(TEXT("focused World screenshot captured"), bCaptured);
            if (bCaptured)
            {
                const FString Dir = FPaths::ProjectSavedDir() / TEXT("Screenshots/HaybaReview");
                IFileManager::Get().MakeDirectory(*Dir, true);
                TArray64<uint8> Png;
                FImageUtils::PNGCompressImageArray(Size.X, Size.Y, Pixels, Png);
                TestTrue(TEXT("focused World screenshot saved"),
                    FFileHelper::SaveArrayToFile(Png, *(Dir / TEXT("World-Tile-1000.png"))));
            }
        }
        HaybaWorldTileCapture::Initialize();
        const HaybaWorldTileCapture::FStartResult Started = HaybaWorldTileCapture::StartById(
            GEditor->GetEditorWorldContext().World(), Context->TileId);
        TestEqual(TEXT("agent capture of focused mesh tile queued"), Started.Status.State,
            HaybaWorldTileCapture::EState::Queued);
        Context->ServiceCaptureId = Started.Status.CaptureId;
        return true;
    }));

    ADD_LATENT_AUTOMATION_COMMAND(FHaybaWaitUntilLatentCommand(this,
        TEXT("the agent World capture has published a geometry tile"), [Context]()
        {
            if (Context->ServiceCaptureId.IsEmpty()) return true;
            const HaybaWorldTileCapture::FStatus Status = HaybaWorldTileCapture::GetStatus(
                GEditor->GetEditorWorldContext().World(), Context->ServiceCaptureId);
            return Status.State == HaybaWorldTileCapture::EState::Captured ||
                Status.State == HaybaWorldTileCapture::EState::Partial ||
                Status.State == HaybaWorldTileCapture::EState::Aborted;
        }, 60.0));

    ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Context]()
    {
        if (!Context->ServiceCaptureId.IsEmpty())
        {
            const HaybaWorldTileCapture::FStatus Status = HaybaWorldTileCapture::GetStatus(
                GEditor->GetEditorWorldContext().World(), Context->ServiceCaptureId);
            TestTrue(TEXT("agent capture published real mesh points"), Status.Snapshot.IsValid() &&
                Status.PointCount > 0);
            if (Status.Snapshot.IsValid())
            {
                TestEqual(TEXT("agent tile capture ID matches published snapshot"),
                    Status.Snapshot->CaptureId, Context->ServiceCaptureId);
                TestTrue(TEXT("agent tile has authored semantic groups"),
                    !Status.Snapshot->SemanticGroups.IsEmpty());
                AddInfo(FString::Printf(TEXT("Agent World tile: %s, points=%d, semantic groups=%d, gaps=%d"),
                    *Context->TileId, Status.PointCount,
                    Status.Snapshot->SemanticGroups.Num(), Status.Gaps.Num()));

                FHaybaMCPSceneGraphHandler Handler;
                TSharedRef<FJsonObject> StatusParams = MakeShared<FJsonObject>();
                StatusParams->SetStringField(TEXT("action"), TEXT("status"));
                StatusParams->SetStringField(TEXT("capture_id"), Context->ServiceCaptureId);
                const FHaybaHandlerResult WireStatus = Handler.Handle(TEXT("world_tile_capture"), StatusParams);
                TestTrue(TEXT("agent capture status resolves through the native handler"),
                    WireStatus.bOk && WireStatus.Data.IsValid() &&
                    WireStatus.Data->GetStringField(TEXT("capture_id")) == Context->ServiceCaptureId &&
                    WireStatus.Data->GetNumberField(TEXT("point_count")) > 0);

                TSharedRef<FJsonObject> RelationParams = MakeShared<FJsonObject>();
                RelationParams->SetStringField(TEXT("source"), TEXT("mesh_tile"));
                RelationParams->SetStringField(TEXT("section"), TEXT("relations"));
                RelationParams->SetStringField(TEXT("tile_id"), Context->TileId);
                RelationParams->SetStringField(TEXT("expected_capture_id"), Context->ServiceCaptureId);
                const FHaybaHandlerResult Relations = Handler.Handle(TEXT("world_semantic_snapshot"), RelationParams);
                TestTrue(TEXT("captured spatial relations resolve through the native handler"),
                    Relations.bOk && Relations.Data.IsValid() &&
                    Relations.Data->GetStringField(TEXT("capture_id")) == Context->ServiceCaptureId &&
                    Relations.Data->GetStringField(TEXT("relation_scope")) ==
                        TEXT("candidates_from_sampled_axis_aligned_bounds"));
            }
        }
        if (Context->Window.IsValid())
            FSlateApplication::Get().RequestDestroyWindow(Context->Window.ToSharedRef());
        return true;
    }));
    return true;
}

#endif
