"""Solvability invariant. Stdlib only - runs in pytest AND the UE python sandbox."""
from collections import deque


class SolvabilityError(Exception):
    pass


def assert_solvable(d):
    """Raise SolvabilityError unless every key is collectable before its lock,
    and the boss room is reachable from the entrance."""
    rooms = set(d["rooms"])
    entrance = d["entrance"]
    boss = d["boss"]
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
                    held.add(kid)
                    progressed = True
            for nxt, lock in adj.get(cur, []):
                if nxt in reached:
                    continue
                if lock == -1 or lock in held:
                    reached.add(nxt)
                    q.append(nxt)
                    progressed = True
    if boss not in reached:
        raise SolvabilityError(
            f"boss {boss} unreachable; reached={sorted(reached)}")
    missing = rooms - reached
    if missing:
        raise SolvabilityError(f"unreachable rooms {sorted(missing)}")
