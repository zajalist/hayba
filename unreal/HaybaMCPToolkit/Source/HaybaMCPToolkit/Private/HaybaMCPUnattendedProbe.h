#pragma once

#include "CoreMinimal.h"

// Test seam for R-3. Headless automation runs with -unattended, where
// FMessageDialog never opens a modal, so a missing unattended guard at a save
// or Python site would pass unnoticed. Each such site reports here whether
// unattended mode was in effect; tests assert it. Compiles to nothing outside
// WITH_DEV_AUTOMATION_TESTS.
#if WITH_DEV_AUTOMATION_TESTS
namespace HaybaMCPUnattendedProbe
{
	struct FRecord
	{
		FString Site;
		bool bUnattended = false;
	};

	inline TArray<FRecord>*& ActiveRecords()
	{
		static TArray<FRecord>* Records = nullptr;
		return Records;
	}

	inline void Note(const TCHAR* Site, bool bUnattended)
	{
		if (TArray<FRecord>* Records = ActiveRecords())
		{
			Records->Add({ FString(Site), bUnattended });
		}
	}

	/** Records every probe hit while alive (game thread only; nests). */
	class FScopedRecorder
	{
	public:
		FScopedRecorder() : Previous(ActiveRecords()) { ActiveRecords() = &Records; }
		~FScopedRecorder() { ActiveRecords() = Previous; }
		TArray<FRecord> Records;

	private:
		TArray<FRecord>* Previous;
	};
}
#define HAYBA_UNATTENDED_PROBE(Site, bUnattended) HaybaMCPUnattendedProbe::Note(TEXT(Site), (bUnattended))
#else
#define HAYBA_UNATTENDED_PROBE(Site, bUnattended)
#endif
