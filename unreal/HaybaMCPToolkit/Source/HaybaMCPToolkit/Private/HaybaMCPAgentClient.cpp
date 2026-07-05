#include "HaybaMCPAgentClient.h"
#include "HaybaMCPSettings.h"
#include "HttpModule.h"
#include "Interfaces/IHttpResponse.h"
#include "Json.h"
#include "Misc/Guid.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaAgentClient, Log, All);

// ─────────────────────────────────────────────────────────────────────────────
// Small JSON helpers
// ─────────────────────────────────────────────────────────────────────────────
namespace
{
	/** Serialize a JSON object to a compact string. */
	FString JsonToString(const TSharedRef<FJsonObject>& Root)
	{
		FString Out;
		TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Out);
		FJsonSerializer::Serialize(Root, Writer);
		return Out;
	}

	/** Re-serialize a JSON value field back to its compact JSON string (for input/result). */
	FString FieldAsJsonString(const TSharedPtr<FJsonObject>& Obj, const TCHAR* Field)
	{
		if (!Obj.IsValid()) return FString();
		TSharedPtr<FJsonValue> Val = Obj->TryGetField(Field);
		if (!Val.IsValid()) return FString();
		if (Val->Type == EJson::String) return Val->AsString();
		FString Out;
		TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
			TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Out);
		FJsonSerializer::Serialize(Val.ToSharedRef(), TEXT(""), Writer);
		return Out;
	}
}

FHaybaMCPAgentClient::~FHaybaMCPAgentClient()
{
	// Best-effort: drop callbacks and cancel any in-flight request so a late HTTP
	// tick cannot re-enter a destroyed client. (Callbacks also capture a weak ptr.)
	if (StreamRequest.IsValid())
	{
		StreamRequest->OnRequestProgress64().Unbind();
		StreamRequest->OnProcessRequestComplete().Unbind();
		StreamRequest->CancelRequest();
		StreamRequest.Reset();
	}
}

