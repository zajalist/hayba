#include "HaybaMCPUIBridgeHandler.h"
#include "HAL/FileManager.h"
#include "Misc/FileHelper.h"
#include "ImageUtils.h"
#include "Framework/Application/SlateApplication.h"
#include "HaybaMCPParams.h"
#include "HaybaMCPMainPanel.h"
#include "HaybaMCPSecretRedaction.h"

#include "HaybaMCPModule.h"
#include "HaybaMCPMemoryPanel.h"
#include "HaybaMCPToolStreamPanel.h"
#include "Async/Async.h"
#include "Json.h"
#include "Modules/ModuleManager.h"

TArray<FString> FHaybaMCPUIBridgeHandler::GetCommands() const
{
    return {
        TEXT("ui_memory_set"),
        TEXT("ui_capture_panel"),
        TEXT("ui_tool_stream"),
        TEXT("ui_tool_stream_new_turn"),
    };
}

FHaybaHandlerResult FHaybaMCPUIBridgeHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params)
{
    if (!Params.IsValid()) return FHaybaHandlerResult::Err(TEXT("UIBridgeHandler: missing params"));

    if (Cmd == TEXT("ui_memory_set"))           return HandleMemorySet(Params);
    if (Cmd == TEXT("ui_capture_panel"))        return HandleCapturePanel(Params);
    if (Cmd == TEXT("ui_tool_stream"))          return HandleToolStream(Params);
    if (Cmd == TEXT("ui_tool_stream_new_turn")) return HandleToolStreamNewTurn(Params);

    return FHaybaHandlerResult::Err(FString::Printf(TEXT("UIBridgeHandler: unhandled command %s"), *Cmd));
}

/** Every command here acks rather than returning a result: they are mirrors,
 *  and the caller wants to know the panel heard, not what it drew. */
static FHaybaHandlerResult Received()
{
    auto Data = MakeShared<FJsonObject>();
    Data->SetBoolField(TEXT("received"), true);
    return FHaybaHandlerResult::Ok(Data);
}

FHaybaHandlerResult FHaybaMCPUIBridgeHandler::HandleMemorySet(const TSharedPtr<FJsonObject>& /*P*/)
{
    // The Semantic Library reads the PLUMB stores itself, so this is a request
    // to re-read from disk, not a payload to display -- which is why the
    // parameters are unused, and why moving this out of the router turned out
    // to be trivial rather than the "separate change" it was left as.
    AsyncTask(ENamedThreads::GameThread, []()
    {
        if (FHaybaMCPModule* M = FModuleManager::GetModulePtr<FHaybaMCPModule>("HaybaMCPToolkit"))
        {
            if (TSharedPtr<SHaybaMCPMemoryPanel> Panel = M->MemoryPanel.Pin())
            {
                Panel->RefreshLibrary();
            }
        }
    });
    return Received();
}

