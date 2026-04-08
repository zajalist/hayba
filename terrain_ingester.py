#!/usr/bin/env python3
import argparse
import json
import os
import re
import sys
from pathlib import Path

DEFAULT_ARCHETYPES_PATH = "packages/hayba/src/gaea/knowledge/archetypes.json"

# Batch processing directory
TERRAIN_EXAMPLES_DIR = r"C:\Users\Admin\AppData\Local\Programs\Gaea 2.0\Examples"

try:
    from litellm import completion
    HAS_LITELLM = True
except ImportError:
    HAS_LITELLM = False


LLM_SYSTEM_PROMPT = """You are an expert AAA terrain artist specializing in Gaea 2.0.
Analyze this raw Gaea node graph and its parameters. Generate a JSON response containing:
1. semantic_intent: A detailed description of what kind of terrain this graph likely builds.
2. heuristic_parameters: For each parameter provided, write a short geological/technical "reason" why this value was chosen.
3. biome_tags: A list of applicable biomes (e.g., alpine, desert, coastal, volcanic, tropical, arctic).
4. pattern_name: A highly descriptive, creative name for this workflow (e.g., "Alpine Glacial Erosion" or "Desert Dune Formation").

Return ONLY valid JSON, no additional text."""

MOCK_RESPONSE = {
    "semantic_intent": "Mock terrain intent - dry run mode",
    "heuristic_parameters": {"Mock": {"value": "mock", "reason": "Mock reason for testing"}},
    "biome_tags": ["mock"],
    "pattern_name": "Mock Pattern (Dry Run)"
}


def enrich_with_llm(topology: list, parameters: dict, mock: bool = False) -> dict:
    if mock:
        return MOCK_RESPONSE

    if not HAS_LITELLM:
        raise RuntimeError("litellm not installed. Install with: pip install litellm")

    user_message = f"""Node topology: {' -> '.join(topology)}

Parameters:
{json.dumps(parameters, indent=2)}

Generate the JSON response as specified in the system prompt."""

    # Use Ollama (local, free) - no API costs
    try:
        response = completion(
            model="ollama/llama3.2",
            messages=[
                {"role": "system", "content": LLM_SYSTEM_PROMPT},
                {"role": "user", "content": user_message}
            ],
            api_base="http://localhost:11434",
            timeout=180
        )
        content = response.choices[0].message.content
        json_match = re.search(r'\{[\s\S]*\}', content)
        if json_match:
            return json.loads(json_match.group())
        raise ValueError("No valid JSON found in LLM response")
    except Exception as e:
        raise RuntimeError(f"LLM enrichment failed: {e}. Use --mock for testing.")


EXCLUDED_KEYS = {
    "$type", "$id", "$ref", "Id", "Name", "Position", "Ports", "Modifiers",
    "NodeSize", "PortCount", "Parent", "HasUI", "Intrinsic", "Version"
}

IMPORTANT_NODE_TYPES = {
    "Erosion2", "Mountain", "MountainRange", "MountainSide",
    "EasyErosion", "ThermalShaper", "Snow", "Snowfield", "Glacier",
    "Combine", "Transform", "Fold", "Curvature", "Crater",
    "TextureBase", "SatMap", "SuperColor", "ColorErosion", "GroundTexture"
}


def get_assets(terrain: dict) -> list:
    a = terrain.get("Assets")
    if isinstance(a, list):
        return a
    if a and isinstance(a, dict) and "$values" in a:
        return a["$values"]
    return []


def get_nodes(terrain: dict) -> dict:
    assets = get_assets(terrain)
    if not assets:
        return {}
    terrain_data = assets[0].get("Terrain", {}) if assets else {}
    if not terrain_data:
        return {}
    nodes = terrain_data.get("Nodes", {})
    if isinstance(nodes, dict) and "$id" in nodes:
        return {k: v for k, v in nodes.items() if k != "$id"}
    return nodes


def get_node_type(node: dict) -> str:
    full_type = node.get("$type", "")
    if not full_type:
        return ""
    if "," in full_type:
        type_part = full_type.split(",")[0]
        if "." in type_part:
            return type_part.split(".")[-1]
        return type_part
    if "." in full_type:
        return full_type.split(".")[-1]
    return full_type


def get_node_params(node: dict) -> dict:
    params = {}
    for k, v in node.items():
        if k in EXCLUDED_KEYS or k.startswith("$"):
            continue
        params[k] = v
    return params


def extract_topology(nodes: dict) -> list:
    sorted_nodes = sorted(nodes.items(), key=lambda x: int(x[0]) if x[0].isdigit() else float('inf'))
    return [get_node_type(n) for _, n in sorted_nodes if get_node_type(n)]


def extract_key_parameters(nodes: dict) -> dict:
    result = {}
    sorted_nodes = sorted(nodes.items(), key=lambda x: int(x[0]) if x[0].isdigit() else float('inf'))
    
    for _, node in sorted_nodes:
        node_type = get_node_type(node)
        if node_type not in IMPORTANT_NODE_TYPES:
            continue
        
        params = get_node_params(node)
        if not params:
            continue
        
        default_params = get_default_params(node_type)
        key_params = {}
        
        for name, value in params.items():
            if name not in default_params:
                key_params[name] = {"value": value, "reason": "non-standard parameter"}
            elif default_params[name] != value:
                key_params[name] = {"value": value, "reason": f"non-default (default: {default_params[name]})"}
        
        if key_params:
            result[node_type] = key_params
    
    return result


