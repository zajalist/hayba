// HaybaMCPEditorStatePolicy.h - pure editor-state policy (no GEditor, no clock).
//
// PIE is a state, not a lock (docs/adr/0012). FPieTracker follows the engine's
// PIE delegates; ResolvePie backstops a missed hook from the two engine facts
// that hold exactly while a session exists or is queued (the play world and
// the queued request). PieRuleFor decides what may run during PIE from the
// named sets in HaybaMCPCommandSets.h and fails closed: a command in no set is
// refused. Everything here is testable without an editor.

#pragma once

#include "CoreMinimal.h"
#include "HaybaMCPCommandSets.h"
#include "HaybaMCPAccessPolicy.h"
#include "HaybaMCPLeasePolicy.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"

namespace HaybaMCPState
{
	enum class EPieKind : uint8
	{
		None,
		User,
		Agent,
	};

	enum class EPiePhase : uint8
	{
		None,
		/** RequestPlaySession was called; the session starts on the next editor tick. */
		Queued,
		/** PreBeginPIE fired; the authorizers and BeginPIE have not finished. */
		Starting,
		Running,
	};

	struct FPieState
	{
		EPieKind Kind = EPieKind::None;
		EPiePhase Phase = EPiePhase::None;
		/** The agent owner of an Agent session; empty otherwise. */
		FString Owner;
		bool bSimulating = false;
		/** Clock seconds when the session was first seen. */
		double Since = 0.0;
	};

	inline FString LexPie(const FPieState& S)
	{
		switch (S.Kind)
		{
		case EPieKind::User:  return TEXT("user");
		case EPieKind::Agent: return FString::Printf(TEXT("agent:%s"), *S.Owner);
		default:              return TEXT("none");
		}
	}

	inline const TCHAR* LexPiePhase(EPiePhase P)
	{
		switch (P)
		{
		case EPiePhase::Queued:   return TEXT("queued");
		case EPiePhase::Starting: return TEXT("starting");
		case EPiePhase::Running:  return TEXT("running");
		default:                  return TEXT("none");
		}
	}

	/** A session is the agent's when its editor_start_pie came this recently. */
	constexpr double AgentAttributionWindowSeconds = 5.0;

	class FPieTracker
	{
	public:
		void NoteAgentRequest(const FString& Owner, double Now)
		{
			bPendingAgent = true;
			PendingOwner = Owner;
			PendingAt = Now;
		}

		/** An agent's editor_start_pie recent enough to claim the next session. */
		bool HasPendingAgentRequest(double Now) const
		{
			return bPendingAgent && Now - PendingAt <= AgentAttributionWindowSeconds;
		}

		const FString& PendingAgentOwner() const { return PendingOwner; }

		void OnPreBegin(bool bSimulating, double Now)
		{
			const bool bAgent = HasPendingAgentRequest(Now);
			Current = FPieState();
			Current.Kind = bAgent ? EPieKind::Agent : EPieKind::User;
			Current.Owner = bAgent ? PendingOwner : FString();
			Current.Phase = EPiePhase::Starting;
			Current.bSimulating = bSimulating;
			Current.Since = Now;
			ClearPending();
		}

		void OnBegin(bool bSimulating, double Now)
		{
			if (Current.Kind == EPieKind::None)
			{
				OnPreBegin(bSimulating, Now);   // a missed PreBeginPIE
			}
			Current.Phase = EPiePhase::Running;
			Current.bSimulating = bSimulating;
		}

		void OnSwitchSimulate(bool bSimulating)
		{
			if (Current.Kind != EPieKind::None)
			{
				Current.bSimulating = bSimulating;
			}
		}

		/**
		 * EndPIE, CancelPIE and ShutdownPIE. The engine can send two of them for
		 * one session (EndPIE then CancelPIE when the errored-Blueprint dialog is
		 * refused, PlayLevel.cpp:2671-2674), so only the first end of a session
		 * counts. A cancelled queued request (no session yet) only drops the
		 * pending attribution.
		 */
		void OnEnd(double /*Now*/)
		{
			ClearPending();
			if (Current.Kind == EPieKind::None)
			{
				return;
			}
			Current = FPieState();
			++EndSerialValue;
		}

		const FPieState& State() const { return Current; }
		int32 EndSerial() const { return EndSerialValue; }

	private:
		void ClearPending()
		{
			bPendingAgent = false;
			PendingOwner.Reset();
			PendingAt = 0.0;
		}

