#include "PCGExClaudeClient.h"
#include "HttpModule.h"
#include "Interfaces/IHttpResponse.h"
#include "Json.h"

void FPCGExClaudeClient::SendMessage(
	const FString& SystemPrompt,
	const FString& UserMessage,
	const FString& ApiKey,
	const FString& Model,
	FOnClaudeResponse OnComplete)
{
	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(TEXT("https://api.anthropic.com/v1/messages"));
	Request->SetVerb(TEXT("POST"));
	Request->SetHeader(TEXT("content-type"), TEXT("application/json"));
	Request->SetHeader(TEXT("x-api-key"), ApiKey);
	Request->SetHeader(TEXT("anthropic-version"), TEXT("2023-06-01"));
	Request->SetContentAsString(BuildRequestBody(SystemPrompt, UserMessage, Model));

	Request->OnProcessRequestComplete().BindLambda(
		[OnComplete](FHttpRequestPtr /*Req*/, FHttpResponsePtr Response, bool bConnected)
		{
			if (!bConnected || !Response.IsValid())
			{
				OnComplete.ExecuteIfBound(false, TEXT("Network error: could not reach api.anthropic.com"));
				return;
			}

			const int32 Code = Response->GetResponseCode();
			const FString Body = Response->GetContentAsString();

			if (Code == 401)
			{
				OnComplete.ExecuteIfBound(false, TEXT("Invalid API key. Click ⚙ Settings and check your Anthropic API key."));
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
					FString::Printf(TEXT("Claude API error %d: %s"), Code, *Body.Left(200)));
				return;
			}

			const FString Reply = ExtractReplyText(Body);
			OnComplete.ExecuteIfBound(!Reply.IsEmpty(), Reply.IsEmpty()
				? TEXT("Unexpected response format from Claude.") : Reply);
		}
	);

	Request->ProcessRequest();
}

FString FPCGExClaudeClient::BuildRequestBody(
	const FString& SystemPrompt,
	const FString& UserMessage,
	const FString& Model)
{
	TSharedPtr<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetStringField(TEXT("model"), Model);
	Root->SetNumberField(TEXT("max_tokens"), 4096);
	Root->SetStringField(TEXT("system"), SystemPrompt);

	TArray<TSharedPtr<FJsonValue>> Messages;
	TSharedPtr<FJsonObject> UserMsg = MakeShared<FJsonObject>();
	UserMsg->SetStringField(TEXT("role"), TEXT("user"));
	UserMsg->SetStringField(TEXT("content"), UserMessage);
	Messages.Add(MakeShared<FJsonValueObject>(UserMsg));
	Root->SetArrayField(TEXT("messages"), Messages);

	FString Out;
	TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Out);
	FJsonSerializer::Serialize(Root.ToSharedRef(), Writer);
	return Out;
}

FString FPCGExClaudeClient::ExtractReplyText(const FString& ResponseJson)
{
	TSharedPtr<FJsonObject> Root;
	TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(ResponseJson);
	if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid()) return TEXT("");

	const TArray<TSharedPtr<FJsonValue>>* Content;
	if (!Root->TryGetArrayField(TEXT("content"), Content) || Content->IsEmpty()) return TEXT("");

	const TSharedPtr<FJsonObject>* Block;
	if (!(*Content)[0]->TryGetObject(Block)) return TEXT("");

	FString Text;
	(*Block)->TryGetStringField(TEXT("text"), Text);
	return Text;
}
