#pragma once
#include "CoreMinimal.h"
#include "Interfaces/IHttpRequest.h"
#include "HaybaMCPChatConfigGate.h"

class FJsonObject;

namespace HaybaChatEndpoint
{
    /** Built-in provider endpoints are implicit for Pro BYOK; genuine overrides remain explicit. */
    bool IsCustom(const FString& ProviderId, const FString& BaseURL);
}

// ─────────────────────────────────────────────────────────────────────────────
// FHaybaMCPAgentClient — Server-Sent-Events consumer for the BYOK copilot.
//
// Talks to the Node sidecar (SidecarURL, default http://localhost:7821) chat
// surface defined in mcp-tools/hayba-mcp/src/chat/chat-server.ts:
//
//   0. GET /api/health — verifies the expected Hayba chat protocol before a
//      decrypted BYOK key is sent to anything listening on the configured port.
//   1. POST /chat/config  (once per session) — pushes {provider, model,
//      base_url?, api_key} into the sidecar's in-memory config store. This is the
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
//   done         {reason,assistant_text,partial_text,cancelled,
//                 pending_warning_ids?,warning_reviews?,...} -> OnDone
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
	/** Validated warning identifiers only (at most 64, each at most 80 ASCII chars). */
	TArray<FString> PendingWarningIds;
	bool bPendingWarningIdsTruncated = false;
	bool bWarningOverflow = false;
	/** Counts only validated warning-review records. Reasons remain server-side. */
	int32 PendingWarningReviewCount = 0;
	int32 AcknowledgedWarningReviewCount = 0;
	int32 DeferredWarningReviewCount = 0;
	bool bWarningReviewsTruncated = false;
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
	 * with the given user prompt. Provider/baseURL/key come from
	 * FHaybaMCPSettings (selected provider + DPAPI vault); the composer may
	 * override model and reasoning effort for this turn. Each new turn refreshes
	 * the sidecar config. A parked approval resumes under its original choice.
	 */
	void SendPrompt(const FString& UserPrompt, const FString& WorkMode = TEXT("production"),
		const FString& ModelId = FString(), const FString& ReasoningEffort = FString());

	/** Use the UI conversation id before the first send so reopening a saved
	 *  transcript can reconnect while the sidecar still holds that session. */
	void SetSessionId(const FString& InSessionId)
	{
		if (!bStreaming && SessionId.IsEmpty()) SessionId = InSessionId;
	}

	/**
	 * Plan-mode resume: after the user Approves a gated action in the Plan tab,
	 * POST /chat/approve {session_id} (binds the paused call), then re-issue
	 * /chat/stream with the original Community prompt (or empty Pro prompt) so
	 * the stored server transcript continues
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

	/**
	 * Switch this chat to the Community loop (sets bForceCommunityThisChat) and
	 * force /chat/config to be re-posted with the current provider key.
	 */
	void ForceCommunityThisChat();

	/** True while a stream request is in flight. */
	bool IsStreaming() const { return bStreaming; }
	/** True while a turn is in flight, including its pre-stream round-trips. */
	bool IsTurnActive() const { return bStreaming || bTurnPending; }

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
    friend class FHaybaAgentHttpDeferralTest;
    friend class FHaybaAgentStreamTerminalTest;
	friend class FHaybaAgentSidecarIdentityTest;
	/** Verify the HTTP service before any BYOK key leaves the vault. */
	void CheckSidecarThenStream(const FString& UserPrompt);
	static bool HasCompatibleSidecarIdentity(const FJsonObject& Health);
	void PostConfig(const FString& UserPrompt);
	/** /chat/config when this session has none yet, then /chat/stream. */
	void ConfigureAndStream(const FString& UserPrompt);
	/** Hayba Pro: GET /brain/status (store rotation), push the vault token only if not signed in, then stream. */
	void CheckBrainThenStream(const FString& UserPrompt);
	/** Hayba Pro: push the DPAPI-stored refresh token (POST /brain/config), then ConfigureAndStream. */
	void PostBrainConfig(const FString& UserPrompt, const FString& RefreshToken);
	/** Hayba Pro: at every end of a Pro stream, GET /brain/status and re-store any rotated refresh token. */
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
	TSharedPtr<IHttpRequest, ESPMode::ThreadSafe> IdentityRequest;
	TSharedPtr<IHttpRequest, ESPMode::ThreadSafe> ConfigRequest;
	TSharedPtr<IHttpRequest, ESPMode::ThreadSafe> StreamRequest;
	FHaybaMCPChatConfigGate ConfigGate;
	bool bStreaming = false;
	bool bTerminalEmitted = false;   // true only after OnDone was broadcast (local or server)
	bool bApprovalPauseSeen = false; // approval may intentionally close a stream before its done frame
	FString ApprovalActivityId;     // only this activity's outcome can clear the pause
	bool bCurrentTurnPro = false;    // the in-flight/last turn asked for loop=pro
	/** SendPrompt until /chat/stream starts: the /brain/status, /brain/config, /chat/config round-trips. */
	bool bTurnPending = false;
	/** Bumped per SendPrompt and on a pending-phase Cancel; captured by every pre-stream continuation. */
	uint32 TurnGeneration = 0;
	/** True while the pre-stream phase of turn Generation is still the live one. */
	bool IsTurnCurrent(uint32 Generation) const;

	/** Index into the decoded stream body up to which frames have been parsed. */
	int32 ParseCursor = 0;
	/** Accumulated assistant text (for partial_text on local cancel). */
	FString AccumulatedText;
	/** Explicit composer mode, sent on every stream request (including resumes). */
	FString WorkMode = TEXT("production");
	FString TurnPrompt;
	/** Frozen composer selection for the active turn and any approval resume. */
	FString TurnModelId;
	FString TurnReasoningEffort;
	/** Unresolved identities owned by this client, retained across approval resume requests. */
	TSet<FString> StreamActivityIds;
};
