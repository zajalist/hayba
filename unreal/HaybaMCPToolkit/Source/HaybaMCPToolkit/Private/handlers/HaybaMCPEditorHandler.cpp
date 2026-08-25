#include "HaybaMCPEditorHandler.h"
#include "Interfaces/IPluginManager.h"
#include "HaybaMCPProtocol.h"
#include "HaybaEditorOps.h"
#include "HaybaMCPCaptureActor.h"
#include "Editor.h"
#include "EngineUtils.h"
#include "Engine/Engine.h"
#include "LevelEditor.h"
#include "SLevelViewport.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Misc/PackageName.h"
#include "Misc/CoreDelegates.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformMisc.h"
#include "FileHelpers.h"
#include "Containers/Ticker.h"
#include "UObject/UObjectIterator.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Internationalization/Regex.h"
// IHotReloadModule removed in UE 5.4+; LiveCoding replaces it

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPEditor, Log, All);

static TArray<FString> CollectSaveableDirtyPackageNames()
{
    TArray<FString> Names;
    for (TObjectIterator<UPackage> It; It; ++It)
    {
        UPackage* Package = *It;
        if (!Package || !Package->IsDirty()
            || Package->HasAnyPackageFlags(PKG_CompiledIn)
            || Package->HasAnyFlags(RF_Transient))
        {
            continue;
        }
        const FString PackageName = Package->GetName();
        if (!FPackageName::IsValidLongPackageName(PackageName)) continue;
        Names.AddUnique(PackageName);
    }
    Names.Sort();
    return Names;
}

// Safely resolve a viewport's client to an FEditorViewportClient. FViewportClient
// has no RTTI, so the old StaticCast<FEditorViewportClient*>(VP->GetClient())
// blindly reinterpreted whatever client the viewport had — for a PIE or a
// non-level editor viewport (material/BP preview) that is NOT an
// FEditorViewportClient, and the first virtual call crashed. Confirm identity
// against the engine's registered editor viewport clients before trusting it.
static FEditorViewportClient* AsEditorViewportClient(FViewport* VP)
{
    if (!VP || !GEditor) return nullptr;
    FViewportClient* Raw = VP->GetClient();
    if (!Raw) return nullptr;
    for (FEditorViewportClient* EVC : GEditor->GetAllViewportClients())
    {
        if (EVC == Raw) return EVC;  // pointer identity: Raw really is this editor client
    }
    return nullptr;
}

// Read the most-recent project .log file into a line array using a SHARED read.
// UE holds the active editor log open for writing, so FFileHelper's default
// exclusive read fails ("failed to read log file") even though the file exists
// and is being actively written. CreateFileReader(FILEREAD_AllowWrite) opens
// alongside the live writer. Reads at most the last 16MB (a multi-GB log would
// overflow the int32 in SetNumUninitialized(Size+1) and block the game thread).
// Returns false and fills OutError on failure. Shared by GetOutputLog + StreamLog.
static bool ReadMostRecentLogLines(TArray<FString>& OutLines, FString& OutFile, FString& OutError)
{
    OutLines.Reset();
    OutFile.Reset();

    const FString LogDir = FPaths::ProjectLogDir();
    TArray<FString> LogFiles;
    IFileManager::Get().FindFiles(LogFiles, *(LogDir / TEXT("*.log")), true, false);
    if (LogFiles.Num() == 0)
    {
        OutError = TEXT("No log files found");
        return false;
    }

    FDateTime MostRecentTime = FDateTime::MinValue();
    for (const FString& File : LogFiles)
    {
        const FString FullPath = LogDir / File;
        const FDateTime ModTime = IFileManager::Get().GetTimeStamp(*FullPath);
        if (ModTime > MostRecentTime)
        {
            MostRecentTime = ModTime;
            OutFile = FullPath;
        }
    }

    TUniquePtr<FArchive> Reader(IFileManager::Get().CreateFileReader(*OutFile, FILEREAD_AllowWrite));
    if (!Reader)
    {
        OutError = FString::Printf(TEXT("failed to open log file: %s"), *OutFile);
        return false;
    }

    const int64 FullSize = Reader->TotalSize();
    const int64 MaxBytes = 16 * 1024 * 1024;
    int64 Size = FullSize;
    if (FullSize > MaxBytes)
    {
        Reader->Seek(FullSize - MaxBytes);
        Size = MaxBytes;
    }
    TArray<uint8> Buf;
    Buf.SetNumUninitialized((int32)Size + 1);
    Reader->Serialize(Buf.GetData(), Size);
    Buf[(int32)Size] = 0;
    const FString Content(UTF8_TO_TCHAR(Buf.GetData()));
    Content.ParseIntoArrayLines(OutLines, /*InCullEmpty=*/false);
    return true;
}

