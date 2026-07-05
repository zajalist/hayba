#pragma once
#include "CoreMinimal.h"
#include "Interfaces/IHttpRequest.h"

// ─────────────────────────────────────────────────────────────────────────────
// FHaybaMCPAgentClient — Server-Sent-Events consumer for the BYOK copilot.
//
// Talks to the Node sidecar (SidecarURL, default http://localhost:7821) chat
// surface defined in mcp-tools/hayba-mcp/src/chat/chat-server.ts:
//
//   1. POST /chat/config  (once per session) — pushes {provider, model,
//      base_url, api_key} into the sidecar's in-memory config store. This is the
//      KEY HANDOFF: the decrypted BYOK key travels over loopback to /chat/config
//      and is never placed on the MCP command socket, never journaled, never
//      logged. (Chosen over copilot_get_key — one egress, key never round-trips
//      through the MCP tool layer.)
//   2. POST /chat/stream  — starts the turn and returns a text/event-stream. We
//      consume the body incrementally (OnRequestProgress64), parse complete
//      `\n\n`-delimited SSE frames out of the growing buffer, and fan each frame
//      out on a typed multicast delegate.
//   3. POST /chat/cancel  — {session_id}: on Cancel() we abort the in-flight
//      HTTP request locally (CancelRequest) AND tell the sidecar to abort the
//      server-side loop, then fire OnDone{cancelled:true, partial_text}.
//
// SSE frame → delegate mapping (event names mirror chat-server.ts EXACTLY):
//   text_delta   {text}                        -> OnTextDelta
//   tool_call    {id,name,input}               -> OnToolCall
//   tool_result  {id,name,result,isError?}     -> OnToolResult
//   plan_request {id,name,input,source,hint?,args_hash} -> OnPlanRequest
//   done         {reason,assistant_text,partial_text,cancelled,...} -> OnDone
//   error        {error,kind?}                 -> OnError
//   `: ping` heartbeat comment lines           -> ignored
//
// THREADING: FHttpModule dispatches OnRequestProgress64 / OnProcessRequestComplete
// on the game thread (FHttpManager ticks there in-editor), so all delegates fire
// on the game thread and are safe to touch Slate widgets directly.
//
// LIFETIME: create via MakeShared; callbacks capture a TWeakPtr so a destroyed
// client cannot be re-entered by a late HTTP callback.
// ─────────────────────────────────────────────────────────────────────────────

struct FHaybaChatToolCall
{
	FString Id;
	FString Name;
	FString InputJson;   // raw JSON of the tool input object
};

struct FHaybaChatToolResult
{
	FString Id;
	FString Name;
	FString ResultJson;  // raw JSON of the result value
	bool bIsError = false;
};

struct FHaybaChatPlanRequest
{
	FString Id;
	FString Name;
	FString InputJson;
	FString Source;
	FString Hint;
	FString ArgsHash;
};

struct FHaybaChatDone
{
	FString Reason;
	FString AssistantText;
	bool bCancelled = false;
};

struct FHaybaChatError
{
	FString Error;
	FString Kind;
};

DECLARE_MULTICAST_DELEGATE_OneParam(FOnHaybaChatTextDelta, const FString& /*Text*/);
DECLARE_MULTICAST_DELEGATE_OneParam(FOnHaybaChatToolCall, const FHaybaChatToolCall&);
DECLARE_MULTICAST_DELEGATE_OneParam(FOnHaybaChatToolResult, const FHaybaChatToolResult&);
DECLARE_MULTICAST_DELEGATE_OneParam(FOnHaybaChatPlanRequest, const FHaybaChatPlanRequest&);
DECLARE_MULTICAST_DELEGATE_OneParam(FOnHaybaChatDone, const FHaybaChatDone&);
DECLARE_MULTICAST_DELEGATE_OneParam(FOnHaybaChatError, const FHaybaChatError&);

class FHaybaMCPAgentClient : public TSharedFromThis<FHaybaMCPAgentClient>
{
public:
	FHaybaMCPAgentClient() = default;
	~FHaybaMCPAgentClient();

	/**
	 * Push provider/key config to the sidecar (once) then start a streaming turn
	 * with the given user prompt. Provider/model/baseURL/key are resolved from
	 * FHaybaMCPSettings (selected provider + DPAPI vault). Safe to call again for
	 * a follow-up turn on the same session; the config push is skipped after the
	 * first success.
	 */
	void SendPrompt(const FString& UserPrompt);

	/**
	 * Plan-mode resume: after the user Approves a gated action in the Plan tab,
	 * POST /chat/approve {session_id} (binds the paused call), then re-issue
	 * /chat/stream with an EMPTY prompt so the stored server transcript continues
	 * and the one approved call dispatches past the TS gate exactly once. NEVER
	 * call this without an explicit human Approve — it is the resume half of the
	 * plan_request handshake.
	 */
	void ApproveAndResume();

	/**
	 * Abort the in-flight stream: tells the sidecar to abort the server-side loop
	 * (POST /chat/cancel), cancels the local HTTP request, and fires OnDone with
	 * {cancelled:true, partial_text} = whatever text streamed so far.
	 */
	void Cancel();

	/**
	 * Abort a PARKED server-side turn without touching local stream state. On a
	 * plan reject the plan_request SSE stream has already closed (bStreaming is
	 * false), so Cancel()'s early-return would skip the server notification and
	 * leave the paused session parked. This fires POST /chat/cancel regardless of
	 * local stream state and does NOT emit a local done (the UI already finalized
	 * the bubble as [rejected]).
	 */
	void AbortServerTurn();

	/** True while a stream request is in flight. */
	bool IsStreaming() const { return bStreaming; }

	/** The session id used against the sidecar (stable for this client). */
	const FString& GetSessionId() const { return SessionId; }

	// Delegates — Task 8's panel subscribes to these. All fire on the game thread.
	FOnHaybaChatTextDelta   OnTextDelta;
	FOnHaybaChatToolCall    OnToolCall;
	FOnHaybaChatToolResult  OnToolResult;
	FOnHaybaChatPlanRequest OnPlanRequest;
	FOnHaybaChatDone        OnDone;
	FOnHaybaChatError       OnError;

private:
	void PostConfig(const FString& UserPrompt);
	void StartStream(const FString& UserPrompt);
	void PostApprove();

	/** Fire-and-forget POST /chat/cancel with {session_id} (no-op if no session). */
	void PostCancel();

	/** Parse any newly-completed `\n\n`-delimited frames out of the full body. */
	void ParseNewFrames(const FString& FullBody);
	/** Dispatch a single SSE frame block (the text between two `\n\n`). */
	void DispatchFrame(const FString& FrameBlock);

	/** Emit a synthetic local terminal done frame (used by Cancel / transport error). */
	void EmitLocalDone(const FString& Reason, bool bCancelled);

	FString MakeSessionId();

	// State
	FString SessionId;
	TSharedPtr<IHttpRequest, ESPMode::ThreadSafe> StreamRequest;
	bool bConfigDone = false;
	bool bStreaming = false;
	bool bTerminalEmitted = false;   // guards against double done (local + server)

	/** Index into the decoded stream body up to which frames have been parsed. */
	int32 ParseCursor = 0;
	/** Accumulated assistant text (for partial_text on local cancel). */
	FString AccumulatedText;
};
