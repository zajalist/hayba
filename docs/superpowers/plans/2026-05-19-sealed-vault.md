# The Sealed Vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate a multi-room dungeon whose lock/key progression is provably solvable, authored live in UE5 via the Hayba MCP PCGEx toolkit.

**Architecture:** A dependency-free Python reference oracle generates a deterministic, solvable room/lock/key graph from a seed and a reusable `assert_solvable` invariant. The oracle is TDD'd offline with pytest (the real test of correctness is seed-fuzzing the invariant). Then the equivalent PCGEx graph is authored in UE through Hayba MCP tools; the *same* `invariant.py` runs in-engine via `python_run` against the read-back attribute tables, plus a top-down viewport screenshot for visual validation.

**Tech Stack:** Python 3 (stdlib only — compact Bowyer–Watson Delaunay, no scipy/numpy), pytest, Hayba MCP toolkit (PCGEx node catalog + `hayba_create_pcg_graph` / `hayba_execute_pcg_graph` / `python_run` / `editor_capture_viewport`), UE5.7 + PCGEx.

**MCP note:** Hayba tool schemas are deferred. Before any task that calls `mcp__hayba-toolkit__*`, load it with `ToolSearch` query `select:<tool_name>`. UE must be open with the plugin (`hayba_check_ue_status` returns ok; server already `✓ Connected`).

---

## File Structure

- `tools/sealed_vault/__init__.py` — package marker
- `tools/sealed_vault/geom.py` — deterministic point seeding, Lloyd relax, Bowyer–Watson Delaunay (stdlib only)
- `tools/sealed_vault/oracle.py` — seed → `Dungeon{rooms, edges, locks, keys, rank, roles}`; MST spine, loop edges, flood-fill rank, invariant-respecting lock/key placement
- `tools/sealed_vault/invariant.py` — `assert_solvable(dungeon)`; pure, importable both in pytest and in-UE via `python_run`
- `tools/sealed_vault/test_oracle.py` — pytest: invariant fixtures, determinism, topology bounds, seed fuzz 1..25
- `tools/sealed_vault/pcgex_nodes.md` — generated record of exact PCGEx class/pins/props per stage (filled in Task 7, no guessed names)
- `tools/sealed_vault/sealed_vault_graph.json` — exported PCGEx graph snapshot (Task 11, version-controlled artifact)
- `tools/sealed_vault/validation/` — committed viewport screenshots + in-UE invariant output (Task 10–11)

Each Python file has one responsibility; `invariant.py` deliberately has zero deps so it can be shipped verbatim into the UE Python sandbox.

---

## Task 1: Package scaffold + invariant contract (failing test)

**Files:**
- Create: `tools/sealed_vault/__init__.py`
- Create: `tools/sealed_vault/invariant.py`
- Test: `tools/sealed_vault/test_oracle.py`

- [ ] **Step 1: Write the failing test**

```python
# tools/sealed_vault/test_oracle.py
from tools.sealed_vault.invariant import assert_solvable, SolvabilityError

def _solvable_fixture():
    # rooms 0..3; entrance=0 boss=3. edge (2,3) locked by key 1, key in room 1.
    return dict(
        rooms=[0, 1, 2, 3], entrance=0, boss=3,
        edges=[(0, 1, -1), (1, 2, -1), (2, 3, 1)],   # (u, v, lock_id)
        rank={0: 0, 1: 1, 2: 2, 3: 3},
        keys={1: 1},                                  # key_id -> room
    )

def _unsolvable_fixture():
    f = _solvable_fixture()
    f["keys"] = {1: 3}    # key sealed in the boss room behind its own lock
    return f

def test_solvable_passes():
    assert_solvable(_solvable_fixture()) is None

def test_unsolvable_raises():
    import pytest
    with pytest.raises(SolvabilityError):
        assert_solvable(_unsolvable_fixture())
```

- [ ] **Step 2: Run to verify it fails**

Run: `python -m pytest tools/sealed_vault/test_oracle.py -q`
Expected: FAIL — `ModuleNotFoundError: tools.sealed_vault.invariant`

