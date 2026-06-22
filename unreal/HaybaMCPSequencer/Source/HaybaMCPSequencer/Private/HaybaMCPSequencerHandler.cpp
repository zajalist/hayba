#include "HaybaMCPSequencerHandler.h"

#include "Json.h"
#include "Editor.h"
#include "EngineUtils.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "Camera/CameraActor.h"
#include "Subsystems/AssetEditorSubsystem.h"

#include "Misc/PackageName.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"
#include "AssetRegistry/AssetRegistryModule.h"

#include "LevelSequence.h"
#include "LevelSequenceActor.h"
#include "LevelSequencePlayer.h"
#include "MovieScene.h"
#include "MovieSceneSection.h"
#include "MovieSceneTrack.h"
#include "MovieScenePossessable.h"
#include "MovieSceneSpawnable.h"
#include "MovieSceneBinding.h"
#include "MovieSceneObjectBindingID.h"

#include "Tracks/MovieScene3DTransformTrack.h"
#include "Tracks/MovieSceneFloatTrack.h"
#include "Tracks/MovieSceneAudioTrack.h"
#include "Tracks/MovieSceneCameraCutTrack.h"
#include "Sections/MovieSceneFloatSection.h"
#include "Sections/MovieSceneCameraCutSection.h"
#include "Channels/MovieSceneFloatChannel.h"
#include "Channels/MovieSceneChannelProxy.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPSequencer, Log, All);

TArray<FString> FHaybaMCPSequencerHandler::GetCommands() const
{
    return {
        TEXT("seq_create"),
        TEXT("seq_add_track"),
        TEXT("seq_add_keyframe"),
        TEXT("seq_get_info"),
        TEXT("seq_play"),
        TEXT("seq_export"),
        TEXT("seq_add_camera_cut"),
        TEXT("seq_set_playback_range")
    };
}

// ---------------- helpers ----------------

static ULevelSequence* LoadLevelSequence(const FString& Path)
{
    return LoadObject<ULevelSequence>(nullptr, *Path);
}

static AActor* FindActorByPathOrName(UWorld* World, const FString& PathOrName)
{
    if (!World) return nullptr;
    // try direct object load
    if (UObject* Obj = StaticFindObject(AActor::StaticClass(), nullptr, *PathOrName))
    {
        if (AActor* A = Cast<AActor>(Obj)) return A;
    }
    if (UObject* Obj = LoadObject<UObject>(nullptr, *PathOrName))
    {
        if (AActor* A = Cast<AActor>(Obj)) return A;
    }
    // fallback: by label / name
    for (TActorIterator<AActor> It(World); It; ++It)
    {
        AActor* A = *It;
        if (A->GetName() == PathOrName || A->GetActorLabel() == PathOrName) return A;
    }
    return nullptr;
}

static FFrameNumber SecondsToFrame(UMovieScene* MS, double Seconds)
{
    const FFrameRate Tick = MS->GetTickResolution();
    return (Seconds * Tick).RoundToFrame();
}

static UMovieSceneTrack* FindTrackByGuid(UMovieScene* MS, const FString& TrackGuidStr)
{
    if (!MS) return nullptr;
    // master track first (no binding)
    for (UMovieSceneTrack* T : MS->GetTracks())
    {
        if (T && T->GetSignature().ToString() == TrackGuidStr) return T;
    }
    for (const FMovieSceneBinding& B : const_cast<const UMovieScene*>(MS)->GetBindings())
    {
        for (UMovieSceneTrack* T : B.GetTracks())
        {
            if (T && T->GetSignature().ToString() == TrackGuidStr) return T;
        }
    }
    return nullptr;
}

// Find or create a possessable binding for an object inside the sequence.
static FGuid FindOrCreateBinding(ULevelSequence* Seq, UObject* Object)
{
    if (!Seq || !Object) return FGuid();
    UMovieScene* MS = Seq->GetMovieScene();
    if (!MS) return FGuid();
    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    // BindPossessableObject dereferences World to resolve the possessable's
    // context — a null world (no level loaded) would crash inside Sequencer.
    if (!World) return FGuid();

    // search existing possessables (name-based; cheap idempotency)
    const FString ObjName = Object->GetName();
    for (int32 i = 0; i < MS->GetPossessableCount(); ++i)
    {
        const FMovieScenePossessable& P = MS->GetPossessable(i);
        if (P.GetName() == ObjName) return P.GetGuid();
    }

    // create new possessable
    FGuid NewGuid = MS->AddPossessable(ObjName, Object->GetClass());
    Seq->BindPossessableObject(NewGuid, *Object, World);
    return NewGuid;
}

