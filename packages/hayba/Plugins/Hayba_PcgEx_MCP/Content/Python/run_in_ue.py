"""
PCGEx Exporter — UE5 Integration Runner

Paste this into UE5's Output Log (Python mode) or run as:
    unreal.PythonScriptPlugin.exec_script("run_in_ue.py")

This will:
1. Import pcgex_exporter
2. Scan /Game/PCGExExampleProject for PCGGraph assets
3. Export all found graphs to ./Bridge/pcgex_context/
4. Print results to the Output Log
"""

import sys
import os

# Add the script's directory to the Python path
script_dir = os.path.dirname(__file__)
if script_dir not in sys.path:
    sys.path.insert(0, script_dir)

import pcgex_exporter

# Configuration — adjust these for your project
SOURCE_DIR = "/Game/PCGExExampleProject"
OUTPUT_DIR = os.path.join(script_dir, "..", "Bridge", "pcgex_context")

print(f"=== PCGEx Graph Exporter ===")
print(f"Source: {SOURCE_DIR}")
print(f"Output: {OUTPUT_DIR}")
print(f"")

pcgex_exporter.export_all_graphs(SOURCE_DIR, OUTPUT_DIR)

print(f"")
print(f"=== Export Complete ===")
print(f"Check {OUTPUT_DIR} for JSON files.")
