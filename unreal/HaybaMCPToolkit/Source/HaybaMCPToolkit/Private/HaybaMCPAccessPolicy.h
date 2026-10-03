#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "HaybaMCPCommandSets.h"

/**
 * Pure access policy for one MCP command: what it touches (its access class
 * and the resources it locks), whether it may open the global editor
 * transaction, and how long python_run may run.
 *
 * Kept free of GEditor, sockets and settings so every decision is unit-testable
 * without an editor. The caller supplies the facts (settings, lease state,
 * current world). The lease table that consumes these lives in
 * HaybaMCPLeasePolicy.h; the model is recorded in docs/adr/0010.
 */
namespace HaybaMCPAccess
{
	/** python_run's cooperative bytecode deadline without an exclusive lease. */
	constexpr double DefaultPythonDeadlineSeconds = 5.0;
	/** Upper clamp for a caller-requested python_run deadline. */
	constexpr double MaxPythonDeadlineSeconds = 60.0;

	// -------------------------------------------------------------------------
	// Command classification
	// -------------------------------------------------------------------------

	/**
	 * How much of the editor a command can disturb. Ordered: each class
	 * conflicts with more than the one before it.
	 *
	 *  Read        - reads state. Needs no lock and is never refused.
	 *  WriteScoped - mutates something inside one world (an actor, an asset,
	 *                a region). The default for every Plan-Mode destructive
	 *                command. Without declared resources it takes only an
	 *                intent lock on the world, so it collides with a world or
	 *                global holder but not with another scoped writer.
	 *  WriteWorld  - saves, or loads/unloads World Partition state, for the
	 *                whole current world.
	 *  Global      - switches or tears down the editor world (map load/create,
	 *                PIE, save-and-quit, arbitrary console commands).
	 */
	enum class EAccessClass : uint8
	{
		Read,
		WriteScoped,
		WriteWorld,
		Global,
	};

	inline const TCHAR* LexAccessClass(EAccessClass Class)
	{
		switch (Class)
		{
		case EAccessClass::Read:        return TEXT("read");
		case EAccessClass::WriteScoped: return TEXT("write_scoped");
		case EAccessClass::WriteWorld:  return TEXT("write_world");
		case EAccessClass::Global:      return TEXT("global");
		}
		return TEXT("read");
	}

	/** Whole-world writers. Every name must be a registered command
	 *  (access-policy-drift.test.ts and Hayba.MCP.Lease.ClassificationDrift). */
	inline const TSet<FString>& WriteWorldCommands()
	{
		static const TSet<FString> Commands = {
			TEXT("level_save"),
			// World Partition cell load/unload.
			TEXT("wp_load_cell"),
		};
		return Commands;
	}

	/** Editor-wide commands. Same drift rule as WriteWorldCommands. */
	inline const TSet<FString>& GlobalCommands()
	{
		static const TSet<FString> Commands = {
			TEXT("level_load"),
			TEXT("level_create"),
			TEXT("editor_start_pie"),
			TEXT("editor_stop_pie"),
			TEXT("editor_save_all_and_quit"),
			TEXT("editor_run_console_command"),
			// Live Coding reinstances every patched class under every agent.
			TEXT("editor_live_compile"),
		};
		return Commands;
	}

