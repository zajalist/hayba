#include "HaybaMCPAgentClient.h"
#include "HaybaMCPActivityModel.h"
#include "HaybaMCPModule.h"
#include "HaybaMCPSettings.h"
#include "HttpModule.h"
#include "Interfaces/IHttpResponse.h"
#include "Json.h"
#include "Misc/Guid.h"
#include "Editor.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaAgentClient, Log, All);

// ─────────────────────────────────────────────────────────────────────────────
// Small JSON helpers
// ─────────────────────────────────────────────────────────────────────────────
namespace
{
	// HTTP completion delegates run inside FHttpManager's request iteration.
	// Registering another request there can invalidate its ranged-for iterator.
	template <typename F>
	void AfterHttpTick(F&& Continuation)
	{
		if (!GEditor) return; // editor shutdown: never run a continuation inline
		GEditor->GetTimerManager()->SetTimerForNextTick(Forward<F>(Continuation));
	}

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

	/** What a GET /brain/status said about the sidecar's sign-in state. */
	enum class EHaybaBrainSignIn : uint8
	{
		SignedIn,
		NotSignedIn,
		Unknown,   // transport error / non-200 / unreadable body: do NOT push the vault token
	};

	/**
	 * Apply a GET /brain/status response: re-store any rotated refresh token in
	 * the DPAPI vault (Supabase rotates on every refresh; the sidecar hands the
	 * new one back exactly once). Returns the sidecar's sign-in state.
	 */
	EHaybaBrainSignIn ApplyBrainStatusResponse(const FHttpResponsePtr& Response, bool bConnected)
	{
		if (!bConnected || !Response.IsValid() || Response->GetResponseCode() != 200) return EHaybaBrainSignIn::Unknown;
		TSharedPtr<FJsonObject> Root;
		if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Response->GetContentAsString()), Root) ||
			!Root.IsValid()) return EHaybaBrainSignIn::Unknown;
		FString Rotated;
		if (Root->TryGetStringField(TEXT("rotated_refresh_token"), Rotated) && !Rotated.IsEmpty())
		{
			FHaybaMCPSettings::SetProviderKey(TEXT("hayba-brain"), Rotated);   // never logged
		}
		bool bSignedIn = false;
		if (!Root->TryGetBoolField(TEXT("signed_in"), bSignedIn)) return EHaybaBrainSignIn::Unknown;
		return bSignedIn ? EHaybaBrainSignIn::SignedIn : EHaybaBrainSignIn::NotSignedIn;
	}

	// The sidecar's warning ledger emits identifiers with this restricted shape.
	// Revalidate at the SSE boundary so arbitrary server text cannot become a
	// saved Chat notice, and never log or copy the raw pending_warning_ids field.
	bool IsSafeWarningId(const FString& Id)
	{
		if (Id.IsEmpty() || Id.Len() > 80 || Id[0] < TEXT('a') || Id[0] > TEXT('z'))
		{
			return false;
		}
		for (const TCHAR Character : Id)
		{
			const bool bLower = Character >= TEXT('a') && Character <= TEXT('z');
			const bool bDigit = Character >= TEXT('0') && Character <= TEXT('9');
			if (!bLower && !bDigit && Character != TEXT('_')) return false;
		}
		return true;
	}
}

