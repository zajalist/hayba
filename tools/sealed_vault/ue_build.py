import unreal, json, random, math
from collections import deque
R = {}
eas = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)


def mkmat(name, col, emis):
    try:
        path = '/Game/Hayba/SV'
        full = path + '/' + name
        if unreal.EditorAssetLibrary.does_asset_exist(full):
            return unreal.load_asset(full)
        at = unreal.AssetToolsHelpers.get_asset_tools()
        m = at.create_asset(name, path, unreal.Material, unreal.MaterialFactoryNew())
        b = unreal.MaterialEditingLibrary.create_material_expression(m, unreal.MaterialExpressionConstant3Vector)
        b.set_editor_property('constant', unreal.LinearColor(col[0], col[1], col[2], 1.0))
        unreal.MaterialEditingLibrary.connect_material_property(b, '', unreal.MaterialProperty.MP_BASE_COLOR)
        e = unreal.MaterialEditingLibrary.create_material_expression(m, unreal.MaterialExpressionConstant3Vector)
        e.set_editor_property('constant', unreal.LinearColor(col[0]*emis, col[1]*emis, col[2]*emis, 1.0))
        unreal.MaterialEditingLibrary.connect_material_property(e, '', unreal.MaterialProperty.MP_EMISSIVE_COLOR)
        unreal.MaterialEditingLibrary.recompile_material(m)
        return m
    except Exception:
        return None


MAT = {
    'ground':   mkmat('M_SV_Ground',   (0.014, 0.014, 0.018), 0.35),
    'floor':    mkmat('M_SV_Floor',    (0.34, 0.32, 0.38), 0.75),
    'rim':      mkmat('M_SV_Rim',      (0.12, 0.12, 0.16), 0.5),
    'corridor': mkmat('M_SV_Corridor', (0.50, 0.47, 0.55), 0.85),
    'entrance': mkmat('M_SV_Entrance', (0.10, 0.85, 0.35), 1.7),
    'boss':     mkmat('M_SV_Boss',     (0.95, 0.13, 0.13), 1.7),
    'key':      mkmat('M_SV_Key',      (1.00, 0.80, 0.05), 2.8),
    'door':     mkmat('M_SV_Door',     (0.98, 0.22, 0.10), 2.4),
}

SEED, N, EXT, LOOP_K, N_KEYS = 5, 14, 5200.0, 3, 4
ROOM = {'hub': 380, 'entrance': 480, 'boss': 640, 'key': 400}
rng = random.Random(SEED)
pts = [[round(rng.uniform(0, EXT), 2), round(rng.uniform(0, EXT), 2)] for _ in range(N)]

# --- relax points apart so fixed-size rooms never overlap ---
MIN_D = max(ROOM.values()) * 1.7
for _ in range(160):
    moved = False
    for i in range(N):
        for j in range(i + 1, N):
            dx = pts[j][0] - pts[i][0]; dy = pts[j][1] - pts[i][1]
            dist = math.hypot(dx, dy) or 0.01
            if dist < MIN_D:
                push = (MIN_D - dist) / 2.0
                ux, uy = dx / dist, dy / dist
                pts[i][0] -= ux * push; pts[i][1] -= uy * push
                pts[j][0] += ux * push; pts[j][1] += uy * push
                moved = True
    for p in pts:
        p[0] = min(max(p[0], 0), EXT * 1.5)
        p[1] = min(max(p[1], 0), EXT * 1.5)
    if not moved:
        break
pts = [(round(x, 2), round(y, 2)) for x, y in pts]


def circ(a, b, c):
    ax, ay = a; bx, by = b; cx, cy = c
    d = 2 * (ax*(by-cy) + bx*(cy-ay) + cx*(ay-by))
    if abs(d) < 1e-9:
        return None
    ux = ((ax*ax+ay*ay)*(by-cy) + (bx*bx+by*by)*(cy-ay) + (cx*cx+cy*cy)*(ay-by)) / d
    uy = ((ax*ax+ay*ay)*(cx-bx) + (bx*bx+by*by)*(ax-cx) + (cx*cx+cy*cy)*(bx-ax)) / d
    return (ux, uy)


def incc(p, a, b, c):
    cc = circ(a, b, c)
    if cc is None:
        return False
    r2 = (a[0]-cc[0])**2 + (a[1]-cc[1])**2
    return (p[0]-cc[0])**2 + (p[1]-cc[1])**2 <= r2 + 1e-6


def delaunay(P):
    big = max(max(x, y) for x, y in P) * 10 + 1000
    S = [(-big, -big), (big, -big), (0, big)]
    A = list(P) + S; si = len(P); T = [(si, si+1, si+2)]
    for pi in range(len(P)):
        bad = [t for t in T if incc(A[pi], A[t[0]], A[t[1]], A[t[2]])]
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
tset = set(tree)
loops = [(min(u, v), max(u, v)) for _, u, v in
         sorted((d2(pts[u], pts[v]), u, v) for u, v in de if (min(u, v), max(u, v)) not in tset)][:LOOP_K]
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

for ac in list(eas.get_all_level_actors()):
    try:
        lbl = ac.get_actor_label()
        if lbl.startswith('SVx_') or lbl.startswith('SVlight_'):
            eas.destroy_actor(ac)
        elif 'Landscape' in ac.get_class().get_name() or lbl.startswith('Floor'):
            # reversible: hide the World-Partition landscape/default floor so the
            # dark backdrop shows. Un-hide via the Outliner eye icon.
            ac.set_is_temporarily_hidden_in_editor(True)
    except Exception:
        pass
