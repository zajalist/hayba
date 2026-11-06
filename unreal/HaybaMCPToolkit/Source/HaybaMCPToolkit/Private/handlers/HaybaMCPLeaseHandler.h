// HaybaMCPLeaseHandler.h - multi-agent leases (lease_acquire / renew / release / status).
//
// A thin command facade over FHaybaMCPLeaseManager's pure table. Nothing here
// blocks: lease_acquire answers granted (token) or queued (ticket, position,
// holder, ETA) and the caller polls with its ticket. See docs/adr/0010.

#pragma once
#include "IHaybaMCPHandler.h"

class FHaybaMCPLeaseHandler : public IHaybaMCPHandler
{
public:
	virtual FString GetDomain() const override { return TEXT("lease"); }
	virtual TArray<FString> GetCommands() const override;
	virtual FHaybaHandlerResult Handle(const FString& Command, const TSharedPtr<FJsonObject>& Params) override;

	/**
	 * TCP thread: answer a lease_* request without queueing it behind game-thread work, so lanes can acquire,
	 * poll, renew and release while another lane's long script holds the game thread. False (not handled)
	 * for every other command, a bad frame, or a poisoned session; those take the normal game-thread path.
	 */
	static bool TryHandleOffThread(const FString& Message, int32 ConnId, FString& OutResponse);

private:
	FHaybaHandlerResult Acquire(const TSharedPtr<FJsonObject>& Params);
	FHaybaHandlerResult Renew(const TSharedPtr<FJsonObject>& Params);
	FHaybaHandlerResult Release(const TSharedPtr<FJsonObject>& Params);
	FHaybaHandlerResult Status(const TSharedPtr<FJsonObject>& Params);
};
