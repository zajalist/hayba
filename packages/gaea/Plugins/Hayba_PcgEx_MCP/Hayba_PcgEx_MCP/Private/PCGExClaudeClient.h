#pragma once
#include "CoreMinimal.h"
#include "Interfaces/IHttpRequest.h"

DECLARE_DELEGATE_TwoParams(FOnClaudeResponse, bool /*bSuccess*/, const FString& /*ReplyText*/);

/** HTTP client for AI chat — supports Anthropic and OpenAI-compatible endpoints. */
class FPCGExClaudeClient
{
public:
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
		const FString& Model,
		bool bIsAnthropic
	);

	static FString ExtractReplyText(const FString& ResponseJson, bool bIsAnthropic);
};
