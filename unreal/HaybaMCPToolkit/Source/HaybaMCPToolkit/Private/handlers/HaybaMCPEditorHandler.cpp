#include "HaybaMCPEditorHandler.h"
#include "HaybaMCPCaptureActor.h"
#include "Editor.h"
#include "EngineUtils.h"
#include "Engine/Engine.h"
#include "LevelEditor.h"
#include "SLevelViewport.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "HAL/FileManager.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Internationalization/Regex.h"
// IHotReloadModule removed in UE 5.4+; LiveCoding replaces it

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

TArray<FString> FHaybaMCPEditorHandler::GetCommands() const
{
    return {
        TEXT("editor_start_pie"),
        TEXT("editor_stop_pie"),
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

    // Rotation. UE FRotator is (Pitch, Yaw, Roll) — NOT XYZ euler. Agents commonly
    // think "rotate N about Z" and pass [0,0,N] expecting yaw, but index 2 is ROLL,
    // which tilts the horizon → the "camera looks angled" bug. Two guards:
    //   1. Accept an unambiguous object form {pitch, yaw, roll} (recommended).
    //   2. Keep the editor viewport LEVEL by default: roll is only applied when
    //      explicitly given via the object's "roll" key. The array form is read as
    //      [pitch, yaw] and any 3rd (roll) element is ignored, so a stray value can
    //      never tilt the camera.
    FRotator Rotation = Client->GetViewRotation();
    bool bRotProvided = false;
    double NewPitch = Rotation.Pitch, NewYaw = Rotation.Yaw, NewRoll = 0.0;

    // HIGHEST PRIORITY: look_at [x,y,z]. The agent gives a world point to face and
    // we derive the orientation — no manual angles, no axis confusion, and
    // FVector::Rotation() yields roll=0 by construction (horizon always level).
    // This is the correct way to "aim" the camera; prefer it over rotation.
    const TArray<TSharedPtr<FJsonValue>>* LookAtArr = nullptr;
    if (P->TryGetArrayField(TEXT("look_at"), LookAtArr) && LookAtArr && LookAtArr->Num() >= 3)
    {
        const FVector Target(
            (*LookAtArr)[0]->AsNumber(),
            (*LookAtArr)[1]->AsNumber(),
            (*LookAtArr)[2]->AsNumber());
        const FVector Dir = (Target - Location);
        if (!Dir.IsNearlyZero())
        {
            Rotation = Dir.Rotation();          // pitch+yaw to face Target, roll = 0
            Client->SetViewRotation(Rotation);
            bRotProvided = true;
        }
    }

    const TSharedPtr<FJsonObject>* RotObj = nullptr;
    const TArray<TSharedPtr<FJsonValue>>* RotArr = nullptr;
    if (bRotProvided)
    {
        // look_at already set orientation — skip the manual rotation paths.
    }
    else if (P->TryGetObjectField(TEXT("rotation"), RotObj) && RotObj && RotObj->IsValid())
    {
        bRotProvided = true;
        (*RotObj)->TryGetNumberField(TEXT("pitch"), NewPitch);
        (*RotObj)->TryGetNumberField(TEXT("yaw"), NewYaw);
        (*RotObj)->TryGetNumberField(TEXT("roll"), NewRoll); // opt-in tilt only
        Rotation = FRotator(NewPitch, NewYaw, NewRoll);
        Client->SetViewRotation(Rotation);
    }
    else if (P->TryGetArrayField(TEXT("rotation"), RotArr) && RotArr && RotArr->Num() >= 2)
    {
        NewPitch = (*RotArr)[0]->AsNumber();
        NewYaw   = (*RotArr)[1]->AsNumber();
        // (*RotArr)[2] (roll) intentionally ignored — see guard #2 above.
        Rotation = FRotator(NewPitch, NewYaw, NewRoll);
        Client->SetViewRotation(Rotation);
    }

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

    FString LogDir = FPaths::ProjectLogDir();
    TArray<FString> LogFiles;
    IFileManager::Get().FindFiles(LogFiles, *(LogDir / TEXT("*.log")), true, false);

    if (LogFiles.Num() == 0)
        return FHaybaHandlerResult::Err(TEXT("No log files found"));

    // Find the most recent log file
    FString MostRecentFile;
    FDateTime MostRecentTime = FDateTime::MinValue();
    for (const FString& File : LogFiles)
    {
        FString FullPath = LogDir / File;
        FDateTime ModTime = IFileManager::Get().GetTimeStamp(*FullPath);
        if (ModTime > MostRecentTime)
        {
            MostRecentTime = ModTime;
            MostRecentFile = FullPath;
        }
    }

    TArray<FString> AllLines;
    if (!FFileHelper::LoadFileToStringArray(AllLines, *MostRecentFile))
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("editor_get_output_log: failed to read log file: %s"), *MostRecentFile));

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

    FString LogDir = FPaths::ProjectLogDir();
    TArray<FString> LogFiles;
    IFileManager::Get().FindFiles(LogFiles, *(LogDir / TEXT("*.log")), true, false);

    if (LogFiles.Num() == 0)
        return FHaybaHandlerResult::Err(TEXT("No log files found"));

    FString MostRecentFile;
    FDateTime MostRecentTime = FDateTime::MinValue();
    for (const FString& File : LogFiles)
    {
        FString FullPath = LogDir / File;
        FDateTime ModTime = IFileManager::Get().GetTimeStamp(*FullPath);
        if (ModTime > MostRecentTime)
        {
            MostRecentTime = ModTime;
            MostRecentFile = FullPath;
        }
    }

    // UE keeps the active log open for writing — LoadFileToStringArray()'s
    // default exclusive read fails. Use CreateFileReader with
    // FILEREAD_AllowWrite to read alongside the live writer.
    TArray<FString> AllLines;
    {
        TUniquePtr<FArchive> Reader(IFileManager::Get().CreateFileReader(*MostRecentFile, FILEREAD_AllowWrite));
        if (!Reader)
        {
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("editor_stream_log: failed to open log file: %s"), *MostRecentFile));
        }
        // Cap the read: a multi-GB log would (a) overflow TArray's int32 size in
        // SetNumUninitialized(Size+1) -> one-past-end write, and (b) block the
        // game thread for seconds. Read at most the last 16MB.
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
        Content.ParseIntoArrayLines(AllLines, /*InCullEmpty=*/false);
    }

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
    // Hot Reload was removed in UE 5.4+; Live Coding replaces it but its public C++ API is limited.
    TSharedPtr<FJsonObject> Result = MakeShareable(new FJsonObject());
    Result->SetBoolField(TEXT("compile_started"), false);
    Result->SetStringField(TEXT("reason"), TEXT("Use Live Coding (Ctrl+Alt+F11) — programmatic trigger not exposed in UE 5.4+"));
    return FHaybaHandlerResult::Ok(Result);
}

FHaybaHandlerResult FHaybaMCPEditorHandler::GetPerformanceStats(const TSharedPtr<FJsonObject>& P)
{
    extern ENGINE_API float GAverageFPS;
    extern ENGINE_API float GAverageMS;
    TSharedPtr<FJsonObject> Result = MakeShareable(new FJsonObject());
    Result->SetNumberField(TEXT("fps"), GAverageFPS);
    Result->SetNumberField(TEXT("frame_ms"), GAverageMS);
    Result->SetNumberField(TEXT("render_thread_ms"), GRenderThreadTime);
    Result->SetNumberField(TEXT("game_thread_ms"), GGameThreadTime);
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