TArray<FString> FHaybaMCPEditorHandler::GetCommands() const
{
    return {
        TEXT("editor_start_pie"),
        TEXT("editor_stop_pie"),
        TEXT("editor_save_all_and_quit"),
        TEXT("editor_get_state"),
        TEXT("editor_set_camera"),
        TEXT("editor_capture_viewport"),
        TEXT("editor_run_console_command"),
        TEXT("editor_get_output_log"),
        TEXT("editor_stream_log"),
        TEXT("editor_live_compile"),
        TEXT("editor_get_performance_stats"),
        TEXT("editor_set_viewport_mode"),
        TEXT("editor_focus_actor")
    };
}

FHaybaHandlerResult FHaybaMCPEditorHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params)
{
    if (Cmd == TEXT("editor_start_pie"))         return StartPIE(Params);
    if (Cmd == TEXT("editor_stop_pie"))          return StopPIE(Params);
    if (Cmd == TEXT("editor_save_all_and_quit")) return SaveAllAndQuit(Params);
    if (Cmd == TEXT("editor_get_state"))         return GetState(Params);
    if (Cmd == TEXT("editor_set_camera"))        return SetCamera(Params);
    if (Cmd == TEXT("editor_capture_viewport"))  return CaptureViewport(Params);
    if (Cmd == TEXT("editor_run_console_command")) return RunConsoleCommand(Params);
    if (Cmd == TEXT("editor_get_output_log"))    return GetOutputLog(Params);
    if (Cmd == TEXT("editor_stream_log"))        return StreamLog(Params);
    if (Cmd == TEXT("editor_live_compile"))      return LiveCompile(Params);
    if (Cmd == TEXT("editor_get_performance_stats")) return GetPerformanceStats(Params);
    if (Cmd == TEXT("editor_set_viewport_mode")) return SetViewportMode(Params);
    if (Cmd == TEXT("editor_focus_actor"))       return FocusActor(Params);
    return FHaybaHandlerResult::Err(FString::Printf(TEXT("Unknown editor command: %s"), *Cmd));
}

AHaybaMCPCaptureActor* FHaybaMCPEditorHandler::GetOrSpawnCaptureActor() const
{
    if (!GEditor) return nullptr;
    UWorld* World = GEditor->GetEditorWorldContext().World();
    if (!World) return nullptr;

    for (TActorIterator<AHaybaMCPCaptureActor> It(World); It; ++It)
    {
        return *It;
    }

    return World->SpawnActor<AHaybaMCPCaptureActor>();
}

FHaybaHandlerResult FHaybaMCPEditorHandler::StartPIE(const TSharedPtr<FJsonObject>& P)
{
    if (!GEditor)
        return FHaybaHandlerResult::Err(TEXT("GEditor is null"));

    FRequestPlaySessionParams PlayParams;
    GEditor->RequestPlaySession(PlayParams);

    TSharedPtr<FJsonObject> Result = MakeShareable(new FJsonObject());
    Result->SetBoolField(TEXT("pie_started"), true);
    return FHaybaHandlerResult::Ok(Result);
}

FHaybaHandlerResult FHaybaMCPEditorHandler::StopPIE(const TSharedPtr<FJsonObject>& P)
{
    if (!GEditor)
        return FHaybaHandlerResult::Err(TEXT("GEditor is null"));

    GEditor->RequestEndPlayMap();

    TSharedPtr<FJsonObject> Result = MakeShareable(new FJsonObject());
    Result->SetBoolField(TEXT("pie_stopped"), true);
    return FHaybaHandlerResult::Ok(Result);
}