	/**
	 * Commands that write exactly one asset, and the request field that names
	 * it. Without declared resources they lock X on asset:<that package> rather
	 * than only intending the world. So two agents editing one Blueprint or
	 * Widget Blueprint collide, agents editing different assets do not, and a
	 * world or region lease does not block asset authoring, because an asset
	 * is not inside a world (docs/adr/0010). Same drift rule as the tables
	 * above; the rows are pinned by Hayba.MCP.Lease.ClassificationDrift and
	 * access-policy-drift.test.ts.
	 *
	 * Compile-and-save commands are listed too. Plan Mode leaves them alone,
	 * because a compile is derived state, but saving writes the asset. The
	 * animation rows of <deploy-branch> arrive by merge (P0 spec
	 * section 7.3).
	 */
	inline const TMap<FString, FString>& AssetWriteCommands()
	{
		static const TMap<FString, FString> Commands = {
			// Blueprint graph authoring.
			{ TEXT("blueprint_add_node"), TEXT("path") },
			{ TEXT("blueprint_connect_nodes"), TEXT("path") },
			{ TEXT("blueprint_set_pin_default"), TEXT("path") },
			{ TEXT("blueprint_add_variable"), TEXT("path") },
			{ TEXT("blueprint_add_function"), TEXT("path") },
			{ TEXT("blueprint_add_event"), TEXT("path") },
			{ TEXT("blueprint_compile"), TEXT("path") },
			// Widget Blueprint authoring.
			{ TEXT("ui_build_tree"), TEXT("widget_blueprint_path") },
			{ TEXT("ui_mutate_tree"), TEXT("widget_blueprint_path") },
			{ TEXT("ui_set_variable"), TEXT("widget_blueprint_path") },
			{ TEXT("ui_set_widget_properties"), TEXT("widget_blueprint_path") },
			{ TEXT("ui_add_element"), TEXT("widget_blueprint_path") },
			{ TEXT("ui_bind_property"), TEXT("widget_blueprint_path") },
			{ TEXT("ui_compile_widget"), TEXT("widget_blueprint_path") },
			{ TEXT("ui_save_widget"), TEXT("widget_blueprint_path") },
		};
		return Commands;
	}

	/**
	 * The package an asset path names, lower-cased, so every spelling of one
	 * asset is one lock: "/Game/A/ABP_X", "/Game/A/ABP_X.ABP_X" and the class
	 * path "/Game/A/ABP_X.ABP_X_C" are all asset:/game/a/abp_x. Empty when the
	 * text is not a package path.
	 */
	inline FString AssetPackageKey(const FString& InPath)
	{
		FString Path = InPath.TrimStartAndEnd();
		int32 Dot = INDEX_NONE;
		if (Path.FindChar(TEXT('.'), Dot))
		{
			Path = Path.Left(Dot);
		}
		while (Path.Len() > 1 && Path.EndsWith(TEXT("/")))
		{
			Path.LeftChopInline(1);
		}
		if (!Path.StartsWith(TEXT("/")) || Path.Len() < 2 || Path.Contains(TEXT(":")) || Path.Contains(TEXT("//")))
		{
			return FString();
		}
		return Path.ToLower();
	}

	struct FClassification
	{
		EAccessClass Class = EAccessClass::Read;
		/** False when the class was the fail-closed fallback rather than
		 *  named by a table or a prefix rule. */
		bool bExplicit = false;
	};

	/**
	 * Classify a command by name. T8: fail closed. A command is Read ONLY
	 * when it is in the R12 read sets (HaybaMCPCommandSets::IsReadSetCommand:
	 * control plane, reads, PIE observation, lease_*); every other command is
	 * at least WriteScoped, so a writer missing from these tables and from the
	 * Plan-Mode gate (material_set_param, bt_compile, …) can no longer pass as
	 * a Read. `bIsDestructive` (the Plan-Mode verdict) no longer decides the
	 * class; it stays in the signature for its callers. The fallback is
	 * WriteScoped, marked derived (bExplicit false).
	 *
	 * python_run is refined per request by ClassifyPythonRun; by name alone it
	 * is WriteWorld, the class of an undeclared mutation.
	 */
	inline FClassification ClassifyCommand(const FString& Cmd, bool bIsDestructive)
	{
		if (HaybaMCPCommandSets::IsReadSetCommand(Cmd))
		{
			return { EAccessClass::Read, true };
		}
		if (GlobalCommands().Contains(Cmd))
		{
			return { EAccessClass::Global, true };
		}
		if (Cmd.StartsWith(TEXT("editor_pie_")))
		{
			// PIE drive commands (observation is Read above). They keep a write
			// class for reporting; slot 2 authorizes them for the PIE's owner and
			// they then skip the lease gate (R13).
			return { EAccessClass::WriteScoped, true };
		}
		if (WriteWorldCommands().Contains(Cmd) || Cmd.StartsWith(TEXT("editor_save")))
		{
			return { EAccessClass::WriteWorld, true };
		}
		if (Cmd == TEXT("python_run"))
		{
			return { EAccessClass::WriteWorld, true };
		}
		if (AssetWriteCommands().Contains(Cmd))
		{
			// Even the ones Plan Mode leaves alone (compile-and-save) write the asset.
			return { EAccessClass::WriteScoped, true };
		}
		(void)bIsDestructive;
		return { EAccessClass::WriteScoped, false };
	}