- [ ] **Step 3: Implement the invariant**

```python
# tools/sealed_vault/invariant.py
"""Solvability invariant. Stdlib only — runs in pytest AND the UE python sandbox."""
from collections import deque

class SolvabilityError(Exception): pass

def assert_solvable(d):
    """Raise SolvabilityError unless every key is collectable before its lock,
    and the boss room is reachable from the entrance."""
    rooms = set(d["rooms"]); entrance = d["entrance"]; boss = d["boss"]
    keys = dict(d["keys"])                       # key_id -> room holding it
    adj = {}
    for u, v, lock in d["edges"]:
        adj.setdefault(u, []).append((v, lock))
        adj.setdefault(v, []).append((u, lock))
    held = set()
    # Fixpoint BFS: traverse only edges that are open or whose key is already held.
    progressed = True
    reached = {entrance}
    while progressed:
        progressed = False
        q = deque(reached)
        while q:
            cur = q.popleft()
            for kid, room in keys.items():
                if room == cur and kid not in held:
                    held.add(kid); progressed = True
            for nxt, lock in adj.get(cur, []):
                if nxt in reached: continue
                if lock == -1 or lock in held:
                    reached.add(nxt); q.append(nxt); progressed = True
    if boss not in reached:
        raise SolvabilityError(f"boss {boss} unreachable; reached={sorted(reached)}")
    missing = rooms - reached
    if missing:
        raise SolvabilityError(f"unreachable rooms {sorted(missing)}")
```

- [ ] **Step 4: Run to verify it passes**

Run: `python -m pytest tools/sealed_vault/test_oracle.py -q`
Expected: PASS (2 passed). Create empty `tools/sealed_vault/__init__.py` and ensure `tools/__init__.py` exists (create if missing) so the package import resolves.

- [ ] **Step 5: Commit**

```bash
git add tools/__init__.py tools/sealed_vault/
git commit -m "feat(sealed-vault): solvability invariant + fixtures"
```

---

## Task 2: Deterministic geometry — seeds, Lloyd relax, Delaunay

**Files:**
- Create: `tools/sealed_vault/geom.py`
- Test: `tools/sealed_vault/test_oracle.py` (append)

- [ ] **Step 1: Write the failing test**

```python
# append to tools/sealed_vault/test_oracle.py
from tools.sealed_vault.geom import seed_points, lloyd_relax, delaunay_edges

def test_seed_points_deterministic():
    a = seed_points(seed=7, n=14, extent=1000.0)
    b = seed_points(seed=7, n=14, extent=1000.0)
    assert a == b and len(a) == 14
    assert all(0 <= x <= 1000 and 0 <= y <= 1000 for x, y in a)

def test_delaunay_is_connected_planar():
    pts = lloyd_relax(seed_points(seed=3, n=14, extent=1000.0), iterations=2, extent=1000.0)
    e = delaunay_edges(pts)
    # every vertex appears in at least one edge -> graph spans all points
    used = {i for edge in e for i in edge}
    assert used == set(range(len(pts)))
    assert all(0 <= i < len(pts) and 0 <= j < len(pts) and i != j for i, j in e)
```

- [ ] **Step 2: Run to verify it fails**

Run: `python -m pytest tools/sealed_vault/test_oracle.py -q -k "deterministic or planar"`
Expected: FAIL — `ModuleNotFoundError: tools.sealed_vault.geom`

- [ ] **Step 3: Implement geometry (stdlib only)**

