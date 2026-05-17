#pragma once
#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

struct FHaybaHandlerResult
{
    bool bOk = true;
    TSharedPtr<FJsonObject> Data;   // populated when bOk=true
    FString ErrorMessage;           // populated when bOk=false

    static FHaybaHandlerResult Ok(TSharedPtr<FJsonObject> InData)
    {
        FHaybaHandlerResult R;
        R.bOk = true;
        R.Data = InData;
        return R;
    }

    static FHaybaHandlerResult Err(const FString& Msg)
    {
        FHaybaHandlerResult R;
        R.bOk = false;
        R.ErrorMessage = Msg;
        return R;
    }
};

class IHaybaMCPHandler
{
public:
    virtual ~IHaybaMCPHandler() = default;

    /** Domain prefix, e.g. "actor", "scene", "pcg", "legacy". */
    virtual FString GetDomain() const = 0;

    /** All commands this handler dispatches. */
    virtual TArray<FString> GetCommands() const = 0;

    /**
     * Dispatch a command. Returns a FHaybaHandlerResult containing either
     * the payload data object (on success) or an error message (on failure).
     * The router (FHaybaMCPCommandHandler) is responsible for building the
     * {id, ok, data} envelope.
     */
    virtual FHaybaHandlerResult Handle(const FString& Command,
                                       const TSharedPtr<FJsonObject>& Params) = 0;
};