	/**
	 * python_run by what the request declares (T8). The lexical tier
	 * classifier no longer decides the class: it misses real writers
	 * (set_editor_property, build_from_static_mesh_descriptions,
	 * compile_blueprint). A World Partition script is WriteWorld whatever it
	 * declares; declared resources make it WriteScoped; `read_only: true`,
	 * trusted like a resource list, makes it Read; anything else is an
	 * undeclared mutation.
	 */
	inline EAccessClass ClassifyPythonRun(bool bDeclaredReadOnly, bool bTouchesWorldPartition, bool bDeclaredResources)
	{
		if (bTouchesWorldPartition) return EAccessClass::WriteWorld;
		if (bDeclaredResources) return EAccessClass::WriteScoped;
		if (bDeclaredReadOnly) return EAccessClass::Read;
		return EAccessClass::WriteWorld;
	}

	// -------------------------------------------------------------------------
	// Resources
	// -------------------------------------------------------------------------

	/**
	 * A lockable thing. Text forms (case-insensitive, as UE paths are):
	 *
	 *   global
	 *   pie
	 *   world:<package>                                 world:/Game/Maps/Valley
	 *   wp-region:<package>:<minX>,<minY>,<maxX>,<maxY> (world units, XY)
	 *   asset:<path>                                    asset:/Game/Props/SM_Rock
	 *   actor:<object path>                             actor:/Game/Maps/Valley.Valley:PersistentLevel.Tree_3
	 *
	 * Hierarchy: global > world:<pkg> > { wp-region, actor }. asset:<path> and
	 * pie sit directly under global: an asset is not inside a world, and PIE
	 * owns its own world. An actor path's world is the package before the
	 * first '.'.
	 */
	enum class EResourceKind : uint8
	{
		Global,
		Pie,
		World,
		WpRegion,
		Asset,
		Actor,
	};

	struct FResource
	{
		EResourceKind Kind = EResourceKind::Global;
		/** Lower-cased world package for World / WpRegion / Actor (may be empty for an actor). */
		FString World;
		/** Lower-cased asset or actor path. */
		FString Path;
		double MinX = 0.0;
		double MinY = 0.0;
		double MaxX = 0.0;
		double MaxY = 0.0;

		static FResource MakeGlobal() { return FResource(); }
		static FResource MakeWorld(const FString& Package)
		{
			FResource R;
			R.Kind = EResourceKind::World;
			R.World = Package.ToLower();
			return R;
		}

		/** Canonical node key. Two resources with the same key are the same node. */
		FString Key() const
		{
			switch (Kind)
			{
			case EResourceKind::Global:   return TEXT("global");
			case EResourceKind::Pie:      return TEXT("pie");
			case EResourceKind::World:    return TEXT("world:") + World;
			case EResourceKind::WpRegion:
				return FString::Printf(TEXT("wp-region:%s:%g,%g,%g,%g"), *World, MinX, MinY, MaxX, MaxY);
			case EResourceKind::Asset:    return TEXT("asset:") + Path;
			case EResourceKind::Actor:    return TEXT("actor:") + Path;
			}
			return TEXT("global");
		}

		/** Ancestor keys, outermost first (never includes Key() itself). */
		TArray<FString> AncestorKeys() const
		{
			TArray<FString> Out;
			if (Kind == EResourceKind::Global) return Out;
			Out.Add(TEXT("global"));
			if ((Kind == EResourceKind::WpRegion || Kind == EResourceKind::Actor) && !World.IsEmpty())
			{
				Out.Add(TEXT("world:") + World);
			}
			return Out;
		}
	};