FHaybaHandlerResult FHaybaMCPEditorHandler::GetState(const TSharedPtr<FJsonObject>& P)
{
    if (!GEditor)
        return FHaybaHandlerResult::Err(TEXT("editor_get_state: GEditor is not available"));

    UWorld* World = GEditor->GetEditorWorldContext().World();
    const TArray<FString> DirtyPackages = CollectSaveableDirtyPackageNames();

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("ok"), true);

    // The install is two artifacts that update independently -- this plugin and
    // the npm server -- so they drift, and drift presents as individual
    // commands being unknown rather than as a version gap. Reporting the
    // version here is what lets a client (and `hayba-cli doctor`) say "these
    // two are different" instead of the caller debugging one command at a time.
    if (TSharedPtr<IPlugin> Self = IPluginManager::Get().FindPlugin(TEXT("HaybaMCPToolkit")))
    {
        Out->SetStringField(TEXT("plugin_version"), Self->GetDescriptor().VersionName);
    }

    // The number that actually decides whether these two can talk. plugin_version
    // above is a product version and is NOT comparable with the server's --
    // they have never shared a scheme. See HaybaMCPProtocol.h for when to bump.
    Out->SetNumberField(TEXT("protocol_version"), HAYBA_PROTOCOL_VERSION);

    Out->SetStringField(TEXT("map"), World ? World->GetPathName() : FString());
    Out->SetBoolField(TEXT("pie_running"), GEditor->IsPlaySessionInProgress());
    Out->SetNumberField(TEXT("selection_count"), GEditor->GetSelectedActorCount());
    TArray<TSharedPtr<FJsonValue>> DirtyValues;
    DirtyValues.Reserve(DirtyPackages.Num());
    for (const FString& PackageName : DirtyPackages)
        DirtyValues.Add(MakeShared<FJsonValueString>(PackageName));
    Out->SetArrayField(TEXT("dirty_packages"), MoveTemp(DirtyValues));
    Out->SetNumberField(TEXT("dirty_count"), DirtyPackages.Num());
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPEditorHandler::SaveAllAndQuit(const TSharedPtr<FJsonObject>& P)
{
    if (!GEditor)
        return FHaybaHandlerResult::Err(TEXT("editor_save_all_and_quit: GEditor is null"));
    if (GEditor->IsPlaySessionInProgress())
        return FHaybaHandlerResult::Err(
            TEXT("editor_save_all_and_quit: PIE is running; call editor_stop_pie and wait for it to stop first"));

    bool bQuit = true;
    if (P.IsValid()) P->TryGetBoolField(TEXT("quit"), bQuit);

    const TArray<FString> DirtyBefore = CollectSaveableDirtyPackageNames();
    const bool bSaved = UEditorLoadingAndSavingUtils::SaveDirtyPackages(
        /*bSaveMapPackages=*/true,
        /*bSaveContentPackages=*/true);
    const TArray<FString> DirtyAfter = CollectSaveableDirtyPackageNames();

    if (!bSaved || !DirtyAfter.IsEmpty())
    {
        const FString Remaining = DirtyAfter.IsEmpty()
            ? TEXT("none reported (save API returned failure)")
            : FString::Join(DirtyAfter, TEXT(", "));
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("editor_save_all_and_quit: save verification failed; editor remains open; dirty packages: %s"),
            *Remaining));
    }

    if (bQuit)
    {
        // Return the response before asking the process to exit. Revalidate in
        // the callback because TcpServer may still drain a queued mutation in
        // this tick, or a background completion may dirty a package during the
        // response-flush delay. In either case refuse exit rather than risking
        // an unanswerable modal or data loss.
        FTSTicker::GetCoreTicker().AddTicker(
            FTickerDelegate::CreateLambda([](float)
            {
                const TArray<FString> DirtyAtExit = CollectSaveableDirtyPackageNames();
                if (!DirtyAtExit.IsEmpty())
                {
                    UE_LOG(LogHaybaMCPEditor, Error,
                        TEXT("editor_save_all_and_quit: exit cancelled because packages became dirty after verification: %s"),
                        *FString::Join(DirtyAtExit, TEXT(", ")));
                    return false;
                }
                FPlatformMisc::RequestExit(false);
                return false;
            }),
            0.25f);
    }

    auto Result = MakeShared<FJsonObject>();
    Result->SetNumberField(TEXT("dirty_package_count_before"), DirtyBefore.Num());
    Result->SetNumberField(TEXT("dirty_package_count_after"), DirtyAfter.Num());
    Result->SetNumberField(TEXT("save_candidate_count"), DirtyBefore.Num());
    Result->SetBoolField(TEXT("save_verified"), true);
    Result->SetBoolField(TEXT("quit_scheduled"), bQuit);
    return FHaybaHandlerResult::Ok(Result);
}

