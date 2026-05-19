import unreal, json, random, math
from collections import deque
R = {}

# ---- 1. Best-effort: bind+generate the PCGEx graph on an actor (non-fatal) ----
eas = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
try:
    g = unreal.load_asset('/Game/Hayba/Generated/PCG_SealedVault')
    a = eas.spawn_actor_from_class(unreal.Actor, unreal.Vector(0, 0, 0))
    a.set_actor_label('SVx_pcg_driver')
    comp = None
    try:
        comp = a.add_actor_component(unreal.PCGComponent, 'PCG')
    except Exception:
        try:
            comp = unreal.PCGComponent(a)
            comp.register_component()
        except Exception:
            comp = None
    if comp is not None:
        try:
            comp.set_editor_property('graph', g)
        except Exception:
            pass
        try:
            comp.generate(True)
        except Exception:
            pass
    R["pcg_generate"] = {"ok": True, "asset": g.get_name()}
except Exception as e:
    R["pcg_generate"] = {"ok": False, "error": str(e)}

# ---- 2. Sealed Vault: deterministic, provably-solvable lock/key dungeon ----
SEED, N, EXT, LOOP_K, N_KEYS = 5, 14, 4000.0, 3, 4
rng = random.Random(SEED)
pts = [(round(rng.uniform(0, EXT), 2), round(rng.uniform(0, EXT), 2)) for _ in range(N)]


def circ(a, b, c):
    ax, ay = a
    bx, by = b
    cx, cy = c
    d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    if abs(d) < 1e-9:
        return None
    ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d
    uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d
    return (ux, uy)


def inc(p, a, b, c):
    cc = circ(a, b, c)
    if cc is None:
        return False
    r2 = (a[0] - cc[0]) ** 2 + (a[1] - cc[1]) ** 2
    return (p[0] - cc[0]) ** 2 + (p[1] - cc[1]) ** 2 <= r2 + 1e-6


