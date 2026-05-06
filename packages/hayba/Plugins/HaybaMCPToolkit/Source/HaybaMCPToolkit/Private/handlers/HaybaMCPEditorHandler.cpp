#include "HaybaMCPEditorHandler.h"
#include "HaybaMCPCaptureActor.h"
#include "Editor.h"
#include "EngineUtils.h"
#include "Engine/Engine.h"
#include "LevelEditorViewportClient.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "HAL/FileManager.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "IHotReloadModule.h"

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
        TEXT("editor_set_viewport_mode")
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

    FEditorViewportClient* Client = StaticCast<FEditorViewportClient*>(VP->GetClient());
    if (!Client)
        return FHaybaHandlerResult::Err(TEXT("No editor viewport client"));

    Client->SetViewLocation(Location);

    FRotator Rotation = Client->GetViewRotation();
    const TArray<TSharedPtr<FJsonValue>>* RotArr = nullptr;
    if (P->TryGetArrayField(TEXT("rotation"), RotArr) && RotArr && RotArr->Num() >= 3)
    {
        Rotation = FRotator(
            (*RotArr)[0]->AsNumber(),
            (*RotArr)[1]->AsNumber(),
            (*RotArr)[2]->AsNumber()
        );
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
        FEditorViewportClient* Client = StaticCast<FEditorViewportClient*>(VP->GetClient());
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
    FFileHelper::LoadFileToStringArray(AllLines, *MostRecentFile);

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
    FString Filter;
    int32 SinceLine = 0;
    if (P.IsValid())
    {
        P->TryGetStringField(TEXT("filter"), Filter);
        P->TryGetNumberField(TEXT("since_line"), SinceLine);
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

    TArray<FString> AllLines;
    FFileHelper::LoadFileToStringArray(AllLines, *MostRecentFile);

    int32 ClampedStart = FMath::Clamp(SinceLine, 0, AllLines.Num());
    TArray<TSharedPtr<FJsonValue>> OutLines;
    for (int32 i = ClampedStart; i < AllLines.Num(); ++i)
    {
        const FString& Line = AllLines[i];
        if (Filter.IsEmpty() || Line.Contains(Filter))
        {
            OutLines.Add(MakeShareable(new FJsonValueString(Line)));
        }
    }

    TSharedPtr<FJsonObject> Result = MakeShareable(new FJsonObject());
    Result->SetArrayField(TEXT("lines"), OutLines);
    Result->SetNumberField(TEXT("next_line"), AllLines.Num());
    return FHaybaHandlerResult::Ok(Result);
}

FHaybaHandlerResult FHaybaMCPEditorHandler::LiveCompile(const TSharedPtr<FJsonObject>& P)
{
#if WITH_LIVE_CODING
    IHotReloadModule::Get().DoHotReloadFromEditor(EHotReloadFlags::None);
    TSharedPtr<FJsonObject> Result = MakeShareable(new FJsonObject());
    Result->SetBoolField(TEXT("compile_started"), true);
    return FHaybaHandlerResult::Ok(Result);
#else
    TSharedPtr<FJsonObject> Result = MakeShareable(new FJsonObject());
    Result->SetBoolField(TEXT("compile_started"), false);
    Result->SetStringField(TEXT("reason"), TEXT("LiveCoding not available"));
    return FHaybaHandlerResult::Ok(Result);
#endif
}

FHaybaHandlerResult FHaybaMCPEditorHandler::GetPerformanceStats(const TSharedPtr<FJsonObject>& P)
{
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
    else if (Mode == TEXT("wireframe"))   ModeIndex = VMI_BrushWireframe;
    else if (Mode == TEXT("detail_lighting")) ModeIndex = VMI_Lit_DetailLighting;
    else if (Mode != TEXT("lit"))
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("Unknown mode: %s. Use lit|unlit|wireframe|detail_lighting"), *Mode));

    if (!GEditor)
        return FHaybaHandlerResult::Err(TEXT("GEditor is null"));

    FViewport* VP = GEditor->GetActiveViewport();
    if (!VP)
        return FHaybaHandlerResult::Err(TEXT("No active viewport"));

    FEditorViewportClient* Client = StaticCast<FEditorViewportClient*>(VP->GetClient());
    if (!Client)
        return FHaybaHandlerResult::Err(TEXT("No editor viewport client"));

    Client->SetViewMode(ModeIndex);

    TSharedPtr<FJsonObject> Result = MakeShareable(new FJsonObject());
    Result->SetStringField(TEXT("mode"), Mode);
    return FHaybaHandlerResult::Ok(Result);
}
