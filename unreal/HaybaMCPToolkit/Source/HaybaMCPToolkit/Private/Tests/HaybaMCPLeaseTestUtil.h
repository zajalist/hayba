#pragma once

#include "CoreMinimal.h"

#if WITH_DEV_AUTOMATION_TESTS

#include "Dom/JsonObject.h"
#include "HAL/CriticalSection.h"
#include "Misc/Guid.h"
#include "Misc/OutputDevice.h"
#include "Misc/OutputDeviceRedirector.h"
#include "Misc/ScopeLock.h"
#include "Modules/ModuleManager.h"
#include "Policies/CondensedJsonPrintPolicy.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "HaybaMCPCommandHandler.h"
#include "HaybaMCPLeaseManager.h"
#include "HaybaMCPModule.h"

/** Shared helpers for the router-level lease tests (T6-T9). */
namespace HaybaMCPLeaseTest
{
	/** Starts a test with nobody present and leaves nobody present behind it.
	 *  Earlier router tests name owners on fake connections that never close, so
	 *  in a single-process run those owners would stay "connected" for good. A
	 *  test that sends an owner-less write (owner_required needs other owners to
	 *  be present), or that asserts who other_owners names, declares one first. */
	struct FScopedCleanPresence
	{
		FScopedCleanPresence() { FHaybaMCPLeaseManager::Get().ResetPresenceForTests(); }
		~FScopedCleanPresence() { FHaybaMCPLeaseManager::Get().ResetPresenceForTests(); }
	};

	/** Captures one log category while alive. */
	class FLogCapture : public FOutputDevice
	{
	public:
		explicit FLogCapture(const TCHAR* InCategory)
			: Category(InCategory)
		{
			GLog->AddOutputDevice(this);
			// UE 5.7+ replays the backlog into a new device; start clean.
			FScopeLock Lock(&Mutex);
			Lines.Reset();
			Verbosities.Reset();
		}

		virtual ~FLogCapture() override
		{
			GLog->RemoveOutputDevice(this);
		}

		virtual bool CanBeUsedOnAnyThread() const override { return true; }

		virtual void Serialize(const TCHAR* V, ELogVerbosity::Type Verbosity, const FName& InCategory) override
		{
			if (InCategory != Category) return;
			FScopeLock Lock(&Mutex);
			Lines.Add(FString(V));
			Verbosities.Add(static_cast<ELogVerbosity::Type>(Verbosity & ELogVerbosity::VerbosityMask));
		}

		void Flush()
		{
			GLog->FlushThreadedLogs();
		}

		/** Lines containing Needle; All counts every verbosity. */
		int32 Count(const FString& Needle, ELogVerbosity::Type Verbosity = ELogVerbosity::All)
		{
			FScopeLock Lock(&Mutex);
			int32 N = 0;
			for (int32 I = 0; I < Lines.Num(); ++I)
			{
				if ((Verbosity == ELogVerbosity::All || Verbosities[I] == Verbosity) && Lines[I].Contains(Needle))
				{
					++N;
				}
			}
			return N;
		}

	private:
		FName Category;
		FCriticalSection Mutex;
		TArray<FString> Lines;
		TArray<ELogVerbosity::Type> Verbosities;
	};

	inline TSharedPtr<FHaybaMCPCommandHandler> Router()
	{
		FHaybaMCPModule* Module = FModuleManager::GetModulePtr<FHaybaMCPModule>(TEXT("HaybaMCPToolkit"));
		return Module ? Module->GetCommandHandler() : nullptr;
	}

	/** hayba-test-<role>-<guid8>: never collides with a real agent or another test. */
	inline FString UniqueOwner(const TCHAR* Role)
	{
		return FString::Printf(TEXT("hayba-test-%s-%s"), Role,
			*FGuid::NewGuid().ToString(EGuidFormats::Digits).Left(8).ToLower());
	}

	inline TSharedPtr<FJsonObject> Json(const FString& Text)
	{
		TSharedPtr<FJsonObject> Out;
		FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Out);
		return Out.IsValid() ? Out : TSharedPtr<FJsonObject>(MakeShared<FJsonObject>());
	}

	/** One wire envelope as JSON. Owner and lease are omitted when empty. */
	inline FString Envelope(const FString& Owner, const FString& Cmd,
		const TSharedPtr<FJsonObject>& Params, const FString& Lease = FString())
	{
		TSharedRef<FJsonObject> Env = MakeShared<FJsonObject>();
		Env->SetStringField(TEXT("id"), TEXT("t-") + FGuid::NewGuid().ToString(EGuidFormats::Digits).Left(8));
		Env->SetStringField(TEXT("cmd"), Cmd);
		Env->SetObjectField(TEXT("params"), Params.IsValid() ? Params.ToSharedRef() : MakeShared<FJsonObject>());
		if (!Owner.IsEmpty()) Env->SetStringField(TEXT("owner"), Owner);
		if (!Lease.IsEmpty()) Env->SetStringField(TEXT("lease"), Lease);
		FString Text;
		const TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
			TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Text);
		FJsonSerializer::Serialize(Env, Writer);
		return Text;
	}

	/** Through ProcessCommand, so every reply passes JsonToString and RedactFinalEnvelope. */
	inline TSharedPtr<FJsonObject> Send(FHaybaMCPCommandHandler& Router, int32 ConnId, const FString& Owner,
		const FString& Cmd, const TSharedPtr<FJsonObject>& Params, const FString& Lease = FString())
	{
		return Json(Router.ProcessCommand(Envelope(Owner, Cmd, Params, Lease), ConnId));
	}

	inline FString CodeOf(const TSharedPtr<FJsonObject>& Reply)
	{
		FString Code;
		if (Reply.IsValid()) Reply->TryGetStringField(TEXT("code"), Code);
		return Code;
	}

	inline TSharedPtr<FJsonObject> DataOf(const TSharedPtr<FJsonObject>& Reply)
	{
		const TSharedPtr<FJsonObject>* Data = nullptr;
		return Reply.IsValid() && Reply->TryGetObjectField(TEXT("data"), Data) && Data ? *Data : TSharedPtr<FJsonObject>(MakeShared<FJsonObject>());
	}

	/** lease_acquire through the router; the granted lease_id, or empty. */
	inline FString AcquireId(FHaybaMCPCommandHandler& Router, int32 ConnId, const FString& Owner, const FString& ParamsJson)
	{
		FString Id;
		DataOf(Send(Router, ConnId, Owner, TEXT("lease_acquire"), Json(ParamsJson)))->TryGetStringField(TEXT("lease_id"), Id);
		return Id;
	}
}

#endif // WITH_DEV_AUTOMATION_TESTS
