#include "HaybaMCPUIBridgeHandler.h"

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
        TEXT("ui_tool_stream"),
        TEXT("ui_tool_stream_new_turn"),
    };
}

FHaybaHandlerResult FHaybaMCPUIBridgeHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params)
{
    if (!Params.IsValid()) return FHaybaHandlerResult::Err(TEXT("UIBridgeHandler: missing params"));

    if (Cmd == TEXT("ui_memory_set"))           return HandleMemorySet(Params);
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

FHaybaHandlerResult FHaybaMCPUIBridgeHandler::HandleToolStream(const TSharedPtr<FJsonObject>& P)
{
    // Lets the Node side mirror its own tool-call lifecycle into the Tool
    // Stream panel. TS-only handlers never route through UE dispatch, so
    // without this they are invisible in the editor.
    FString TName, PStr, RStr;
    P->TryGetStringField(TEXT("tool"), TName);
    P->TryGetStringField(TEXT("params"), PStr);
    P->TryGetStringField(TEXT("result"), RStr);

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
