#pragma once

#include "CoreMinimal.h"

/**
 * The named command sets (P0 spec R12). Pure: no GEditor, no module state.
 *
 * One read list, not three: the unsafe allowlist (HaybaMCPHealthPolicy.h),
 * the PIE rule (HaybaMCPEditorStatePolicy.h) and write detection
 * (HaybaMCPAccessPolicy.h ClassifyCommand) are all built from these sets.
 *
 * Invariants, asserted by Hayba.MCP.Health.AllowlistDrift (and later by
 * Hayba.MCP.State.PieSafeDrift and Hayba.MCP.Lease.ReadClassDrift):
 *  - StatusOnlyCommands() is a subset of ControlPlaneCommands() ∪ ReadCommands();
 *  - ControlPlaneCommands(), ReadCommands() and PieObservationCommands() are
 *    pairwise disjoint;
 *  - every member is a registered command or in RouterInlineCommands();
 *  - wp_region_load / wp_region_unload are native editor_batch steps, not
 *    commands, and appear in no set.
 */
namespace HaybaMCPCommandSets
{
	/**
	 * Commands that never resolve a UObject. After a stranded package save
	 * StaticFindObjectFast is fatal (UE 5.8 UObjectGlobals.cpp:535), so this
	 * is the whole unsafe allowlist for the HCR-NATIVE-004 causes.
	 */
	inline const TSet<FString>& StatusOnlyCommands()
	{
		static const TSet<FString> Set = {
			TEXT("ping"), TEXT("editor_get_state"), TEXT("editor_get_output_log"), TEXT("editor_stream_log"),
			TEXT("lease_status"), TEXT("lease_release"), TEXT("batch_status"), TEXT("build_status"),
			TEXT("test_get_log"), TEXT("get_setting"), TEXT("ui_tool_stream"), TEXT("ui_tool_stream_new_turn"),
		};
		return Set;
	}

	/** Editor state, lease bookkeeping, logs and the router-inline UI mirrors. */
	inline const TSet<FString>& ControlPlaneCommands()
	{
		static const TSet<FString> Set = {
			TEXT("ping"), TEXT("editor_get_state"), TEXT("get_setting"), TEXT("copilot_key_status"), TEXT("batch_status"),
			TEXT("lease_acquire"), TEXT("lease_renew"), TEXT("lease_release"), TEXT("lease_status"),
			TEXT("hayba_propose_plan"), TEXT("ui_memory_set"), TEXT("ui_tool_stream"), TEXT("ui_tool_stream_new_turn"),
			TEXT("editor_get_output_log"), TEXT("editor_stream_log"), TEXT("editor_get_performance_stats"),
			TEXT("editor_get_perf_stats"), TEXT("test_cancel"),
		};
		return Set;
	}

	/** Reads of a running PIE session. Never drive it. */
	inline const TSet<FString>& PieObservationCommands()
	{
		static const TSet<FString> Set = {
			TEXT("editor_pie_assert"), TEXT("editor_pie_wait_for"), TEXT("editor_pie_screenshot"),
			TEXT("editor_pie_widget_tree"), TEXT("editor_pie_actor_list"), TEXT("editor_pie_actor_inspect"),
			TEXT("editor_pie_project_world"),
		};
		return Set;
	}

	/** Docs, the asset registry and the plain reads of spec T2 design 1. */
	inline const TSet<FString>& ReadCommands()
	{
		static const TSet<FString> Set = {
			// docs and the asset registry
			TEXT("docs_search"), TEXT("docs_lookup_api"), TEXT("docs_lookup_class"),
			TEXT("asset_search"), TEXT("asset_registry_query"), TEXT("asset_get_info"), TEXT("asset_get_dependencies"),
			TEXT("asset_get_referencers"), TEXT("asset_get_references"), TEXT("asset_browse"),
			// plain reads
			TEXT("actor_list"), TEXT("actor_get_properties"), TEXT("actor_get_components"), TEXT("object_get_property"),
			TEXT("blueprint_get_info"), TEXT("blueprint_inspect_graph"), TEXT("anim_blueprint_get_info"), TEXT("bt_get_info"),
			TEXT("material_get_info"), TEXT("material_list"), TEXT("data_get"), TEXT("level_get_info"), TEXT("level_list"),
			TEXT("level_get_spatial_index"), TEXT("scene_get_actor_relations"), TEXT("spline_get_info"),
			TEXT("texture_get_info"), TEXT("texture_list"), TEXT("mesh_get_info"), TEXT("mesh_list"), TEXT("ui_query"),
			TEXT("ui_list_widget_types"), TEXT("ui_list_widget_blueprints"), TEXT("ui_report_findings"),
			TEXT("audio_list"), TEXT("audio_active_sounds"), TEXT("audio_asset_inspect"), TEXT("audio_meter_read"),
			TEXT("wp_get_cells"), TEXT("wp_get_streaming_state"), TEXT("project_get_info"), TEXT("project_get_settings"),
			TEXT("project_list_plugins"), TEXT("test_list"), TEXT("test_get_log"), TEXT("build_status"),
			TEXT("foliage_list_types"), TEXT("pcg_list_assets"), TEXT("list_pcg_assets"), TEXT("pcg_list_node_classes"),
			TEXT("list_node_classes"), TEXT("pcg_get_node_details"), TEXT("get_node_details"),
			// R-12 (decided 2026-09-28): read-like commands. They are allowed
			// during PIE and are reads for leases. The unsafe allowlist does not
			// use this set, so they stay refused after a contained fault.
			TEXT("wait_for_idle"), TEXT("wait_for_shaders"), TEXT("asset_validate"),
			TEXT("material_validate"), TEXT("mesh_audit"), TEXT("mesh_list_dynamic"),
			TEXT("mesh_topology_stats"), TEXT("metasound_inspect"), TEXT("metasound_list"),
			TEXT("pcg_export_graph"), TEXT("pcg_read_node_output"), TEXT("pcg_validate_graph"),
			TEXT("placement_validate"), TEXT("scene_export"), TEXT("scene_validate_physics"),
			TEXT("texture_audit"), TEXT("ui_measure_text"), TEXT("copilot_get_key"),
		};
		return Set;
	}

	/** Answered by the router itself before the handler map (no IHaybaMCPHandler registers them). */
	inline const TSet<FString>& RouterInlineCommands()
	{
		static const TSet<FString> Set = {
			TEXT("hayba_propose_plan"), TEXT("ui_memory_set"), TEXT("ui_tool_stream"), TEXT("ui_tool_stream_new_turn"),
		};
		return Set;
	}
}