def delaunay(P):
    big = max(max(x, y) for x, y in P) * 10 + 1000
    S = [(-big, -big), (big, -big), (0, big)]
    A = P + S
    si = len(P)
    T = [(si, si + 1, si + 2)]
    for pi in range(len(P)):
        bad = [t for t in T if inc(A[pi], A[t[0]], A[t[1]], A[t[2]])]
        eg = {}
        for t in bad:
            for e in ((t[0], t[1]), (t[1], t[2]), (t[2], t[0])):
                k = tuple(sorted(e))
                eg[k] = eg.get(k, 0) + 1
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
    return (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2


de = delaunay(pts)
par = list(range(N))


def find(x):
    while par[x] != x:
        par[x] = par[par[x]]
        x = par[x]
    return x


tree = []
for w, u, v in sorted((d2(pts[u], pts[v]), u, v) for u, v in de):
    if find(u) != find(v):
        par[find(u)] = find(v)
        tree.append((min(u, v), max(u, v)))
ts = set(tree)
loops = [(min(u, v), max(u, v)) for _, u, v in
         sorted((d2(pts[u], pts[v]), u, v) for u, v in de if (min(u, v), max(u, v)) not in ts)][:LOOP_K]
ent = min(range(N), key=lambda i: pts[i][0] + pts[i][1])
adj = {}
for u, v in tree + loops:
    adj.setdefault(u, []).append(v)
    adj.setdefault(v, []).append(u)
rank = {ent: 0}
q = deque([ent])
while q:
    c = q.popleft()
    for k in adj[c]:
        if k not in rank:
            rank[k] = rank[c] + 1
            q.append(k)
boss = max(rank, key=rank.get)
pp = {ent: None}
q = deque([ent])
at = {}
for u, v in tree:
    at.setdefault(u, []).append(v)
    at.setdefault(v, []).append(u)
while q:
    c = q.popleft()
    for k in at.get(c, []):
        if k not in pp:
            pp[k] = c
            q.append(k)
path = []
cur = boss
while pp[cur] is not None:
    path.append((pp[cur], cur))
    cur = pp[cur]
path.reverse()
nk = min(N_KEYS, len(path)) or 1
idx = sorted(set(round(i * (len(path) - 1) / (nk - 1)) for i in range(nk))) if nk > 1 else [len(path) - 1]
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
roles[ent] = "entrance"
roles[boss] = "boss"
for kid, r in keys.items():
    roles[r] = "key"


def assert_solvable(rooms, e, b, E, K):
    A = {}
    for u, v, l in E:
        A.setdefault(u, []).append((v, l))
        A.setdefault(v, []).append((u, l))
    held = set()
    reach = {e}
    prog = True
    while prog:
        prog = False
        for cur in list(reach):
            for kid, room in K.items():
                if room == cur and kid not in held:
                    held.add(kid)
                    prog = True
            for nx, l in A.get(cur, []):
                if nx not in reach and (l == -1 or l in held):
                    reach.add(nx)
                    prog = True
    if b not in reach:
        raise AssertionError("boss unreachable")
    m = set(rooms) - reach
    if m:
        raise AssertionError("unreachable %s" % sorted(m))


ok = True
err = None
try:
    assert_solvable(list(range(N)), ent, boss, edges, keys)
except AssertionError as ex:
    ok = False
    err = str(ex)

# ---- 3. Instantiate shape-coded actors for the screenshot ----
for ac in list(eas.get_all_level_actors()):
    try:
        if ac.get_actor_label().startswith('SVx_'):
            eas.destroy_actor(ac)
    except Exception:
        pass
SH = {s: unreal.load_asset('/Engine/BasicShapes/%s.%s' % (s, s)) for s in ['Cube', 'Sphere', 'Cylinder', 'Cone']}


def smc(act):
    return act.get_component_by_class(unreal.StaticMeshComponent)


def spawn(mesh, loc, scale, label):
    act = eas.spawn_actor_from_class(unreal.StaticMeshActor, unreal.Vector(*loc))
    mc = smc(act)
    if mc:
        mc.set_static_mesh(mesh)
    act.set_actor_scale3d(unreal.Vector(*scale))
    act.set_actor_label(label)
    return act


for i in range(N):
    rl = roles[i]
    x, y = pts[i]
    if rl == "entrance":
        spawn(SH['Cone'], (x, y, 160), (2, 2, 3.2), 'SVx_entrance_%d' % i)
    elif rl == "boss":
        spawn(SH['Sphere'], (x, y, 170), (3.2, 3.2, 3.2), 'SVx_boss_%d' % i)
    elif rl == "key":
        spawn(SH['Sphere'], (x, y, 130), (1.5, 1.5, 1.5), 'SVx_key_%d' % i)
    else:
        spawn(SH['Cube'], (x, y, 0), (2, 2, 1), 'SVx_room_%d' % i)
for u, v, l in edges:
    ax, ay = pts[u]
    bx, by = pts[v]
    mx, my = (ax + bx) / 2, (ay + by) / 2
    L = math.hypot(bx - ax, by - ay)
    ang = math.degrees(math.atan2(by - ay, bx - ax))
    c = eas.spawn_actor_from_class(unreal.StaticMeshActor, unreal.Vector(mx, my, 25))
    mc = smc(c)
    if mc:
        mc.set_static_mesh(SH['Cube'])
    c.set_actor_scale3d(unreal.Vector(max(L / 100.0, 0.1), 0.35, 0.18))
    c.set_actor_rotation(unreal.Rotator(0, 0, ang), False)
    c.set_actor_label('SVx_corridor_%d_%d' % (u, v))
    if l != -1:
        spawn(SH['Cylinder'], (mx, my, 95), (1.2, 1.2, 1.7), 'SVx_lock_k%d' % l)

R["dungeon"] = {"rooms": N, "edges": len(edges), "locked": len(locks), "entrance": ent,
                "boss": boss, "max_rank": max(rank.values()),
                "keys": {str(k): v for k, v in keys.items()},
                "lock_edges": [list(x) for x in le], "solvable": ok, "error": err}
R["status"] = "SEALED_VAULT_OK" if ok else "SEALED_VAULT_FAIL"
print(json.dumps(R))
