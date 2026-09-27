"""editor_gate.py: the file lock (unchanged behaviour) and the Hayba lease backend.

The file-lock tests point HB_PORT at a port nothing listens on, which is also
the "editor is down" fallback. The lease tests run a fake Hayba server on an
ephemeral port; nothing here ever talks to a real editor.
"""
import json, os, pathlib, socket, socketserver, struct, subprocess, sys, threading, time

import pytest

GATE = pathlib.Path(__file__).resolve().parents[1] / "editor_gate.py"
PIE_LOG = "x\nLogPlayLevel: Creating play world package: /Game/level/UEDPIE_0_X\n"


def closed_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def run(tmp, *args, log="idle\n", port=None, env_extra=None):
    (tmp / "log.txt").write_text(log, encoding="utf-8")
    env = dict(os.environ, EDITOR_GATE_DIR=str(tmp / "gate"), EDITOR_LOG=str(tmp / "log.txt"),
               HB_PORT=str(port or closed_port()))
    env.pop("HAYBA_LEASE", None)
    env.pop("EDITOR_GATE_MODE", None)
    env.update(env_extra or {})
    return subprocess.run([sys.executable, str(GATE), *args], env=env, capture_output=True, text=True, timeout=60)


def lock_json(tmp):
    return json.loads((tmp / "gate" / "lock.json").read_text())


# ----------------------------------------------------------------------------- fake Hayba

class FakeHayba:
    """Just enough of the plugin: ping, and a lease table where every resource
    conflicts with itself and `global` conflicts with everything."""

    def __init__(self, lease_manager=True):
        self.lease_manager = lease_manager
        self.calls = []            # (cmd, params, owner, lease)
        self.leases = {}           # token -> {"owner", "resources"}
        self.queue_first = set()   # owners whose first lease_acquire is answered "queued"
        self.tickets = {}          # ticket -> resources
        self.counter = 0
        self.lock = threading.Lock()
        fake = self

        class Handler(socketserver.BaseRequestHandler):
            def handle(self):
                while True:
                    head = self._read(4)
                    if not head:
                        return
                    msg = json.loads(self._read(struct.unpack(">I", head)[0]))
                    reply = fake.answer(msg)
                    body = json.dumps({"id": msg["id"], **reply}).encode()
                    self.request.sendall(struct.pack(">I", len(body)) + body)

            def _read(self, n):
                buf = b""
                while len(buf) < n:
                    chunk = self.request.recv(n - len(buf))
                    if not chunk:
                        return b""
                    buf += chunk
                return buf

        self.server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    def cmds(self):
        return [c[0] for c in self.calls]

    def answer(self, msg):
        cmd, p, owner = msg["cmd"], msg.get("params", {}), msg.get("owner", "")
        with self.lock:
            self.calls.append((cmd, p, owner, msg.get("lease")))
            if cmd == "ping":
                caps = {"lease_manager": True} if self.lease_manager else {}
                return {"ok": True, "data": {"status": "ok", "capabilities": caps}}
            if cmd == "lease_acquire":
                if "ticket" in p:
                    resources = self.tickets.pop(p["ticket"], None)
                    if resources is None:
                        return {"ok": False, "error": "lease_acquire: unknown or expired ticket; request the lease again"}
                else:
                    resources = p["resources"]
                    if owner in self.queue_first:
                        self.queue_first.discard(owner)
                        return self._queued(owner, resources, "B")
                holder = self._conflict(owner, resources)
                if holder:
                    return self._queued(owner, resources, holder)
                self.counter += 1
                token = f"lease-fake-{self.counter}"
                self.leases[token] = {"owner": owner, "resources": resources}
                return {"ok": True, "data": {"status": "granted", "token": token, "expires_in_s": p.get("ttl_s", 120)}}
            if cmd == "lease_renew":
                lease = self.leases.get(p["token"])
                if not lease:
                    return {"ok": False, "error": "lease_renew: unknown or expired lease"}
                return {"ok": True, "data": {"token": p["token"], "renewed": True, "expires_in_s": p.get("ttl_s", 120)}}
            if cmd == "lease_release":
                if p["token"] in self.tickets:
                    self.tickets.pop(p["token"])
                    return {"ok": True, "data": {"released": True}}
                lease = self.leases.get(p["token"])
                if not lease:
                    return {"ok": False, "error": "lease_release: unknown or expired lease"}
                if lease["owner"] != owner:
                    return {"ok": False, "error": f"lease_release: lease belongs to '{lease['owner']}'"}
                del self.leases[p["token"]]
                return {"ok": True, "data": {"released": True}}
            if cmd == "lease_status":
                return {"ok": True, "data": {"enforcement": "advisory", "leases": list(self.leases.values())}}
            return {"ok": False, "error": f"unknown command {cmd}"}

    def _queued(self, owner, resources, holder):
        self.counter += 1
        ticket = f"q-fake-{self.counter}"
        self.tickets[ticket] = resources
        return {"ok": True, "data": {"status": "queued", "ticket": ticket, "position": 1,
                                     "holder_owner": holder, "eta_s": -1, "poll_after_s": 0.1}}

    def _conflict(self, owner, resources):
        for lease in self.leases.values():
            if lease["owner"] == owner:
                continue
            if "global" in resources or "global" in lease["resources"] or set(resources) & set(lease["resources"]):
                return lease["owner"]
        return None