FHaybaHandlerResult FHaybaMCPEditorHandler::SetCamera(const TSharedPtr<FJsonObject>& P)
{
    if (!GEditor)
        return FHaybaHandlerResult::Err(TEXT("GEditor is null"));

    const TArray<TSharedPtr<FJsonValue>>* LocArr = nullptr;
    if (!P->TryGetArrayField(TEXT("location"), LocArr) || !LocArr || LocArr->Num() < 3)
        return FHaybaHandlerResult::Err(TEXT("location [x,y,z] is required"));

    FVector Location(
        (*LocArr)[0]->AsNumber(),
        (*LocArr)[1]->AsNumber(),
        (*LocArr)[2]->AsNumber()
    );

    FViewport* VP = GEditor->GetActiveViewport();
    if (!VP)
        return FHaybaHandlerResult::Err(TEXT("No active viewport"));

    FEditorViewportClient* Client = AsEditorViewportClient(VP);
    if (!Client)
        return FHaybaHandlerResult::Err(TEXT("No editor viewport client"));

    Client->SetViewLocation(Location);

    // Rotation is decided in HaybaEditorOps::ResolveCameraRotation — three input
    // forms, a precedence order, and the roll rule that keeps the horizon level.
    // All of it is pure, so it lives where a test can reach it.
    const HaybaEditorOps::FCameraOrientation Orient =
        HaybaEditorOps::ResolveCameraRotation(P, Location, Client->GetViewRotation());
    if (Orient.bChanged())
    {
        Client->SetViewRotation(Orient.Rotation);
    }
    const FRotator Rotation = Orient.Rotation;

    TSharedPtr<FJsonObject> Result = MakeShareable(new FJsonObject());

    TArray<TSharedPtr<FJsonValue>> LocOut;
    LocOut.Add(MakeShareable(new FJsonValueNumber(Location.X)));
    LocOut.Add(MakeShareable(new FJsonValueNumber(Location.Y)));
    LocOut.Add(MakeShareable(new FJsonValueNumber(Location.Z)));
    Result->SetArrayField(TEXT("location"), LocOut);

    TArray<TSharedPtr<FJsonValue>> RotOut;
    RotOut.Add(MakeShareable(new FJsonValueNumber(Rotation.Pitch)));
    RotOut.Add(MakeShareable(new FJsonValueNumber(Rotation.Yaw)));
    RotOut.Add(MakeShareable(new FJsonValueNumber(Rotation.Roll)));
    Result->SetArrayField(TEXT("rotation"), RotOut);
    Result->SetStringField(TEXT("rotation_from"), HaybaEditorOps::RotationSourceName(Orient.Source));

    return FHaybaHandlerResult::Ok(Result);
}

