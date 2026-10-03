#include "Misc/AutomationTest.h"
#include "HaybaMCPEditorHealth.h"
#include "HaybaMCPWorldTileCapture.h"

#if WITH_DEV_AUTOMATION_TESTS

#include "Editor.h"
#include "Engine/World.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaWorldTileCaptureTest,
    "Hayba.MCP.World.TileCaptureLifecycle",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaWorldTileCaptureTest::RunTest(const FString& Parameters)
{
    using namespace HaybaWorldTileCapture;
    TestEqual(TEXT("uncaptured state is explicit"),
        FString(StateName(EState::NotCaptured)), FString(TEXT("not_captured")));
    TestEqual(TEXT("aborted state is explicit"),
        FString(StateName(EState::Aborted)), FString(TEXT("aborted")));
    const FStartResult InvalidLOD = Start(nullptr, 3, 0, 0, 0);
    TestEqual(TEXT("out-of-range tile is rejected before world access"),
        InvalidLOD.Status.State, EState::Rejected);
    TestEqual(TEXT("tile address error is explicit"),
        InvalidLOD.Error, FString(TEXT("invalid_tile_address")));
    const FStartResult NonCanonical = StartById(nullptr, TEXT("tile:2:000:0:0"));
    TestEqual(TEXT("noncanonical tile ID is rejected"),
        NonCanonical.Status.State, EState::Rejected);

    FString Child;
    if (!FParse::Value(FCommandLine::Get(), TEXT("HaybaAutomationChild="), Child) ||
        Child != TEXT("p0scratch")) return true;
    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    if (!TestNotNull(TEXT("scratch editor world"), World)) return false;
    Initialize();

    const FStartResult First = Start(World, 2, 120, 0, 0);
    if (!TestEqual(TEXT("valid tile queues a capture"), First.Status.State,
        EState::Queued)) return false;
    TestEqual(TEXT("capture ID has 32 hex digits"), First.Status.CaptureId.Len(), 32);
    bool bAllHex = true;
    for (const TCHAR Digit : First.Status.CaptureId) bAllHex &= FChar::IsHexDigit(Digit);
    TestTrue(TEXT("capture ID is hex"), bAllHex);
    const FStartResult Duplicate = StartById(World, First.Status.TileId);
    TestTrue(TEXT("same active tile deduplicates"), Duplicate.bDeduplicated);
    TestEqual(TEXT("deduplication preserves capture ID"),
        Duplicate.Status.CaptureId, First.Status.CaptureId);
    TestEqual(TEXT("status by tile finds queued capture"),
        GetStatus(World, First.Status.TileId).CaptureId, First.Status.CaptureId);
    TestEqual(TEXT("uppercase capture ID resolves the same queued request"),
        GetStatus(World, First.Status.CaptureId.ToUpper()).CaptureId,
        First.Status.CaptureId);

    int32 DoneEvents = 0;
    const FDelegateHandle Observer = Subscribe(First.Status.CaptureId,
        FOnEvent::FDelegate::CreateLambda([&DoneEvents](const HaybaWorldTileCapture::FEvent& Event)
        {
            if (Event.Type == EEventType::Done) ++DoneEvents;
        }));
    TestTrue(TEXT("observer subscription is valid"), Observer.IsValid());
    const FStatus Cancelled = Cancel(World, First.Status.CaptureId);
    TestEqual(TEXT("cancel by capture ID is terminal"), Cancelled.State, EState::Cancelled);
    TestTrue(TEXT("cancel names the coverage gap"),
        Cancelled.Gaps.Contains(TEXT("capture_cancelled")));
    TestEqual(TEXT("observer receives one done event"), DoneEvents, 1);
    TestFalse(TEXT("cancelled capture has no published snapshot"),
        Cancelled.Snapshot.IsValid());
    Unsubscribe(First.Status.CaptureId, Observer);

    TArray<FString> QueuedIds;
    for (int32 Index = 0; Index < MaxQueuedRequests; ++Index)
    {
        const FStartResult Request = Start(World, 2, 200 + Index, 0, 0);
        if (!TestEqual(TEXT("bounded queue accepts each available slot"),
            Request.Status.State, EState::Queued)) return false;
        QueuedIds.Add(Request.Status.CaptureId);
    }
    const FStartResult Overflow = Start(World, 2, 300, 0, 0);
    TestEqual(TEXT("ninth pending request is rejected"),
        Overflow.Status.State, EState::Rejected);
    TestEqual(TEXT("queue saturation is explicit"),
        Overflow.Error, FString(TEXT("tile_request_queue_full")));
    for (const FString& Id : QueuedIds)
        TestEqual(TEXT("queued request can be cancelled"),
            Cancel(World, Id).State, EState::Cancelled);
    const FStartResult Reused = Start(World, 2, 300, 0, 0);
    TestEqual(TEXT("cancel frees queue capacity"), Reused.Status.State, EState::Queued);
    Cancel(World, Reused.Status.CaptureId);

    {
        FHaybaEditorHealth::FScopedOverrideForTests Health;
        const FStartResult UnsafeCandidate = Start(World, 2, 301, 0, 0);
        if (!TestEqual(TEXT("safe editor can queue the candidate"),
            UnsafeCandidate.Status.State, EState::Queued)) return false;
        AddExpectedError(TEXT("editor_unsafe_restart_required"),
            EAutomationExpectedErrorFlags::Contains, 1);
        FHaybaEditorHealth::RecordCaughtFault(EHaybaFaultSite::TestInjection, 0xC0000005u);
        const FStatus Aborted = GetStatus(World, UnsafeCandidate.Status.CaptureId);
        TestEqual(TEXT("sticky unsafe transition aborts queued capture"),
            Aborted.State, EState::Aborted);
        TestTrue(TEXT("unsafe abort has explicit reason"),
            Aborted.Gaps.Contains(TEXT("editor_unsafe")));
        const FDelegateHandle UnsafeObserver = Subscribe(UnsafeCandidate.Status.CaptureId,
            FOnEvent::FDelegate::CreateLambda([](const HaybaWorldTileCapture::FEvent&) {}));
        TestFalse(TEXT("unsafe editor refuses tile subscriptions"), UnsafeObserver.IsValid());
        const FStartResult Refused = Start(World, 2, 302, 0, 0);
        TestEqual(TEXT("unsafe editor refuses new tile work"),
            Refused.Status.State, EState::Rejected);
    }

    // A published capture can outlive its bounded job record. Polling by its
    // returned ID must still report the retained immutable observation.
    HaybaWorldTileSnapshot::FTile Retained;
    Retained.TileId = TEXT("tile:2:401:0:0");
    Retained.CaptureId = TEXT("abcdefabcdefabcdefabcdefabcdefab");
    Retained.World = World;
    Retained.OriginCm = FVector(World->OriginLocation);
    Retained.PointCount = 7;
    HaybaWorldTileSnapshot::Publish(MoveTemp(Retained));
    const FStatus RetainedStatus = GetStatus(World,
        TEXT("ABCDEFABCDEFABCDEFABCDEFABCDEFAB"));
    TestEqual(TEXT("status by capture ID survives job pruning"),
        RetainedStatus.State, EState::Captured);
    TestEqual(TEXT("status reports the retained point count"),
        RetainedStatus.PointCount, 7);
    HaybaWorldTileSnapshot::Invalidate();
    return true;
}

#endif
