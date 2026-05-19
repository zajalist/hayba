import unreal, json, random, math
from collections import deque
R = {}
eas = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)

# ---- colored materials (constant base color) ----
def mkmat(name, col):
    try:
        path = '/Game/Hayba/SV'
        at = unreal.AssetToolsHelpers.get_asset_tools()
        full = path + '/' + name
        if unreal.EditorAssetLibrary.does_asset_exist(full):
            return unreal.load_asset(full)
        m = at.create_asset(name, path, unreal.Material, unreal.MaterialFactoryNew())
        n = unreal.MaterialEditingLibrary.create_material_expression(m, unreal.MaterialExpressionConstant3Vector)
        n.set_editor_property('constant', unreal.LinearColor(col[0], col[1], col[2], 1.0))
        unreal.MaterialEditingLibrary.connect_material_property(n, '', unreal.MaterialProperty.MP_BASE_COLOR)
        unreal.MaterialEditingLibrary.recompile_material(m)
        return m
    except Exception:
        return None

MAT = {
    'ground':   mkmat('M_SV_Ground',   (0.03, 0.03, 0.04)),
    'floor':    mkmat('M_SV_Floor',    (0.32, 0.30, 0.34)),
    'wall':     mkmat('M_SV_Wall',     (0.16, 0.15, 0.18)),
    'corridor': mkmat('M_SV_Corridor', (0.42, 0.40, 0.45)),
    'entrance': mkmat('M_SV_Entrance', (0.15, 0.70, 0.30)),
    'boss':     mkmat('M_SV_Boss',     (0.80, 0.12, 0.12)),
    'key':      mkmat('M_SV_Key',      (1.00, 0.78, 0.08)),
    'door':     mkmat('M_SV_Door',     (0.75, 0.10, 0.10)),
}

# ---- deterministic, provably-solvable dungeon (same SEED => same proven layout) ----
SEED, N, EXT, LOOP_K, N_KEYS = 5, 14, 4200.0, 3, 4
rng = random.Random(SEED)
pts = [(round(rng.uniform(0, EXT), 2), round(rng.uniform(0, EXT), 2)) for _ in range(N)]

def circ(a, b, c):
    ax, ay = a; bx, by = b; cx, cy = c
    d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    if abs(d) < 1e-9:
        return None
    ux = ((ax*ax+ay*ay)*(by-cy) + (bx*bx+by*by)*(cy-ay) + (cx*cx+cy*cy)*(ay-by)) / d
    uy = ((ax*ax+ay*ay)*(cx-bx) + (bx*bx+by*by)*(ax-cx) + (cx*cx+cy*cy)*(bx-ax)) / d
    return (ux, uy)

def inc(p, a, b, c):
    cc = circ(a, b, c)
    if cc is None:
        return False
    r2 = (a[0]-cc[0])**2 + (a[1]-cc[1])**2
    return (p[0]-cc[0])**2 + (p[1]-cc[1])**2 <= r2 + 1e-6

def delaunay(P):
    big = max(max(x, y) for x, y in P) * 10 + 1000
    S = [(-big, -big), (big, -big), (0, big)]
    A = P + S; si = len(P); T = [(si, si+1, si+2)]
    for pi in range(len(P)):
        bad = [t for t in T if inc(A[pi], A[t[0]], A[t[1]], A[t[2]])]
        eg = {}
        for t in bad:
            for e in ((t[0], t[1]), (t[1], t[2]), (t[2], t[0])):
                k = tuple(sorted(e)); eg[k] = eg.get(k, 0) + 1
        T = [t for t in T if t not in bad]
        for (x, y), c in eg.items():
            if c == 1:
                T.append((x, y, pi))
    o = set()
    for t in T:
        if any(v >= si for v in t):
            continue
        for x, y in ((t[0], t[1]), (t[1], t[2]), (t[2], t[0])):
            o.add((min(x, y), max(x, y)))
    return sorted(o)

def d2(p, q):
    return (p[0]-q[0])**2 + (p[1]-q[1])**2

de = delaunay(pts)
par = list(range(N))

def find(x):
    while par[x] != x:
        par[x] = par[par[x]]; x = par[x]
    return x

tree = []
for w, u, v in sorted((d2(pts[u], pts[v]), u, v) for u, v in de):
    if find(u) != find(v):
        par[find(u)] = find(v); tree.append((min(u, v), max(u, v)))
ts = set(tree)
loops = [(min(u, v), max(u, v)) for _, u, v in
         sorted((d2(pts[u], pts[v]), u, v) for u, v in de if (min(u, v), max(u, v)) not in ts)][:LOOP_K]
ent = min(range(N), key=lambda i: pts[i][0] + pts[i][1])
adj = {}
for u, v in tree + loops:
    adj.setdefault(u, []).append(v); adj.setdefault(v, []).append(u)
rank = {ent: 0}; q = deque([ent])
while q:
    c = q.popleft()
    for k in adj[c]:
        if k not in rank:
            rank[k] = rank[c] + 1; q.append(k)
boss = max(rank, key=rank.get)
pp = {ent: None}; q = deque([ent]); at = {}
for u, v in tree:
    at.setdefault(u, []).append(v); at.setdefault(v, []).append(u)
while q:
    c = q.popleft()
    for k in at.get(c, []):
        if k not in pp:
            pp[k] = c; q.append(k)