FHaybaHandlerResult FHaybaMCPEditorHandler::FocusActor(const TSharedPtr<FJsonObject>& P)
{
    if (!GEditor) return FHaybaHandlerResult::Err(TEXT("GEditor is null"));

    FString Label;
    if (!P->TryGetStringField(TEXT("actor_label"), Label) || Label.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("editor_focus_actor: actor_label is required"));

    UWorld* World = GEditor->GetEditorWorldContext().World();
    if (!World) return FHaybaHandlerResult::Err(TEXT("editor_focus_actor: no editor world"));

    AActor* Target = nullptr;
    for (TActorIterator<AActor> It(World); It; ++It)
        if (*It && (*It)->GetActorLabel() == Label) { Target = *It; break; }
    if (!Target) return FHaybaHandlerResult::Err(FString::Printf(TEXT("editor_focus_actor: actor not found by label: %s"), *Label));

    // Frame the actor's world bounds. Camera sits back along a default 3/4 view
    // direction at a distance derived from the bounds radius, looking AT the
    // centre. Orientation comes from FVector::Rotation() so roll is always 0 —
    // the viewport never tilts.
    FVector Origin, Extent;
    Target->GetActorBounds(/*bOnlyCollidingComponents=*/false, Origin, Extent);
    const double Radius = FMath::Max(Extent.Size(), 50.0);

    double DistScale = 2.5;
    { double D; if (P->TryGetNumberField(TEXT("distance_scale"), D) && D > 0.0) DistScale = D; }

    // Default look direction: front-right-above (a readable perspective), unless
    // the caller supplies an explicit unit-ish [x,y,z] view direction.
    FVector ViewDir(-1.0, -1.0, -0.6);
    const TArray<TSharedPtr<FJsonValue>>* DirArr = nullptr;
    if (P->TryGetArrayField(TEXT("direction"), DirArr) && DirArr && DirArr->Num() >= 3)
        ViewDir = FVector((*DirArr)[0]->AsNumber(), (*DirArr)[1]->AsNumber(), (*DirArr)[2]->AsNumber());
    if (ViewDir.IsNearlyZero()) ViewDir = FVector(-1.0, -1.0, -0.6);
    ViewDir.Normalize();

    const FVector Location = Origin - ViewDir * (Radius * DistScale);
    const FRotator Rotation = (Origin - Location).Rotation(); // look at centre, roll = 0

    FViewport* VP = GEditor->GetActiveViewport();
    if (!VP) return FHaybaHandlerResult::Err(TEXT("editor_focus_actor: no active viewport"));
    FEditorViewportClient* Client = AsEditorViewportClient(VP);
    if (!Client) return FHaybaHandlerResult::Err(TEXT("editor_focus_actor: no editor viewport client"));

    Client->SetViewLocation(Location);
    Client->SetViewRotation(Rotation);
    Client->Invalidate();

    TSharedPtr<FJsonObject> Result = MakeShareable(new FJsonObject());
    Result->SetStringField(TEXT("actor_label"), Label);
    TArray<TSharedPtr<FJsonValue>> LocOut = {
        MakeShareable(new FJsonValueNumber(Location.X)),
        MakeShareable(new FJsonValueNumber(Location.Y)),
        MakeShareable(new FJsonValueNumber(Location.Z)) };
    Result->SetArrayField(TEXT("location"), LocOut);
    TArray<TSharedPtr<FJsonValue>> RotOut = {
        MakeShareable(new FJsonValueNumber(Rotation.Pitch)),
        MakeShareable(new FJsonValueNumber(Rotation.Yaw)),
        MakeShareable(new FJsonValueNumber(Rotation.Roll)) };
    Result->SetArrayField(TEXT("rotation"), RotOut);
    return FHaybaHandlerResult::Ok(Result);
}

FHaybaHandlerResult FHaybaMCPEditorHandler::CaptureViewport(const TSharedPtr<FJsonObject>& P)
{
    int32 Width = 1280;
    int32 Height = 720;
    if (P.IsValid())
    {
        int32 TmpW = 0, TmpH = 0;
        if (P->TryGetNumberField(TEXT("width"), TmpW) && TmpW > 0) Width = TmpW;
        if (P->TryGetNumberField(TEXT("height"), TmpH) && TmpH > 0) Height = TmpH;
    }

    AHaybaMCPCaptureActor* CaptureActor = GetOrSpawnCaptureActor();
    if (!CaptureActor)
        return FHaybaHandlerResult::Err(TEXT("Could not get or spawn capture actor"));

    FViewport* VP = GEditor ? GEditor->GetActiveViewport() : nullptr;
    FVector CamLoc = FVector::ZeroVector;
    FRotator CamRot = FRotator::ZeroRotator;

    if (VP)
    {
        FEditorViewportClient* Client = AsEditorViewportClient(VP);
        if (Client)
        {
            CamLoc = Client->GetViewLocation();
            CamRot = Client->GetViewRotation();
            CaptureActor->SetActorLocation(CamLoc);
            CaptureActor->SetActorRotation(CamRot);
        }
    }

    FString Base64 = CaptureActor->CaptureToBase64(Width, Height);
    if (Base64.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("CaptureToBase64 returned empty string"));

    TSharedPtr<FJsonObject> Result = MakeShareable(new FJsonObject());
    Result->SetStringField(TEXT("image_base64"), Base64);
    Result->SetNumberField(TEXT("width"), Width);
    Result->SetNumberField(TEXT("height"), Height);

    TSharedPtr<FJsonObject> CamObj = MakeShareable(new FJsonObject());
    TArray<TSharedPtr<FJsonValue>> LocArr, RotArr;
    LocArr.Add(MakeShareable(new FJsonValueNumber(CamLoc.X)));
    LocArr.Add(MakeShareable(new FJsonValueNumber(CamLoc.Y)));
    LocArr.Add(MakeShareable(new FJsonValueNumber(CamLoc.Z)));
    RotArr.Add(MakeShareable(new FJsonValueNumber(CamRot.Pitch)));
    RotArr.Add(MakeShareable(new FJsonValueNumber(CamRot.Yaw)));
    RotArr.Add(MakeShareable(new FJsonValueNumber(CamRot.Roll)));
    CamObj->SetArrayField(TEXT("location"), LocArr);
    CamObj->SetArrayField(TEXT("rotation"), RotArr);
    Result->SetObjectField(TEXT("camera"), CamObj);

    return FHaybaHandlerResult::Ok(Result);
}

