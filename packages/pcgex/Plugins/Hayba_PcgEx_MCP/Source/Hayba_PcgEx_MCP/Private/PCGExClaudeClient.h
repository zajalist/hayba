#pragma once
#include "CoreMinimal.h"
#include "Interfaces/IHttpRequest.h"

DECLARE_DELEGATE_TwoParams(FOnClaudeResponse, bool /*bSuccess*/, const FString& /*ReplyText*/);

/** Thin wrapper around the Claude Messages API (non-streaming). */
class FPCGExClaudeClient
{
public:
	/**
	 * Send a chat turn to Claude and receive the assistant reply via callback.
	 * @param SystemPrompt  Context/instructions for the assistant.
	 * @param UserMessage   The user's turn text.
	 * @param ApiKey        Anthropic API key.
	 * @param Model         Model ID e.g. "claude-opus-4-6-20251101".
	 * @param OnComplete    Called on the game thread with success flag and reply text.
	 */
	static void SendMessage(
		const FString& SystemPrompt,
		const FString& UserMessage,
		const FString& ApiKey,
		const FString& Model,
		FOnClaudeResponse OnComplete
	);

private:
	static FString BuildRequestBody(
		const FString& SystemPrompt,
		const FString& UserMessage,
		const FString& Model
	);

	static FString ExtractReplyText(const FString& ResponseJson);
};