FHaybaHandlerResult FHaybaMCPUIBridgeHandler::HandleCapturePanel(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader R(P, TEXT("ui_capture_panel"));
    const FString OutPath = R.RequiredString(TEXT("path"));
    if (R.HasErrors()) return FHaybaHandlerResult::Err(R.ErrorMessage());

    // Absolute paths only, and never inside the engine install. A relative
    // name here would resolve against the editor's working directory, which
    // is the Unreal install tree.
    if (FPaths::IsRelative(OutPath))
        return FHaybaHandlerResult::Err(
            TEXT("ui_capture_panel: path must be absolute; a relative name resolves into the Unreal install tree"));

    FHaybaMCPModule* M = FModuleManager::GetModulePtr<FHaybaMCPModule>("HaybaMCPToolkit");
    TSharedPtr<SHaybaMCPMainPanel> Panel = M ? M->MainPanel.Pin() : nullptr;
    if (!Panel.IsValid())
        return FHaybaHandlerResult::Err(
            TEXT("ui_capture_panel: the Hayba dock is not open; open it from the toolbar first"));

    TArray<FColor> Pixels;
    FIntVector Size(0, 0, 0);
    if (!FSlateApplication::Get().TakeScreenshot(Panel.ToSharedRef(), Pixels, Size)
        || Size.X <= 0 || Size.Y <= 0 || Pixels.Num() == 0)
    {
        return FHaybaHandlerResult::Err(
            TEXT("ui_capture_panel: Slate returned no pixels; the panel may be collapsed or offscreen"));
    }

    // TakeScreenshot leaves alpha as rendered, which can make the PNG appear
    // empty in viewers that honour it. The dock is opaque; force it.
    for (FColor& C : Pixels) C.A = 255;

    TArray64<uint8> Png;
    FImageUtils::PNGCompressImageArray(Size.X, Size.Y, Pixels, Png);
    if (Png.Num() == 0)
        return FHaybaHandlerResult::Err(TEXT("ui_capture_panel: PNG compression produced no bytes"));

    const FString Dir = FPaths::GetPath(OutPath);
    IFileManager::Get().MakeDirectory(*Dir, /*Tree*/ true);
    if (!FFileHelper::SaveArrayToFile(Png, *OutPath))
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("ui_capture_panel: could not write %s"), *OutPath));

    // Read the file back rather than trusting the write, and report the
    // dimensions so a caller can tell a real capture from a 1x1 stub.
    const int64 OnDisk = IFileManager::Get().FileSize(*OutPath);

    auto Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("path"), OutPath);
    Out->SetNumberField(TEXT("width"), Size.X);
    Out->SetNumberField(TEXT("height"), Size.Y);
    Out->SetNumberField(TEXT("bytes"), static_cast<double>(OnDisk));
    Out->SetBoolField(TEXT("verified"), OnDisk > 0);
    return FHaybaHandlerResult::Ok(Out);
}
FHaybaHandlerResult FHaybaMCPUIBridgeHandler::HandleToolStream(const TSharedPtr<FJsonObject>& P)
{
    // Lets the Node side mirror its own tool-call lifecycle into the Tool
    // Stream panel. TS-only handlers never route through UE dispatch, so
    // without this they are invisible in the editor.
    FString TName, PStr, RStr;
    P->TryGetStringField(TEXT("tool"), TName);
    P->TryGetStringField(TEXT("params"), PStr);
    P->TryGetStringField(TEXT("result"), RStr);

    // This route is normally called by the Node mirror AFTER its own final
    // redaction boundary -- but it is also reachable over raw TCP, so a direct
    // client can put a credential straight into native Tool Stream history.
    // Redact the two dynamic fields again at this native observability
    // boundary; the exact markers are idempotent, so the ordinary Node path is
    // unchanged.
    //
    // Came from the crash-hardening branch, where it lived in the router's
    // inline ui_tool_stream case. That case moved here, so this moved with it.
    {
        TSharedPtr<FJsonObject> MirrorText = MakeShared<FJsonObject>();
        MirrorText->SetStringField(TEXT("params"), PStr);
        MirrorText->SetStringField(TEXT("result"), RStr);
        const HaybaMCPSecretRedaction::FResult SafeMirror =
            HaybaMCPSecretRedaction::Redact(MirrorText);
        if (!SafeMirror.Value.IsValid() ||
            !SafeMirror.Value->TryGetStringField(TEXT("params"), PStr) ||
            !SafeMirror.Value->TryGetStringField(TEXT("result"), RStr))
        {
            PStr = TEXT("[TRUNCATED:nodes]");
            RStr = TEXT("[TRUNCATED:nodes]");
        }
    }

    if (FHaybaMCPModule* M = FModuleManager::GetModulePtr<FHaybaMCPModule>("HaybaMCPToolkit"))
    {
        M->RecordToolCall(TName, PStr, RStr);
        AsyncTask(ENamedThreads::GameThread, [TName, PStr, RStr]()
        {
            if (FHaybaMCPModule* Mod = FModuleManager::GetModulePtr<FHaybaMCPModule>("HaybaMCPToolkit"))
            {
                if (TSharedPtr<SHaybaMCPToolStreamPanel> Panel = Mod->ToolStreamPanel.Pin())
                {
                    Panel->AddToolCall(TName, PStr, RStr);
                }
            }
        });
    }
    return Received();
}

FHaybaHandlerResult FHaybaMCPUIBridgeHandler::HandleToolStreamNewTurn(const TSharedPtr<FJsonObject>& /*P*/)
{
    // The Node mirror saw an idle gap, so start a fresh collapsible group.
    AsyncTask(ENamedThreads::GameThread, []()
    {
        if (FHaybaMCPModule* M = FModuleManager::GetModulePtr<FHaybaMCPModule>("HaybaMCPToolkit"))
        {
            if (TSharedPtr<SHaybaMCPToolStreamPanel> Panel = M->ToolStreamPanel.Pin())
            {
                Panel->BeginNewTurn();
            }
        }
    });
    return Received();
}