FHaybaHandlerResult FHaybaMCPEditorHandler::RunConsoleCommand(const TSharedPtr<FJsonObject>& P)
{
    FString Command;
    if (!P.IsValid() || !P->TryGetStringField(TEXT("command"), Command) || Command.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("command parameter is required"));

    if (!GEngine)
        return FHaybaHandlerResult::Err(TEXT("editor_run_console_command: GEngine not available"));

    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    GEngine->Exec(World, *Command, *GLog);

    TSharedPtr<FJsonObject> Result = MakeShareable(new FJsonObject());
    Result->SetStringField(TEXT("command"), Command);
    Result->SetBoolField(TEXT("executed"), true);
    return FHaybaHandlerResult::Ok(Result);
}

FHaybaHandlerResult FHaybaMCPEditorHandler::GetOutputLog(const TSharedPtr<FJsonObject>& P)
{
    int32 Lines = 50;
    if (P.IsValid())
    {
        int32 TmpLines = 0;
        if (P->TryGetNumberField(TEXT("lines"), TmpLines) && TmpLines > 0)
            Lines = FMath::Min(TmpLines, 200);
    }

    // Shared-read the live log (see ReadMostRecentLogLines) — the legacy
    // exclusive read via FFileHelper::LoadFileToStringArray failed while the
    // editor held the file open, even though it exists and is being written.
    TArray<FString> AllLines;
    FString MostRecentFile;
    FString ReadError;
    if (!ReadMostRecentLogLines(AllLines, MostRecentFile, ReadError))
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("editor_get_output_log: %s"), *ReadError));

    int32 StartIdx = FMath::Max(0, AllLines.Num() - Lines);
    TArray<TSharedPtr<FJsonValue>> LogLineValues;
    for (int32 i = StartIdx; i < AllLines.Num(); ++i)
    {
        LogLineValues.Add(MakeShareable(new FJsonValueString(AllLines[i])));
    }

    TSharedPtr<FJsonObject> Result = MakeShareable(new FJsonObject());
    Result->SetArrayField(TEXT("log_lines"), LogLineValues);
    Result->SetNumberField(TEXT("count"), LogLineValues.Num());
    Result->SetStringField(TEXT("log_file"), MostRecentFile);
    return FHaybaHandlerResult::Ok(Result);
}