FHaybaMCPAgentClient::~FHaybaMCPAgentClient()
{
	// Best-effort: drop callbacks and cancel any in-flight request so a late HTTP
	// tick cannot re-enter a destroyed client. (Callbacks also capture a weak ptr.)
	if (ConfigRequest.IsValid())
	{
		ConfigRequest->OnProcessRequestComplete().Unbind();
		ConfigRequest->CancelRequest();
		ConfigRequest.Reset();
	}
	if (StreamRequest.IsValid())
	{
		if (!bTerminalEmitted) MarkActivitiesDisconnected();
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
void FHaybaMCPAgentClient::SendPrompt(const FString& UserPrompt, const FString& InWorkMode,
	const FString& InModelId, const FString& InReasoningEffort)
{
	// Re-entrancy guard: a second SendPrompt while a turn is in flight would
	// start a second /chat/stream sharing this instance's ParseCursor +
	// AccumulatedText (reset in StartStream), corrupting the live parse. The
	// server 409s a concurrent turn, but self-guard so the UI can't garble it.
	if (bStreaming || bTurnPending || ConfigGate.IsPending())
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
		bForceCommunityThisChat = false;
	}
	bTerminalEmitted = false;
	bApprovalPauseSeen = false;
	ApprovalActivityId.Empty();
	WorkMode = InWorkMode;
	TurnPrompt = UserPrompt;
	TurnModelId = InModelId;
	TurnReasoningEffort = InReasoningEffort;
	// The turn is pending until /chat/stream starts (or it terminates). Every
	// pre-stream continuation checks this generation, so a Stop pressed during
	// the /brain/status, /brain/config or /chat/config round-trip wins.
	bTurnPending = true;
	++TurnGeneration;
	AccumulatedText.Empty();
	bCurrentTurnPro = IsProLoopActive();

	CheckSidecarThenStream(UserPrompt);
}

bool FHaybaMCPAgentClient::HasCompatibleSidecarIdentity(const FJsonObject& Health)
{
	FString Service;
	FString Protocol;
	FString Status;
	return Health.TryGetStringField(TEXT("service"), Service) && Service == TEXT("hayba-mcp") &&
		Health.TryGetStringField(TEXT("chatProtocol"), Protocol) &&
		Protocol == TEXT("hayba-chat-2026-10-03") &&
		Health.TryGetStringField(TEXT("status"), Status) && Status == TEXT("ok");
}

void FHaybaMCPAgentClient::CheckSidecarThenStream(const FString& UserPrompt)
{
	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	IdentityRequest = Request;
	Request->SetURL(FHaybaMCPSettings::Get().SidecarURL / TEXT("api/health"));
	Request->SetVerb(TEXT("GET"));
	Request->SetTimeout(5.0f);
	const uint32 Generation = TurnGeneration;
	TWeakPtr<FHaybaMCPAgentClient> WeakSelf = AsShared();
	Request->OnProcessRequestComplete().BindLambda(
		[WeakSelf, UserPrompt, Generation](FHttpRequestPtr, FHttpResponsePtr Response, bool bConnected)
		{
			TSharedPtr<FHaybaMCPAgentClient> Self = WeakSelf.Pin();
			if (!Self.IsValid() || !Self->IsTurnCurrent(Generation)) return;
			Self->IdentityRequest.Reset();
			TSharedPtr<FJsonObject> Health;
			const bool bCompatible = bConnected && Response.IsValid() &&
				Response->GetResponseCode() == 200 && Response->GetContent().Num() <= 4096 &&
				FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Response->GetContentAsString()), Health) &&
				Health.IsValid() && FHaybaMCPAgentClient::HasCompatibleSidecarIdentity(*Health);
			if (!bCompatible)
			{
				Self->OnError.Broadcast(FHaybaChatError{
					TEXT("The chat sidecar is unavailable or incompatible. Restart Hayba's sidecar, then retry; your message is still here."),
					TEXT("sidecar_identity") });
				Self->EmitLocalDone(TEXT("error"), /*cancelled*/ false);
				return;
			}
			if (Self->bCurrentTurnPro) Self->CheckBrainThenStream(UserPrompt);
			else Self->ConfigureAndStream(UserPrompt);
		});
	if (!Request->ProcessRequest() && IsTurnCurrent(Generation))
	{
		IdentityRequest.Reset();
		OnError.Broadcast(FHaybaChatError{
			TEXT("Could not connect to the Hayba chat sidecar. Restart it, then retry."), TEXT("transport") });
		EmitLocalDone(TEXT("error"), /*cancelled*/ false);
	}
}

void FHaybaMCPAgentClient::ForceCommunityThisChat()
{
	bForceCommunityThisChat = true;
	// Every new turn posts /chat/config, so the next Community turn uses the
	// current provider key without retaining a stale sidecar configuration.
}