	/** Parse one resource string. Returns false with a reason on bad input. */
	inline bool ParseResource(const FString& InText, FResource& Out, FString& OutError)
	{
		const FString Lower = InText.TrimStartAndEnd().ToLower();
		Out = FResource();
		if (Lower == TEXT("global")) { Out.Kind = EResourceKind::Global; return true; }
		if (Lower == TEXT("pie")) { Out.Kind = EResourceKind::Pie; return true; }

		auto IsPackage = [](const FString& Package)
		{
			return Package.StartsWith(TEXT("/")) && Package.Len() >= 2 && !Package.Contains(TEXT(":"));
		};

		if (Lower.StartsWith(TEXT("world:")))
		{
			const FString Package = Lower.Mid(6);
			if (!IsPackage(Package))
			{
				OutError = FString::Printf(TEXT("resource '%s': expected world:<package path starting with '/'>"), *InText);
				return false;
			}
			Out.Kind = EResourceKind::World;
			Out.World = Package;
			return true;
		}
		if (Lower.StartsWith(TEXT("wp-region:")))
		{
			const FString Rest = Lower.Mid(10);
			int32 Colon = INDEX_NONE;
			if (!Rest.FindLastChar(TEXT(':'), Colon) || !IsPackage(Rest.Left(Colon)))
			{
				OutError = FString::Printf(
					TEXT("resource '%s': expected wp-region:<package>:<minX>,<minY>,<maxX>,<maxY>"), *InText);
				return false;
			}
			TArray<FString> Parts;
			Rest.Mid(Colon + 1).ParseIntoArray(Parts, TEXT(","), false);
			if (Parts.Num() != 4)
			{
				OutError = FString::Printf(TEXT("resource '%s': a region needs exactly four numbers"), *InText);
				return false;
			}
			double V[4] = { 0.0, 0.0, 0.0, 0.0 };
			for (int32 I = 0; I < 4; ++I)
			{
				const FString Part = Parts[I].TrimStartAndEnd();
				if (Part.IsEmpty() || !Part.IsNumeric())
				{
					OutError = FString::Printf(TEXT("resource '%s': '%s' is not a number"), *InText, *Part);
					return false;
				}
				V[I] = FCString::Atod(*Part);
			}
			if (V[0] > V[2] || V[1] > V[3])
			{
				OutError = FString::Printf(TEXT("resource '%s': min must not exceed max"), *InText);
				return false;
			}
			Out.Kind = EResourceKind::WpRegion;
			Out.World = Rest.Left(Colon);
			Out.MinX = V[0];
			Out.MinY = V[1];
			Out.MaxX = V[2];
			Out.MaxY = V[3];
			return true;
		}
		if (Lower.StartsWith(TEXT("asset:")))
		{
			const FString Path = Lower.Mid(6);
			if (!Path.StartsWith(TEXT("/")))
			{
				OutError = FString::Printf(TEXT("resource '%s': expected asset:<path starting with '/'>"), *InText);
				return false;
			}
			Out.Kind = EResourceKind::Asset;
			Out.Path = Path;
			return true;
		}
		if (Lower.StartsWith(TEXT("actor:")))
		{
			const FString Path = Lower.Mid(6);
			if (Path.IsEmpty())
			{
				OutError = FString::Printf(TEXT("resource '%s': empty actor path"), *InText);
				return false;
			}
			Out.Kind = EResourceKind::Actor;
			Out.Path = Path;
			int32 Dot = INDEX_NONE;
			if (Path.StartsWith(TEXT("/")) && Path.FindChar(TEXT('.'), Dot))
			{
				Out.World = Path.Left(Dot);
			}
			return true;
		}
		OutError = FString::Printf(
			TEXT("resource '%s': unknown kind (expected global, pie, world:, wp-region:, asset: or actor:)"), *InText);
		return false;
	}

	/** Strict XY overlap; regions that only share an edge do not overlap. */
	inline bool RegionsOverlap(const FResource& A, const FResource& B)
	{
		return A.MinX < B.MaxX && B.MinX < A.MaxX && A.MinY < B.MaxY && B.MinY < A.MaxY;
	}

	// -------------------------------------------------------------------------
	// Lock modes (multi-granularity locking)
	// -------------------------------------------------------------------------

