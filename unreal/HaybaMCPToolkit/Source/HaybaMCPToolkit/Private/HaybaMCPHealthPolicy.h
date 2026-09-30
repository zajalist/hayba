#pragma once

#include "CoreMinimal.h"
#include "HaybaMCPSeh.h"          // EHaybaFaultSite
#include "HaybaMCPCommandSets.h"

/**
 * Pure policy for sticky editor_unsafe (ADR-0011): fault classification, the
 * causes and their HCR codes, the unsafe allowlist, the CPython corruption
 * markers, and the exact texts of the fault log line, the refusal, the
 * native_fault_contained reply and the user notification. No GEditor, no
 * module state: Hayba.MCP.Health.* pins it directly.
 */
namespace HaybaMCPHealth
{
	/** Severity order. The gate uses the most severe cause seen so far. */
	enum class ECause : uint8
	{
		None,
		NativeFault,           // HCR-NATIVE-003
		PythonNativeFault,     // HCR-NATIVE-002
		StrandedPackageSave,   // HCR-NATIVE-004: a save scope was abandoned mid-save
		EngineFatalSwallowed,  // HCR-NATIVE-004: appError/assert/GPU code, or GIsCriticalError
	};

	/** After these causes object lookups are themselves fatal: only status commands answer. */
	inline bool IsStatusOnlyCause(ECause Cause)
	{
		return Cause == ECause::StrandedPackageSave || Cause == ECause::EngineFatalSwallowed;
	}

	inline ECause MoreSevere(ECause A, ECause B)
	{
		return static_cast<uint8>(A) >= static_cast<uint8>(B) ? A : B;
	}

	inline const TCHAR* LexCause(ECause Cause)
	{
		switch (Cause)
		{
		case ECause::NativeFault:          return TEXT("native_fault");
		case ECause::PythonNativeFault:    return TEXT("python_native_fault");
		case ECause::StrandedPackageSave:  return TEXT("stranded_package_save");
		case ECause::EngineFatalSwallowed: return TEXT("engine_fatal_swallowed");
		case ECause::None:
		default:                           return TEXT("none");
		}
	}

	inline const TCHAR* FaultCodeFor(ECause Cause)
	{
		switch (Cause)
		{
		case ECause::PythonNativeFault:    return TEXT("HCR-NATIVE-002");
		case ECause::NativeFault:          return TEXT("HCR-NATIVE-003");
		case ECause::StrandedPackageSave:
		case ECause::EngineFatalSwallowed: return TEXT("HCR-NATIVE-004");
		case ECause::None:
		default:                           return TEXT("");
		}
	}

	inline const TCHAR* LexSite(EHaybaFaultSite Site)
	{
		switch (Site)
		{
		case EHaybaFaultSite::Dispatch:      return TEXT("dispatch");
		case EHaybaFaultSite::Python:        return TEXT("python");
		case EHaybaFaultSite::HandlerInner:  return TEXT("handler_inner");
		case EHaybaFaultSite::TestInjection: return TEXT("test_injection");
		default:                             return TEXT("handler_inner");
		}
	}

	/** appError's AssertExceptionCode (0x4000), 0xC000 and the GPU crash code (0x8000):
	 *  engine fatals that EXCEPTION_EXECUTE_HANDLER swallows (UE 5.8
	 *  WindowsPlatformCrashContext.cpp:109-110). */
	inline bool IsEngineFatalCode(uint32 Code)
	{
		return Code == 0x4000u || Code == 0xC000u || Code == 0x8000u;
	}

	/** Engine fatal first, then a stranded save, then the Python site, else native. */
	inline ECause ClassifyCaughtFault(EHaybaFaultSite Site, uint32 Code, bool bCriticalError, bool bSavingPackage)
	{
		if (IsEngineFatalCode(Code) || bCriticalError) return ECause::EngineFatalSwallowed;
		if (bSavingPackage) return ECause::StrandedPackageSave;
		if (Site == EHaybaFaultSite::Python) return ECause::PythonNativeFault;
		return ECause::NativeFault;
	}

	/** Control-plane commands that still answer after a Python or native fault. Each is in
	 *  ControlPlaneCommands() or ReadCommands() (test_list is a read). */
	inline const TSet<FString>& UnsafeControlPlaneCommands()
	{
		static const TSet<FString> Set = { TEXT("test_list"), TEXT("test_cancel"), TEXT("ui_memory_set") };
		return Set;
	}

	/** Reads that still answer after a Python or native fault. A subset of ReadCommands(). */
	inline const TSet<FString>& UnsafeReads()
	{
		static const TSet<FString> Set = {
			TEXT("project_get_info"), TEXT("level_get_info"), TEXT("level_list"), TEXT("actor_list"),
			TEXT("actor_get_properties"), TEXT("actor_get_components"), TEXT("object_get_property"),
			TEXT("asset_get_info"), TEXT("asset_search"), TEXT("asset_browse"), TEXT("asset_registry_query"),
			TEXT("asset_get_dependencies"), TEXT("asset_get_referencers"), TEXT("asset_get_references"),
			TEXT("blueprint_get_info"), TEXT("blueprint_inspect_graph"), TEXT("material_get_info"), TEXT("material_list"),
			TEXT("mesh_get_info"), TEXT("mesh_list"), TEXT("texture_get_info"), TEXT("texture_list"),
			TEXT("wp_get_cells"), TEXT("wp_get_streaming_state"), TEXT("docs_search"), TEXT("docs_lookup_api"),
			TEXT("docs_lookup_class"),
		};
		return Set;
	}

