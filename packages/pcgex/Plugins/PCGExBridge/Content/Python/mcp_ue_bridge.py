"""
PCGEx UE Bridge — Phase 3: Ingestion Pipeline

Polls bridge_inbox/ for new PCGEx graph JSON files and reconstructs them
inside Unreal Engine using the PCGEditorSubsystem.

Usage:
    import mcp_ue_bridge
    mcp_ue_bridge.start_polling(
        inbox_dir="./Bridge/bridge_inbox",
        outbox_dir="./Bridge/bridge_outbox",
        poll_interval=1.0
    )
"""

import json
import os
import time
from datetime import datetime, timezone

try:
    import unreal
except ImportError:
    unreal = None


def _log(msg):
    """Log a message, using unreal.log if available, otherwise print."""
    if unreal:
        unreal.log(msg)
    else:
        print(msg)


def _log_error(msg):
    """Log an error message, using unreal.log_error if available, otherwise print."""
    if unreal:
        unreal.log_error(msg)
    else:
        print(f"ERROR: {msg}")


def _log_warning(msg):
    """Log a warning message, using unreal.log_warning if available, otherwise print."""
    if unreal:
        unreal.log_warning(msg)
    else:
        print(f"WARNING: {msg}")


def validate_graph(graph):
    """
    Validate a graph dictionary against the expected schema.

    Returns:
        (bool, str|None): (is_valid, error_message)
    """
    if not isinstance(graph, dict):
        return False, "Graph must be a JSON object"

    if "version" not in graph:
        return False, "Missing required field: version"

    if "nodes" not in graph or not isinstance(graph["nodes"], list):
        return False, "Missing required field: nodes (must be an array)"

    if "edges" not in graph or not isinstance(graph["edges"], list):
        return False, "Missing required field: edges (must be an array)"

    for i, node in enumerate(graph["nodes"]):
        required = ["id", "class", "label", "position"]
        for field in required:
            if field not in node:
                return False, f"Node {i} missing required field: {field}"

        if not isinstance(node["position"], dict):
            return False, f"Node {i} position must be an object with x/y"
        if "x" not in node["position"] or "y" not in node["position"]:
            return False, f"Node {i} position must have x and y values"

    for i, edge in enumerate(graph["edges"]):
        required = ["fromNode", "fromPin", "toNode", "toPin"]
        for field in required:
            if field not in edge:
                return False, f"Edge {i} missing required field: {field}"

    return True, None