```python
# tools/sealed_vault/geom.py
"""Deterministic point seeding + Lloyd relax + Bowyer-Watson Delaunay. Stdlib only."""
import random, itertools

def seed_points(seed, n, extent):
    r = random.Random(seed)
    return [(round(r.uniform(0, extent), 4), round(r.uniform(0, extent), 4)) for _ in range(n)]

def _circumcenter(a, b, c):
    ax, ay = a; bx, by = b; cx, cy = c
    dd = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    if abs(dd) < 1e-9: return None
    ux = ((ax**2 + ay**2) * (by - cy) + (bx**2 + by**2) * (cy - ay) + (cx**2 + cy**2) * (ay - by)) / dd
    uy = ((ax**2 + ay**2) * (cx - bx) + (bx**2 + by**2) * (ax - cx) + (cx**2 + cy**2) * (bx - ax)) / dd
    return (ux, uy)

def _in_circumcircle(p, a, b, c):
    cc = _circumcenter(a, b, c)
    if cc is None: return False
    r2 = (a[0] - cc[0])**2 + (a[1] - cc[1])**2
    return (p[0] - cc[0])**2 + (p[1] - cc[1])**2 <= r2 + 1e-7

def delaunay_edges(points):
    """Bowyer-Watson. Returns sorted unique (i,j) index edges, deterministic."""
    pts = list(points)
    big = max(max(x, y) for x, y in pts) * 10 + 1000
    s = [(-big, -big), (big, -big), (0, big)]            # super-triangle verts
    P = pts + s
    si = len(pts)
    tris = [(si, si + 1, si + 2)]
    for pi in range(len(pts)):
        bad = [t for t in tris if _in_circumcircle(P[pi], P[t[0]], P[t[1]], P[t[2]])]
        edges = {}
        for t in bad:
            for e in ((t[0], t[1]), (t[1], t[2]), (t[2], t[0])):
                k = tuple(sorted(e)); edges[k] = edges.get(k, 0) + 1
        tris = [t for t in tris if t not in bad]
        for (a, b), cnt in edges.items():
            if cnt == 1:
                tris.append((a, b, pi))
    out = set()
    for t in tris:
        if any(v >= si for v in t): continue
        for a, b in ((t[0], t[1]), (t[1], t[2]), (t[2], t[0])):
            out.add((min(a, b), max(a, b)))
    return sorted(out)

def lloyd_relax(points, iterations, extent):
    """Approx centroidal relax: move each point toward mean of Delaunay neighbours."""
    pts = [tuple(p) for p in points]
    for _ in range(iterations):
        nb = {i: [] for i in range(len(pts))}
        for i, j in delaunay_edges(pts):
            nb[i].append(j); nb[j].append(i)
        moved = []
        for i, (x, y) in enumerate(pts):
            if nb[i]:
                mx = sum(pts[k][0] for k in nb[i]) / len(nb[i])
                my = sum(pts[k][1] for k in nb[i]) / len(nb[i])
                x, y = (x + mx) / 2, (y + my) / 2
            moved.append((round(min(max(x, 0), extent), 4), round(min(max(y, 0), extent), 4)))
        pts = moved
    return pts
```

- [ ] **Step 4: Run to verify it passes**

Run: `python -m pytest tools/sealed_vault/test_oracle.py -q -k "deterministic or planar"`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add tools/sealed_vault/geom.py tools/sealed_vault/test_oracle.py
git commit -m "feat(sealed-vault): deterministic seeds + Lloyd relax + Delaunay"
```

---

## Task 3: Oracle — spine (MST), loops, flood-fill rank

**Files:**
- Create: `tools/sealed_vault/oracle.py`
- Test: `tools/sealed_vault/test_oracle.py` (append)

- [ ] **Step 1: Write the failing test**

```python
# append to tools/sealed_vault/test_oracle.py
from tools.sealed_vault.oracle import build_topology

def test_topology_connected_with_loops():
    t = build_topology(seed=5, n=14, extent=1000.0, loop_k=3)
    n = len(t["rooms"])
    assert 12 <= n <= 16
    # connected: BFS from entrance reaches all
    adj = {}
    for u, v in t["tree_edges"] + t["loop_edges"]:
        adj.setdefault(u, []).append(v); adj.setdefault(v, []).append(u)
    seen = {t["entrance"]}; stack = [t["entrance"]]
    while stack:
        c = stack.pop()
        for k in adj.get(c, []):
            if k not in seen: seen.add(k); stack.append(k)
    assert seen == set(t["rooms"])
    assert len(t["tree_edges"]) == n - 1            # spanning tree
    assert len(t["loop_edges"]) == 3                # exactly loop_k cycles added
    # rank is BFS depth from entrance, monotone along tree
    assert t["rank"][t["entrance"]] == 0
    assert t["boss"] == max(t["rank"], key=t["rank"].get)