# fixed exposure so emissive colors read crisp (no auto-exposure wash)
unreal.SystemLibrary.execute_console_command(unreal.EditorLevelLibrary.get_editor_world(), 'r.EyeAdaptationQuality 0')
CUBE = unreal.load_asset('/Engine/BasicShapes/Cube.Cube')
CYL = unreal.load_asset('/Engine/BasicShapes/Cylinder.Cylinder')


def box(mesh, cx, cy, cz, sx, sy, sz, mat, label, yaw=0.0):
    a = eas.spawn_actor_from_class(unreal.StaticMeshActor, unreal.Vector(cx, cy, cz))
    mc = a.get_component_by_class(unreal.StaticMeshComponent)
    mc.set_static_mesh(mesh)
    a.set_actor_scale3d(unreal.Vector(sx/100.0, sy/100.0, sz/100.0))
    if yaw:
        a.set_actor_rotation(unreal.Rotator(0, 0, yaw), False)
    if mat:
        mc.set_material(0, mat)
    a.set_actor_label(label)
    return a


xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
cx, cy = (min(xs)+max(xs))/2.0, (min(ys)+max(ys))/2.0
# true content extent incl. room footprints, small margin
ext = max(max(xs)-min(xs), max(ys)-min(ys)) + max(ROOM.values()) + 350
# straight-down cam: editor hFOV ~90deg, shot is 4:3 so vertical FOV limits.
# half-vFOV ~ 36.9deg (tan ~0.75) => H = (ext/2)/0.75, *1.18 for margin
cam_h = (ext / 2.0) / 0.75 * 1.18
# dark backdrop sized to fully cover the top-down frustum (kills default grid)
GROUND = cam_h * 2.6
box(CUBE, cx, cy, -25, GROUND, GROUND, 40, MAT['ground'], 'SVx_ground')

CORR_W = 150
# corridors: clipped to stop at each room's edge (no shooting through rooms)
for u, v, l in edges:
    ax, ay = pts[u]; bx, by = pts[v]
    dx, dy = bx-ax, by-ay
    D = math.hypot(dx, dy) or 1.0
    ux, uy = dx/D, dy/D
    ha = ROOM[roles[u]]/2.0 - 10
    hb = ROOM[roles[v]]/2.0 - 10
    sxp, syp = ax+ux*ha, ay+uy*ha
    exp, eyp = bx-ux*hb, by-uy*hb
    L = math.hypot(exp-sxp, eyp-syp)
    if L < 40:
        continue
    mx, my = (sxp+exp)/2.0, (syp+eyp)/2.0
    ang = math.degrees(math.atan2(eyp-syp, exp-sxp))
    box(CUBE, mx, my, 6, L, CORR_W, 14, MAT['corridor'], 'SVx_corr_%d_%d' % (u, v), ang)
    if l != -1:
        # door sits at the corridor mouth of the deeper (locked-side) room
        far = v if rank[v] >= rank[u] else u
        fx, fy = pts[far]
        hf = ROOM[roles[far]]/2.0
        dxm, dym = fx-mx, fy-my
        dd = math.hypot(dxm, dym) or 1.0
        doorx = fx - (dxm/dd)*hf
        doory = fy - (dym/dd)*hf
        box(CUBE, doorx, doory, 70, 60, CORR_W+40, 150, MAT['door'], 'SVx_door_k%d_%d_%d' % (l, u, v), ang)

# rooms: open floor tile + thin low rim (no sealing walls -> corridors connect visibly)
for i in range(N):
    rl = roles[i]; x, y = pts[i]; s = ROOM[rl]
    fmat = MAT['entrance'] if rl == 'entrance' else (MAT['boss'] if rl == 'boss' else MAT['floor'])
    box(CUBE, x, y, 12, s, s, 22, fmat, 'SVx_room_%s_%d' % (rl, i))
    rim = 26
    for dx, dy, sx, sy in ((0, s/2.0, s, rim), (0, -s/2.0, s, rim),
                           (s/2.0, 0, rim, s), (-s/2.0, 0, rim, s)):
        box(CUBE, x+dx, y+dy, 34, sx, sy, 60, MAT['rim'], 'SVx_rim_%d' % i)
    if i in keyroom:
        box(CYL, x, y, 150, 150, 150, 230, MAT['key'], 'SVx_key_k%d_%d' % (keyroom[i], i))

dl = eas.spawn_actor_from_class(unreal.DirectionalLight, unreal.Vector(cx, cy, 5000))
dl.set_actor_rotation(unreal.Rotator(0, -60, 30), False)
dl.set_actor_label('SVlight_dir')
try:
    dl.get_component_by_class(unreal.DirectionalLightComponent).set_intensity(2.0)
except Exception:
    pass

unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).set_level_viewport_camera_info(
    unreal.Vector(cx, cy, cam_h), unreal.Rotator(0, -90, 0))

R["dungeon"] = {"rooms": N, "edges": len(edges), "locked": len(locks), "entrance": ent,
                "boss": boss, "max_rank": max(rank.values()),
                "keys": {str(k): v for k, v in keys.items()},
                "lock_edges": [list(x) for x in le], "solvable": ok, "error": err,
                "min_pair_dist": round(min(math.hypot(pts[i][0]-pts[j][0], pts[i][1]-pts[j][1])
                                           for i in range(N) for j in range(i+1, N)), 1)}
R["status"] = "SEALED_VAULT_OK" if ok else "SEALED_VAULT_FAIL"
unreal.log_warning('SVRESULT ' + json.dumps(R))
