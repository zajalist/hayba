"""
PCGEx Graph Exporter — Phase 1

Extracts PCGEx graph topologies from Unreal Engine 5 as standardized JSON.
Run inside UE5 Python console or as an editor script.

Usage:
    import pcgex_exporter
    pcgex_exporter.export_all_graphs(
        source_dir="/Game/PCGExExampleProject",
        output_dir="./Bridge/pcgex_context"
    )
"""

import json
import os
from datetime import datetime, timezone

try:
    import unreal
except ImportError:
    unreal = None


def build_graph_schema(source_path, ue_version, pcgex_version, tags):
    """Build an empty graph schema dictionary."""
    return {
        "version": "1.0.0",
        "meta": {
            "sourceGraph": source_path,
            "ueVersion": ue_version,
            "pcgExVersion": pcgex_version,
            "exportedAt": datetime.now(timezone.utc).isoformat(),
            "tags": tags
        },
        "nodes": [],
        "edges": [],
        "metadata": {
            "inputSettings": {},
            "outputSettings": {},
            "graphSettings": {}
        }
    }


def serialize_node(pcg_node, node_index):
    """
    Serialize a single PCG node into the JSON schema format.

    Args:
        pcg_node: unreal.PCGNode instance
        node_index: int, used for generating unique IDs

    Returns:
        dict matching the nodes[] schema
    """
    node_class = pcg_node.get_class().get_name()
    node_label = pcg_node.get_node_label() or node_class
    node_position = pcg_node.get_node_editor_position()
    pos_x = node_position.x if node_position else 0
    pos_y = node_position.y if node_position else 0

    properties = {}
    try:
        element = pcg_node.get_element()
        if element:
            for prop_name in element.get_class().get_property_names():
                try:
                    prop_value = getattr(element, prop_name, None)
                    if prop_value is not None:
                        properties[prop_name] = _sanitize_property_value(prop_value)
                except Exception:
                    pass
    except Exception:
        pass

    custom_data = _extract_custom_data(pcg_node)

    return {
        "id": f"node_{node_index:03d}",
        "class": node_class,
        "label": node_label,
        "position": {"x": pos_x, "y": pos_y},
        "properties": properties,
        "customData": custom_data
    }