	/** The whole allowlist for a cause (M4 and AllowlistDrift read it). */
	inline TSet<FString> CommandsAllowedWhileUnsafe(ECause Cause)
	{
		TSet<FString> Allowed = HaybaMCPCommandSets::StatusOnlyCommands();
		if (!IsStatusOnlyCause(Cause))
		{
			Allowed.Append(UnsafeControlPlaneCommands());
			Allowed.Append(UnsafeReads());
		}
		return Allowed;
	}

	/** Fails closed: an unlisted or unknown command is refused. */
	inline bool IsCommandAllowedWhileUnsafe(const FString& Cmd, ECause Cause)
	{
		if (HaybaMCPCommandSets::StatusOnlyCommands().Contains(Cmd)) return true;
		if (IsStatusOnlyCause(Cause)) return false;
		return UnsafeControlPlaneCommands().Contains(Cmd) || UnsafeReads().Contains(Cmd);
	}

	/** The marker a CPython-internal failure line carries, or nullptr. Case-sensitive. */
	inline const TCHAR* FindPythonCorruptionMarker(const FString& Text)
	{
		static const TCHAR* const Markers[] = {
			TEXT("SystemError: unknown opcode"),
			TEXT("bad argument to internal function"),
			TEXT("error return without exception set"),
			TEXT("Fatal Python error"),
		};
		for (const TCHAR* Marker : Markers)
		{
			if (Text.Contains(Marker, ESearchCase::CaseSensitive)) return Marker;
		}
		return nullptr;
	}

	inline bool IsPythonCorruptionMarker(const FString& Text)
	{
		return FindPythonCorruptionMarker(Text) != nullptr;
	}

	/** The one Error line per fault. M4 and M8 grep it, so it is pinned by ClassifyCaughtFault. */
	inline FString FormatFaultLine(ECause Cause, uint32 ExceptionCode, const FString& Cmd, const FString& Id,
		const FString& Owner, EHaybaFaultSite Site, uint64 Frame, const FString& Marker = FString())
	{
		const FString MarkerPart = Marker.IsEmpty() ? FString() : FString::Printf(TEXT(", marker '%s'"), *Marker);
		return FString::Printf(
			TEXT("[%s] editor_unsafe: native fault 0x%08X contained in '%s' (id %s, owner %s, site %s, cause %s%s, frame %llu). ")
			TEXT("Fault contained; restart the editor before further work. Until restart Hayba refuses writes, Python, saves, ")
			TEXT("compiles and PIE (editor_unsafe_restart_required); %s."),
			FaultCodeFor(Cause), ExceptionCode, *Cmd, *Id, *Owner, LexSite(Site), LexCause(Cause), *MarkerPart,
			static_cast<unsigned long long>(Frame),
			IsStatusOnlyCause(Cause) ? TEXT("only status commands answer") : TEXT("reads still answer"));
	}

	/** editor_unsafe_restart_required text (plan A.2.10). The record names the first fault; the tail follows the gate cause. */
	inline FString UnsafeRefusalMessage(const FString& Cmd, const FString& FaultedAtUtc, const FString& FaultedCommand,
		ECause FirstCause, ECause GateCause)
	{
		return FString::Printf(
			TEXT("editor_unsafe_restart_required: '%s' was not run. A native fault was contained at %s in '%s' (%s, %s); ")
			TEXT("the editor process can no longer be trusted. Fault contained; restart the editor before further work. %s"),
			*Cmd, *FaultedAtUtc, *FaultedCommand, LexCause(FirstCause), FaultCodeFor(FirstCause),
			IsStatusOnlyCause(GateCause)
				? TEXT("Only status commands such as editor_get_state, ping and lease_status answer.")
				: TEXT("Reads such as editor_get_state, ping and lease_status still answer."));
	}

	/** The faulting command's own reply text. */
	inline FString NativeFaultContainedMessage(const FString& Cmd, ECause Cause, uint32 ExceptionCode)
	{
		return FString::Printf(
			TEXT("native_fault_contained [%s]: '%s' raised native fault 0x%08X (%s); its outcome is unknown and it may have ")
			TEXT("partly run. Fault contained; restart the editor before further work. Until restart Hayba refuses writes, ")
			TEXT("Python, saves, compiles and PIE."),
			FaultCodeFor(Cause), *Cmd, ExceptionCode, LexCause(Cause));
	}

	/** test_inject_native_fault runs only in-process (ConnId 0), inside a running
	 *  automation test that holds FHaybaEditorHealth::FScopedOverrideForTests. */
	inline bool IsNativeFaultInjectionAllowed(bool bOverrideActive, int32 ConnId, bool bAutomationTesting)
	{
		return bOverrideActive && ConnId == 0 && bAutomationTesting;
	}

	/** The persistent editor notification (plan A.2.10). */
	inline FString NotificationTextFor(ECause Cause, const FString& Cmd)
	{
		return IsStatusOnlyCause(Cause)
			? FString::Printf(TEXT("Hayba contained an engine fatal error in '%s' during a package save. Do not save; restart the editor now. Saving in this state can crash the editor or write a corrupt package."), *Cmd)
			: FString::Printf(TEXT("Hayba contained a native fault in '%s'. Save now (File > Save All) and restart the editor. Do not compile, press Play or load a map before restarting."), *Cmd);
	}
}