		FPieState Current;
		bool bPendingAgent = false;
		FString PendingOwner;
		double PendingAt = 0.0;
		int32 EndSerialValue = 0;
	};

	/**
	 * The session as it is now: the tracker, backstopped by the play world and
	 * the queued request so a missed hook can neither hide a session nor keep a
	 * finished one alive. It takes no "playing session in editor" input on
	 * purpose: that engine flag can stay set after a Standalone launch.
	 */
	inline FPieState ResolvePie(const FPieTracker& Tracker, bool bPlayWorld, bool bRequestQueued, double Now)
	{
		if (!bPlayWorld && !bRequestQueued)
		{
			return FPieState();
		}
		const FPieState& Seen = Tracker.State();
		if (Seen.Kind != EPieKind::None)
		{
			return Seen;
		}
		FPieState Backstop;
		Backstop.Phase = bPlayWorld ? EPiePhase::Running : EPiePhase::Queued;
		Backstop.Since = Now;
		if (Tracker.HasPendingAgentRequest(Now))
		{
			Backstop.Kind = EPieKind::Agent;
			Backstop.Owner = Tracker.PendingAgentOwner();
		}
		else
		{
			Backstop.Kind = EPieKind::User;
		}
		return Backstop;
	}

	enum class EPieRule : uint8
	{
		Safe,
		PieOwner,
		Refuse,
	};

	inline const TCHAR* LexPieRule(EPieRule R)
	{
		switch (R)
		{
		case EPieRule::Safe:     return TEXT("safe");
		case EPieRule::PieOwner: return TEXT("pie_owner");
		default:                 return TEXT("refuse");
		}
	}

	/** Drive commands plus editor_stop_pie: the agent that owns a PIE drives it; any caller stops an agent PIE. */
	inline const TSet<FString>& PieOwnerCommands()
	{
		static const TSet<FString> Commands = {
			TEXT("editor_pie_press_key"),
			TEXT("editor_pie_mouse"),
			TEXT("editor_pie_type_text"),
			TEXT("editor_pie_axis"),
			TEXT("editor_pie_click_widget"),
			TEXT("editor_pie_set_text"),
			TEXT("editor_pie_click_actor"),
			TEXT("editor_stop_pie"),
		};
		return Commands;
	}

	/** Safe = the R12 read, control and observation sets plus lease_*; the default is Refuse. */
	inline EPieRule PieRuleFor(const FString& Cmd)
	{
		if (PieOwnerCommands().Contains(Cmd))
		{
			return EPieRule::PieOwner;
		}
		if (HaybaMCPCommandSets::ControlPlaneCommands().Contains(Cmd)
			|| HaybaMCPCommandSets::PieObservationCommands().Contains(Cmd)
			|| HaybaMCPCommandSets::ReadCommands().Contains(Cmd)
			|| Cmd.StartsWith(TEXT("lease_")))
		{
			return EPieRule::Safe;
		}
		return EPieRule::Refuse;
	}

	struct FPieVerdict
	{
		bool bAllow = true;
		/** Slot 2 authorized this as a PIE command, so it skips the lease gate (R13). */
		bool bAuthorizedAsPie = false;
		/** editor_stop_pie of an agent PIE from a caller that does not own it. */
		bool bNonOwnerStop = false;
		EPieRule Rule = EPieRule::Safe;
	};

	inline FPieVerdict CheckPie(const FPieState& Pie, const FString& Cmd, const FString& CallerOwner)
	{
		FPieVerdict V;
		V.Rule = PieRuleFor(Cmd);
		if (Pie.Kind == EPieKind::None || V.Rule == EPieRule::Safe)
		{
			return V;
		}
		if (V.Rule == EPieRule::Refuse || Pie.Kind == EPieKind::User)
		{
			// Nobody edits during PIE, and nobody drives or stops the user's PIE.
			V.bAllow = false;
			return V;
		}
		if (Cmd == TEXT("editor_stop_pie"))
		{
			V.bAuthorizedAsPie = true;
			V.bNonOwnerStop = CallerOwner != Pie.Owner;
			return V;
		}
		V.bAllow = CallerOwner == Pie.Owner;
		V.bAuthorizedAsPie = V.bAllow;
		return V;
	}

