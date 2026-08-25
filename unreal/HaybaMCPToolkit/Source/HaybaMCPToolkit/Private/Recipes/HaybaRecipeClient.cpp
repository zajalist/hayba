// HaybaRecipeClient.cpp
#include "Recipes/HaybaRecipeClient.h"

#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"

void FHaybaRecipeClient::RunRecipe(
    const FString& BaseUrl,
    const FString& Id,
    const FString& ParamsJson,
    FHaybaRecipeRunCallback OnDone)
{
    const FString Url = BaseUrl + TEXT("/recipe/run");
    const FString Body = FString::Printf(TEXT("{\"id\":\"%s\",\"params\":%s}"), *Id, *ParamsJson);

    const TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Req = FHttpModule::Get().CreateRequest();
    Req->SetVerb(TEXT("POST"));
    Req->SetURL(Url);
    Req->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
    Req->SetContentAsString(Body);

    Req->OnProcessRequestComplete().BindLambda(
        [OnDone](FHttpRequestPtr, FHttpResponsePtr Resp, bool bSucceeded)
        {
            if (!bSucceeded || !Resp.IsValid())
            { OnDone.ExecuteIfBound(false, TEXT("HTTP request failed")); return; }
            const int32 Code = Resp->GetResponseCode();
            const FString Content = Resp->GetContentAsString();
            OnDone.ExecuteIfBound(Code >= 200 && Code < 300, Content);
        });
    Req->ProcessRequest();
}