```

- [ ] **Step 2: Run to verify it fails**

Run: `python -m pytest tools/sealed_vault/test_oracle.py -q -k topology`
Expected: FAIL — `ModuleNotFoundError: tools.sealed_vault.oracle`

- [ ] **Step 3: Implement topology**

```python
# tools/sealed_vault/oracle.py
"""Seed -> solvable dungeon. Mirrors the PCGEx pipeline stages 1-6."""
import random
from collections import deque
from tools.sealed_vault.geom import seed_points, lloyd_relax, delaunay_edges

def _dist2(p, q): return (p[0]-q[0])**2 + (p[1]-q[1])**2

def _mst(n, weighted_edges):
    parent = list(range(n))
    def find(a):
        while parent[a] != a: parent[a] = parent[parent[a]]; a = parent[a]
        return a
    tree = []
    for w, u, v in sorted(weighted_edges):
        ru, rv = find(u), find(v)
        if ru != rv: parent[ru] = rv; tree.append((min(u, v), max(u, v)))
    return tree

def build_topology(seed, n=14, extent=1000.0, loop_k=3):
    pts = lloyd_relax(seed_points(seed, n, extent), iterations=2, extent=extent)
    de = delaunay_edges(pts)
    we = [(_dist2(pts[u], pts[v]), u, v) for u, v in de]
    tree = _mst(len(pts), we)
    tree_set = {(min(u, v), max(u, v)) for u, v in tree}
    extra = sorted((w, u, v) for w, u, v in we if (min(u, v), max(u, v)) not in tree_set)
    loops = [(min(u, v), max(u, v)) for _, u, v in extra[:loop_k]]
    entrance = min(range(len(pts)), key=lambda i: pts[i][0] + pts[i][1])  # corner-most
    adj = {}
    for u, v in tree + loops:
        adj.setdefault(u, []).append(v); adj.setdefault(v, []).append(u)
    rank = {entrance: 0}; q = deque([entrance])
    while q:
        c = q.popleft()
        for k in adj.get(c, []):
            if k not in rank: rank[k] = rank[c] + 1; q.append(k)
    boss = max(rank, key=rank.get)
    return dict(rooms=list(range(len(pts))), points=pts, entrance=entrance,
                boss=boss, tree_edges=tree, loop_edges=loops, rank=rank)
```

- [ ] **Step 4: Run to verify it passes**

Run: `python -m pytest tools/sealed_vault/test_oracle.py -q -k topology`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/sealed_vault/oracle.py tools/sealed_vault/test_oracle.py
git commit -m "feat(sealed-vault): MST spine + loops + flood-fill rank"
```

---

## Task 4: Oracle — invariant-respecting lock/key placement + seed fuzz

**Files:**
- Modify: `tools/sealed_vault/oracle.py`
- Test: `tools/sealed_vault/test_oracle.py` (append)

- [ ] **Step 1: Write the failing test (the real correctness test)**

```python
# append to tools/sealed_vault/test_oracle.py
from tools.sealed_vault.oracle import build_dungeon
from tools.sealed_vault.invariant import assert_solvable

def test_dungeon_solvable_fuzz():
    for seed in range(1, 26):
        d = build_dungeon(seed=seed, n=14, extent=1000.0, loop_k=3, n_keys=4)
        assert_solvable(d)                       # must hold for EVERY seed
        assert len([1 for *_ , l in d["edges"] if l != -1]) == 4   # 4 locked edges
        assert len(d["keys"]) == 4

def test_dungeon_deterministic():
    a = build_dungeon(seed=9, n=14, extent=1000.0, loop_k=3, n_keys=4)
    b = build_dungeon(seed=9, n=14, extent=1000.0, loop_k=3, n_keys=4)
    assert a["edges"] == b["edges"] and a["keys"] == b["keys"]
```

- [ ] **Step 2: Run to verify it fails**