def get_default_params(node_type: str) -> dict:
    defaults = {
        "Erosion2": {
            "Duration": 50.0, "Downcutting": 0.5, "Seed": 0,
            "SuspendedLoadDischargeAmount": 0.1, "BedLoadDischargeAmount": 0.5,
            "CoarseSedimentsDischargeAmount": 0.5, "CoarseSedimentsDischargeAngle": 30.0,
            "ShapeSharpness": 0.5, "ShapeDetailScale": 0.5
        },
        "Mountain": {"Seed": 0, "Scale": 1.0, "Height": 0.5, "Style": "Basic", "Bulk": "Medium"},
        "MountainRange": {"Seed": 0, "Scale": 1.0, "Height": 0.5, "Style": "Basic"},
        "MountainSide": {"Seed": 0, "Scale": 1.0, "Detail": 0.5, "Style": "Slope"},
        "EasyErosion": {"Style": "Simple", "Influence": 0.5},
        "ThermalShaper": {},
        "Snow": {"Duration": 0.5, "Intensity": 0.5, "SettleThaw": 0.5, "MeltType": "Uniform", "Melt": 0.5, "SnowLine": 0.0, "Seed": 0},
        "Snowfield": {"Cascades": 3, "Duration": 0.5, "Intensity": 0.5, "SettleThaw": 0.5, "Direction": "N", "Seed": 0},
        "Glacier": {"Scale": 0.5, "Direction": 0.0, "Breakage": 0.5, "Seed": 0},
        "Combine": {"Ratio": 0.5, "Mode": "Blend", "Enhance": "None"},
        "Transform": {"OffsetX": 0.0, "OffsetY": 0.0, "Rotation": 0.0, "ScaleX": 1.0, "ScaleY": 1.0},
        "Fold": {"Waveform": "Sine", "Folds": 0.5, "Symmetric": False},
        "Curvature": {"Type": "Vertical"},
        "Crater": {"Seed": 0, "Style": "New"},
        "TextureBase": {"Slope": 0.5, "Scale": 0.5, "Soil": 0.5, "Patches": 0.5, "Chaos": 0.5, "Seed": 0},
        "SatMap": {"Enhance": "None", "Rough": "Med", "Bias": 0.5, "Reverse": False},
        "SuperColor": {"Texture": "Texture", "Strength": 0.5, "Seed": 0, "Bias": 0.5, "Reverse": False},
        "ColorErosion": {"TransportDistance": 0.5, "SedimentDensity": 0.5, "Seed": 0, "Blend": 0.5, "ColorHold": 0.5},
        "GroundTexture": {"Strength": 0.5, "Coverage": 0.5, "Density": 0.5},
        "RadialGradient": {"Height": 1.0, "Scale": 1.0},
    }
    return defaults.get(node_type, {})


def parse_terrain_file(terrain_path: str) -> dict:
    with open(terrain_path, "r", encoding="utf-8") as f:
        terrain = json.load(f)
    
    nodes = get_nodes(terrain)
    core_topology = extract_topology(nodes)
    heuristic_parameters = extract_key_parameters(nodes)
    
    return {
        "core_topology": core_topology,
        "heuristic_parameters": heuristic_parameters
    }


def process_directory(dir_path: str, mock: bool, output_path: str) -> None:
    """Process all .terrain files in a directory."""
    import glob
    
    path = Path(dir_path)
    if not path.exists():
        print(f"Error: Directory not found: {dir_path}", file=sys.stderr)
        sys.exit(1)
    
    terrain_files = sorted(path.glob("*.terrain"))
    if not terrain_files:
        print(f"Error: No .terrain files found in {dir_path}", file=sys.stderr)
        sys.exit(1)
    
    print(f"Processing {len(terrain_files)} .terrain files...", file=sys.stderr)
    
    added = 0
    skipped = 0
    
    for terrain_file in terrain_files:
        try:
            parsed = parse_terrain_file(str(terrain_file))
        except Exception as e:
            print(f"  Skipping {terrain_file.name}: {e}", file=sys.stderr)
            skipped += 1
            continue
        
        enrichment = enrich_with_llm(
            parsed["core_topology"],
            parsed["heuristic_parameters"],
            mock=mock
        )
        
        result = {
            "pattern_name": enrichment.get("pattern_name", "Unknown"),
            "semantic_intent": enrichment.get("semantic_intent", ""),
            "biome_tags": enrichment.get("biome_tags", []),
            "core_topology": parsed["core_topology"],
            "heuristic_parameters": parsed["heuristic_parameters"],
            "llm_heuristic_parameters": enrichment.get("heuristic_parameters", {}),
            "_source_file": str(terrain_file)
        }
        
        if append_to_archetypes(result, output_path):
            print(f"  + {terrain_file.stem}", file=sys.stderr)
            added += 1
        else:
            print(f"  = {terrain_file.stem} (skipped duplicate)", file=sys.stderr)
            skipped += 1
    
    print(f"\nDone: {added} added, {skipped} skipped", file=sys.stderr)
    """Infer the workflow phase from node topology."""
    simulation_nodes = {'Erosion2', 'Anastomosis', 'Thermal', 'EasyErosion', 'Crumble', 'Fluvial', 'ThermalShaper'}
    base_nodes = {'Mountain', 'MountainRange', 'MountainSide', 'Ridge', 'Hillify', 'Perlin', 'Gradient', 'Template', 'RadialGradient', 'Canyon', 'Crater'}
    lookdev_nodes = {'Surface', 'Craggy', 'Sandstone', 'Color', 'Normal', 'SatMap', 'TextureBase', 'SuperColor', 'ColorErosion', 'GroundTexture'}
    utility_nodes = {'Combine', 'Mask', 'Clip', 'Clamp', 'Adjust', 'AutoLevel', 'Blur', 'Transform', 'Fold', 'Curvature'}
    
    node_set = set(topology)
    
    if node_set & simulation_nodes:
        return 'simulation'
    elif node_set & lookdev_nodes:
        return 'lookdev'
    elif node_set & base_nodes:
        return 'base'
    else:
        return 'utility'


