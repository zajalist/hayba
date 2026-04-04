"""
PCGEx UE Bridge — Runner Script

Paste into UE5 Output Log (Python mode) or run as:
    unreal.PythonScriptPlugin.exec_script("run_bridge.py")

This starts the inbox polling loop.
"""

import sys
import os

script_dir = os.path.dirname(__file__)
if script_dir not in sys.path:
    sys.path.insert(0, script_dir)

import mcp_ue_bridge

INBOX_DIR = os.path.join(script_dir, "..", "Bridge", "bridge_inbox")
OUTBOX_DIR = os.path.join(script_dir, "..", "Bridge", "bridge_outbox")
POLL_INTERVAL = 1.0

mcp_ue_bridge.start_polling(INBOX_DIR, OUTBOX_DIR, POLL_INTERVAL)
