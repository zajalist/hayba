// HaybaMCPEditorState.h - runtime editor state (docs/adr/0012).
//
// PIE hooks are bound at module startup, before the TCP server can deliver a
// request and in owned automation children too. The PIE tracker is the pure
// HaybaMCPState::FPieTracker; FHaybaPIEAuthorizer (defined in the .cpp) vetoes
// the user's Play while the editor is unsafe. Game thread only. The module
// holds no member for this: it is a function-local singleton.

#pragma once

#include "CoreMinimal.h"
#include "Delegates/IDelegateInstance.h"
#include "Dom/JsonObject.h"
#include "HaybaMCPEditorStatePolicy.h"

class FHaybaMCPEditorState
{
public:
	static FHaybaMCPEditorState& Get();

	/** Binds the six PIE delegates and registers the Play authorizer. Idempotent. */
	void Startup();
	/** Unbinds and unregisters. Idempotent. Called from ShutdownModule. */
	void Shutdown();

	bool AreHooksBound() const;
	/** Asks IModularFeatures, not a flag: true only while the authorizer is really registered. */
	bool IsAuthorizerRegistered() const;

	/** editor_start_pie calls this right before RequestPlaySession. */
	void NoteAgentPieRequest(const FString& Owner);

	/** ResolvePie over the tracker, the play world and the queued request (or the test override). */
	HaybaMCPState::FPieState CurrentPie() const;
	bool IsPieActiveOrQueued() const;
	/** pie, pie_running, pie_phase, pie_since_s, pie_simulating. */
	void WritePieJson(const TSharedRef<FJsonObject>& Out) const;

	/** The Play authorizer's whole decision for one request made at Now. Non-const:
	 *  IPIEAuthorizer's methods are const (C19), so T10.1 keeps its double-press
	 *  state on this object and fills in the build branch here. */
	HaybaMCPState::FPlayDecision EvaluateUserPlayRequest(double Now);

	/** Sessions ended since startup (one per session, however many end delegates fired). */
	int32 PieEndSerial() const { return Tracker.EndSerial(); }

#if WITH_DEV_AUTOMATION_TESTS
	/** Forces CurrentPie() for one scope; restores the previous override on exit. */
	class FScopedPieOverride
	{
	public:
		explicit FScopedPieOverride(const HaybaMCPState::FPieState& Forced);
		~FScopedPieOverride();

	private:
		TOptional<HaybaMCPState::FPieState> Previous;
	};
#endif

private:
	FHaybaMCPEditorState() = default;

	HaybaMCPState::FPieTracker Tracker;
	FDelegateHandle PreBeginHandle;
	FDelegateHandle BeginHandle;
	FDelegateHandle EndHandle;
	FDelegateHandle CancelHandle;
	FDelegateHandle ShutdownHandle;
	FDelegateHandle SwitchHandle;
	bool bStarted = false;
#if WITH_DEV_AUTOMATION_TESTS
	TOptional<HaybaMCPState::FPieState> PieOverride;
#endif
};