	/** Shared / exclusive on a node, plus the intent modes taken on each
	 *  ancestor so a coarse lock sees a fine one below it. */
	enum class ELockMode : uint8
	{
		IntentShared,
		IntentExclusive,
		Shared,
		Exclusive,
	};

	inline const TCHAR* LexLockMode(ELockMode Mode)
	{
		switch (Mode)
		{
		case ELockMode::IntentShared:    return TEXT("IS");
		case ELockMode::IntentExclusive: return TEXT("IX");
		case ELockMode::Shared:          return TEXT("S");
		case ELockMode::Exclusive:       return TEXT("X");
		}
		return TEXT("X");
	}

	/** The standard IS/IX/S/X compatibility matrix. */
	inline bool AreCompatible(ELockMode A, ELockMode B)
	{
		static const bool Matrix[4][4] = {
			//          IS     IX     S      X
			/* IS */ {  true,  true,  true, false },
			/* IX */ {  true,  true, false, false },
			/* S  */ {  true, false,  true, false },
			/* X  */ { false, false, false, false },
		};
		return Matrix[static_cast<uint8>(A)][static_cast<uint8>(B)];
	}

	/** One requested resource and whether it is wanted shared or exclusive. */
	struct FClaim
	{
		FResource Resource;
		bool bExclusive = true;
	};

	/**
	 * The asset claim an asset-writing command implies from its own request,
	 * for when the caller declared no resources. False when the command is not
	 * an asset writer (AssetWriteCommands) or its path field is missing or not
	 * a package path; the command then keeps the undeclared WriteScoped locks.
	 */
	inline bool ImpliedAssetClaim(const FString& Cmd, const TSharedPtr<FJsonObject>& Params, FClaim& OutClaim)
	{
		const FString* Field = AssetWriteCommands().Find(Cmd);
		FString Path;
		if (!Field || !Params.IsValid() || !Params->TryGetStringField(**Field, Path))
		{
			return false;
		}
		const FString Package = AssetPackageKey(Path);
		if (Package.IsEmpty())
		{
			return false;
		}
		OutClaim = FClaim();
		OutClaim.Resource.Kind = EResourceKind::Asset;
		OutClaim.Resource.Path = Package;
		OutClaim.bExclusive = true;
		return true;
	}

	/** One node lock, after expanding a claim into its intent path. */
	struct FLock
	{
		FString Key;
		ELockMode Mode = ELockMode::Exclusive;
		/** Set on the explicit lock of a wp-region, for AABB overlap. */
		bool bRegion = false;
		FResource Region;
	};

	/** Expand claims into node locks: S/X on each claimed node, IS/IX on every
	 *  ancestor. A key seen twice keeps its strongest mode. */
	inline TArray<FLock> ExpandClaims(const TArray<FClaim>& Claims)
	{
		TArray<FLock> Out;
		auto AddLock = [&Out](const FString& Key, ELockMode Mode, const FResource* Region)
		{
			for (FLock& Existing : Out)
			{
				if (Existing.Key == Key)
				{
					if (static_cast<uint8>(Mode) > static_cast<uint8>(Existing.Mode))
					{
						Existing.Mode = Mode;
					}
					return;
				}
			}
			FLock Lock;
			Lock.Key = Key;
			Lock.Mode = Mode;
			if (Region)
			{
				Lock.bRegion = true;
				Lock.Region = *Region;
			}
			Out.Add(MoveTemp(Lock));
		};
		for (const FClaim& Claim : Claims)
		{
			const ELockMode Intent = Claim.bExclusive ? ELockMode::IntentExclusive : ELockMode::IntentShared;
			for (const FString& Ancestor : Claim.Resource.AncestorKeys())
			{
				AddLock(Ancestor, Intent, nullptr);
			}
			const bool bRegion = Claim.Resource.Kind == EResourceKind::WpRegion;
			AddLock(Claim.Resource.Key(), Claim.bExclusive ? ELockMode::Exclusive : ELockMode::Shared,
				bRegion ? &Claim.Resource : nullptr);
		}
		return Out;
	}