	inline FString FormatPieActiveMessage(const FPieState& Pie, const FString& Cmd, EPieRule Rule, double Now)
	{
		if (Rule == EPieRule::PieOwner && Pie.Kind == EPieKind::User)
		{
			return FString::Printf(
				TEXT("pie_active: '%s' was not run: the play session belongs to the user, and Hayba never drives or stops the user's PIE. ")
				TEXT("Nothing ran; retry when editor_get_state.pie is \"none\"."), *Cmd);
		}
		if (Rule == EPieRule::PieOwner)
		{
			return FString::Printf(
				TEXT("pie_active: '%s' was not run: the play session belongs to '%s' and only its owner drives it. ")
				TEXT("Nothing ran; editor_stop_pie from any agent stops an agent PIE."), *Cmd, *Pie.Owner);
		}
		const int32 SinceSeconds = FMath::Max(0, FMath::FloorToInt32(Now - Pie.Since));
		return FString::Printf(
			TEXT("pie_active: '%s' was not run: a play session is %s (%s, %d s). Hayba refuses editor changes during PIE. ")
			TEXT("Nothing ran; retry when editor_get_state.pie is \"none\"."),
			*Cmd, LexPiePhase(Pie.Phase), *LexPie(Pie), SinceSeconds);
	}

	enum class EPlayRequestKind : uint8
	{
		User,
		Agent,
	};

	constexpr double PlayVetoOverrideWindowSeconds = 10.0;

	/** One asset:<path> X build lease, as editor_get_state.building reports it (T3). */
	struct FBusyAsset
	{
		FString Asset;
		FString Owner;
		FString Label;
		FString Lane;
		FString SinceUtc;
		double HeldSeconds = 0.0;
		double ExpiresInSeconds = 0.0;
	};

	// -------------------------------------------------------------------------
	// asset_busy (P0 T3, D5). A build marks its assets busy by holding
	// asset:<path> X leases. These tables say which commands would use such an
	// asset half-built. The router's slot 3 applies them (docs/adr/0012).
	// -------------------------------------------------------------------------

	/** Compile or save of ONE asset, and the request field(s) that name it.
	 *  Refused while ANOTHER owner holds X on that asset under a refusing
	 *  LeaseEnforcement; runs with state_warning under Advisory. Pinned by
	 *  Hayba.MCP.State.AssetBusyTargets and asset-busy-drift.test.ts. */
	inline const TMap<FString, TArray<FString>>& AssetBusyTargets()
	{
		static const TMap<FString, TArray<FString>> Targets = {
			{ TEXT("blueprint_compile"), { TEXT("path") } },
			{ TEXT("anim_blueprint_compile"), { TEXT("path") } },
			{ TEXT("bt_compile"), { TEXT("path") } },
			{ TEXT("audio_asset_save"), { TEXT("path") } },
			{ TEXT("ui_compile_widget"), { TEXT("widget_blueprint_path") } },
			{ TEXT("ui_save_widget"), { TEXT("widget_blueprint_path") } },
			{ TEXT("material_compile"), { TEXT("material_path"), TEXT("function_path") } },
		};
		return Targets;
	}

	/** Commands that use every loaded asset: PIE's pre-play compile, and
	 *  save-all. Refused while ANY owner, the caller included, holds an asset X
	 *  lock. A lane's own agent must not play its own half-built build (I-6).
	 *  A tool releases its build leases before it starts PIE. */
	inline const TSet<FString>& AnyBusyCommands()
	{
		static const TSet<FString> Commands = {
			TEXT("editor_start_pie"),
			TEXT("editor_save_all_and_quit"),
		};
		return Commands;
	}

	/** LeaseEnforcement as slot 3 reads it. Refusing covers every mode stronger
	 *  than Advisory (Enforced, and EnforcedForWrites once T8 adds it). */
	enum class EBusyMode : uint8 { Off, Advisory, Refusing };

	/** Slot 3's verdict. */
	enum class EBusyGate : uint8 { Pass, Warn, Refuse };

	/** What one request would use: every asset, or these lock keys. */
	struct FBusyQuery
	{
		bool bAnyBusy = false;
		/** Lower-cased lock keys, "asset:/game/…". */
		TArray<FString> AssetKeys;

		bool IsEmpty() const { return !bAnyBusy && AssetKeys.Num() == 0; }
	};

	inline FBusyQuery BusyQueryFor(const FString& Cmd, const TSharedPtr<FJsonObject>& Params)
	{
		FBusyQuery Query;
		if (AnyBusyCommands().Contains(Cmd))
		{
			Query.bAnyBusy = true;
			return Query;
		}
		const TArray<FString>* Fields = AssetBusyTargets().Find(Cmd);
		if (!Fields || !Params.IsValid())
		{
			return Query;
		}
		for (const FString& Field : *Fields)
		{
			FString Path;
			if (!Params->TryGetStringField(*Field, Path))
			{
				continue;
			}
			// A field that is not a package path cannot name a build. The
			// handler rejects it on its own.
			const FString Package = HaybaMCPAccess::AssetPackageKey(Path);
			if (!Package.IsEmpty())
			{
				Query.AssetKeys.AddUnique(TEXT("asset:") + Package);
			}
		}
		return Query;
	}

