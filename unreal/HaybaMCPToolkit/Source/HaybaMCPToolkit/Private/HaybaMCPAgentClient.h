#pragma once
#include "CoreMinimal.h"
#include "Interfaces/IHttpRequest.h"

class FJsonObject;

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
DECLARE_MULTICAST_DELEGATE_OneParam(FOnHaybaActivityEvent, const FJsonObject&);

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
	void SendPrompt(const FString& UserPrompt, const FString& WorkMode = TEXT("production"));

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

	/**
	 * Hayba Pro fallback: when true, this chat's turns use the local Community
	 * loop even if FHaybaMCPSettings::bUseHaybaPro is on (set by the panel's
	 * "Use Community for this chat" after a brain_unavailable error). Reset to
	 * false whenever the client starts or adopts a chat session id.
	 */
	bool bForceCommunityThisChat = false;

	/** True when the next turn routes through Hayba Pro (setting on, not forced to Community). */
	bool IsProLoopActive() const;

	/** True while a stream request is in flight. */
	bool IsStreaming() const { return bStreaming; }

	/** The session id used against the sidecar (stable for this client). */
	const FString& GetSessionId() const { return SessionId; }
	/** Continue a saved text session. Provider credentials are always reconfigured. */
	bool AdoptSavedSession(const FString& InSessionId);

	/** Strict semantic JSON decoder; requires matching SSE and payload event types. */
	static bool DecodeActivityEvent(const FString& EventType, const FString& Json, TSharedPtr<FJsonObject>& OutEvent);
	FOnHaybaActivityEvent OnActivityEvent;

	// Delegates — Task 8's panel subscribes to these. All fire on the game thread.
	FOnHaybaChatTextDelta   OnTextDelta;
	FOnHaybaChatToolCall    OnToolCall;
	FOnHaybaChatToolResult  OnToolResult;
	FOnHaybaChatPlanRequest OnPlanRequest;
	FOnHaybaChatDone        OnDone;
	FOnHaybaChatError       OnError;

private:
    friend class FHaybaActivityClientFramesTest;
    friend class FHaybaActivityResumeDisconnectTest;
	void PostConfig(const FString& UserPrompt);
	/** /chat/config when this session has none yet, then /chat/stream. */
	void ConfigureAndStream(const FString& UserPrompt);
	/** Hayba Pro: push the DPAPI-stored refresh token (POST /brain/config), then ConfigureAndStream. */
	void PostBrainConfig(const FString& UserPrompt, const FString& RefreshToken);
	/** Hayba Pro: after a Pro turn's done, GET /brain/status and re-store any rotated refresh token. */
	void StoreRotatedBrainToken();
	void StartStream(const FString& UserPrompt);
	/** Prepare callbacks/state separately from sending, so transport outcomes can be tested offline. */
	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> CreateStreamRequest(const FString& UserPrompt);
	void PostApprove();

	/** Fire-and-forget POST /chat/cancel with {session_id} (no-op if no session). */
	void PostCancel();

	/** Parse any newly-completed `\n\n`-delimited frames out of the full body. */
	void ParseNewFrames(const FString& FullBody);
	/** Dispatch a single SSE frame block (the text between two `\n\n`). */
	void DispatchFrame(const FString& FrameBlock);

	/** Emit a synthetic local terminal done frame (used by Cancel / transport error). */
	void EmitLocalDone(const FString& Reason, bool bCancelled);
	void MarkActivitiesDisconnected();

	FString MakeSessionId();

	// State
	FString SessionId;
	TSharedPtr<IHttpRequest, ESPMode::ThreadSafe> StreamRequest;
	bool bConfigDone = false;
	bool bStreaming = false;
	bool bTerminalEmitted = false;   // guards against double done (local + server)
	bool bCurrentTurnPro = false;    // the in-flight/last stream request asked for loop=pro

	/** Index into the decoded stream body up to which frames have been parsed. */
	int32 ParseCursor = 0;
	/** Accumulated assistant text (for partial_text on local cancel). */
	FString AccumulatedText;
	/** Explicit composer mode, sent on every stream request (including resumes). */
	FString WorkMode = TEXT("production");
	/** Unresolved identities owned by this client, retained across approval resume requests. */
	TSet<FString> StreamActivityIds;
};