// ─────────────────────────────────────────────────────────────────────────────
// Hayba Pro — GET /brain/status first. The sidecar keeps the refresh token in
// memory and rotates it; pushing the vault token blindly could overwrite a
// pending rotation with a spent token. So: collect any rotation, and push the
// vault token (POST /brain/config) only when the sidecar is NOT signed in
// (e.g. it restarted). With no stored token the push is skipped and the
// sidecar answers brain_unavailable, which the panel renders.
// ─────────────────────────────────────────────────────────────────────────────
void FHaybaMCPAgentClient::CheckBrainThenStream(const FString& UserPrompt)
{
	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(FHaybaMCPSettings::Get().SidecarURL / TEXT("brain/status"));
	Request->SetVerb(TEXT("GET"));
	Request->SetTimeout(10.0f);

	TWeakPtr<FHaybaMCPAgentClient> WeakSelf = AsShared();
	const FString CapturedPrompt = UserPrompt;
	const uint32 Generation = TurnGeneration;
	Request->OnProcessRequestComplete().BindLambda(
		[WeakSelf, CapturedPrompt, Generation](FHttpRequestPtr /*Req*/, FHttpResponsePtr Response, bool bConnected)
		{
			// Store any rotation even if the client or turn is gone; the vault must not lose it.
			const EHaybaBrainSignIn SignIn = ApplyBrainStatusResponse(Response, bConnected);
			TSharedPtr<FHaybaMCPAgentClient> Self = WeakSelf.Pin();
			if (!Self.IsValid() || !Self->IsTurnCurrent(Generation)) return;
			// Push the vault token only when the sidecar definitely has none (e.g. it
			// restarted). On Unknown, stream without pushing: a possibly-spent vault
			// token must not overwrite the sidecar's, and a sidecar that truly has no
			// token answers brain_unavailable itself.
			if (SignIn == EHaybaBrainSignIn::NotSignedIn)
			{
				const FString RefreshToken = FHaybaMCPSettings::GetProviderKey(TEXT("hayba-brain"));
				if (!RefreshToken.IsEmpty())
				{
					AfterHttpTick([WeakSelf, CapturedPrompt, RefreshToken, Generation]()
					{
						TSharedPtr<FHaybaMCPAgentClient> Next = WeakSelf.Pin();
						if (Next.IsValid() && Next->IsTurnCurrent(Generation))
							Next->PostBrainConfig(CapturedPrompt, RefreshToken);
					});
					return;
				}
			}
			AfterHttpTick([WeakSelf, CapturedPrompt, Generation]()
			{
				TSharedPtr<FHaybaMCPAgentClient> Next = WeakSelf.Pin();
				if (Next.IsValid() && Next->IsTurnCurrent(Generation))
					Next->ConfigureAndStream(CapturedPrompt);
			});
		});
	Request->ProcessRequest();
}

bool FHaybaMCPAgentClient::IsTurnCurrent(uint32 Generation) const
{
	return bTurnPending && TurnGeneration == Generation;
}

bool FHaybaMCPAgentClient::IsProLoopActive() const
{
	return FHaybaMCPSettings::Get().bUseHaybaPro && !bForceCommunityThisChat;
}

void FHaybaMCPAgentClient::ConfigureAndStream(const FString& UserPrompt)
{
	ConfigGate.Begin();
	PostConfig(UserPrompt);
}

// ─────────────────────────────────────────────────────────────────────────────
// Hayba Pro — POST /brain/config (refresh-token handoff, loopback only, never logged)
// ─────────────────────────────────────────────────────────────────────────────
void FHaybaMCPAgentClient::PostBrainConfig(const FString& UserPrompt, const FString& RefreshToken)
{
	const FHaybaMCPSettings& Settings = FHaybaMCPSettings::Get();

	TSharedRef<FJsonObject> Body = MakeShared<FJsonObject>();
	Body->SetStringField(TEXT("refresh_token"), RefreshToken);   // loopback only — never logged
	if (!Settings.BrainAccountEmail.IsEmpty())
	{
		Body->SetStringField(TEXT("email"), Settings.BrainAccountEmail);
	}

	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(Settings.SidecarURL / TEXT("brain/config"));
	Request->SetVerb(TEXT("POST"));
	Request->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
	Request->SetContentAsString(JsonToString(Body));
	Request->SetTimeout(10.0f);

	// NB: never log the body — it carries the refresh token.
	UE_LOG(LogHaybaAgentClient, Verbose, TEXT("POST /brain/config (token %d bytes, not logged)"), RefreshToken.Len());

	TWeakPtr<FHaybaMCPAgentClient> WeakSelf = AsShared();
	const FString CapturedPrompt = UserPrompt;
	const uint32 Generation = TurnGeneration;
	Request->OnProcessRequestComplete().BindLambda(
		[WeakSelf, CapturedPrompt, Generation](FHttpRequestPtr /*Req*/, FHttpResponsePtr Response, bool bConnected)
		{
			TSharedPtr<FHaybaMCPAgentClient> Self = WeakSelf.Pin();
			if (!Self.IsValid() || !Self->IsTurnCurrent(Generation)) return;
			// Stream either way: a failed push surfaces as the sidecar's own
			// brain_unavailable error (or /chat/config's transport error).
			if (!bConnected || !Response.IsValid() || Response->GetResponseCode() != 200)
			{
				UE_LOG(LogHaybaAgentClient, Verbose, TEXT("POST /brain/config did not succeed (HTTP %d)"),
					Response.IsValid() ? Response->GetResponseCode() : 0);
			}
			AfterHttpTick([WeakSelf, CapturedPrompt, Generation]()
			{
				TSharedPtr<FHaybaMCPAgentClient> Next = WeakSelf.Pin();
				if (Next.IsValid() && Next->IsTurnCurrent(Generation))
					Next->ConfigureAndStream(CapturedPrompt);
			});
		});

	Request->ProcessRequest();
}