FHaybaHandlerResult FHaybaMCPEditorHandler::StreamLog(const TSharedPtr<FJsonObject>& P)
{
    // Initiative #9: optional regex_filter (full Perl-ish regex via FRegex)
    // and severity_filter (Verbose / Log / Warning / Error / Fatal). Output
    // shape gains structured {severity, category, msg} fields per line.
    FString Filter, RegexFilter, SeverityFilter, FormatStr;
    int32 SinceLine = 0;
    if (P.IsValid())
    {
        P->TryGetStringField(TEXT("filter"), Filter);
        P->TryGetStringField(TEXT("regex_filter"), RegexFilter);
        P->TryGetStringField(TEXT("severity_filter"), SeverityFilter);
        P->TryGetStringField(TEXT("format"), FormatStr);  // "structured" → JSON objects per line
        P->TryGetNumberField(TEXT("since_line"), SinceLine);
    }
    const bool bStructured = FormatStr.Equals(TEXT("structured"), ESearchCase::IgnoreCase);

    // Parse "Error,Warning" → set of severity strings.
    TSet<FString> SeverityWanted;
    if (!SeverityFilter.IsEmpty())
    {
        TArray<FString> Parts;
        SeverityFilter.ParseIntoArray(Parts, TEXT(","), true);
        for (FString& S : Parts) { S.TrimStartAndEndInline(); if (!S.IsEmpty()) SeverityWanted.Add(S); }
    }

    // Shared-read the live log (16MB tail, FILEREAD_AllowWrite) — see
    // ReadMostRecentLogLines. GetOutputLog uses the same helper.
    TArray<FString> AllLines;
    FString MostRecentFile;
    FString ReadError;
    if (!ReadMostRecentLogLines(AllLines, MostRecentFile, ReadError))
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("editor_stream_log: %s"), *ReadError));

    int32 ClampedStart = FMath::Clamp(SinceLine, 0, AllLines.Num());
    TArray<TSharedPtr<FJsonValue>> OutLines;

    // UE log format (when LogTimes=Local): [yyyy.mm.dd-hh.mm.ss:msec][N]Category: Severity: msg
    // Pull severity + category out so we can filter cheaply.
    auto ParseLine = [](const FString& Line, FString& OutCategory, FString& OutSeverity, FString& OutMsg)
    {
        OutCategory.Reset(); OutSeverity.Reset(); OutMsg = Line;
        // Strip the [timestamp][frame] prefix if present.
        int32 LastBracket = INDEX_NONE;
        if (Line.FindLastChar(']', LastBracket) && LastBracket + 1 < Line.Len())
        {
            FString Rest = Line.Mid(LastBracket + 1).TrimStart();
            // Rest now looks like "Category: Severity: msg" OR "Category: msg".
            int32 ColonIdx;
            if (Rest.FindChar(':', ColonIdx))
            {
                OutCategory = Rest.Left(ColonIdx);
                FString After = Rest.Mid(ColonIdx + 1).TrimStart();
                // Severity is one of Verbose / Display / Log / Warning / Error / Fatal.
                static const TCHAR* kSev[] = { TEXT("Verbose"), TEXT("Display"), TEXT("Log"),
                                               TEXT("Warning"), TEXT("Error"), TEXT("Fatal") };
                for (const TCHAR* S : kSev)
                {
                    const FString Prefix = FString(S) + TEXT(":");
                    if (After.StartsWith(Prefix))
                    {
                        OutSeverity = S;
                        OutMsg = After.Mid(Prefix.Len()).TrimStart();
                        return;
                    }
                }
                OutSeverity = TEXT("Log");
                OutMsg = After;
            }
        }
    };

    FRegexPattern Pattern(RegexFilter);
    const bool bUseRegex = !RegexFilter.IsEmpty();

    for (int32 i = ClampedStart; i < AllLines.Num(); ++i)
    {
        const FString& Line = AllLines[i];

        // Apply substring filter (legacy).
        if (!Filter.IsEmpty() && !Line.Contains(Filter)) continue;

        // Apply regex filter.
        if (bUseRegex)
        {
            FRegexMatcher M(Pattern, Line);
            if (!M.FindNext()) continue;
        }

        FString Category, Severity, Msg;
        ParseLine(Line, Category, Severity, Msg);

        // Apply severity filter.
        if (SeverityWanted.Num() > 0 && !SeverityWanted.Contains(Severity)) continue;

        if (bStructured)
        {
            TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
            Entry->SetNumberField(TEXT("line"),     i);
            Entry->SetStringField(TEXT("category"), Category);
            Entry->SetStringField(TEXT("severity"), Severity);
            Entry->SetStringField(TEXT("msg"),      Msg);
            Entry->SetStringField(TEXT("raw"),      Line);
            OutLines.Add(MakeShared<FJsonValueObject>(Entry));
        }
        else
        {
            OutLines.Add(MakeShared<FJsonValueString>(Line));
        }
    }

    TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
    Result->SetArrayField(TEXT("lines"), OutLines);
    Result->SetNumberField(TEXT("next_line"), AllLines.Num());
    Result->SetStringField(TEXT("format"), bStructured ? TEXT("structured") : TEXT("raw"));
    return FHaybaHandlerResult::Ok(Result);
}