@pytest.fixture
def hayba():
    fake = FakeHayba()
    yield fake
    fake.close()


# ----------------------------------------------------------------------------- file lock (editor down)

def test_acquire_then_release(tmp_path):
    assert run(tmp_path, "acquire", "--owner", "A", "--timeout-min", "0.02").returncode == 0
    lock = lock_json(tmp_path)
    assert lock["owner"] == "A"
    assert run(tmp_path, "release", "--owner", "A").returncode == 0
    assert not (tmp_path / "gate" / "lock.json").exists()


def test_second_owner_times_out(tmp_path):
    run(tmp_path, "acquire", "--owner", "A", "--timeout-min", "0.02")
    r = run(tmp_path, "acquire", "--owner", "B", "--timeout-min", "0.02")
    assert r.returncode == 1 and "held by A" in r.stdout


def test_expired_lock_is_taken_over(tmp_path):
    (tmp_path / "gate").mkdir()
    (tmp_path / "gate" / "lock.json").write_text(json.dumps({"owner": "A", "acquired_at": 0, "expires_at": time.time() - 1}))
    assert run(tmp_path, "acquire", "--owner", "B", "--timeout-min", "0.02").returncode == 0


def test_pie_blocks(tmp_path):
    r = run(tmp_path, "acquire", "--owner", "A", "--timeout-min", "0.02", log=PIE_LOG)
    assert r.returncode == 1 and "PIE" in r.stdout


def test_release_by_other_owner_is_refused(tmp_path):
    run(tmp_path, "acquire", "--owner", "A", "--timeout-min", "0.02")
    assert run(tmp_path, "release", "--owner", "B").returncode == 1


def test_same_owner_acquire_renews_expiry(tmp_path):
    run(tmp_path, "acquire", "--owner", "A", "--timeout-min", "0.02", "--ttl-min", "1")
    first = lock_json(tmp_path)
    assert run(tmp_path, "acquire", "--owner", "A", "--timeout-min", "0.02", "--ttl-min", "30").returncode == 0
    second = lock_json(tmp_path)
    assert second["owner"] == "A"
    assert second["acquired_at"] == first["acquired_at"]
    assert second["expires_at"] > first["expires_at"] + 25 * 60


def test_status_without_an_editor_reads_the_mirror(tmp_path):
    assert run(tmp_path, "status").stdout.strip() == "free"
    run(tmp_path, "acquire", "--owner", "A", "--timeout-min", "0.02")
    assert json.loads(run(tmp_path, "status").stdout)["owner"] == "A"


def test_plugin_without_lease_manager_keeps_the_file_lock(tmp_path):
    fake = FakeHayba(lease_manager=False)
    try:
        assert run(tmp_path, "acquire", "--owner", "A", "--timeout-min", "0.02", port=fake.port).returncode == 0
        assert "mode" not in lock_json(tmp_path)
        assert fake.cmds() == ["ping"]
    finally:
        fake.close()


# ----------------------------------------------------------------------------- Hayba leases

def test_no_scope_is_a_global_exclusive_lease(tmp_path, hayba):
    r = run(tmp_path, "acquire", "--owner", "A", "--timeout-min", "0.05", port=hayba.port)
    assert r.returncode == 0, r.stdout
    cmd, params, owner, _ = hayba.calls[-1]
    assert cmd == "lease_acquire" and owner == "A"
    assert params["resources"] == ["global"] and params["mode"] == "exclusive"
    assert params["bind_connection"] is False  # this connection closes as soon as the script exits
    token = next(iter(hayba.leases))
    assert f"HAYBA_LEASE={token}" in r.stdout
    lock = lock_json(tmp_path)
    assert lock["mode"] == "lease" and lock["owner"] == "A" and lock["holders"]["A"]["token"] == token


def test_ttl_is_capped_at_the_editor_maximum(tmp_path, hayba):
    r = run(tmp_path, "acquire", "--owner", "A", "--ttl-min", "30", "--timeout-min", "0.05", port=hayba.port)
    assert hayba.calls[-1][1]["ttl_s"] == 900
    assert "re-run acquire to renew" in r.stdout


def test_scopes_narrow_the_lease_and_let_two_agents_work(tmp_path, hayba):
    west = "wp-region:/Game/Maps/L1:0,0,25600,25600"
    east = "wp-region:/Game/Maps/L1:25600,0,51200,25600"
    assert run(tmp_path, "acquire", "--owner", "A", "--scope", west, "--timeout-min", "0.05", port=hayba.port).returncode == 0
    assert run(tmp_path, "acquire", "--owner", "B", "--scope", east, "--timeout-min", "0.05", port=hayba.port).returncode == 0
    acquires = [c for c in hayba.calls if c[0] == "lease_acquire"]
    assert acquires[0][1]["resources"] == [west] and acquires[1][1]["resources"] == [east]
    assert set(lock_json(tmp_path)["holders"]) == {"A", "B"}
    status = json.loads(run(tmp_path, "status", port=hayba.port).stdout)
    assert len(status["editor"]["leases"]) == 2 and set(status["mirror"]["holders"]) == {"A", "B"}


