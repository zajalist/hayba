"""Shared editor lock plus PIE wait, so parallel agents and the user's play-testing never collide.

    python Tools/GameFlow/editor_gate.py acquire --owner V1 [--scope world:/Game/Maps/L1 ...]
                                         [--timeout-min 60] [--ttl-min 30] [--lane interactive|long]
    python Tools/GameFlow/editor_gate.py release --owner V1
    python Tools/GameFlow/editor_gate.py token   --owner V1      # prints the lease token only
    python Tools/GameFlow/editor_gate.py status

Two backends, chosen per call:

* Hayba leases, when the editor's Hayba plugin answers `ping` with
  capabilities.lease_manager (docs/adr/0010 in the Hayba repo). acquire is
  lease_acquire, release is lease_release. No --scope means the whole editor
  (global, exclusive); --scope world:<pkg> | wp-region:<pkg>:<minX>,<minY>,<maxX>,<maxY>
  | actor:<path> | asset:<path> narrows it, so agents on different regions run
  side by side. The token is printed as HAYBA_LEASE=<token>; pass it as the
  envelope `lease` field (Hayba's Node server reads HAYBA_LEASE_TOKEN). The
  editor caps a lease at 15 minutes: re-run acquire with the same owner to
  renew it, as before. The lease is not bound to this short-lived connection.
* The file lock (lock.json, O_EXCL), unchanged, when the editor is not running
  or its plugin predates leases.

lock.json is kept as a mirror in both modes so `status` works without an
editor, and so a file lock taken while the editor was down still blocks a
lease acquire (and the other way round). The editor is the authority in lease
mode; the mirror is best effort.

Environment: EDITOR_GATE_DIR, EDITOR_LOG (as before), HB_PORT (Hayba port,
default 52342), HAYBA_AUTH (capability token, if the project sets one),
EDITOR_GATE_MODE=auto|file|lease (default auto).
"""
import argparse, json, os, pathlib, socket, struct, sys, time

ROOT = pathlib.Path(__file__).resolve().parents[2]
GATE_DIR = pathlib.Path(os.environ.get("EDITOR_GATE_DIR", ROOT / "Saved" / "EditorGate"))
LOG = pathlib.Path(os.environ.get("EDITOR_LOG", ROOT / "Saved" / "Logs" / "saskartarad.log"))
LOCK = GATE_DIR / "lock.json"
PORT = int(os.environ.get("HB_PORT", 52342))
MAX_LEASE_TTL_S = 900
SCOPE_PREFIXES = ("world:", "wp-region:", "actor:", "asset:")


def pie_running():
    text = LOG.read_text(encoding="utf-8", errors="replace") if LOG.exists() else ""
    return text.rfind("Creating play world package") > text.rfind("Shutting down PIE")


# ----------------------------------------------------------------------------- lock.json mirror

def read_lock():
    if not LOCK.exists():
        return None
    try_text = LOCK.read_text(encoding="utf-8")
    return json.loads(try_text) if try_text.strip() else None


def write_lock(data):
    GATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = LOCK.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    os.replace(tmp, LOCK)


