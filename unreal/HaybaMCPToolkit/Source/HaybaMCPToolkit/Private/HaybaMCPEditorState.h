// HaybaMCPEditorState.h - runtime editor state (docs/adr/0012).
//
// PIE hooks are bound at module startup, before the TCP server can deliver a
// request and in owned automation children too. The PIE tracker is the pure
// HaybaMCPState::FPieTracker; FHaybaPIEAuthorizer (defined in the .cpp) vetoes
// Play while the editor is unsafe or an asset build is held. Game thread only.
// The module holds no member for this: it is a function-local singleton.

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

	/** Every asset: X lock held by any owner (D5). Used by
	 *  editor_get_state.building, and by slot 3 for editor_start_pie and
	 *  editor_save_all_and_quit. Reads Hayba's own lease table only, never a
	 *  UObject, so it is safe while editor_unsafe. */
	TArray<HaybaMCPState::FBusyAsset> BuildingAssets() const;

	/** X locks on these lower-cased asset keys held by owners other than
	 *  ExcludeOwner (slot 3 for AssetBusyTargets). */
	TArray<HaybaMCPState::FBusyAsset> BusyAssetsFor(const TArray<FString>& AssetKeys, const FString& ExcludeOwner) const;

	/** Writes `building`. It is always an array, [] when nothing is built. */
	void WriteBuildingJson(const TSharedRef<FJsonObject>& Out) const;

	/** When the user's last Play was vetoed for a build (mode 1). 0 = none.
	 *  It lives here, because IPIEAuthorizer's methods are const (C19). */
	double LastUserPlayVetoAt() const;
	void NoteUserPlayVeto(double Now);
	void ClearUserPlayVeto();

	/**
	 * The authorizer's whole decision for one Play request (P0 T2 unsafe
	 * branch, T10 build branch). It reads CurrentPie() for the request's
	 * kind, FHaybaEditorHealth::IsUnsafe(), BuildingAssets() and
	 * hayba.PIEBuildVeto. It records or clears the double-press window, logs
	 * every outcome, and posts Hayba's own notification for mode 0 and for an
	 * accepted override. It never cancels the request; the engine does that
	 * on a deny.
	 */
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

	/** See LastUserPlayVetoAt(). */
	double LastUserPlayVeto = 0.0;
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