def write_status(outbox_dir, graph_name, status, details):
    """Write an ingestion status file to the outbox directory."""
    os.makedirs(outbox_dir, exist_ok=True)
    status_data = {
        "status": status,
        "details": details,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
    status_path = os.path.join(outbox_dir, graph_name)
    with open(status_path, 'w', encoding='utf-8') as f:
        json.dump(status_data, f, indent=2)


def load_graph_file(inbox_dir, file_name):
    """Load and parse a JSON file from the inbox."""
    file_path = os.path.join(inbox_dir, file_name)
    with open(file_path, 'r', encoding='utf-8') as f:
        return json.load(f)


def build_node_id_map(nodes):
    """
    Build a lookup map from node IDs to their data.

    Args:
        nodes: list of node dicts from the JSON graph

    Returns:
        dict mapping node_id -> node_data
    """
    return {node["id"]: node for node in nodes}


def resolve_edge_targets(edge, id_map):
    """
    Validate that both endpoints of an edge exist in the node map.

    Args:
        edge: dict with fromNode, fromPin, toNode, toPin
        id_map: dict from build_node_id_map

    Returns:
        (bool, str|None): (is_valid, error_message)
    """
    if edge["fromNode"] not in id_map:
        return False, f"Edge references unknown source node: {edge['fromNode']}"
    if edge["toNode"] not in id_map:
        return False, f"Edge references unknown target node: {edge['toNode']}"
    return True, None


def ingest_graph(graph, inbox_dir, outbox_dir, graph_name):
    """
    Main ingestion function. Reconstructs a PCGEx graph inside UE5.

    Args:
        graph: dict — the parsed JSON graph
        inbox_dir: str — path to inbox directory
        outbox_dir: str — path to outbox directory
        graph_name: str — name of the graph file
    """
    if not unreal:
        write_status(outbox_dir, f"{graph_name}.json", "error", "unreal module not available")
        _log_error("Ingestion requires the unreal module (must run inside UE5)")
        return

    valid, error = validate_graph(graph)
    if not valid:
        write_status(outbox_dir, f"{graph_name}.json", "error", f"Validation failed: {error}")
        _log_error(f"Ingestion failed for {graph_name}: {error}")
        return

    try:
        new_graph = _create_pcg_graph(graph, graph_name)
        if not new_graph:
            write_status(outbox_dir, f"{graph_name}.json", "error", "Failed to create PCGGraph asset")
            return

        id_map = build_node_id_map(graph["nodes"])

        for edge in graph["edges"]:
            valid, error = resolve_edge_targets(edge, id_map)
            if not valid:
                write_status(outbox_dir, f"{graph_name}.json", "error", f"Edge error: {error}")
                return

        node_instances = {}
        for node_data in graph["nodes"]:
            ue_node = _add_node_to_graph(new_graph, node_data)
            if ue_node:
                node_instances[node_data["id"]] = ue_node
            else:
                write_status(
                    outbox_dir, f"{graph_name}.json", "error",
                    f"Failed to create node: {node_data['class']}"
                )
                return

        for edge in graph["edges"]:
            from_ue_node = node_instances.get(edge["fromNode"])
            to_ue_node = node_instances.get(edge["toNode"])
            if from_ue_node and to_ue_node:
                _connect_nodes(new_graph, from_ue_node, edge["fromPin"], to_ue_node, edge["toPin"])

        for node_data in graph["nodes"]:
            ue_node = node_instances.get(node_data["id"])
            if ue_node and node_data.get("properties"):
                _apply_node_properties(ue_node, node_data["properties"])

        unreal.EditorAssetLibrary.save_loaded_asset(new_graph)

        write_status(outbox_dir, f"{graph_name}.json", "success", "Graph ingested successfully")
        _log(f"Successfully ingested graph: {graph_name}")

    except Exception as e:
        write_status(outbox_dir, f"{graph_name}.json", "error", str(e))
        _log_error(f"Error ingesting {graph_name}: {e}")


def _create_pcg_graph(graph, graph_name):
    """Create a new PCGGraph asset in the Content browser."""
    package_path = "/Game/PCGExBridge/Imported"
    asset_name = graph_name.replace('.json', '')

    unreal.EditorAssetLibrary.make_directory(package_path)

    try:
        subsystem = unreal.PCGEditorSubsystem()
        new_graph = subsystem.create_new_graph(
            package_path=f"{package_path}/{asset_name}",
            b_open_editor=False
        )
        return new_graph
    except Exception as e:
        _log_error(f"Failed to create PCGGraph: {e}")
        return None


def _add_node_to_graph(pcg_graph, node_data):
    """
    Add a single node to the PCGGraph.

    Args:
        pcg_graph: unreal.PCGGraph
        node_data: dict with class, label, position

    Returns:
        unreal.PCGNode or None
    """
    try:
        node_class_name = node_data["class"]
        node_class = unreal.find_class(None, node_class_name)
        if not node_class:
            _log_warning(f"Node class not found: {node_class_name}")
            return None

        subsystem = unreal.PCGEditorSubsystem()
        new_node = subsystem.add_node(pcg_graph, node_class)

        if new_node:
            new_node.set_node_label(node_data["label"])

            pos = node_data["position"]
            new_node.set_node_editor_position(unreal.Vector2D(pos["x"], pos["y"]))

        return new_node
    except Exception as e:
        _log_error(f"Failed to add node {node_data['class']}: {e}")
        return None


def _connect_nodes(pcg_graph, from_node, from_pin, to_node, to_pin):
    """
    Connect two nodes via their pins.

    Args:
        pcg_graph: unreal.PCGGraph
        from_node: unreal.PCGNode
        from_pin: str
        to_node: unreal.PCGNode
        to_pin: str
    """
    try:
        subsystem = unreal.PCGEditorSubsystem()
        subsystem.add_connection(pcg_graph, from_node, from_pin, to_node, to_pin)
    except Exception as e:
        _log_warning(f"Failed to connect {from_pin} -> {to_pin}: {e}")


def _apply_node_properties(ue_node, properties):
    """
    Apply properties from the JSON to the UE node's element.

    Args:
        ue_node: unreal.PCGNode
        properties: dict of property name -> value
    """
    try:
        element = ue_node.get_element()
        if not element:
            return

        for prop_name, prop_value in properties.items():
            try:
                if hasattr(element, prop_name):
                    setattr(element, prop_name, _convert_to_ue_type(prop_value, getattr(element, prop_name, None)))
            except Exception:
                pass
    except Exception:
        pass


def _convert_to_ue_type(value, existing_value):
    """Attempt to convert a JSON value to the appropriate UE type."""
    if existing_value is None:
        return value

    existing_type = type(existing_value)

    if isinstance(existing_value, unreal.Vector):
        if isinstance(value, dict):
            return unreal.Vector(value.get('x', 0), value.get('y', 0), value.get('z', 0))
        return existing_value

    if isinstance(existing_value, unreal.Vector2D):
        if isinstance(value, dict):
            return unreal.Vector2D(value.get('x', 0), value.get('y', 0))
        return existing_value

    if isinstance(existing_value, unreal.Rotator):
        if isinstance(value, dict):
            return unreal.Rotator(value.get('pitch', 0), value.get('yaw', 0), value.get('roll', 0))
        return existing_value

    return value


_processed_files = set()


def start_polling(inbox_dir, outbox_dir, poll_interval=1.0):
    """
    Main polling loop. Call this from UE5 Python console.

    Args:
        inbox_dir: str — path to bridge_inbox/
        outbox_dir: str — path to bridge_outbox/
        poll_interval: float — seconds between checks
    """
    _log("=== PCGEx UE Bridge — Polling Started ===")
    _log(f"Inbox: {inbox_dir}")
    _log(f"Outbox: {outbox_dir}")
    _log(f"Poll interval: {poll_interval}s")
    _log("Press Ctrl+C or close UE5 to stop.")

    os.makedirs(inbox_dir, exist_ok=True)
    os.makedirs(outbox_dir, exist_ok=True)

    try:
        while True:
            _poll_once(inbox_dir, outbox_dir)
            time.sleep(poll_interval)
    except KeyboardInterrupt:
        _log("=== PCGEx UE Bridge — Polling Stopped ===")


def _poll_once(inbox_dir, outbox_dir):
    """Check inbox for new files and process them."""
    try:
        files = [f for f in os.listdir(inbox_dir) if f.endswith('.json')]
    except OSError:
        return

    new_files = [f for f in files if f not in _processed_files]

    for file_name in new_files:
        _log(f"Processing: {file_name}")
        try:
            graph = load_graph_file(inbox_dir, file_name)
            graph_name = file_name.replace('.json', '')
            ingest_graph(graph, inbox_dir, outbox_dir, graph_name)
            _processed_files.add(file_name)
        except json.JSONDecodeError as e:
            write_status(outbox_dir, f"{file_name}", "error", f"Invalid JSON: {e}")
            _log_error(f"Invalid JSON in {file_name}: {e}")
            _processed_files.add(file_name)
        except Exception as e:
            write_status(outbox_dir, f"{file_name}", "error", str(e))
            _log_error(f"Error processing {file_name}: {e}")
            _processed_files.add(file_name)