	/**
	 * Whether two lock sets conflict. Same node -> the matrix. Two different
	 * wp-regions of one world whose AABBs overlap -> their explicit modes are
	 * compared as if they were one node.
	 */
	inline bool FindConflict(const TArray<FLock>& Wanted, const TArray<FLock>& Held, FString* OutDetail = nullptr)
	{
		for (const FLock& W : Wanted)
		{
			for (const FLock& H : Held)
			{
				bool bSameNode = W.Key == H.Key;
				if (!bSameNode && W.bRegion && H.bRegion
					&& W.Region.World == H.Region.World && RegionsOverlap(W.Region, H.Region))
				{
					bSameNode = true;
				}
				if (bSameNode && !AreCompatible(W.Mode, H.Mode))
				{
					if (OutDetail)
					{
						*OutDetail = W.Key == H.Key
							? FString::Printf(TEXT("%s: wants %s, held %s"), *W.Key, LexLockMode(W.Mode), LexLockMode(H.Mode))
							: FString::Printf(TEXT("%s overlaps %s: wants %s, held %s"),
								*W.Key, *H.Key, LexLockMode(W.Mode), LexLockMode(H.Mode));
					}
					return true;
				}
			}
		}
		return false;
	}

	/**
	 * The locks a command needs, from its class, any resources it declared,
	 * and the current editor world package (empty when unknown).
	 *
	 *  Read        -> none.
	 *  WriteScoped -> X on each declared resource; undeclared, only IX on the
	 *                 world (and global), so scoped writers do not exclude one
	 *                 another but do collide with a world or global holder.
	 *  WriteWorld  -> X on world:<current> (X on global when unknown).
	 *  Global      -> X on global.
	 */
	inline TArray<FLock> RequiredLocks(EAccessClass Class, const TArray<FClaim>& Declared, const FString& CurrentWorld)
	{
		switch (Class)
		{
		case EAccessClass::Read:
			return {};
		case EAccessClass::WriteScoped:
		{
			if (Declared.Num() > 0)
			{
				TArray<FClaim> Exclusive = Declared;
				for (FClaim& Claim : Exclusive)
				{
					Claim.bExclusive = true;
				}
				return ExpandClaims(Exclusive);
			}
			TArray<FLock> Out;
			FLock GlobalIntent;
			GlobalIntent.Key = TEXT("global");
			GlobalIntent.Mode = ELockMode::IntentExclusive;
			Out.Add(GlobalIntent);
			if (!CurrentWorld.IsEmpty())
			{
				FLock WorldIntent;
				WorldIntent.Key = FResource::MakeWorld(CurrentWorld).Key();
				WorldIntent.Mode = ELockMode::IntentExclusive;
				Out.Add(WorldIntent);
			}
			return Out;
		}
		case EAccessClass::WriteWorld:
		{
			FClaim Claim;
			Claim.Resource = CurrentWorld.IsEmpty() ? FResource::MakeGlobal() : FResource::MakeWorld(CurrentWorld);
			return ExpandClaims({ Claim });
		}
		case EAccessClass::Global:
			return ExpandClaims({ FClaim() });
		}
		return {};
	}

	/** True when `Held` has an exclusive lock on `Key` or on global. */
	inline bool HoldsExclusiveOn(const TArray<FLock>& Held, const FString& Key)
	{
		for (const FLock& Lock : Held)
		{
			if (Lock.Mode == ELockMode::Exclusive && (Lock.Key == Key || Lock.Key == TEXT("global")))
			{
				return true;
			}
		}
		return false;
	}

	/**
	 * T8: an undeclared, non-read_only, non-World-Partition python_run takes X
	 * on global for conflict checks, so it meets any other owner's lock,
	 * including an asset: build lease that sits directly under global. Scripts
	 * narrow their scope by declaring resources (or read_only).
	 */
	inline TArray<FLock> UndeclaredPythonRunLocks()
	{
		return ExpandClaims({ FClaim() });
	}

	// -------------------------------------------------------------------------
	// Editor transaction and python_run deadline
	// -------------------------------------------------------------------------

