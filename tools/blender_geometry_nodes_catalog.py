#!/usr/bin/env python3
"""
A6 — Blender Geometry Nodes catalog scraper.

Run inside Blender's bundled Python, e.g.

  blender --background --python scripts/blender_geometry_nodes_catalog.py -- \\
      --output D:/hayba/blender_gn_catalog.sqlite

Mirrors the PCGEx registry pattern: SQLite tables `nodes`, `inputs`, `properties`.
Requires Blender 3.x+ with Geometry Nodes.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from datetime import datetime, timezone


def main() -> int:
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = []

    p = argparse.ArgumentParser()
    p.add_argument("--output", required=True, help="Output SQLite path")
    args = p.parse_args(argv)

    try:
        import bpy
    except ImportError:
        print("This script must be executed by Blender's Python interpreter.", file=sys.stderr)
        return 2

    conn = sqlite3.connect(args.output)
    cur = conn.cursor()
    cur.executescript(
        """
        DROP TABLE IF EXISTS inputs;
        DROP TABLE IF EXISTS properties;
        DROP TABLE IF EXISTS nodes;
        CREATE TABLE nodes (
          bl_idname TEXT PRIMARY KEY,
          name TEXT,
          description TEXT,
          category TEXT
        );
        CREATE TABLE inputs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          node_class TEXT,
          identifier TEXT,
          name TEXT,
          type TEXT,
          optional INTEGER
        );
        CREATE TABLE properties (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          node_class TEXT,
          identifier TEXT,
          name TEXT,
          type TEXT,
          default_json TEXT
        );
        """
    )

    count = 0
    for attr in dir(bpy.types):
        try:
            cls = getattr(bpy.types, attr)
        except Exception:
            continue
        try:
            if not issubclass(cls, bpy.types.Node):
                continue
        except TypeError:
            continue
        bl_id = getattr(cls, "bl_idname", "") or ""
        if not bl_id.startswith("GeometryNode"):
            continue
        rna = getattr(cls, "__rna__", None)
        name = getattr(cls, "bl_label", attr)
        desc = ""
        if rna is not None:
            desc = getattr(rna, "description", "") or ""
        cat = bl_id.replace("GeometryNode", "", 1)
        cur.execute(
            "INSERT INTO nodes(bl_idname, name, description, category) VALUES (?,?,?,?)",
            (bl_id, name, desc, cat),
        )

        # RNA inputs / props for factory defaults
        if rna is not None:
            try:
                for idx, socket in enumerate(rna.inputs):
                    cur.execute(
                        "INSERT INTO inputs(node_class, identifier, name, type, optional) VALUES (?,?,?,?,?)",
                        (
                            bl_id,
                            getattr(socket, "identifier", str(idx)),
                            getattr(socket, "name", ""),
                            str(getattr(socket, "type", "")),
                            1 if getattr(socket, "is_optional", False) else 0,
                        ),
                    )
                for prop in rna.properties:
                    if prop.identifier in {"rna_type", "name", "bl_idname"}:
                        continue
                    try:
                        default = json.dumps(prop.default)
                    except Exception:
                        default = None
                    cur.execute(
                        "INSERT INTO properties(node_class, identifier, name, type, default_json) VALUES (?,?,?,?,?)",
                        (bl_id, prop.identifier, prop.name, str(prop.type), default),
                    )
            except Exception:
                pass
        count += 1

    meta = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "blender_version": ".".join(str(x) for x in bpy.app.version),
        "node_count": count,
    }
    cur.execute(
        "CREATE TABLE IF NOT EXISTS _meta (k TEXT PRIMARY KEY, v TEXT)"
    )
    cur.execute("INSERT OR REPLACE INTO _meta(k,v) VALUES ('catalog', ?)", (json.dumps(meta),))
    conn.commit()
    conn.close()
    print(json.dumps({"ok": True, "db": args.output, **meta}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
