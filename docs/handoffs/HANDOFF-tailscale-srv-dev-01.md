# HANDOFF — Connecting to srv-dev-01 over Tailscale

Status as of 2026-07-14. Everything in the "Verified" table below was tested live from
`DESKTOP-OQAM6E3`. The SSH login user is **not** yet confirmed — see Open questions.

## What Tailscale actually is

Tailscale builds a private network (a "tailnet") across your machines, wherever they
physically sit. Each machine runs a daemon, authenticates to a coordination server with
your identity, and gets a stable IP in the `100.64.0.0/10` range. That IP belongs to the
machine, not to its location — it does not change when the machine moves between the
office LAN, a coffee shop, or a datacenter.

Traffic between two machines is a WireGuard tunnel, encrypted end to end. The
coordination server hands out public keys and helps the two peers find each other; it
does not see the plaintext. There is no port forwarding, no VPN concentrator, and
nothing exposed to the public internet.

Two peers connect one of two ways:

- **Direct** — they punch through NAT and talk peer to peer. Fast, low latency.
- **DERP relay** — if NAT traversal fails, traffic is relayed through a Tailscale relay
  server. Still end-to-end encrypted, but slower.

You can see which path is in use. Our `tailscale ping` to srv-dev-01 returned a DERP
response first (`via DERP(tor)`, 46ms) and then upgraded to direct (`via
10.0.0.227:41641`, 86ms). That upgrade is normal and automatic — Tailscale starts on the
relay so the connection works immediately, then negotiates a direct path in the
background.

## This tailnet

| Field | Value |
|---|---|
| Tailnet | `zejbadr@gmail.com` |
| MagicDNS suffix | `tail599939.ts.net` |
| This machine | `DESKTOP-OQAM6E3` → `100.65.61.110` |
| Other desktop | `DESKTOP-89Q6FFV` → `100.122.74.37` (online) |
| **srv-dev-01** | **`100.98.219.8`** (Linux, online) |

`srv-dev-01` is the box the self-hosted infra targets: Docker + Supabase behind a Caddy
gateway, fronted by a Cloudflare Tunnel. See `infra/README.md`.

## Verified

| Check | Result |
|---|---|
| `tailscale ping 100.98.219.8` | pong, direct path established |
| TCP 22 on `100.98.219.8` (Tailscale) | open |
| TCP 22 on `10.0.0.227` (LAN) | open |
| `known_hosts` | already contains `srv-dev-01` and `10.0.0.227` — this machine has connected before |

## The name collision — read this before debugging anything

`srv-dev-01` resolves to **two different addresses** on this machine depending on who
answers first:

- Your **hosts file** maps it to `100.98.219.8` (the Tailscale IP).
- Your **local DNS** also answers `srv-dev-01` as `10.0.0.227` (the LAN IP).

Same physical box, two routes to it. This is fine until you are off the home network, at
which point the LAN address silently stops working and the failure looks like "the server
is down" rather than "the name resolved to the wrong address."

Pin the address explicitly rather than trusting name resolution. Use the Tailscale IP:
it is correct on the LAN *and* off it.

## How to connect

There is currently **no `Host srv-dev-01` block** in `~/.ssh/config`, which is why no user
or key is remembered. Once the login user is confirmed, add:

```sshconfig
Host srv-dev-01
    Hostname 100.98.219.8
    User <CONFIRM — see below>
    IdentityFile ~/.ssh/id_ed25519
```

Then `ssh srv-dev-01` works from anywhere the tailnet is up.

Prerequisite: Tailscale must be running and authenticated on this machine. Check with
`tailscale status` — `BackendState` should be `Running` (it is, right now). If it is not,
`tailscale up` and complete the browser login.

## Open questions

1. **What is the SSH user?** Not recorded anywhere in the repo or in `~/.ssh/config`. The
   `supabase_admin` in `infra/backup.sh:6` is the *Postgres* role, not an SSH login — do
   not confuse the two. `root` was the working assumption but the test was interrupted
   and **never completed**, so it is unconfirmed.
2. **Which key does the server trust?** Available locally: `~/.ssh/id_ed25519` and
   `~/.ssh/zajalist.pem`. Untested against this host.

Resolve #1 and #2 by running the probe below; the first line it prints tells you both.

```bash
ssh -o BatchMode=yes -o ConnectTimeout=10 -i ~/.ssh/id_ed25519 \
    root@100.98.219.8 'echo "CONNECTED as $(whoami)@$(hostname)"'
```

`BatchMode=yes` means it fails fast instead of hanging on a password prompt — if key auth
is not set up for that user, you get `Permission denied (publickey)` immediately rather
than a stuck terminal.

## Why Tailscale rather than exposing SSH

srv-dev-01's SSH port is reachable on the tailnet and on the LAN, not from the public
internet. The Cloudflare Tunnel (`infra/cloudflared.yml`) is what publishes the *API*
to the world at `api.hayba.app`; it does not publish SSH. Keeping admin access on the
tailnet means there is no public SSH surface to brute-force, and no firewall rule to
maintain — access is governed by tailnet membership.
