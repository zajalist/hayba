#include "HaybaMCPClaudeClient.h"
#include "HaybaMCPSettings.h"
#include "HttpModule.h"
#include "Interfaces/IHttpResponse.h"
#include "Json.h"

void FHaybaMCPClaudeClient::SendMessage(
	const FString& SystemPrompt,
	const FString& UserMessage,
	const FString& ApiKey,
	const FString& Model,
	FOnClaudeResponse OnComplete)
{
	const FHaybaMCPSettings& Settings = FHaybaMCPSettings::Get();
	const bool bIsAnthropic = Settings.IsAnthropicEndpoint();

	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(Settings.BaseURL);
	Request->SetVerb(TEXT("POST"));
	Request->SetHeader(TEXT("Content-Type"), TEXT("application/json"));

	if (bIsAnthropic)
	{
		Request->SetHeader(TEXT("x-api-key"), ApiKey);
		Request->SetHeader(TEXT("anthropic-version"), TEXT("2023-06-01"));
	}
	else
	{
		Request->SetHeader(TEXT("Authorization"), FString::Printf(TEXT("Bearer %s"), *ApiKey));
	}

	Request->SetContentAsString(BuildRequestBody(SystemPrompt, UserMessage, Model, bIsAnthropic));

	Request->OnProcessRequestComplete().BindLambda(
		[OnComplete, bIsAnthropic](FHttpRequestPtr /*Req*/, FHttpResponsePtr Response, bool bConnected)
		{
			if (!bConnected || !Response.IsValid())
			{
				OnComplete.ExecuteIfBound(false, TEXT("Network error: could not reach the API endpoint."));
				return;
			}

			const int32 Code = Response->GetResponseCode();
			const FString Body = Response->GetContentAsString();

			if (Code == 401)
			{
				OnComplete.ExecuteIfBound(false, TEXT("Invalid API key. Open Settings (\u2699) and check your key."));
				return;
			}
			if (Code == 429)
			{
				OnComplete.ExecuteIfBound(false, TEXT("Rate limited. Please wait a moment and try again."));
				return;
			}
			if (Code != 200)
			{
				OnComplete.ExecuteIfBound(false,
					FString::Printf(TEXT("API error %d: %s"), Code, *Body.Left(300)));
				return;
			}

			const FString Reply = ExtractReplyText(Body, bIsAnthropic);
			OnComplete.ExecuteIfBound(!Reply.IsEmpty(), Reply.IsEmpty()
				? TEXT("Unexpected response format from AI endpoint.") : Reply);
		}
	);

	Request->ProcessRequest();
}

FString FHaybaMCPClaudeClient::BuildRequestBody(
	const FString& SystemPrompt,
	const FString& UserMessage,
	const FString& Model,
	bool bIsAnthropic)
{
	TSharedPtr<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetStringField(TEXT("model"), Model);
	Root->SetNumberField(TEXT("max_tokens"), 4096);

	TArray<TSharedPtr<FJsonValue>> Messages;

	if (bIsAnthropic)
	{
		// Anthropic: system at top level, messages array has user only
		Root->SetStringField(TEXT("system"), SystemPrompt);

		TSharedPtr<FJsonObject> UserMsg = MakeShared<FJsonObject>();
		UserMsg->SetStringField(TEXT("role"), TEXT("user"));
		UserMsg->SetStringField(TEXT("content"), UserMessage);
		Messages.Add(MakeShared<FJsonValueObject>(UserMsg));
	}
	else
	{
		// OpenAI-compatible: system is first message
		TSharedPtr<FJsonObject> SysMsg = MakeShared<FJsonObject>();
		SysMsg->SetStringField(TEXT("role"), TEXT("system"));
		SysMsg->SetStringField(TEXT("content"), SystemPrompt);
		Messages.Add(MakeShared<FJsonValueObject>(SysMsg));

		TSharedPtr<FJsonObject> UserMsg = MakeShared<FJsonObject>();
		UserMsg->SetStringField(TEXT("role"), TEXT("user"));
		UserMsg->SetStringField(TEXT("content"), UserMessage);
		Messages.Add(MakeShared<FJsonValueObject>(UserMsg));
	}

	Root->SetArrayField(TEXT("messages"), Messages);

	FString Out;
	TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Out);
	FJsonSerializer::Serialize(Root.ToSharedRef(), Writer);
	return Out;
}

FString FHaybaMCPClaudeClient::ExtractReplyText(const FString& ResponseJson, bool bIsAnthropic)
{
	TSharedPtr<FJsonObject> Root;
	TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(ResponseJson);
	if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid()) return TEXT("");

	if (bIsAnthropic)
	{
		// Anthropic: { "content": [{ "type": "text", "text": "..." }] }
		const TArray<TSharedPtr<FJsonValue>>* Content;
		if (!Root->TryGetArrayField(TEXT("content"), Content) || Content->IsEmpty()) return TEXT("");
		const TSharedPtr<FJsonObject>* Block;
		if (!(*Content)[0]->TryGetObject(Block)) return TEXT("");
		FString Text;
		(*Block)->TryGetStringField(TEXT("text"), Text);
		return Text;
	}
	else
	{
		// OpenAI-compatible: { "choices": [{ "message": { "content": "..." } }] }
		const TArray<TSharedPtr<FJsonValue>>* Choices;
		if (!Root->TryGetArrayField(TEXT("choices"), Choices) || Choices->IsEmpty()) return TEXT("");
		const TSharedPtr<FJsonObject>* Choice;
		if (!(*Choices)[0]->TryGetObject(Choice)) return TEXT("");
		const TSharedPtr<FJsonObject>* MsgObj;
		if (!(*Choice)->TryGetObjectField(TEXT("message"), MsgObj)) return TEXT("");
		FString Content;
		(*MsgObj)->TryGetStringField(TEXT("content"), Content);
		return Content;
	}
}