Run: `python -m pytest tools/sealed_vault/test_oracle.py -q -k dungeon`
Expected: FAIL — `ImportError: cannot import name 'build_dungeon'`

- [ ] **Step 3: Implement lock/key placement**

```python
# append to tools/sealed_vault/oracle.py
def build_dungeon(seed, n=14, extent=1000.0, loop_k=3, n_keys=4):
    t = build_topology(seed, n, extent, loop_k)
    rank = t["rank"]; entrance = t["entrance"]; boss = t["boss"]
    rng = random.Random(seed * 1000 + 17)
    # Candidate lock edges = tree edges on the entrance->boss path, deepest first,
    # so locks gate progression. Pick n_keys of them spread by rank.
    parent = {entrance: None}; q = deque([entrance])
    adjt = {}
    for u, v in t["tree_edges"]:
        adjt.setdefault(u, []).append(v); adjt.setdefault(v, []).append(u)
    while q:
        c = q.popleft()
        for k in adjt.get(c, []):
            if k not in parent: parent[k] = c; q.append(k)
    path = []; cur = boss
    while parent[cur] is not None:
        path.append((parent[cur], cur)); cur = parent[cur]
    path.reverse()                                    # entrance -> boss tree edges
    # choose n_keys lock edges evenly along the path (closest to boss included)
    if len(path) < n_keys:
        n_keys = max(1, len(path))
    idxs = sorted(set(round(i*(len(path)-1)/(n_keys-1)) for i in range(n_keys))) \
        if n_keys > 1 else [len(path)-1]
    lock_edges = [path[i] for i in idxs]
    edges = []
    locks_by_pair = {}
    for kid, (u, v) in enumerate(lock_edges, start=1):
        locks_by_pair[(min(u, v), max(u, v))] = kid
    all_pairs = [(min(u, v), max(u, v)) for u, v in t["tree_edges"] + t["loop_edges"]]
    for (u, v) in all_pairs:
        edges.append((u, v, locks_by_pair.get((u, v), -1)))
    # Place each key in a room with rank <= rank(near endpoint of its lock edge),
    # excluding the boss and rooms strictly deeper. Deterministic choice.
    keys = {}
    for (u, v), kid in locks_by_pair.items():
        near = u if rank[u] <= rank[v] else v
        cap = rank[near]
        candidates = sorted(r for r in t["rooms"]
                            if rank[r] <= cap and r != boss)
        keys[kid] = candidates[rng.randrange(len(candidates))]
    roles = {r: "hub" for r in t["rooms"]}
    roles[entrance] = "entrance"; roles[boss] = "boss"
    for kid, r in keys.items(): roles.setdefault(r, "hub"); roles[r] = "key"
    d = dict(rooms=t["rooms"], points=t["points"], entrance=entrance, boss=boss,
             edges=edges, rank=rank, keys=keys, roles=roles)
    assert_solvable(d)                                # construct-time guarantee
    return d
```

- [ ] **Step 4: Run to verify it passes**

Run: `python -m pytest tools/sealed_vault/test_oracle.py -q`
Expected: PASS (all tests, incl. 25-seed fuzz). If any seed fails, the `cap`/candidate rule is wrong — fix here, do not weaken the invariant.

- [ ] **Step 5: Commit**

```bash
git add tools/sealed_vault/oracle.py tools/sealed_vault/test_oracle.py
git commit -m "feat(sealed-vault): invariant-respecting lock/key placement (seed-fuzz green)"
```

---

## Task 5: UE preflight + exact PCGEx node resolution (no guessed names)

**Files:**
- Create: `tools/sealed_vault/pcgex_nodes.md`

- [ ] **Step 1: Confirm UE reachable**

Load + call: `ToolSearch select:mcp__hayba-toolkit__hayba_check_ue_status` then call it.
Expected: status ok, project = geoforge. If not ok, STOP and tell the user to focus the UE editor.

- [ ] **Step 2: Resolve every pipeline node's exact class/pins/props**