FHaybaHandlerResult FHaybaMCPEditorHandler::LiveCompile(const TSharedPtr<FJsonObject>& P)
{
    // This returned Ok with compile_started:false and "programmatic trigger not
    // exposed in UE 5.4+". That reason was wrong: the LiveCoding.Compile console
    // command triggers it, and it is the route WORKFLOW-improving-the-mcp.md has
    // told agents to use through editor_run_console_command all along. The
    // command that exists for this job was the only thing refusing to do it.
    if (!GEngine)
        return FHaybaHandlerResult::Err(TEXT("editor_live_compile: GEngine not available"));

    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    GEngine->Exec(World, TEXT("LiveCoding.Compile"), *GLog);

    TSharedPtr<FJsonObject> Result = MakeShareable(new FJsonObject());
    // "Requested", not "succeeded". The compile runs asynchronously in
    // LiveCodingConsole and its outcome never comes back through this call, so
    // claiming a result here would be precisely the lie this codebase keeps
    // finding in its own replies.
    Result->SetBoolField(TEXT("compile_requested"), true);
    Result->SetStringField(TEXT("result_source"),
        TEXT("asynchronous — poll the editor log for 'Live coding succeeded' or 'LogLiveCoding: Error', "
             "matching on a COUNT of those lines rather than presence, since earlier runs are still in the file. "
             "Compile ERRORS are not in the editor log at all; they are in UnrealBuildTool\\Log.txt."));
    Result->SetStringField(TEXT("log_dir"), FPaths::ConvertRelativePathToFull(FPaths::ProjectLogDir()));
    return FHaybaHandlerResult::Ok(Result);
}

FHaybaHandlerResult FHaybaMCPEditorHandler::GetPerformanceStats(const TSharedPtr<FJsonObject>& P)
{
    extern ENGINE_API float GAverageFPS;
    extern ENGINE_API float GAverageMS;
    TSharedPtr<FJsonObject> Result = MakeShareable(new FJsonObject());
    Result->SetNumberField(TEXT("fps"), GAverageFPS);
    Result->SetNumberField(TEXT("frame_ms"), GAverageMS);
    // GRenderThreadTime and GGameThreadTime are CYCLE COUNTS, not milliseconds.
    // Reported raw under a name ending in _ms they read as a catastrophically
    // slow editor — a live capture showed game_thread_ms: 281961 next to
    // frame_ms: 333, two numbers that cannot both be true. The unit was the lie,
    // not the measurement.
    Result->SetNumberField(TEXT("render_thread_ms"), FPlatformTime::ToMilliseconds(GRenderThreadTime));
    Result->SetNumberField(TEXT("game_thread_ms"), FPlatformTime::ToMilliseconds(GGameThreadTime));
    return FHaybaHandlerResult::Ok(Result);
}

FHaybaHandlerResult FHaybaMCPEditorHandler::SetViewportMode(const TSharedPtr<FJsonObject>& P)
{
    FString Mode;
    if (!P.IsValid() || !P->TryGetStringField(TEXT("mode"), Mode) || Mode.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("mode parameter is required (lit|unlit|wireframe|detail_lighting)"));

    EViewModeIndex ModeIndex = VMI_Lit;
    if (Mode == TEXT("unlit"))            ModeIndex = VMI_Unlit;
    else if (Mode == TEXT("wireframe"))   ModeIndex = VMI_Wireframe;
    else if (Mode == TEXT("detail_lighting")) ModeIndex = VMI_Lit_DetailLighting;
    else if (Mode != TEXT("lit"))
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("Unknown mode: %s. Use lit|unlit|wireframe|detail_lighting"), *Mode));

    if (!GEditor)
        return FHaybaHandlerResult::Err(TEXT("GEditor is null"));

    FViewport* VP = GEditor->GetActiveViewport();
    if (!VP)
        return FHaybaHandlerResult::Err(TEXT("No active viewport"));

    FEditorViewportClient* Client = AsEditorViewportClient(VP);
    if (!Client)
        return FHaybaHandlerResult::Err(TEXT("No editor viewport client"));

    Client->SetViewMode(ModeIndex);

    TSharedPtr<FJsonObject> Result = MakeShareable(new FJsonObject());
    Result->SetStringField(TEXT("mode"), Mode);
    return FHaybaHandlerResult::Ok(Result);
}
