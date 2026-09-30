// HaybaMCPLeaseHandler.h - multi-agent leases (lease_acquire / renew / release / status).
//
// A thin command facade over FHaybaMCPLeaseManager's pure table. Nothing here
// blocks: lease_acquire answers granted (lease_id) or queued (ticket,
// position, holder, ETA) and the caller polls with its ticket. The handle is
// never named `token` on output: both redaction layers erase values under
// secret-shaped keys (docs/adr/0010, "Lease ids").

#pragma once
#include "IHaybaMCPHandler.h"

class FHaybaMCPLeaseHandler : public IHaybaMCPHandler
{
public:
	virtual FString GetDomain() const override { return TEXT("lease"); }
	virtual TArray<FString> GetCommands() const override;
	virtual FHaybaHandlerResult Handle(const FString& Command, const TSharedPtr<FJsonObject>& Params) override;

private:
	FHaybaHandlerResult Acquire(const TSharedPtr<FJsonObject>& Params);
	FHaybaHandlerResult Renew(const TSharedPtr<FJsonObject>& Params);
	FHaybaHandlerResult Release(const TSharedPtr<FJsonObject>& Params);
	FHaybaHandlerResult Status(const TSharedPtr<FJsonObject>& Params);
};