Load: `ToolSearch select:mcp__hayba-toolkit__hayba_search_node_catalog,mcp__hayba-toolkit__hayba_get_node_details,mcp__hayba-toolkit__hayba_query_pcgex_docs`
For each stage node, `hayba_search_node_catalog` then `hayba_get_node_details`:
Delaunay 2D · Refine : Edges (MST mode enum) · Cluster : Sanitize · Cluster : Flood Fill · Cluster : Partition Vtx / Partition by Values · Pathfinding : Find Cells · Pathfinding : Plot Edges · Heuristics Definition (Shortest Distance) · Path : Subdivide · Action : Write Attributes · Lloyd Relax 2D.

- [ ] **Step 3: Record findings**

Write `tools/sealed_vault/pcgex_nodes.md`: one section per stage with the exact `class`, input/output pin names, and the precise property/enum names used (e.g. the Refine mode value for MST). No assumptions — only what the catalog/docs return.

- [ ] **Step 4: Commit**

```bash
git add tools/sealed_vault/pcgex_nodes.md
git commit -m "docs(sealed-vault): exact PCGEx node/pin/prop resolution"
```

---

## Task 6: Author the PCGEx graph in UE (stages 1–4) + structural validation

**Files:** (UE-side asset; no repo file yet)

- [ ] **Step 1: Create the graph asset under Plan Mode**

Load: `ToolSearch select:mcp__hayba-toolkit__hayba_propose_plan,mcp__hayba-toolkit__hayba_create_pcg_graph,mcp__hayba-toolkit__hayba_validate_pcg_graph,mcp__hayba-toolkit__hayba_validate_attribute_flow`
`hayba_propose_plan` describing the 9-stage build; on approval `hayba_create_pcg_graph` named `PCG_SealedVault` with stages 1–4 wired using the exact names from `pcgex_nodes.md`: point seed → `Lloyd Relax 2D` → `Cluster : Delaunay 2D` → `Refine : Edges` (MST) → re-add k loop edges via `Cluster : Sanitize`/filtered merge.

- [ ] **Step 2: Validate graph + attribute flow**

Call `hayba_validate_pcg_graph` and `hayba_validate_attribute_flow`.
Expected: no dangling pins, no type mismatches, cluster vtx/edge attributes flow end-to-end. Fix wiring until clean before continuing.

- [ ] **Step 3: Commit checkpoint note**

```bash
git commit --allow-empty -m "chore(sealed-vault): UE graph stages 1-4 validated"
```

---

## Task 7: Add stages 5–9 (rank, lock/key, cells, corridors, dressing)

- [ ] **Step 1: Wire reachability + placement**

Append to `PCG_SealedVault`: `Cluster : Flood Fill` seeded from the entrance vtx (tag it first via `Action : Write Attributes`) → write `Rank` int attr → `Partition by Values` over `Rank` to derive lock edges + key rooms following the **same cap rule as `oracle.build_dungeon`** (key room rank ≤ near-endpoint rank, exclude boss).

- [ ] **Step 2: Wire footprints, corridors, dressing**

`Pathfinding : Find Cells` (room footprints) · `Pathfinding : Plot Edges` + `Heuristics Definition` (Shortest Distance) → `Path : Subdivide` (corridor splines) · `Partition by Values` on `RoomRole` → ISM scatter (entrance/hub/key/lock/treasure/boss placeholders).

- [ ] **Step 3: Re-validate**

`hayba_validate_pcg_graph` + `hayba_validate_attribute_flow` → clean.

- [ ] **Step 4: Commit checkpoint note**

```bash
git commit --allow-empty -m "chore(sealed-vault): UE graph stages 5-9 validated"
```

---

## Task 8: Execute + in-engine invariant assertion (the real gate)

- [ ] **Step 1: Spawn driver + execute**

Load: `ToolSearch select:mcp__hayba-toolkit__actor_spawn,mcp__hayba-toolkit__hayba_execute_pcg_graph,mcp__hayba-toolkit__python_run,mcp__hayba-toolkit__editor_stream_log`
`actor_spawn` a PCG volume actor bound to `PCG_SealedVault` (seed=5). `hayba_execute_pcg_graph`. Tail `editor_stream_log` for errors.