// Supabase rotates the refresh token on every refresh; the sidecar hands the new
// one back exactly once via /brain/status so the next editor launch still signs in.
void FHaybaMCPAgentClient::StoreRotatedBrainToken()
{
	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(FHaybaMCPSettings::Get().SidecarURL / TEXT("brain/status"));
	Request->SetVerb(TEXT("GET"));
	Request->SetTimeout(10.0f);
	Request->OnProcessRequestComplete().BindLambda(
		[](FHttpRequestPtr /*Req*/, FHttpResponsePtr Response, bool bConnected)
		{
			ApplyBrainStatusResponse(Response, bConnected);
		});
	AfterHttpTick([Request]() { Request->ProcessRequest(); });
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1 — POST /chat/config (key handoff, loopback only, never logged)
// ─────────────────────────────────────────────────────────────────────────────
bool HaybaChatEndpoint::IsCustom(const FString& ProviderId, const FString& BaseURL)
{
	FString Actual = BaseURL.TrimStartAndEnd();
	if (Actual.IsEmpty()) return false;
	while (Actual.RemoveFromEnd(TEXT("/"))) {}
	const FHaybaProviderInfo* Provider = FHaybaMCPSettings::FindProvider(ProviderId);
	if (!Provider || !Provider->BaseURLDefault) return true;
	FString Standard(Provider->BaseURLDefault);
	while (Standard.RemoveFromEnd(TEXT("/"))) {}
	if (Actual.Equals(Standard, ESearchCase::IgnoreCase)) return false;
	// Older editor settings stored Anthropic's Messages route as its default.
	return !(ProviderId == TEXT("anthropic") &&
		Actual.Equals(TEXT("https://api.anthropic.com/v1/messages"), ESearchCase::IgnoreCase));
}

void FHaybaMCPAgentClient::PostConfig(const FString& UserPrompt)
{
	const FHaybaMCPSettings& Settings = FHaybaMCPSettings::Get();
	const FString Provider = Settings.SelectedProviderId;
	const FHaybaProviderInfo* Info = FHaybaMCPSettings::FindProvider(Provider);

	// Settings Save keeps user-edited values. Send those exact values to the
	// sidecar; provider defaults are only a fallback for an empty field.
	const FString Model = !TurnModelId.IsEmpty() ? TurnModelId : !Settings.Model.IsEmpty() ? Settings.Model
		: (Info && Info->DefaultModel ? FString(Info->DefaultModel) : FString());
	const FString BaseURL = !Settings.BaseURL.IsEmpty() ? Settings.BaseURL
		: (Info && Info->BaseURLDefault ? FString(Info->BaseURLDefault) : FString());

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
	if (HaybaChatEndpoint::IsCustom(Provider, BaseURL))
		Body->SetStringField(TEXT("base_url"), BaseURL);
	// Omission lets the sidecar use its provider-specific environment key.
	// An explicit empty api_key sent by other clients still suppresses that
	// fallback; never turn an absent vault value into an explicit clear.
	if (!ApiKey.IsEmpty())
	{
		Body->SetStringField(TEXT("api_key"), ApiKey);   // loopback only — never logged
	}

	const FString ConfigUrl = Settings.SidecarURL / TEXT("chat/config");

	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	ConfigRequest = Request;
	Request->SetURL(ConfigUrl);
	Request->SetVerb(TEXT("POST"));
	Request->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
	Request->SetContentAsString(JsonToString(Body));
	Request->SetTimeout(10.0f);

	// NB: never log the body — it carries the raw key.
	UE_LOG(LogHaybaAgentClient, Verbose, TEXT("POST /chat/config provider=%s (key %d bytes, not logged)"),
		*Provider, ApiKey.Len());

	TWeakPtr<FHaybaMCPAgentClient> WeakSelf = AsShared();
	const FString CapturedPrompt = UserPrompt;
	const uint32 CapturedTurn = TurnGeneration;
	const uint64 CapturedConfig = ConfigGate.Generation;
	Request->OnProcessRequestComplete().BindLambda(
		[WeakSelf, CapturedPrompt, CapturedTurn, CapturedConfig](FHttpRequestPtr /*Req*/, FHttpResponsePtr Response, bool bConnected)
		{
			TSharedPtr<FHaybaMCPAgentClient> Self = WeakSelf.Pin();
			// Both the Pro pre-stream turn and config handoff must still be live.
			if (!Self.IsValid() || !Self->IsTurnCurrent(CapturedTurn)) return;
			if (!Self->ConfigGate.Complete(CapturedConfig)) return;
			Self->ConfigRequest.Reset();

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
			Self->StartStream(CapturedPrompt);
		});

	if (!Request->ProcessRequest() && IsTurnCurrent(CapturedTurn) && ConfigGate.Complete(CapturedConfig))
	{
		ConfigRequest.Reset();
		OnError.Broadcast(FHaybaChatError{
			TEXT("Could not start chat configuration request."), TEXT("transport") });
		EmitLocalDone(TEXT("error"), /*cancelled*/ false);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2 — POST /chat/stream and consume the SSE body incrementally
// ─────────────────────────────────────────────────────────────────────────────
void FHaybaMCPAgentClient::StartStream(const FString& UserPrompt)
{
	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = CreateStreamRequest(UserPrompt);
	TWeakPtr<FHaybaMCPAgentClient> WeakSelf = AsShared();
	const uint32 Generation = TurnGeneration;
	AfterHttpTick([WeakSelf, Request, Generation]()
	{
		TSharedPtr<FHaybaMCPAgentClient> Self = WeakSelf.Pin();
		if (!Self.IsValid() || Self->TurnGeneration != Generation || !Self->bStreaming ||
			Self->StreamRequest.Get() != &Request.Get()) return;
		if (!Request->ProcessRequest() && Self->bStreaming &&
			Self->StreamRequest.Get() == &Request.Get())
		{
			Self->StreamRequest.Reset();
			Self->bStreaming = false;
			Self->OnError.Broadcast(FHaybaChatError{
				TEXT("Could not start chat stream request."), TEXT("transport") });
			Self->EmitLocalDone(TEXT("error"), /*cancelled*/ false);
		}
	});
}

bool FHaybaMCPAgentClient::AdoptSavedSession(const FString& InSessionId)
{
	if (IsTurnActive() || ConfigGate.IsPending() || InSessionId.IsEmpty() || InSessionId.Len() > 128) return false;
	for (TCHAR Character : InSessionId)
	{
		if (!FChar::IsAlnum(Character) && Character != TEXT('_') && Character != TEXT('-')) return false;
	}
	SessionId = InSessionId;
	bForceCommunityThisChat = false;
	StreamActivityIds.Reset();
	return true;
}

TSharedRef<IHttpRequest, ESPMode::ThreadSafe> FHaybaMCPAgentClient::CreateStreamRequest(const FString& UserPrompt)
{
	const FHaybaMCPSettings& Settings = FHaybaMCPSettings::Get();
	const FString StreamUrl = Settings.SidecarURL / TEXT("chat/stream");

	// Reset per-turn parse state.
	ParseCursor = 0;
	AccumulatedText.Empty();
	bApprovalPauseSeen = false;
	ApprovalActivityId.Empty();
	// An approval resume may fail before its first semantic frame. Keep its
	// unresolved identity across requests so that loss can still mark it Unknown.
	bStreaming = true;
	bTurnPending = false;   // the pre-stream phase of this turn is over

	TSharedRef<FJsonObject> Body = MakeShared<FJsonObject>();
	Body->SetStringField(TEXT("session_id"), SessionId);
	Body->SetStringField(TEXT("prompt"), UserPrompt);
	Body->SetStringField(TEXT("mode"), WorkMode);
	if (!TurnModelId.IsEmpty()) Body->SetStringField(TEXT("model"), TurnModelId);
	const bool bPro = Settings.bUseHaybaPro && !bForceCommunityThisChat;
	Body->SetStringField(TEXT("loop"), bPro ? TEXT("pro") : TEXT("community"));
	if (!bPro && !TurnReasoningEffort.IsEmpty())
		Body->SetStringField(TEXT("reasoning_effort"), TurnReasoningEffort);
	if (bPro)
	{
		Body->SetStringField(TEXT("llm"), Settings.BrainLlmMode);
	}
	bCurrentTurnPro = bPro;
	// provider/model/key already registered via /chat/config for this session.

	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(StreamUrl);
	Request->SetVerb(TEXT("POST"));
	Request->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
	Request->SetHeader(TEXT("Accept"), TEXT("text/event-stream"));
	Request->SetContentAsString(JsonToString(Body));
	StreamRequest = Request;

	TWeakPtr<FHaybaMCPAgentClient> WeakSelf = AsShared();

	// Progressive body access: OnRequestProgress64 fires as bytes arrive. The
	// response's GetContentAsString() returns the whole body received so far, so
	// we track a parse cursor and pull out only newly-completed `\n\n` frames.
	Request->OnRequestProgress64().BindLambda(
		[WeakSelf](FHttpRequestPtr Req, uint64 /*BytesSent*/, uint64 /*BytesReceived*/)
		{
			TSharedPtr<FHaybaMCPAgentClient> Self = WeakSelf.Pin();
			if (!Self.IsValid() || !Req.IsValid()) return;
			FHttpResponsePtr Response = Req->GetResponse();
			if (!Response.IsValid()) return;
			Self->ParseNewFrames(Response->GetContentAsString());
		});

	Request->OnProcessRequestComplete().BindLambda(
		[WeakSelf](FHttpRequestPtr /*Req*/, FHttpResponsePtr Response, bool bConnected)
		{
			TSharedPtr<FHaybaMCPAgentClient> Self = WeakSelf.Pin();
			if (!Self.IsValid()) return;
			Self->bStreaming = false;

			// Every end of a Pro stream request (server done, approval pause,
			// transport drop) collects a rotated refresh token, if any.
			if (Self->bCurrentTurnPro)
			{
				Self->StoreRotatedBrainToken();
			}

			// Drain any frames that arrived between the last progress tick and
			// completion (a small tail can land in one shot).
			if (Response.IsValid())
			{
				Self->ParseNewFrames(Response->GetContentAsString());
			}

			// A rejected JSON request is not an empty successful SSE turn. Preserve
			// the sidecar's bounded error message so the composer can show the cause.
			if (Response.IsValid() && Response->GetResponseCode() != 200 && !Self->bTerminalEmitted)
			{
				FString Message = FString::Printf(TEXT("Chat request failed (HTTP %d)."), Response->GetResponseCode());
				if (Response->GetContent().Num() <= 16 * 1024)
				{
					TSharedPtr<FJsonObject> Failure;
					FString Detail;
					if (FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Response->GetContentAsString()), Failure) &&
						Failure.IsValid() && Failure->TryGetStringField(TEXT("error"), Detail) && Detail.Len() <= 400)
						Message += TEXT(" ") + Detail;
				}
				Self->OnError.Broadcast(FHaybaChatError{Message, TEXT("request")});
				Self->EmitLocalDone(TEXT("error"), /*cancelled*/ false);
			}

			// A server `done` already notified Chat. An approval pause without
			// `done` remains parked for the explicit human decision. A semantic
			// activity result alone is not a Chat terminal notification.
			if (Self->bTerminalEmitted || Self->bApprovalPauseSeen)
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
				// A successful HTTP response is not proof that the agent finished.
				// Preserve any partial text, but surface the missing terminal frame so
				// Chat can offer recovery instead of presenting a truncated answer as
				// a completed turn.
				Self->OnError.Broadcast(FHaybaChatError{
					TEXT("Chat stream ended before completion. Your partial reply was kept; retry the request."),
					TEXT("protocol") });
				Self->EmitLocalDone(TEXT("error"), /*cancelled*/ false);
			}
			Self->StreamRequest.Reset();
		});

	UE_LOG(LogHaybaAgentClient, Verbose, TEXT("POST /chat/stream session=%s"), *SessionId);
	return Request;
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
		int32 Boundary = FullBody.Find(
			TEXT("\n\n"), ESearchCase::CaseSensitive, ESearchDir::FromStart, ParseCursor);
		const int32 CRLFBoundary = FullBody.Find(
			TEXT("\r\n\r\n"), ESearchCase::CaseSensitive, ESearchDir::FromStart, ParseCursor);
		int32 SeparatorLength = 2;
		if (CRLFBoundary != INDEX_NONE && (Boundary == INDEX_NONE || CRLFBoundary < Boundary))
		{
			Boundary = CRLFBoundary;
			SeparatorLength = 4;
		}
		if (Boundary == INDEX_NONE)
		{
			break; // remainder is a partial frame; wait for more
		}
		const FString FrameBlock = FullBody.Mid(ParseCursor, Boundary - ParseCursor);
		ParseCursor = Boundary + SeparatorLength;
		DispatchFrame(FrameBlock);
	}
}