	/** NumHolders are the X holders the router found for the query: any owner
	 *  for bAnyBusy, and owners other than the caller for AssetKeys. */
	inline EBusyGate DecideAssetBusy(const FBusyQuery& Query, int32 NumHolders, EBusyMode Mode)
	{
		if (Mode == EBusyMode::Off || NumHolders <= 0 || Query.IsEmpty())
		{
			return EBusyGate::Pass;
		}
		if (Query.bAnyBusy)
		{
			return EBusyGate::Refuse;
		}
		return Mode == EBusyMode::Refusing ? EBusyGate::Refuse : EBusyGate::Warn;
	}

	inline FString LabelOrNone(const FString& Label)
	{
		return Label.IsEmpty() ? FString(TEXT("none")) : Label;
	}

	/** Copies the holds at once: FAssetHold::Lease is valid only until the next
	 *  table call. `Now` is the table clock (FPlatformTime::Seconds in the
	 *  editor). `UtcNow` dates `since`. */
	inline TArray<FBusyAsset> MakeBusyAssets(const TArray<HaybaMCPLease::FAssetHold>& Holds, double Now, const FDateTime& UtcNow)
	{
		TArray<FBusyAsset> Out;
		Out.Reserve(Holds.Num());
		for (const HaybaMCPLease::FAssetHold& Hold : Holds)
		{
			if (!Hold.Lease)
			{
				continue;
			}
			FBusyAsset Asset;
			Asset.Asset = Hold.AssetKey.StartsWith(TEXT("asset:")) ? Hold.AssetKey.Mid(6) : Hold.AssetKey;
			Asset.Owner = Hold.Lease->Owner;
			Asset.Label = Hold.Lease->Label;
			Asset.Lane = Hold.Lease->Lane == HaybaMCPLease::ELane::Long ? TEXT("long") : TEXT("interactive");
			Asset.HeldSeconds = FMath::Max(0.0, Now - Hold.Lease->GrantedAt);
			Asset.ExpiresInSeconds = FMath::Max(0.0, Hold.Lease->ExpiresAt - Now);
			Asset.SinceUtc = (UtcNow - FTimespan::FromSeconds(Asset.HeldSeconds)).ToIso8601();
			Out.Add(MoveTemp(Asset));
		}
		return Out;
	}

	/** {asset, owner, label, lane, held_s, since, expires_in_s}. Never a lease handle. */
	inline TSharedRef<FJsonObject> BusyAssetToJson(const FBusyAsset& Asset)
	{
		TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
		Json->SetStringField(TEXT("asset"), Asset.Asset);
		Json->SetStringField(TEXT("owner"), Asset.Owner);
		Json->SetStringField(TEXT("label"), Asset.Label);
		Json->SetStringField(TEXT("lane"), Asset.Lane);
		Json->SetNumberField(TEXT("held_s"), FMath::RoundToDouble(Asset.HeldSeconds * 10.0) / 10.0);
		Json->SetStringField(TEXT("since"), Asset.SinceUtc);
		Json->SetNumberField(TEXT("expires_in_s"), FMath::RoundToDouble(Asset.ExpiresInSeconds * 10.0) / 10.0);
		return Json;
	}

	inline TArray<TSharedPtr<FJsonValue>> BusyAssetsToJson(const TArray<FBusyAsset>& Assets)
	{
		TArray<TSharedPtr<FJsonValue>> Out;
		Out.Reserve(Assets.Num());
		for (const FBusyAsset& Asset : Assets)
		{
			Out.Add(MakeShared<FJsonValueObject>(BusyAssetToJson(Asset)));
		}
		return Out;
	}

	/** The `busy` detail of an asset_busy refusal or state_warning. */
	inline TSharedRef<FJsonObject> MakeBusyDetail(const FString& Cmd, const FString& CallerOwner, const TArray<FBusyAsset>& Assets)
	{
		TSharedRef<FJsonObject> Detail = MakeShared<FJsonObject>();
		Detail->SetStringField(TEXT("command"), Cmd);
		Detail->SetStringField(TEXT("caller_owner"), CallerOwner);
		Detail->SetArrayField(TEXT("assets"), BusyAssetsToJson(Assets));
		return Detail;
	}