def append_to_archetypes(archetype: dict, output_path: str) -> bool:
    path = Path(output_path)
    
    if path.exists():
        archetypes = json.loads(path.read_text(encoding="utf-8"))
    else:
        archetypes = []
    
    pattern_name = archetype.get("pattern_name", "Unknown")
    filename = Path(archetype.get("_source_file", "")).stem
    source_video_id = f"{filename}#{pattern_name}"
    
    for existing in archetypes:
        if existing.get("source_video_id") == source_video_id:
            return False
    
    enriched = {
        "pattern_name": pattern_name,
        "phase": archetype.get("phase") or infer_phase(archetype.get("core_topology", [])),
        "semantic_intent": archetype.get("semantic_intent", ""),
        "core_topology": archetype.get("core_topology", []),
        "heuristic_parameters": archetype.get("heuristic_parameters", {}),
        "biome_tags": archetype.get("biome_tags", []),
        "scale_reference": archetype.get("scale_reference"),
        "source_video_id": source_video_id
    }
    
    archetypes.append(enriched)
    path.write_text(json.dumps(archetypes, indent=2), encoding="utf-8")
    return True


def main():
    parser = argparse.ArgumentParser(description="Parse .terrain files and extract node topology/parameters")
    parser.add_argument("--input", required=True, help="Path to .terrain file")
    parser.add_argument("--dry-run", action="store_true", help="Use mock LLM response (for testing)")
    parser.add_argument("--output", help="Output JSON file path (default: stdout)")
    parser.add_argument("--mock", action="store_true", help="Use mock LLM response (alias for --dry-run)")
    parser.add_argument("--append", "-a", action="store_true", help="Append to archetypes.json")
    parser.add_argument("--dir", "-d", help="Process all .terrain files in directory")
    parser.add_argument("--examples", action="store_true", help=f"Process Gaea examples ({TERRAIN_EXAMPLES_DIR})")
    
    args = parser.parse_args()
    
    use_mock = args.dry_run or args.mock
    
    input_path = Path(args.input)
    if not input_path.exists():
        print(f"Error: File not found: {args.input}", file=sys.stderr)
        sys.exit(1)
    
    try:
        parsed = parse_terrain_file(args.input)
    except json.JSONDecodeError as e:
        print(f"Error: Invalid JSON in terrain file: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    
    enrichment = enrich_with_llm(
        parsed["core_topology"],
        parsed["heuristic_parameters"],
        mock=use_mock
    )
    
    result = {
        "pattern_name": enrichment.get("pattern_name", "Unknown"),
        "semantic_intent": enrichment.get("semantic_intent", ""),
        "biome_tags": enrichment.get("biome_tags", []),
        "core_topology": parsed["core_topology"],
        "heuristic_parameters": parsed["heuristic_parameters"],
        "llm_heuristic_parameters": enrichment.get("heuristic_parameters", {}),
        "_source_file": args.input
    }
    
    # Handle batch processing
    if args.examples:
        process_directory(TERRAIN_EXAMPLES_DIR, use_mock, args.output or DEFAULT_ARCHETYPES_PATH)
        return
    
    if args.dir:
        process_directory(args.dir, use_mock, args.output or DEFAULT_ARCHETYPES_PATH)
        return
    
    if args.append:
        output_path = args.output or DEFAULT_ARCHETYPES_PATH
        if append_to_archetypes(result, output_path):
            print(f"Appended archetype to {output_path}", file=sys.stderr)
        else:
            print(f"Skipped duplicate archetype in {output_path}", file=sys.stderr)
    else:
        json_output = json.dumps(result, indent=2)
        
        if args.output:
            Path(args.output).write_text(json_output, encoding="utf-8")
        else:
            print(json_output)


if __name__ == "__main__":
    main()