	/**
	 * True when a python_run script visibly loads or unloads World Partition
	 * actors. Unloading actors inside Hayba's global BeginTransaction left
	 * UTransBuffer with a non-zero active count ("UTransBuffer::Reset non-zero
	 * active count") and the next tick crashed in Landscape. A false positive
	 * only costs the Ctrl+Z record for that script; a false negative is the
	 * crash, so the match is deliberately broad.
	 */
	inline bool ScriptTouchesWorldPartition(const FString& Script)
	{
		static const TCHAR* const Markers[] = {
			TEXT("worldpartitioneditorloaderadapter"),
			TEXT("worldpartitionblueprintlibrary"),
			TEXT("worldpartitioneditorsubsystem"),
			TEXT("load_actors("),
			TEXT("unload_actors("),
			TEXT("pin_actors("),
			TEXT("unpin_actors("),
			TEXT("load_regions("),
			TEXT("unload_regions("),
		};
		const FString Lower = Script.ToLower();
		for (const TCHAR* Marker : Markers)
		{
			if (Lower.Contains(Marker))
			{
				return true;
			}
		}
		return false;
	}

	/**
	 * Per-request opt-outs from the global editor transaction. Only ever turns
	 * a transaction OFF; it cannot add one to a command the static policy
	 * leaves unwrapped.
	 *
	 *  - `transaction: false` on any command (follows the ui_compile_widget
	 *    precedent, but chosen by the caller for one request).
	 *  - python_run with `world_partition: true`, or a script that visibly
	 *    uses the World Partition load/unload APIs.
	 */
	inline bool ParamsAllowEditorTransaction(const FString& Cmd, const TSharedPtr<FJsonObject>& Params)
	{
		if (!Params.IsValid())
		{
			return true;
		}
		bool bTransaction = true;
		if (Params->TryGetBoolField(TEXT("transaction"), bTransaction) && !bTransaction)
		{
			return false;
		}
		if (Cmd == TEXT("python_run"))
		{
			bool bWorldPartition = false;
			if (Params->TryGetBoolField(TEXT("world_partition"), bWorldPartition) && bWorldPartition)
			{
				return false;
			}
			FString Script;
			if (Params->TryGetStringField(TEXT("script"), Script) && ScriptTouchesWorldPartition(Script))
			{
				return false;
			}
		}
		return true;
	}

	/** Outcome of resolving python_run's `deadline_s`. */
	struct FPythonDeadline
	{
		bool bAllowed = true;
		double Seconds = DefaultPythonDeadlineSeconds;
		/** Set when bAllowed is false: the stable refusal reason. */
		FString Error;
	};

	/**
	 * Resolve python_run's cooperative deadline.
	 *
	 * Absent -> 5 s. Present -> clamped to [5, 60]. Anything above 5 s holds the
	 * game thread long enough to starve every other agent, so it is granted only
	 * when the caller holds an exclusive lease on the world (or global), or when
	 * the server setting allows it without one. Otherwise it is refused rather
	 * than silently clamped, so the caller learns why its long script cannot run.
	 */
	inline FPythonDeadline ResolvePythonDeadline(
		bool bHasField,
		double Requested,
		bool bCallerHoldsExclusiveLease,
		bool bSettingAllowsWithoutLease)
	{
		FPythonDeadline Out;
		if (!bHasField)
		{
			return Out;
		}
		if (!FMath::IsFinite(Requested))
		{
			Out.bAllowed = false;
			Out.Error = TEXT("deadline_s must be a finite number of seconds");
			return Out;
		}
		Out.Seconds = FMath::Clamp(Requested, DefaultPythonDeadlineSeconds, MaxPythonDeadlineSeconds);
		if (Out.Seconds > DefaultPythonDeadlineSeconds
			&& !bCallerHoldsExclusiveLease && !bSettingAllowsWithoutLease)
		{
			Out.bAllowed = false;
			Out.Error = FString::Printf(
				TEXT("deadline_s %.1f needs an exclusive lease on the current world (lease_acquire mode:\"exclusive\"); ")
				TEXT("without one python_run is limited to %.0f s so it cannot starve other agents"),
				Out.Seconds, DefaultPythonDeadlineSeconds);
		}
		return Out;
	}
}