def take(owner, ttl_min):
    GATE_DIR.mkdir(parents=True, exist_ok=True)
    now = time.time()
    data = json.dumps({"owner": owner, "acquired_at": now, "expires_at": now + ttl_min * 60})
    fd = os.open(LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(data)


def renew(lock, ttl_min):
    """The holder re-acquiring extends its expiry in place, so it never has to release and lose its turn."""
    lock["expires_at"] = max(lock["expires_at"], time.time() + ttl_min * 60)
    write_lock(lock)


def live_file_lock_of_other(owner):
    """A file-mode lock (taken while the editor was down) held by someone else, or None."""
    lock = read_lock()
    if lock and lock.get("mode") != "lease" and lock["owner"] != owner and lock["expires_at"] >= time.time():
        return lock
    return None


def mirror_grant(owner, token, resources, expires_in_s):
    lock = read_lock() or {}
    if lock.get("mode") != "lease":
        lock = {"mode": "lease", "holders": {}}
    now = time.time()
    holders = {o: h for o, h in lock.get("holders", {}).items() if h["expires_at"] >= now}
    prior = holders.get(owner, {})
    holders[owner] = {"token": token, "resources": resources,
                      "acquired_at": prior.get("acquired_at", now), "expires_at": now + expires_in_s}
    first = min(holders, key=lambda o: holders[o]["acquired_at"])
    write_lock({"mode": "lease", "owner": first, "acquired_at": holders[first]["acquired_at"],
                "expires_at": max(h["expires_at"] for h in holders.values()), "port": PORT, "holders": holders})


def mirror_drop(owner):
    lock = read_lock()
    if not lock or lock.get("mode") != "lease":
        return
    holders = {o: h for o, h in lock.get("holders", {}).items() if o != owner and h["expires_at"] >= time.time()}
    if not holders:
        LOCK.unlink(missing_ok=True)
        return
    first = min(holders, key=lambda o: holders[o]["acquired_at"])
    lock.update(owner=first, acquired_at=holders[first]["acquired_at"],
                expires_at=max(h["expires_at"] for h in holders.values()), holders=holders)
    write_lock(lock)


def mirrored_token(owner):
    lock = read_lock()
    if lock and lock.get("mode") == "lease":
        held = lock.get("holders", {}).get(owner)
        if held:
            return held["token"]
    return None


# ----------------------------------------------------------------------------- Hayba transport

class HaybaError(Exception):
    """The editor answered, and said no."""


def hayba(cmd, params, owner=None, lease=None, timeout_s=10.0):
    """One framed request on its own connection. Returns data; raises HaybaError on ok:false,
    OSError when nothing is listening."""
    envelope = {"cmd": cmd, "id": f"editor_gate_{os.getpid()}_{time.monotonic_ns()}", "params": params}
    if owner:
        envelope["owner"] = owner
    if lease:
        envelope["lease"] = lease
    if os.environ.get("HAYBA_AUTH"):
        envelope["auth"] = os.environ["HAYBA_AUTH"]
    payload = json.dumps(envelope).encode("utf-8")
    with socket.create_connection(("127.0.0.1", PORT), timeout=timeout_s) as s:
        s.sendall(struct.pack(">I", len(payload)) + payload)
        body = _recv_exact(s, struct.unpack(">I", _recv_exact(s, 4))[0])
    msg = json.loads(body.decode("utf-8"))
    if not msg.get("ok"):
        raise HaybaError(msg.get("error") or "Hayba refused the request")
    return msg.get("data") or {}


def _recv_exact(s, n):
    buf = b""
    while len(buf) < n:
        chunk = s.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("Hayba closed the connection")
        buf += chunk
    return buf


def lease_manager_available():
    mode = os.environ.get("EDITOR_GATE_MODE", "auto")
    if mode in ("file", "lease"):
        return mode == "lease"
    try:
        caps = hayba("ping", {}, timeout_s=3.0).get("capabilities") or {}
    except (OSError, ValueError, HaybaError):
        return False
    return bool(caps.get("lease_manager"))


# ----------------------------------------------------------------------------- file backend (unchanged)

def acquire_file(owner, timeout_min, ttl_min):
    deadline = time.monotonic() + timeout_min * 60
    reason = ""
    while True:
        lock = read_lock()
        if lock and lock["expires_at"] < time.time():
            LOCK.unlink(missing_ok=True)
            lock = None
        if pie_running():
            reason = "PIE is running"
        elif lock and lock["owner"] != owner:
            reason = f"held by {lock['owner']}"
        else:
            if not lock:
                try:
                    take(owner, ttl_min)
                except FileExistsError:
                    continue
            elif lock.get("mode") == "lease":
                # Only our own lease mirror is left and the editor is not
                # answering (an editor restart forgets every lease anyway):
                # hold the editor with a file lock instead.
                LOCK.unlink(missing_ok=True)
                continue
            else:
                renew(lock, ttl_min)
            print(f"acquired by {owner}", flush=True)
            return 0
        if time.monotonic() >= deadline:
            print(f"timeout: {reason}", flush=True)
            return 1
        time.sleep(2)


def release_file(owner):
    lock = read_lock()
    if lock and lock["owner"] != owner:
        print(f"refused: held by {lock['owner']}")
        return 1
    LOCK.unlink(missing_ok=True)
    print("released")
    return 0


# ----------------------------------------------------------------------------- lease backend

def announce(owner, token, resources, expires_in_s, capped):
    what = ", ".join(resources)
    note = f" (the editor caps leases at {MAX_LEASE_TTL_S // 60} min; re-run acquire to renew)" if capped else ""
    print(f"acquired by {owner} (lease on {what}, expires in {int(expires_in_s)} s){note}", flush=True)
    print(f"HAYBA_LEASE={token}", flush=True)


def acquire_lease(owner, timeout_min, ttl_min, scopes, lane):
    resources = scopes or ["global"]
    ttl_s = max(5, min(MAX_LEASE_TTL_S, int(ttl_min * 60)))
    capped = ttl_min * 60 > MAX_LEASE_TTL_S

    # The same owner re-acquiring renews in place, as the file lock did.
    token = mirrored_token(owner)
    if token:
        try:
            data = hayba("lease_renew", {"token": token, "ttl_s": ttl_s}, owner=owner)
            announce(owner, token, resources, data.get("expires_in_s", ttl_s), capped)
            mirror_grant(owner, token, resources, data.get("expires_in_s", ttl_s))
            return 0
        except HaybaError:
            mirror_drop(owner)  # lapsed: ask again below

    deadline = time.monotonic() + timeout_min * 60
    ticket, held, poll_after, reason = None, None, 2.0, ""
    while True:
        other = live_file_lock_of_other(owner)
        pie = pie_running()
        if other:
            reason = f"held by {other['owner']} (file lock taken while the editor was down)"
        elif held is None and (ticket or not pie):
            # While PIE runs we keep polling a ticket we already have, so we keep
            # our place in the queue, but we do not start queueing.
            params = {"ticket": ticket} if ticket else {
                "resources": resources, "mode": "exclusive", "ttl_s": ttl_s, "lane": lane,
                "label": f"editor_gate:{owner}", "bind_connection": False}
            try:
                data = hayba("lease_acquire", params, owner=owner)
            except HaybaError as e:
                if ticket and "ticket" in str(e):
                    ticket = None  # the queue dropped it; ask again
                    continue
                print(f"refused: {e}", flush=True)
                return 2
            if data.get("status") == "granted":
                held = data
            else:
                ticket = data.get("ticket")
                poll_after = float(data.get("poll_after_s", 2.0))
                reason = f"held by {data.get('holder_owner') or 'another agent'}"
                if data.get("position"):
                    reason += f" (queue position {data['position']})"
        if held is not None and not pie_running():
            expires_in_s = held.get("expires_in_s", ttl_s)
            announce(owner, held["token"], resources, expires_in_s, capped)
            mirror_grant(owner, held["token"], resources, expires_in_s)
            return 0
        if pie and not other:
            reason = "PIE is running"
        if time.monotonic() >= deadline:
            # Leave nothing behind: withdraw the ticket, or give back a lease PIE kept us from using.
            leftover = held["token"] if held else ticket
            if leftover:
                try:
                    hayba("lease_release", {"token": leftover}, owner=owner)
                except (OSError, HaybaError):
                    pass
            print(f"timeout: {reason}", flush=True)
            return 1
        wait = poll_after if (ticket and held is None and not other) else 2.0
        time.sleep(max(0.05, min(wait, 10.0, max(0.0, deadline - time.monotonic()))))


def release_lease(owner, token):
    token = token or os.environ.get("HAYBA_LEASE") or mirrored_token(owner)
    if not token:
        lock = read_lock()
        if lock and lock.get("mode") != "lease":
            return release_file(owner)  # a file lock from before the editor came up
        print("released (nothing held)")
        return 0
    try:
        hayba("lease_release", {"token": token}, owner=owner)
    except HaybaError as e:
        if "belongs to" in str(e):
            print(f"refused: {e}")
            return 1
        print(f"released (the lease had already lapsed: {e})")
        mirror_drop(owner)
        return 0
    mirror_drop(owner)
    print("released")
    return 0


def status():
    lock = read_lock()
    if lease_manager_available():
        try:
            print(json.dumps({"editor": hayba("lease_status", {}), "mirror": lock}))
            return 0
        except (OSError, HaybaError):
            pass
    print(json.dumps(lock) if lock else "free")
    return 0


# ----------------------------------------------------------------------------- CLI

def main():
    p = argparse.ArgumentParser()
    p.add_argument("cmd", choices=["acquire", "release", "status", "token"])
    p.add_argument("--owner", default="")
    p.add_argument("--timeout-min", type=float, default=60)
    p.add_argument("--ttl-min", type=float, default=30)
    p.add_argument("--scope", action="append", default=[],
                   help="narrow the lease: world:<pkg> | wp-region:<pkg>:<minX>,<minY>,<maxX>,<maxY> | actor:<path> | asset:<path>")
    p.add_argument("--lane", choices=["interactive", "long"], default="interactive")
    p.add_argument("--token", default="", help="release: the lease token (default: HAYBA_LEASE, then the mirror)")
    a = p.parse_args()
    bad = [s for s in a.scope if not s.startswith(SCOPE_PREFIXES)]
    if bad:
        print(f"bad --scope {bad[0]!r}: expected one of {', '.join(p + '...' for p in SCOPE_PREFIXES)}")
        return 2
    if a.cmd in ("acquire", "release", "token") and not a.owner:
        print("--owner is required")
        return 2
    if a.cmd == "status":
        return status()
    if a.cmd == "token":
        token = mirrored_token(a.owner)
        print(token or "")
        return 0 if token else 1
    leases = lease_manager_available()
    if a.cmd == "acquire":
        if leases:
            return acquire_lease(a.owner, a.timeout_min, a.ttl_min, a.scope, a.lane)
        if a.scope:
            print("note: --scope needs Hayba leases; the file lock covers the whole editor", flush=True)
        return acquire_file(a.owner, a.timeout_min, a.ttl_min)
    return release_lease(a.owner, a.token) if leases else release_file(a.owner)


if __name__ == "__main__":
    sys.exit(main())