// ---------------- dispatch ----------------

FHaybaHandlerResult FHaybaMCPSequencerHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& P)
{
    if (!P.IsValid())
        return FHaybaHandlerResult::Err(TEXT("Sequencer: missing params"));

    if (Cmd == TEXT("seq_create"))              return SeqCreate(P);
    if (Cmd == TEXT("seq_add_track"))           return SeqAddTrack(P);
    if (Cmd == TEXT("seq_add_keyframe"))        return SeqAddKeyframe(P);
    if (Cmd == TEXT("seq_add_camera_cut"))      return SeqAddCameraCut(P);
    if (Cmd == TEXT("seq_set_playback_range"))  return SeqSetPlaybackRange(P);
    if (Cmd == TEXT("seq_play"))                return SeqPlay(P);
    if (Cmd == TEXT("seq_get_info"))            return SeqGetInfo(P);
    if (Cmd == TEXT("seq_export"))              return SeqExport(P);
    return FHaybaHandlerResult::Err(FString::Printf(TEXT("SequencerHandler: unknown command %s"), *Cmd));
}

// ---------------- commands ----------------

FHaybaHandlerResult FHaybaMCPSequencerHandler::SeqCreate(const TSharedPtr<FJsonObject>& P)
{
    FString PkgPath, Name;
    if (!P->TryGetStringField(TEXT("path"), PkgPath) || PkgPath.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("seq_create: missing path"));
    if (!P->TryGetStringField(TEXT("name"), Name) || Name.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("seq_create: missing name"));

    const FString Dir = FPackageName::GetLongPackagePath(PkgPath.EndsWith(TEXT("/"))
        ? PkgPath.LeftChop(1) : PkgPath);
    const FString FullPkgName = FString::Printf(TEXT("%s/%s"), *Dir, *Name);

    UPackage* Pkg = CreatePackage(*FullPkgName);
    if (!Pkg) return FHaybaHandlerResult::Err(TEXT("seq_create: CreatePackage failed"));
    Pkg->FullyLoad();

    ULevelSequence* Seq = NewObject<ULevelSequence>(Pkg, FName(*Name),
        RF_Public | RF_Standalone | RF_Transactional);
    if (!Seq) return FHaybaHandlerResult::Err(TEXT("seq_create: NewObject<ULevelSequence> failed"));
    Seq->Initialize();
    Seq->MarkPackageDirty();
    FAssetRegistryModule::AssetCreated(Seq);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("path"), Seq->GetPathName());
    Out->SetStringField(TEXT("name"), Name);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPSequencerHandler::SeqAddTrack(const TSharedPtr<FJsonObject>& P)
{
    FString SeqPath, TrackType, BoundObjPath;
    if (!P->TryGetStringField(TEXT("path"), SeqPath))
        return FHaybaHandlerResult::Err(TEXT("seq_add_track: missing path"));
    if (!P->TryGetStringField(TEXT("track_type"), TrackType))
        return FHaybaHandlerResult::Err(TEXT("seq_add_track: missing track_type"));
    P->TryGetStringField(TEXT("bound_object_path"), BoundObjPath);

    ULevelSequence* Seq = LoadLevelSequence(SeqPath);
    if (!Seq) return FHaybaHandlerResult::Err(TEXT("seq_add_track: sequence not found"));
    UMovieScene* MS = Seq->GetMovieScene();
    if (!MS) return FHaybaHandlerResult::Err(TEXT("seq_add_track: null MovieScene"));

    TSubclassOf<UMovieSceneTrack> TrackCls = nullptr;
    bool bMaster = false;
    if (TrackType == TEXT("transform"))         TrackCls = UMovieScene3DTransformTrack::StaticClass();
    else if (TrackType == TEXT("float"))        TrackCls = UMovieSceneFloatTrack::StaticClass();
    else if (TrackType == TEXT("audio"))      { TrackCls = UMovieSceneAudioTrack::StaticClass(); bMaster = true; }
    else if (TrackType == TEXT("camera_cuts")){ TrackCls = UMovieSceneCameraCutTrack::StaticClass(); bMaster = true; }
    else return FHaybaHandlerResult::Err(FString::Printf(TEXT("seq_add_track: unknown track_type %s"), *TrackType));

    UMovieSceneTrack* Track = nullptr;
    FGuid BindingGuid;
    if (bMaster)
    {
        Track = MS->AddTrack(TrackCls);
    }
    else
    {
        if (BoundObjPath.IsEmpty())
            return FHaybaHandlerResult::Err(TEXT("seq_add_track: bound_object_path required for transform/float track"));
        UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
        AActor* Actor = FindActorByPathOrName(World, BoundObjPath);
        if (!Actor) return FHaybaHandlerResult::Err(FString::Printf(TEXT("seq_add_track: bound object not found: %s"), *BoundObjPath));
        BindingGuid = FindOrCreateBinding(Seq, Actor);
        if (!BindingGuid.IsValid()) return FHaybaHandlerResult::Err(TEXT("seq_add_track: failed to bind object"));
        Track = MS->AddTrack(TrackCls, BindingGuid);
    }

    if (!Track) return FHaybaHandlerResult::Err(TEXT("seq_add_track: AddTrack failed"));
    Seq->MarkPackageDirty();

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("track_id"), Track->GetSignature().ToString());
    Out->SetStringField(TEXT("track_type"), TrackType);
    Out->SetStringField(TEXT("track_class"), Track->GetClass()->GetName());
    if (BindingGuid.IsValid()) Out->SetStringField(TEXT("binding_guid"), BindingGuid.ToString());
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPSequencerHandler::SeqAddKeyframe(const TSharedPtr<FJsonObject>& P)
{
    FString SeqPath, TrackId;
    double TimeSeconds = 0.0;
    double Value = 0.0;
    if (!P->TryGetStringField(TEXT("path"), SeqPath))
        return FHaybaHandlerResult::Err(TEXT("seq_add_keyframe: missing path"));
    if (!P->TryGetStringField(TEXT("track_id"), TrackId))
        return FHaybaHandlerResult::Err(TEXT("seq_add_keyframe: missing track_id"));
    if (!P->TryGetNumberField(TEXT("time_seconds"), TimeSeconds))
        return FHaybaHandlerResult::Err(TEXT("seq_add_keyframe: missing time_seconds"));
    P->TryGetNumberField(TEXT("value"), Value);

    ULevelSequence* Seq = LoadLevelSequence(SeqPath);
    if (!Seq) return FHaybaHandlerResult::Err(TEXT("seq_add_keyframe: sequence not found"));
    UMovieScene* MS = Seq->GetMovieScene();
    if (!MS) return FHaybaHandlerResult::Err(TEXT("seq_add_keyframe: null MovieScene"));

    UMovieSceneTrack* Track = FindTrackByGuid(MS, TrackId);
    if (!Track) return FHaybaHandlerResult::Err(TEXT("seq_add_keyframe: track not found"));

    UMovieSceneFloatTrack* FloatTrack = Cast<UMovieSceneFloatTrack>(Track);
    if (!FloatTrack)
        return FHaybaHandlerResult::Err(TEXT("seq_add_keyframe: only float tracks supported in v1"));

    const FFrameNumber Frame = SecondsToFrame(MS, TimeSeconds);

    UMovieSceneFloatSection* Section = nullptr;
    TArray<UMovieSceneSection*> Sections = FloatTrack->GetAllSections();
    if (Sections.Num() == 0)
    {
        UMovieSceneSection* NewSec = FloatTrack->CreateNewSection();
        if (!NewSec) return FHaybaHandlerResult::Err(TEXT("seq_add_keyframe: CreateNewSection failed"));
        NewSec->SetRange(TRange<FFrameNumber>::All());
        FloatTrack->AddSection(*NewSec);
        Section = Cast<UMovieSceneFloatSection>(NewSec);
    }
    else
    {
        Section = Cast<UMovieSceneFloatSection>(Sections[0]);
    }
    if (!Section) return FHaybaHandlerResult::Err(TEXT("seq_add_keyframe: no float section"));

    FMovieSceneFloatChannel& Channel = Section->GetChannel();
    AddKeyToChannel(&Channel, Frame, (float)Value, EMovieSceneKeyInterpolation::Auto);
    Section->MarkAsChanged();
    Seq->MarkPackageDirty();

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("track_id"), TrackId);
    Out->SetNumberField(TEXT("frame"), Frame.Value);
    Out->SetNumberField(TEXT("time_seconds"), TimeSeconds);
    Out->SetNumberField(TEXT("value"), Value);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPSequencerHandler::SeqAddCameraCut(const TSharedPtr<FJsonObject>& P)
{
    FString SeqPath, CamPath;
    double StartS = 0.0, EndS = 0.0;
    if (!P->TryGetStringField(TEXT("path"), SeqPath))
        return FHaybaHandlerResult::Err(TEXT("seq_add_camera_cut: missing path"));
    if (!P->TryGetStringField(TEXT("camera_actor_path"), CamPath))
        return FHaybaHandlerResult::Err(TEXT("seq_add_camera_cut: missing camera_actor_path"));
    if (!P->TryGetNumberField(TEXT("start_seconds"), StartS))
        return FHaybaHandlerResult::Err(TEXT("seq_add_camera_cut: missing start_seconds"));
    if (!P->TryGetNumberField(TEXT("end_seconds"), EndS))
        return FHaybaHandlerResult::Err(TEXT("seq_add_camera_cut: missing end_seconds"));

    ULevelSequence* Seq = LoadLevelSequence(SeqPath);
    if (!Seq) return FHaybaHandlerResult::Err(TEXT("seq_add_camera_cut: sequence not found"));
    UMovieScene* MS = Seq->GetMovieScene();
    if (!MS) return FHaybaHandlerResult::Err(TEXT("seq_add_camera_cut: null MovieScene"));

    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    AActor* Cam = FindActorByPathOrName(World, CamPath);
    if (!Cam) return FHaybaHandlerResult::Err(FString::Printf(TEXT("seq_add_camera_cut: camera actor not found: %s"), *CamPath));

    FGuid CamGuid = FindOrCreateBinding(Seq, Cam);
    if (!CamGuid.IsValid()) return FHaybaHandlerResult::Err(TEXT("seq_add_camera_cut: failed to bind camera"));

    UMovieSceneCameraCutTrack* CutTrack = MS->FindTrack<UMovieSceneCameraCutTrack>();
    if (!CutTrack) CutTrack = Cast<UMovieSceneCameraCutTrack>(MS->AddTrack(UMovieSceneCameraCutTrack::StaticClass()));
    if (!CutTrack) return FHaybaHandlerResult::Err(TEXT("seq_add_camera_cut: failed to create camera cut track"));

    const FFrameNumber StartF = SecondsToFrame(MS, StartS);
    const FFrameNumber EndF   = SecondsToFrame(MS, EndS);
    UMovieSceneCameraCutSection* Section = CutTrack->AddNewCameraCut(
        UE::MovieScene::FRelativeObjectBindingID(CamGuid), StartF);
    if (!Section) return FHaybaHandlerResult::Err(TEXT("seq_add_camera_cut: AddNewCameraCut failed"));
    Section->SetRange(TRange<FFrameNumber>(StartF, EndF));
    Seq->MarkPackageDirty();

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("camera_guid"), CamGuid.ToString());
    Out->SetStringField(TEXT("track_id"), CutTrack->GetSignature().ToString());
    Out->SetNumberField(TEXT("start_frame"), StartF.Value);
    Out->SetNumberField(TEXT("end_frame"), EndF.Value);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPSequencerHandler::SeqSetPlaybackRange(const TSharedPtr<FJsonObject>& P)
{
    FString SeqPath;
    double StartS = 0.0, EndS = 0.0;
    if (!P->TryGetStringField(TEXT("path"), SeqPath))
        return FHaybaHandlerResult::Err(TEXT("seq_set_playback_range: missing path"));
    if (!P->TryGetNumberField(TEXT("start_seconds"), StartS))
        return FHaybaHandlerResult::Err(TEXT("seq_set_playback_range: missing start_seconds"));
    if (!P->TryGetNumberField(TEXT("end_seconds"), EndS))
        return FHaybaHandlerResult::Err(TEXT("seq_set_playback_range: missing end_seconds"));

    ULevelSequence* Seq = LoadLevelSequence(SeqPath);
    if (!Seq) return FHaybaHandlerResult::Err(TEXT("seq_set_playback_range: sequence not found"));
    UMovieScene* MS = Seq->GetMovieScene();
    if (!MS) return FHaybaHandlerResult::Err(TEXT("seq_set_playback_range: null MovieScene"));

    const FFrameNumber StartF = SecondsToFrame(MS, StartS);
    const FFrameNumber EndF   = SecondsToFrame(MS, EndS);
    MS->SetPlaybackRange(TRange<FFrameNumber>(StartF, EndF), /*bAlwaysMarkDirty*/true);
    Seq->MarkPackageDirty();

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetNumberField(TEXT("start_frame"), StartF.Value);
    Out->SetNumberField(TEXT("end_frame"), EndF.Value);
    Out->SetNumberField(TEXT("start_seconds"), StartS);
    Out->SetNumberField(TEXT("end_seconds"), EndS);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPSequencerHandler::SeqPlay(const TSharedPtr<FJsonObject>& P)
{
    FString SeqPath;
    if (!P->TryGetStringField(TEXT("path"), SeqPath))
        return FHaybaHandlerResult::Err(TEXT("seq_play: missing path"));

    ULevelSequence* Seq = LoadLevelSequence(SeqPath);
    if (!Seq) return FHaybaHandlerResult::Err(TEXT("seq_play: sequence not found"));

    bool bOpened = false;
    if (GEditor)
    {
        if (UAssetEditorSubsystem* AES = GEditor->GetEditorSubsystem<UAssetEditorSubsystem>())
        {
            bOpened = AES->OpenEditorForAsset(Seq);
        }
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("path"), Seq->GetPathName());
    Out->SetBoolField(TEXT("editor_opened"), bOpened);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPSequencerHandler::SeqGetInfo(const TSharedPtr<FJsonObject>& P)
{
    FString SeqPath;
    if (!P->TryGetStringField(TEXT("path"), SeqPath))
        return FHaybaHandlerResult::Err(TEXT("seq_get_info: missing path"));

    ULevelSequence* Seq = LoadLevelSequence(SeqPath);
    if (!Seq) return FHaybaHandlerResult::Err(TEXT("seq_get_info: sequence not found"));
    UMovieScene* MS = Seq->GetMovieScene();
    if (!MS) return FHaybaHandlerResult::Err(TEXT("seq_get_info: null MovieScene"));

    const FFrameRate DisplayRate = MS->GetDisplayRate();
    const FFrameRate TickRes     = MS->GetTickResolution();
    const TRange<FFrameNumber> Range = MS->GetPlaybackRange();
    double DurationSeconds = 0.0;
    if (Range.HasLowerBound() && Range.HasUpperBound())
    {
        const FFrameNumber Lo = Range.GetLowerBoundValue();
        const FFrameNumber Hi = Range.GetUpperBoundValue();
        DurationSeconds = TickRes.AsSeconds(FFrameTime(Hi)) - TickRes.AsSeconds(FFrameTime(Lo));
    }

    TArray<TSharedPtr<FJsonValue>> TracksJson;
    auto AppendTrack = [&](UMovieSceneTrack* T)
    {
        if (!T) return;
        TSharedPtr<FJsonObject> O = MakeShared<FJsonObject>();
        O->SetStringField(TEXT("guid"), T->GetSignature().ToString());
        O->SetStringField(TEXT("name"), T->GetTrackName().ToString());
        O->SetStringField(TEXT("type"), T->GetClass()->GetName());
        TracksJson.Add(MakeShared<FJsonValueObject>(O.ToSharedRef()));
    };
    for (UMovieSceneTrack* T : MS->GetTracks()) AppendTrack(T);
    for (const FMovieSceneBinding& B : const_cast<const UMovieScene*>(MS)->GetBindings())
    {
        for (UMovieSceneTrack* T : B.GetTracks()) AppendTrack(T);
    }

    TArray<TSharedPtr<FJsonValue>> BindingsJson;
    for (int32 i = 0; i < MS->GetPossessableCount(); ++i)
    {
        const FMovieScenePossessable& Pos = MS->GetPossessable(i);
        TSharedPtr<FJsonObject> O = MakeShared<FJsonObject>();
        O->SetStringField(TEXT("guid"), Pos.GetGuid().ToString());
        O->SetStringField(TEXT("name"), Pos.GetName());
        // Resolving bound object path requires a SharedPlaybackState in 5.7
        // (older overloads deprecated). Expose name only; client can match by name.
        O->SetStringField(TEXT("object_path"), TEXT(""));
        BindingsJson.Add(MakeShared<FJsonValueObject>(O.ToSharedRef()));
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("path"), Seq->GetPathName());
    Out->SetNumberField(TEXT("duration_seconds"), DurationSeconds);
    Out->SetNumberField(TEXT("frame_rate"), DisplayRate.AsDecimal());
    Out->SetNumberField(TEXT("tick_resolution"), TickRes.AsDecimal());
    Out->SetArrayField(TEXT("tracks"), TracksJson);
    Out->SetArrayField(TEXT("bindings"), BindingsJson);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPSequencerHandler::SeqExport(const TSharedPtr<FJsonObject>& P)
{
    // Movie Render Queue integration is complex and brittle to wire from C++
    // without a configured preset asset. Degrade gracefully per spec.
    return FHaybaHandlerResult::Err(TEXT("seq_export: pending MovieRenderPipeline integration"));
}