bool FHaybaMCPAgentClient::DecodeActivityEvent(const FString& EventType, const FString& Json, TSharedPtr<FJsonObject>& OutEvent)
{
	OutEvent.Reset();
	TSharedPtr<FJsonObject> Event;
	if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Json), Event) || !Event.IsValid() ||
		!FHaybaActivityModel::ValidateEvent(*Event) || Event->GetStringField(TEXT("type")) != EventType) return false;
	OutEvent = MoveTemp(Event);
	return true;
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

	// Semantic error shares the legacy event name. Once an identity/type is
	// present it must pass the semantic schema; never fall back to a legacy error.
	const bool bSemantic = EventType == TEXT("message_delta") || EventType == TEXT("activity_started") ||
		EventType == TEXT("activity_step") || EventType == TEXT("approval_requested") ||
		EventType == TEXT("artifact_proposed") || EventType == TEXT("verdict_emitted") ||
		EventType == TEXT("activity_completed") ||
		(EventType == TEXT("error") && Data.IsValid() && (Data->HasField(TEXT("activityId")) || Data->HasField(TEXT("type"))));
	if (bSemantic)
	{
		TSharedPtr<FJsonObject> Event;
		if (!DecodeActivityEvent(EventType, DataStr, Event)) return;
		FHaybaMCPModule* Module = FModuleManager::GetModulePtr<FHaybaMCPModule>(TEXT("HaybaMCPToolkit"));
		if (!Module || !Module->GetActivityModel().ApplyEvent(*Event)) return;
		const FString ActivityId = Event->GetStringField(TEXT("activityId"));
		if (EventType == TEXT("activity_completed") || EventType == TEXT("error"))
			StreamActivityIds.Remove(ActivityId);
		else
			StreamActivityIds.Add(ActivityId);
		// An approval can park the request; activity completion/error only
		// updates the activity model. Chat still needs a `done` or EOF fallback.
		if (EventType == TEXT("approval_requested"))
		{
			bApprovalPauseSeen = true;
			ApprovalActivityId = ActivityId;
		}
		else if ((EventType == TEXT("activity_completed") || EventType == TEXT("error")) &&
			ActivityId == ApprovalActivityId)
		{
			bApprovalPauseSeen = false;
			ApprovalActivityId.Empty();
		}
		OnActivityEvent.Broadcast(*Event);
		return;
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
		if (bTerminalEmitted) return;
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
			Data->TryGetBoolField(TEXT("warning_overflow"), Done.bWarningOverflow);
			const TArray<TSharedPtr<FJsonValue>>* WarningIds = nullptr;
			if (Data->TryGetArrayField(TEXT("pending_warning_ids"), WarningIds) && WarningIds)
			{
				// The server caps the list at 64. Keep the native boundary
				// independently bounded if a malformed sidecar sends more.
				for (int32 Index = 0; Index < FMath::Min(WarningIds->Num(), 256); ++Index)
				{
					const TSharedPtr<FJsonValue>& Value = (*WarningIds)[Index];
					if (!Value.IsValid() || Value->Type != EJson::String) continue;
					const FString Id = Value->AsString();
					if (!IsSafeWarningId(Id) || Done.PendingWarningIds.Contains(Id)) continue;
					if (Done.PendingWarningIds.Num() >= 64)
					{
						Done.bPendingWarningIdsTruncated = true;
						break;
					}
					Done.PendingWarningIds.Add(Id);
				}
				if (WarningIds->Num() > 256) Done.bPendingWarningIdsTruncated = true;
			}
			const TArray<TSharedPtr<FJsonValue>>* Reviews = nullptr;
			if (Data->TryGetArrayField(TEXT("warning_reviews"), Reviews) && Reviews)
			{
				TArray<FString> SeenIds;
				for (int32 Index = 0; Index < FMath::Min(Reviews->Num(), 256); ++Index)
				{
					const TSharedPtr<FJsonValue>& Value = (*Reviews)[Index];
					if (!Value.IsValid() || Value->Type != EJson::Object) continue;
					const TSharedPtr<FJsonObject> Review = Value->AsObject();
					if (!Review.IsValid()) continue;
					FString Id;
					FString Status;
					if (!Review->TryGetStringField(TEXT("id"), Id) || !IsSafeWarningId(Id) ||
						!Review->TryGetStringField(TEXT("status"), Status) || SeenIds.Contains(Id)) continue;
					if (Status != TEXT("pending") && Status != TEXT("acknowledged") && Status != TEXT("deferred")) continue;
					if (SeenIds.Num() >= 64)
					{
						Done.bWarningReviewsTruncated = true;
						break;
					}
					SeenIds.Add(Id);
					if (Status == TEXT("pending")) ++Done.PendingWarningReviewCount;
					else if (Status == TEXT("acknowledged")) ++Done.AcknowledgedWarningReviewCount;
					else ++Done.DeferredWarningReviewCount;
				}
				if (Reviews->Num() > 256) Done.bWarningReviewsTruncated = true;
			}
		}
		bApprovalPauseSeen = false;
		ApprovalActivityId.Empty();
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
		if (Err.Error == TEXT("resume_gap")) MarkActivitiesDisconnected();
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

	TWeakPtr<FHaybaMCPAgentClient> WeakSelf = AsShared();
	Request->OnProcessRequestComplete().BindLambda(
		[WeakSelf](FHttpRequestPtr /*Req*/, FHttpResponsePtr Response, bool bConnected)
		{
			TSharedPtr<FHaybaMCPAgentClient> Self = WeakSelf.Pin();
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
			// The Community gate fingerprints the whole original request. Replay
			// that prompt to match it; the sidecar uses its stored transcript while
			// approvedCall is present, so it does not append a duplicate user turn.
			// Pro resumes its parked remote turn with an empty prompt.
			Self->bTerminalEmitted = false;
			Self->bApprovalPauseSeen = false;
			Self->ApprovalActivityId.Empty();
			Self->StartStream(Self->bCurrentTurnPro ? FString() : Self->TurnPrompt);
		});

	UE_LOG(LogHaybaAgentClient, Verbose, TEXT("POST /chat/approve session=%s"), *SessionId);
	Request->ProcessRequest();
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3 — Cancel: abort server-side loop + local request, emit local done
// ─────────────────────────────────────────────────────────────────────────────
void FHaybaMCPAgentClient::Cancel()
{
	// Stop during the pre-stream round-trips (/brain/status, /brain/config,
	// /chat/config): no server turn exists yet. Invalidate both generations
	// and cancel a pending config request before it can launch a stream.
	if ((bTurnPending || ConfigGate.IsPending()) && !bStreaming)
	{
		bTurnPending = false;
		++TurnGeneration;
		ConfigGate.Cancel();
		if (IdentityRequest.IsValid())
		{
			IdentityRequest->OnProcessRequestComplete().Unbind();
			IdentityRequest->CancelRequest();
			IdentityRequest.Reset();
		}
		if (ConfigRequest.IsValid())
		{
			ConfigRequest->OnProcessRequestComplete().Unbind();
			ConfigRequest->CancelRequest();
			ConfigRequest.Reset();
		}
		if (bCurrentTurnPro)
		{
			StoreRotatedBrainToken();
		}
		EmitLocalDone(TEXT("cancelled"), /*cancelled*/ true);
		return;
	}
	if (!bStreaming && !StreamRequest.IsValid())
	{
		return;
	}

	// Tell the sidecar to abort the server-side loop (fire-and-forget). Without
	// this the turn keeps running server-side even after we drop the socket.
	PostCancel();

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

	// The completion callback (which collects rotations) was unbound above.
	if (bCurrentTurnPro)
	{
		StoreRotatedBrainToken();
	}

	// Fire our own terminal done carrying the partial text streamed so far.
	EmitLocalDone(TEXT("cancelled"), /*cancelled*/ true);
}