FString FHaybaMCPAgentClient::MakeSessionId()
{
	return FString::Printf(TEXT("ue_%s"), *FGuid::NewGuid().ToString(EGuidFormats::Digits));
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry
// ─────────────────────────────────────────────────────────────────────────────
void FHaybaMCPAgentClient::SendPrompt(const FString& UserPrompt)
{
	// Re-entrancy guard: a second SendPrompt while a turn is in flight would
	// start a second /chat/stream sharing this instance's ParseCursor +
	// AccumulatedText (reset in StartStream), corrupting the live parse. The
	// server 409s a concurrent turn, but self-guard so the UI can't garble it.
	if (bStreaming)
	{
		FHaybaChatError Busy;
		Busy.Error = TEXT("a chat turn is already in progress; cancel it or wait for done");
		Busy.Kind = TEXT("busy");
		OnError.Broadcast(Busy);
		return;
	}
	if (SessionId.IsEmpty())
	{
		SessionId = MakeSessionId();
	}
	bTerminalEmitted = false;

	if (bConfigDone)
	{
		StartStream(UserPrompt);
	}
	else
	{
		PostConfig(UserPrompt);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1 — POST /chat/config (key handoff, loopback only, never logged)
// ─────────────────────────────────────────────────────────────────────────────
void FHaybaMCPAgentClient::PostConfig(const FString& UserPrompt)
{
	const FHaybaMCPSettings& Settings = FHaybaMCPSettings::Get();
	const FString Provider = Settings.SelectedProviderId;
	const FHaybaProviderInfo* Info = FHaybaMCPSettings::FindProvider(Provider);

	const FString Model   = (Info && Info->DefaultModel)   ? FString(Info->DefaultModel)   : Settings.Model;
	const FString BaseURL = (Info && Info->BaseURLDefault) ? FString(Info->BaseURLDefault) : Settings.BaseURL;

	// Key of record lives DPAPI-encrypted in the vault; fall back to the legacy
	// shared accessor (which also routes through the vault).
	FString ApiKey = FHaybaMCPSettings::GetProviderKey(Provider);
	if (ApiKey.IsEmpty())
	{
		ApiKey = FHaybaMCPSettings::GetSharedApiKey();
	}

	TSharedRef<FJsonObject> Body = MakeShared<FJsonObject>();
	Body->SetStringField(TEXT("session_id"), SessionId);
	Body->SetStringField(TEXT("provider"), Provider);
	Body->SetStringField(TEXT("model"), Model);
	Body->SetStringField(TEXT("base_url"), BaseURL);
	Body->SetStringField(TEXT("api_key"), ApiKey);   // loopback only — never logged

	const FString ConfigUrl = Settings.SidecarURL / TEXT("chat/config");

	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(ConfigUrl);
	Request->SetVerb(TEXT("POST"));
	Request->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
	Request->SetContentAsString(JsonToString(Body));

	// NB: never log the body — it carries the raw key.
	UE_LOG(LogHaybaAgentClient, Verbose, TEXT("POST /chat/config provider=%s (key %d bytes, not logged)"),
		*Provider, ApiKey.Len());

	TWeakPtr<FHaybaMCPAgentClient> WeakThis = AsShared();
	const FString CapturedPrompt = UserPrompt;
	Request->OnProcessRequestComplete().BindLambda(
		[WeakThis, CapturedPrompt](FHttpRequestPtr /*Req*/, FHttpResponsePtr Response, bool bConnected)
		{
			TSharedPtr<FHaybaMCPAgentClient> Self = WeakThis.Pin();
			if (!Self.IsValid()) return;

			if (!bConnected || !Response.IsValid())
			{
				Self->OnError.Broadcast(FHaybaChatError{
					TEXT("Could not reach the Hayba sidecar. Is it running?"), TEXT("transport") });
				Self->EmitLocalDone(TEXT("error"), /*cancelled*/ false);
				return;
			}
			const int32 Code = Response->GetResponseCode();
			if (Code != 200)
			{
				Self->OnError.Broadcast(FHaybaChatError{
					FString::Printf(TEXT("Sidecar /chat/config rejected the request (HTTP %d)."), Code),
					TEXT("config") });
				Self->EmitLocalDone(TEXT("error"), /*cancelled*/ false);
				return;
			}
			Self->bConfigDone = true;
			Self->StartStream(CapturedPrompt);
		});

	Request->ProcessRequest();
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2 — POST /chat/stream and consume the SSE body incrementally
// ─────────────────────────────────────────────────────────────────────────────
void FHaybaMCPAgentClient::StartStream(const FString& UserPrompt)
{
	const FHaybaMCPSettings& Settings = FHaybaMCPSettings::Get();
	const FString StreamUrl = Settings.SidecarURL / TEXT("chat/stream");

	// Reset per-turn parse state.
	ParseCursor = 0;
	AccumulatedText.Empty();
	bStreaming = true;

	TSharedRef<FJsonObject> Body = MakeShared<FJsonObject>();
	Body->SetStringField(TEXT("session_id"), SessionId);
	Body->SetStringField(TEXT("prompt"), UserPrompt);
	// provider/model/key already registered via /chat/config for this session.

	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(StreamUrl);
	Request->SetVerb(TEXT("POST"));
	Request->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
	Request->SetHeader(TEXT("Accept"), TEXT("text/event-stream"));
	Request->SetContentAsString(JsonToString(Body));
	StreamRequest = Request;

	TWeakPtr<FHaybaMCPAgentClient> WeakThis = AsShared();

	// Progressive body access: OnRequestProgress64 fires as bytes arrive. The
	// response's GetContentAsString() returns the whole body received so far, so
	// we track a parse cursor and pull out only newly-completed `\n\n` frames.
	Request->OnRequestProgress64().BindLambda(
		[WeakThis](FHttpRequestPtr Req, uint64 /*BytesSent*/, uint64 /*BytesReceived*/)
		{
			TSharedPtr<FHaybaMCPAgentClient> Self = WeakThis.Pin();
			if (!Self.IsValid() || !Req.IsValid()) return;
			FHttpResponsePtr Response = Req->GetResponse();
			if (!Response.IsValid()) return;
			Self->ParseNewFrames(Response->GetContentAsString());
		});

	Request->OnProcessRequestComplete().BindLambda(
		[WeakThis](FHttpRequestPtr /*Req*/, FHttpResponsePtr Response, bool bConnected)
		{
			TSharedPtr<FHaybaMCPAgentClient> Self = WeakThis.Pin();
			if (!Self.IsValid()) return;
			Self->bStreaming = false;

			// Drain any frames that arrived between the last progress tick and
			// completion (a small tail can land in one shot).
			if (Response.IsValid())
			{
				Self->ParseNewFrames(Response->GetContentAsString());
			}

			// If the server already sent a `done` frame it drives the terminus;
			// otherwise this was a transport drop / local cancel.
			if (Self->bTerminalEmitted)
			{
				Self->StreamRequest.Reset();
				return;
			}
			if (!bConnected || !Response.IsValid())
			{
				Self->OnError.Broadcast(FHaybaChatError{
					TEXT("Chat stream disconnected before completion."), TEXT("transport") });
				Self->EmitLocalDone(TEXT("error"), /*cancelled*/ false);
			}
			else
			{
				// Stream closed without an explicit done frame — synthesize one.
				Self->EmitLocalDone(TEXT("end_turn"), /*cancelled*/ false);
			}
			Self->StreamRequest.Reset();
		});

	UE_LOG(LogHaybaAgentClient, Verbose, TEXT("POST /chat/stream session=%s"), *SessionId);
	Request->ProcessRequest();
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE frame extraction — buffers partial frames across progress callbacks.
// ─────────────────────────────────────────────────────────────────────────────
void FHaybaMCPAgentClient::ParseNewFrames(const FString& FullBody)
{
	// Frames are separated by a blank line ("\n\n"). Because FullBody is the whole
	// accumulated body, we advance ParseCursor past each complete frame and leave
	// any trailing partial frame unparsed until more bytes arrive.
	while (true)
	{
		const int32 Boundary = FullBody.Find(
			TEXT("\n\n"), ESearchCase::CaseSensitive, ESearchDir::FromStart, ParseCursor);
		if (Boundary == INDEX_NONE)
		{
			break; // remainder is a partial frame; wait for more
		}
		const FString FrameBlock = FullBody.Mid(ParseCursor, Boundary - ParseCursor);
		ParseCursor = Boundary + 2; // skip the "\n\n"
		DispatchFrame(FrameBlock);
	}
}

void FHaybaMCPAgentClient::DispatchFrame(const FString& FrameBlock)
{
	// A frame is a set of lines: `id:`, `event:`, one or more `data:`, and/or
	// `:comment` (heartbeat) lines. Parse them per the SSE grammar.
	TArray<FString> Lines;
	FrameBlock.ParseIntoArray(Lines, TEXT("\n"), /*CullEmpty*/ false);

	FString EventType;
	FString DataStr;
	bool bHasData = false;

	for (FString Line : Lines)
	{
		Line.RemoveFromEnd(TEXT("\r")); // tolerate CRLF
		if (Line.IsEmpty())
		{
			continue;
		}
		if (Line.StartsWith(TEXT(":")))
		{
			continue; // comment / heartbeat (`: ping`) — ignore
		}
		if (Line.StartsWith(TEXT("event:")))
		{
			EventType = Line.RightChop(6).TrimStartAndEnd();
		}
		else if (Line.StartsWith(TEXT("data:")))
		{
			FString Chunk = Line.RightChop(5);
			Chunk.RemoveFromStart(TEXT(" ")); // SSE strips exactly one leading space
			if (bHasData) DataStr += TEXT("\n"); // multi-line data joins with \n
			DataStr += Chunk;
			bHasData = true;
		}
		// `id:` (seq) is ignored client-side — we don't resume yet.
	}

	if (EventType.IsEmpty())
	{
		return; // heartbeat-only or malformed frame
	}

	// Log frame TYPE + size only — never the payload (may contain user content).
	UE_LOG(LogHaybaAgentClient, Verbose, TEXT("SSE frame '%s' (%d bytes data)"),
		*EventType, DataStr.Len());

	// Parse the JSON data payload.
	TSharedPtr<FJsonObject> Data;
	if (bHasData && !DataStr.IsEmpty())
	{
		TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(DataStr);
		FJsonSerializer::Deserialize(Reader, Data);
	}

	if (EventType == TEXT("text_delta") || EventType == TEXT("token"))
	{
		FString Text;
		if (Data.IsValid()) Data->TryGetStringField(TEXT("text"), Text);
		if (!Text.IsEmpty())
		{
			AccumulatedText += Text;
			OnTextDelta.Broadcast(Text);
		}
	}
	else if (EventType == TEXT("tool_call"))
	{
		FHaybaChatToolCall Call;
		if (Data.IsValid())
		{
			Data->TryGetStringField(TEXT("id"), Call.Id);
			Data->TryGetStringField(TEXT("name"), Call.Name);
			Call.InputJson = FieldAsJsonString(Data, TEXT("input"));
		}
		OnToolCall.Broadcast(Call);
	}
	else if (EventType == TEXT("tool_result"))
	{
		FHaybaChatToolResult Result;
		if (Data.IsValid())
		{
			Data->TryGetStringField(TEXT("id"), Result.Id);
			Data->TryGetStringField(TEXT("name"), Result.Name);
			Result.ResultJson = FieldAsJsonString(Data, TEXT("result"));
			Data->TryGetBoolField(TEXT("isError"), Result.bIsError);
		}
		OnToolResult.Broadcast(Result);
	}
	else if (EventType == TEXT("plan_request"))
	{
		FHaybaChatPlanRequest Plan;
		if (Data.IsValid())
		{
			Data->TryGetStringField(TEXT("id"), Plan.Id);
			Data->TryGetStringField(TEXT("name"), Plan.Name);
			Plan.InputJson = FieldAsJsonString(Data, TEXT("input"));
			Data->TryGetStringField(TEXT("source"), Plan.Source);
			Data->TryGetStringField(TEXT("hint"), Plan.Hint);
			Data->TryGetStringField(TEXT("args_hash"), Plan.ArgsHash);
		}
		OnPlanRequest.Broadcast(Plan);
	}
	else if (EventType == TEXT("done"))
	{
		FHaybaChatDone Done;
		if (Data.IsValid())
		{
			Data->TryGetStringField(TEXT("reason"), Done.Reason);
			// Prefer assistant_text; fall back to partial_text.
			if (!Data->TryGetStringField(TEXT("assistant_text"), Done.AssistantText))
			{
				Data->TryGetStringField(TEXT("partial_text"), Done.AssistantText);
			}
			Data->TryGetBoolField(TEXT("cancelled"), Done.bCancelled);
		}
		bTerminalEmitted = true;
		OnDone.Broadcast(Done);
	}
	else if (EventType == TEXT("error"))
	{
		FHaybaChatError Err;
		if (Data.IsValid())
		{
			Data->TryGetStringField(TEXT("error"), Err.Error);
			Data->TryGetStringField(TEXT("kind"), Err.Kind);
			// resume_gap uses `code` instead of `error`.
			if (Err.Error.IsEmpty()) Data->TryGetStringField(TEXT("code"), Err.Error);
		}
		OnError.Broadcast(Err);
	}
	// Unknown event types are ignored (forward-compatible).
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan-mode resume — POST /chat/approve, then re-issue /chat/stream (empty prompt)
// ─────────────────────────────────────────────────────────────────────────────
void FHaybaMCPAgentClient::ApproveAndResume()
{
	if (SessionId.IsEmpty())
	{
		OnError.Broadcast(FHaybaChatError{
			TEXT("Cannot resume: no chat session is active."), TEXT("resume") });
		return;
	}
	if (bStreaming)
	{
		// A turn is already running; nothing to approve/resume against.
		return;
	}
	PostApprove();
}

void FHaybaMCPAgentClient::PostApprove()
{
	const FHaybaMCPSettings& Settings = FHaybaMCPSettings::Get();

	TSharedRef<FJsonObject> Body = MakeShared<FJsonObject>();
	Body->SetStringField(TEXT("session_id"), SessionId);

	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(Settings.SidecarURL / TEXT("chat/approve"));
	Request->SetVerb(TEXT("POST"));
	Request->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
	Request->SetContentAsString(JsonToString(Body));

	TWeakPtr<FHaybaMCPAgentClient> WeakThis = AsShared();
	Request->OnProcessRequestComplete().BindLambda(
		[WeakThis](FHttpRequestPtr /*Req*/, FHttpResponsePtr Response, bool bConnected)
		{
			TSharedPtr<FHaybaMCPAgentClient> Self = WeakThis.Pin();
			if (!Self.IsValid()) return;

			if (!bConnected || !Response.IsValid())
			{
				Self->OnError.Broadcast(FHaybaChatError{
					TEXT("Could not reach the Hayba sidecar to approve the plan."), TEXT("transport") });
				return;
			}
			const int32 Code = Response->GetResponseCode();
			if (Code != 200)
			{
				Self->OnError.Broadcast(FHaybaChatError{
					FString::Printf(TEXT("Sidecar /chat/approve rejected the request (HTTP %d)."), Code),
					TEXT("approve") });
				return;
			}
			// Approval bound server-side; resume the paused turn. The stored
			// transcript continues — an empty prompt just re-drives the loop.
			Self->bTerminalEmitted = false;
			Self->StartStream(FString());
		});

	UE_LOG(LogHaybaAgentClient, Verbose, TEXT("POST /chat/approve session=%s"), *SessionId);
	Request->ProcessRequest();
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3 — Cancel: abort server-side loop + local request, emit local done
// ─────────────────────────────────────────────────────────────────────────────
void FHaybaMCPAgentClient::Cancel()
{
	if (!bStreaming && !StreamRequest.IsValid())
	{
		return;
	}

	// Tell the sidecar to abort the server-side loop (fire-and-forget). Without
	// this the turn keeps running server-side even after we drop the socket.
	if (!SessionId.IsEmpty())
	{
		const FHaybaMCPSettings& Settings = FHaybaMCPSettings::Get();
		TSharedRef<FJsonObject> Body = MakeShared<FJsonObject>();
		Body->SetStringField(TEXT("session_id"), SessionId);

		TSharedRef<IHttpRequest, ESPMode::ThreadSafe> CancelReq = FHttpModule::Get().CreateRequest();
		CancelReq->SetURL(Settings.SidecarURL / TEXT("chat/cancel"));
		CancelReq->SetVerb(TEXT("POST"));
		CancelReq->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
		CancelReq->SetContentAsString(JsonToString(Body));
		CancelReq->ProcessRequest(); // ignore response
	}

	// Cancel the local streaming request. This will trigger OnProcessRequestComplete
	// with bConnected=false; bTerminalEmitted guards against a duplicate done.
	if (StreamRequest.IsValid())
	{
		StreamRequest->OnRequestProgress64().Unbind();
		StreamRequest->OnProcessRequestComplete().Unbind();
		StreamRequest->CancelRequest();
		StreamRequest.Reset();
	}
	bStreaming = false;

	// Fire our own terminal done carrying the partial text streamed so far.
	EmitLocalDone(TEXT("cancelled"), /*cancelled*/ true);
}

void FHaybaMCPAgentClient::EmitLocalDone(const FString& Reason, bool bCancelled)
{
	if (bTerminalEmitted)
	{
		return;
	}
	bTerminalEmitted = true;
	FHaybaChatDone Done;
	Done.Reason = Reason;
	Done.AssistantText = AccumulatedText;
	Done.bCancelled = bCancelled;
	OnDone.Broadcast(Done);
}