	/** The asset_busy refusal text (P0 spec section 2.10). */
	inline FString MakeBusyMessage(const FString& Cmd, const FBusyAsset& First)
	{
		return FString::Printf(
			TEXT("asset_busy: '%s' is refused: %s is being built by '%s' (label %s, held %.0f s, lease expires in %.0f s). ")
			TEXT("PIE/compile would use it half-built. Nothing ran; try again when editor_get_state.building no longer lists it."),
			*Cmd, *First.Asset, *First.Owner, *LabelOrNone(First.Label), First.HeldSeconds, First.ExpiresInSeconds);
	}

	struct FPlayDecision
	{
		bool bDeny = false;
		bool bOverrideAccepted = false;
		bool bNotifyOnly = false;
		FString Reason;
	};

	inline const TCHAR* const UnsafePlayVetoText =
		TEXT("Hayba: the editor is unsafe after a contained native fault. Save your work and restart; Play would compile Blueprints and run garbage collection in a damaged process.");

	/**
	 * A Play request that reached the authorizer (the user's button, or an
	 * agent request slot 1 did not refuse). The unsafe branch takes precedence
	 * and has no override (D2). The build branch (Busy, Mode, LastVetoAt) is T10.
	 */
	inline FPlayDecision DecideUserPlay(
		const TArray<FBusyAsset>& Busy, EPlayRequestKind Kind, int32 Mode, bool bUnsafe, double LastVetoAt, double Now)
	{
		FPlayDecision D;
		if (bUnsafe)
		{
			D.bDeny = true;
			D.Reason = UnsafePlayVetoText;
		}
		return D;
	}

	/** The loaded-Blueprint facts UE 5.8 PlayLevel.cpp ResolveDirtyBlueprints tests before play. */
	struct FBlueprintPlayFacts
	{
		bool bUpToDate = false;
		bool bForDiffing = false;
		/** Status == BS_Dirty. */
		bool bDirty = false;
		bool bDataOnly = false;
		/** Status == BS_Error. */
		bool bError = false;
		bool bDisplayCompilePIEWarning = false;
	};

	enum class EPlayModal : uint8
	{
		None,
		/** ShowCompilationErrorsDialog (PlayLevel.cpp:1498). */
		ErroredDialog,
		/** A dirty code Blueprint. Without auto-recompile the editor asks "compile them
		 *  now?" (PlayLevel.cpp:1313); with it (the default) a failed recompile puts the
		 *  Blueprint in the errors dialog whatever its PIE-warning flag (:1352-1373, :2662). */
		DirtyCode,
	};

	/** Mirrors PlayLevel.cpp:1276-1300. A dirty code Blueprint is a risk under either
	 *  compile setting: the preflight cannot know whether its recompile would fail, and
	 *  an agent's broken edit leaves exactly that. An errored one with its PIE warning
	 *  opens the dialog. */
	inline EPlayModal PlayModalFor(const FBlueprintPlayFacts& F)
	{
		if (F.bUpToDate || F.bForDiffing)
		{
			return EPlayModal::None;
		}
		if (F.bDirty && !F.bDataOnly)
		{
			return EPlayModal::DirtyCode;
		}
		if (F.bError && F.bDisplayCompilePIEWarning)
		{
			return EPlayModal::ErroredDialog;
		}
		return EPlayModal::None;
	}

	inline const TCHAR* LexPlayModal(EPlayModal M)
	{
		switch (M)
		{
		case EPlayModal::ErroredDialog:   return TEXT("errored");
		case EPlayModal::DirtyCode:       return TEXT("dirty");
		default:                          return TEXT("none");
		}
	}

	constexpr int32 MaxBlockedAssetsListed = 16;

	/** Also the refusal's data.hint (a hint field is hidden at the default advisory verbosity). */
	inline const TCHAR* PieBlockedHint()
	{
		return TEXT("Compile each listed Blueprint with blueprint_compile and fix what it reports, then call editor_start_pie again.");
	}

	inline FString FormatPieBlockedMessage(int32 Count, const FString& FirstAsset, EPlayModal FirstModal)
	{
		return FString::Printf(
			TEXT("pie_blocked: 'editor_start_pie' was not run: %d Blueprint(s) would open a modal dialog before play (%s is %s). %s"),
			Count, *FirstAsset, LexPlayModal(FirstModal),
			FirstModal == EPlayModal::DirtyCode ? PieBlockedHint() : TEXT("Compile or fix them first."));
	}
}