def _sanitize_property_value(value):
    """Convert UE property values to JSON-serializable types."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float, str)):
        return value
    if hasattr(value, 'x') and hasattr(value, 'y') and hasattr(value, 'z'):
        return {"x": value.x, "y": value.y, "z": value.z}
    if hasattr(value, 'pitch') and hasattr(value, 'yaw') and hasattr(value, 'roll'):
        return {"pitch": value.pitch, "yaw": value.yaw, "roll": value.roll}
    if hasattr(value, 'x') and hasattr(value, 'y'):
        return {"x": value.x, "y": value.y}
    if isinstance(value, (list, tuple)):
        return [_sanitize_property_value(v) for v in value]
    if hasattr(value, 'get_name'):
        return value.get_name()
    return str(value)


def _extract_custom_data(pcg_node):
    """Extract PCGEx-specific custom data (attribute math, cluster settings)."""
    custom_data = {}
    try:
        element = pcg_node.get_element()
        if element and hasattr(element, 'get_editor_property'):
            try:
                attr_ops = element.get_editor_property('attribute_operations')
                if attr_ops:
                    custom_data["AttributeOperations"] = [
                        _serialize_attribute_op(op) for op in attr_ops
                    ]
            except Exception:
                pass
    except Exception:
        pass
    return custom_data


def _serialize_attribute_op(op):
    """Serialize a single attribute operation."""
    result = {}
    try:
        if hasattr(op, 'get_editor_property'):
            for prop in ['attribute_name', 'operation', 'value']:
                try:
                    result[prop] = str(op.get_editor_property(prop))
                except Exception:
                    pass
    except Exception:
        pass
    return result


def serialize_edge(from_node_id, from_pin_name, to_node_id, to_pin_name):
    """Create an edge dictionary."""
    return {
        "fromNode": from_node_id,
        "fromPin": from_pin_name,
        "toNode": to_node_id,
        "toPin": to_pin_name
    }


def extract_graph(pcg_graph, ue_version="5.6", pcgex_version="0.70"):
    """
    Extract a single PCGGraph asset into the full JSON schema.

    Args:
        pcg_graph: unreal.PCGGraph asset
        ue_version: str, UE engine version
        pcgex_version: str, PCGEx plugin version

    Returns:
        dict matching the full graph schema
    """
    graph_path = pcg_graph.get_path_name()
    tags = _extract_tags_from_path(graph_path)

    schema = build_graph_schema(
        source_path=graph_path,
        ue_version=ue_version,
        pcgex_version=pcgex_version,
        tags=tags
    )

    node_id_map = {}

    nodes = pcg_graph.get_nodes()
    for idx, node in enumerate(nodes):
        node_data = serialize_node(node, idx)
        node_id_map[node] = node_data["id"]
        schema["nodes"].append(node_data)

    for node in nodes:
        try:
            connections = pcg_graph.get_node_connections(node)
            for conn in connections:
                from_node = conn.get_input_node() if hasattr(conn, 'get_input_node') else None
                to_node = conn.get_output_node() if hasattr(conn, 'get_output_node') else None
                from_pin = conn.get_input_pin_name() if hasattr(conn, 'get_input_pin_name') else "Out"
                to_pin = conn.get_output_pin_name() if hasattr(conn, 'get_output_pin_name') else "In"

                if from_node in node_id_map and to_node in node_id_map:
                    schema["edges"].append(serialize_edge(
                        node_id_map[from_node], from_pin,
                        node_id_map[to_node], to_pin
                    ))
        except Exception:
            pass

    try:
        schema["metadata"]["graphSettings"] = {
            "bCanExecuteDirectly": pcg_graph.get_editor_property('bCanExecuteDirectly'),
            "bAutoCompile": pcg_graph.get_editor_property('bAutoCompile')
        }
    except Exception:
        pass

    return schema


def _extract_tags_from_path(path, exclude_parts=('Game', 'Engine', 'PCGExExampleProject', 'Categories', 'Examples')):
    """Extract searchable tags from the asset path."""
    tags = []
    parts = path.split('/')
    for part in parts:
        if part and part not in exclude_parts:
            # Handle UE asset path format: AssetName.AssetName
            base_name = part.split('.')[0]
            tags.append(base_name.lower().replace(' ', '_'))
    return tags


def export_all_graphs(source_dir, output_dir):
    """
    Main entry point. Find all PCGGraph assets under source_dir and export them.

    Args:
        source_dir: str, UE content path (e.g., "/Game/PCGExExampleProject")
        output_dir: str, filesystem path for JSON output
    """
    if unreal is None:
        raise RuntimeError("Must run inside UE5")

    os.makedirs(output_dir, exist_ok=True)

    registry = unreal.AssetRegistryHelpers.get_asset_registry()
    assets = registry.get_assets_by_path(source_dir, recursive=True)

    pcg_graphs = [
        asset for asset in assets
        if asset.asset_class == "PCGGraph"
    ]

    if not pcg_graphs:
        unreal.log_warning(f"No PCGGraph assets found in {source_dir}")
        return

    unreal.log(f"Found {len(pcg_graphs)} PCGGraph assets in {source_dir}")

    exported = 0
    for asset_data in pcg_graphs:
        try:
            graph = unreal.load_asset(asset_data.object_path)
            if not graph:
                unreal.log_warning(f"Failed to load: {asset_data.object_path}")
                continue

            schema = extract_graph(graph)
            safe_name = _make_safe_filename(asset_data.asset_name)
            output_path = os.path.join(output_dir, f"{safe_name}.json")

            with open(output_path, 'w', encoding='utf-8') as f:
                json.dump(schema, f, indent=2, ensure_ascii=False)

            unreal.log(f"Exported: {asset_data.asset_name} -> {output_path}")
            exported += 1
        except Exception as e:
            unreal.log_error(f"Failed to export {asset_data.asset_name}: {e}")

    unreal.log(f"Export complete: {exported}/{len(pcg_graphs)} graphs exported to {output_dir}")


def _make_safe_filename(name):
    """Convert an asset name to a safe filename."""
    safe = "".join(c if c.isalnum() or c in ('-', '_') else '_' for c in name)
    return safe or "unnamed_graph"