path = []; cur = boss
while pp[cur] is not None:
    path.append((pp[cur], cur)); cur = pp[cur]
path.reverse()
nk = min(N_KEYS, len(path)) or 1
idx = sorted(set(round(i*(len(path)-1)/(nk-1)) for i in range(nk))) if nk > 1 else [len(path)-1]
le = [path[i] for i in idx]
locks = {(min(u, v), max(u, v)): kid for kid, (u, v) in enumerate(le, 1)}
edges = [(u, v, locks.get((min(u, v), max(u, v)), -1)) for u, v in tree + loops]
kr = random.Random(SEED * 1000 + 17)
keys = {}
for (u, v), kid in locks.items():
    nr = u if rank[u] <= rank[v] else v
    cand = sorted(r for r in range(N) if rank[r] <= rank[nr] and r != boss)
    keys[kid] = cand[kr.randrange(len(cand))]
roles = {r: "hub" for r in range(N)}
roles[ent] = "entrance"; roles[boss] = "boss"
keyroom = {v: k for k, v in keys.items()}

def assert_solvable(rooms, e, b, E, K):
    A = {}
    for u, v, l in E:
        A.setdefault(u, []).append((v, l)); A.setdefault(v, []).append((u, l))
    held = set(); reach = {e}; prog = True
    while prog:
        prog = False
        for cu in list(reach):
            for kid, room in K.items():
                if room == cu and kid not in held:
                    held.add(kid); prog = True
            for nx, l in A.get(cu, []):
                if nx not in reach and (l == -1 or l in held):
                    reach.add(nx); prog = True
    if b not in reach:
        raise AssertionError("boss unreachable")
    m = set(rooms) - reach
    if m:
        raise AssertionError("unreachable %s" % sorted(m))

ok = True; err = None
try:
    assert_solvable(list(range(N)), ent, boss, edges, keys)
except AssertionError as ex:
    ok = False; err = str(ex)

# ---- render as a top-down dungeon ----
for ac in list(eas.get_all_level_actors()):
    try:
        if ac.get_actor_label().startswith('SVx_'):
            eas.destroy_actor(ac)
    except Exception:
        pass
CUBE = unreal.load_asset('/Engine/BasicShapes/Cube.Cube')

def box(cx, cy, cz, sx, sy, sz, mat, label, yaw=0.0):
    a = eas.spawn_actor_from_class(unreal.StaticMeshActor, unreal.Vector(cx, cy, cz))
    mc = a.get_component_by_class(unreal.StaticMeshComponent)
    mc.set_static_mesh(CUBE)
    a.set_actor_scale3d(unreal.Vector(sx/100.0, sy/100.0, sz/100.0))
    if yaw:
        a.set_actor_rotation(unreal.Rotator(0, 0, yaw), False)
    if mat:
        mc.set_material(0, mat)
    a.set_actor_label(label)
    return a

# ground slab
box(EXT/2, EXT/2, -30, EXT+1600, EXT+1600, 40, MAT['ground'], 'SVx_ground')

ROOM = {'hub': 360, 'entrance': 440, 'boss': 560, 'key': 360}
WALL_H = 130
WALL_T = 28

# corridors first (so room walls/floors sit on top cleanly)
for u, v, l in edges:
    ax, ay = pts[u]; bx, by = pts[v]
    mx, my = (ax+bx)/2, (ay+by)/2
    L = math.hypot(bx-ax, by-ay)
    ang = math.degrees(math.atan2(by-ay, bx-ax))
    box(mx, my, 6, L, 150, 12, MAT['corridor'], 'SVx_corr_%d_%d' % (u, v), ang)
    if l != -1:
        # a locked door: red slab across the corridor
        box(mx, my, 70, 60, 200, 150, MAT['door'], 'SVx_door_k%d_%d_%d' % (l, u, v), ang)

# rooms: floor tile + 4 perimeter walls, colored by role
for i in range(N):
    rl = roles[i]; x, y = pts[i]; hs = ROOM[rl] / 2.0
    fmat = MAT.get(rl, MAT['floor']) if rl in ('entrance', 'boss') else MAT['floor']
    box(x, y, 10, ROOM[rl], ROOM[rl], 16, fmat, 'SVx_room_%s_%d' % (rl, i))
    for dx, dy, sx, sy in ((0, hs, ROOM[rl], WALL_T), (0, -hs, ROOM[rl], WALL_T),
                           (hs, 0, WALL_T, ROOM[rl]), (-hs, 0, WALL_T, ROOM[rl])):
        box(x+dx, y+dy, WALL_H/2.0, sx, sy, WALL_H, MAT['wall'], 'SVx_wall_%d' % i)
    if i in keyroom:
        box(x, y, 90, 70, 70, 70, MAT['key'], 'SVx_key_k%d_%d' % (keyroom[i], i))

R["dungeon"] = {"rooms": N, "edges": len(edges), "locked": len(locks), "entrance": ent,
                "boss": boss, "max_rank": max(rank.values()),
                "keys": {str(k): v for k, v in keys.items()},
                "lock_edges": [list(x) for x in le], "solvable": ok, "error": err}
R["status"] = "SEALED_VAULT_OK" if ok else "SEALED_VAULT_FAIL"
unreal.log_warning('SVRESULT ' + json.dumps(R))