- [ ] **Step 2: Read back attribute tables + assert solvable IN UE**

`python_run` a script that: reads the cluster vtx/edge attribute tables (rooms, edges with `LockId`, `KeyId`, `Rank`, `RoomRole`), builds the same `dict` shape as the oracle, pastes the verbatim body of `tools/sealed_vault/invariant.py`, and calls `assert_solvable(d)`. Print `SEALED_VAULT_OK` on success or the `SolvabilityError` message.
Expected: `SEALED_VAULT_OK`. Also assert topology bounds: 12–16 rooms, ≥3 cycles, exactly one entrance/boss — same as `test_oracle.py`.

- [ ] **Step 3: If it fails**

Use superpowers:systematic-debugging. The most likely cause is a placement-rule mismatch between the PCGEx `Partition by Values` config and `oracle.build_dungeon`'s cap rule — reconcile them; never weaken the invariant to make it pass.

---

## Task 9: Visual validation + seed fuzz in UE

- [ ] **Step 1: Top-down screenshot**

Load: `ToolSearch select:mcp__hayba-toolkit__editor_capture_viewport`
Position a top-down view; `editor_capture_viewport` → save under `tools/sealed_vault/validation/seed5_topdown.png`. Inspect (not just count): rooms non-overlapping, corridors actually connect, key/lock/boss props placed at distinct rooms, entrance corner-most.

- [ ] **Step 2: Fuzz 5 seeds in UE**

Re-run execute + Step 2 of Task 8 for seeds {1,3,5,9,17}. `SEALED_VAULT_OK` required for all five. Capture one extra screenshot (a different seed) to `validation/`.

- [ ] **Step 3: Commit validation artifacts**

```bash
git add tools/sealed_vault/validation/
git commit -m "test(sealed-vault): in-UE invariant + visual validation (5 seeds)"
```

---

## Task 10: Export graph snapshot + finalize

- [ ] **Step 1: Export the PCGEx graph**

Load: `ToolSearch select:mcp__hayba-toolkit__hayba_export_pcg_graph`
`hayba_export_pcg_graph` `PCG_SealedVault` → write `tools/sealed_vault/sealed_vault_graph.json`.

- [ ] **Step 2: Full offline test sweep**

Run: `python -m pytest tools/sealed_vault/ -q`
Expected: all pass (invariant fixtures, geometry, topology, 25-seed dungeon fuzz, determinism).

- [ ] **Step 3: Commit + finish branch**

```bash
git add tools/sealed_vault/sealed_vault_graph.json
git commit -m "feat(sealed-vault): export PCGEx graph snapshot; showcase complete"
```
Then invoke superpowers:finishing-a-development-branch for merge/PR options.

---

## Self-Review

**Spec coverage:** Core invariant → Task 1 (`invariant.py`) + Task 4 (construct-time) + Task 8 (in-UE). Pipeline stages 1–9 → Tasks 2–4 (oracle) mirrored by Tasks 5–7 (PCGEx). Execution via Hayba MCP + Plan Mode → Tasks 6, 8. Validation strategy (structural + topology + visual) → Tasks 8, 9. Testing (determinism, invariant fuzz 1..25, revert) → Tasks 2–4, 9; Plan-Mode Ctrl+Z covered by `hayba_propose_plan` transaction in Task 6. Out-of-scope items not implemented (no gameplay/3D/soft-locks). All spec sections map to a task.

**Placeholder scan:** No TBD/TODO; every Python step ships complete runnable code; MCP steps name exact tools + expected outputs + failure handling. Node names are resolved at runtime in Task 5 precisely to avoid guessed-name placeholders.

**Type consistency:** Dungeon dict shape `{rooms, points, entrance, boss, edges:[(u,v,lock)], rank, keys:{kid:room}, roles}` is identical across `invariant.assert_solvable`, `oracle.build_dungeon`, and the in-UE reader (Task 8). `build_topology` returns `tree_edges`/`loop_edges`; `build_dungeon` consumes them and emits unified `edges`. Names consistent across tasks.