// Fire-and-forget POST /chat/cancel with {session_id}. Shared by Cancel() (mid-
// stream abort) and AbortServerTurn() (parked-turn abort on plan reject).
void FHaybaMCPAgentClient::PostCancel()
{
	if (SessionId.IsEmpty())
	{
		return;
	}

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

// Abort a parked server-side turn (plan reject). The plan_request stream has
// already closed, so Cancel()'s early-return would skip the server notification.
// This fires POST /chat/cancel independent of local stream state and emits no
// local done (the UI already finalized the bubble as [rejected]).
void FHaybaMCPAgentClient::AbortServerTurn()
{
	PostCancel();
}

void FHaybaMCPAgentClient::EmitLocalDone(const FString& Reason, bool bCancelled)
{
	bTurnPending = false;   // a terminated turn has no pending continuation
	if (bTerminalEmitted)
	{
		return;
	}
	// Local completion/cancel only describes the HTTP request. It cannot confirm
	// whether a server-side operation committed; wait for a semantic result.
	MarkActivitiesDisconnected();
	bApprovalPauseSeen = false;
	ApprovalActivityId.Empty();
	bTerminalEmitted = true;
	FHaybaChatDone Done;
	Done.Reason = Reason;
	Done.AssistantText = AccumulatedText;
	Done.bCancelled = bCancelled;
	OnDone.Broadcast(Done);
}

void FHaybaMCPAgentClient::MarkActivitiesDisconnected()
{
	if (FHaybaMCPModule* Module = FModuleManager::GetModulePtr<FHaybaMCPModule>(TEXT("HaybaMCPToolkit")))
	{
		for (const FString& ActivityId : StreamActivityIds)
			Module->GetActivityModel().MarkDisconnected(ActivityId);
	}
}