def test_queued_then_granted_polls_with_the_ticket(tmp_path, hayba):
    hayba.queue_first.add("A")
    r = run(tmp_path, "acquire", "--owner", "A", "--timeout-min", "0.1", port=hayba.port)
    assert r.returncode == 0, r.stdout
    acquires = [c[1] for c in hayba.calls if c[0] == "lease_acquire"]
    assert "resources" in acquires[0] and acquires[1] == {"ticket": "q-fake-1"}


def test_held_by_another_agent_times_out_and_withdraws_its_ticket(tmp_path, hayba):
    assert run(tmp_path, "acquire", "--owner", "B", "--timeout-min", "0.05", port=hayba.port).returncode == 0
    r = run(tmp_path, "acquire", "--owner", "A", "--timeout-min", "0.02", port=hayba.port)
    assert r.returncode == 1 and "held by B" in r.stdout
    last = hayba.calls[-1]
    assert last[0] == "lease_release" and last[1]["token"].startswith("q-fake-") and last[2] == "A"


def test_release_gives_the_lease_back(tmp_path, hayba):
    run(tmp_path, "acquire", "--owner", "A", "--timeout-min", "0.05", port=hayba.port)
    token = next(iter(hayba.leases))
    r = run(tmp_path, "release", "--owner", "A", port=hayba.port)
    assert r.returncode == 0 and "released" in r.stdout
    assert hayba.calls[-1][:3] == ("lease_release", {"token": token}, "A")
    assert not hayba.leases and not (tmp_path / "gate" / "lock.json").exists()


def test_release_of_another_owners_lease_is_refused(tmp_path, hayba):
    run(tmp_path, "acquire", "--owner", "A", "--timeout-min", "0.05", port=hayba.port)
    token = next(iter(hayba.leases))
    r = run(tmp_path, "release", "--owner", "B", "--token", token, port=hayba.port)
    assert r.returncode == 1 and "belongs to" in r.stdout
    assert token in hayba.leases


def test_release_uses_hayba_lease_from_the_environment(tmp_path, hayba):
    run(tmp_path, "acquire", "--owner", "A", "--timeout-min", "0.05", port=hayba.port)
    token = next(iter(hayba.leases))
    (tmp_path / "gate" / "lock.json").unlink()  # no mirror: the env var alone must do
    r = run(tmp_path, "release", "--owner", "A", port=hayba.port, env_extra={"HAYBA_LEASE": token})
    assert r.returncode == 0 and not hayba.leases


def test_same_owner_acquire_renews_the_lease(tmp_path, hayba):
    run(tmp_path, "acquire", "--owner", "A", "--timeout-min", "0.05", port=hayba.port)
    token = next(iter(hayba.leases))
    r = run(tmp_path, "acquire", "--owner", "A", "--timeout-min", "0.05", port=hayba.port)
    assert r.returncode == 0 and f"HAYBA_LEASE={token}" in r.stdout
    assert hayba.calls[-1][0] == "lease_renew"
    assert len(hayba.leases) == 1


def test_a_lapsed_lease_is_asked_for_again(tmp_path, hayba):
    run(tmp_path, "acquire", "--owner", "A", "--timeout-min", "0.05", port=hayba.port)
    hayba.leases.clear()  # the editor restarted
    r = run(tmp_path, "acquire", "--owner", "A", "--timeout-min", "0.05", port=hayba.port)
    assert r.returncode == 0
    assert hayba.cmds()[-2:] == ["lease_renew", "lease_acquire"]


def test_pie_blocks_in_lease_mode_without_queueing(tmp_path, hayba):
    r = run(tmp_path, "acquire", "--owner", "A", "--timeout-min", "0.02", log=PIE_LOG, port=hayba.port)
    assert r.returncode == 1 and "PIE" in r.stdout
    assert "lease_acquire" not in hayba.cmds()


def test_a_file_lock_from_while_the_editor_was_down_still_blocks(tmp_path, hayba):
    run(tmp_path, "acquire", "--owner", "B", "--timeout-min", "0.02")  # editor down: file lock
    r = run(tmp_path, "acquire", "--owner", "A", "--timeout-min", "0.02", port=hayba.port)
    assert r.returncode == 1 and "held by B" in r.stdout and "file lock" in r.stdout


def test_token_prints_the_mirrored_token(tmp_path, hayba):
    run(tmp_path, "acquire", "--owner", "A", "--timeout-min", "0.05", port=hayba.port)
    r = run(tmp_path, "token", "--owner", "A")
    assert r.returncode == 0 and r.stdout.strip() == next(iter(hayba.leases))
    assert run(tmp_path, "token", "--owner", "B").returncode == 1


def test_a_bad_scope_is_refused(tmp_path, hayba):
    r = run(tmp_path, "acquire", "--owner", "A", "--scope", "level:/Game/L1", port=hayba.port)
    assert r.returncode == 2 and "bad --scope" in r.stdout
    assert hayba.calls == []
