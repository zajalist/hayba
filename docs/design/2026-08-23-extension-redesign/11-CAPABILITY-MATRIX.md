# Feature-level capability audit — the whole field (2026-08-23)

Supersedes the roster in `00-FIELD-STUDY.md`, which was incomplete: it missed
**Monolith, StraySpark, UAIP, Ultimate Engine CoPilot, Ludus, CodeFizz**, and
under-counted Epic by an order of magnitude.

---

## Three conclusions that change decisions

### 1. Aura's two headline claims are undocumented across a 44-URL sitemap
Every doc page was fetched. These appear **only** on the homepage/blog:

| Claim | Doc page |
|---|---|
| "builds, **tests, and verifies**" | ✗ none |
| "the only agent that can build a feature and then **playtest itself**" | ✗ none |
| "**automatically recover from editor crashes** while it's running" | ✗ none |
| "**verification sub-agent** … validate features by actually playing the game" | ✗ none |

A sitemap that documents *alpha* features (autonomous profiler capture) has no
testing page, no PIE page, no crash-recovery page. **Announced, not shipped.**
The window to ship a documented, verifiable version is open — and closing.

### 2. Token economy is now TABLE STAKES, not a moat
This retires one of the five moats in the supertooling roadmap. Two
competitors independently solved it and shipped:
- **StraySpark "catalog mode"**: ~62K → ~3K tokens of tool definitions (~95% cut)
- **Monolith namespace dispatch**: one `{namespace}_query(action, params)` tool
  per domain instead of 1,400 flat definitions
- **ChiR24 fat tools**: 23 definitions covering more operations than GenOrca's 253
- Aura claims 45% output-token reduction on level design

Our Code Mode is competitive, not differentiating. **Reclassify as a
requirement.**

### 3. The winning pattern has emerged: wrap Epic, then extend
**UAIP** ships 190+ bridges into Epic's 5.8 Toolset **plus** 540 native
semantic commands. Epic's own **MCP Client Toolset** (Beta) is the *sanctioned*
path for a third-party server to be consumed by Epic's agent UI.

Epic ships **~700–830 tools across 52 toolsets**, and **~40% is
Animation + Sequencer**. Competing on breadth against first-party is futile;
the deepest domains are already commoditized. Composing with Epic and
differentiating on the reliability layer is the live play. This elevates E1
from a nice-to-have to a strategic imperative.

---

## The roster we did not know about

| Product | Surface | License / price | The thing that matters |
|---|---|---|---|
| **Monolith** (`tumourlove/monolith`) | **~1,400+ actions / 25+ namespaces** — largest anywhere | **MIT, free**, 272★, active | **"Reflection Intelligence"** — reads UE C++ implementations, engine source search, class hierarchies, call-graph tracing, replication queries. Native C++, **zero Python**, explicitly positioned against Epic's Python toolsets |
| **StraySpark** | 409 tools / 60 categories + **15 Resources + 18 Prompts** | $89.99 / $299.99 one-time, full source | **Best safety in the field**: *universal named undo per mutation*, dry-run previews, `run_tool_script` runs multi-step programs as **one editor transaction**. **Best security**: bearer auth with per-token read/scene/destructive **scopes**, DNS-rebinding defense |
| **UAIP** (Naotsun) | 540 native + 190 Epic bridges ≈ **730** | Fab, paid | **Wrap-Epic-then-extend**. Four transports (MCP/HTTP/WebSocket/CLI). **"Self-verifying loops"** — agent screenshots and reviews its own work |
| **Ultimate Engine CoPilot** | **1,050+ actions / 56 categories** | ~$220 one-time, full source | **Voice control** + **multiple concurrent agents in-editor** |
| **Ludus AI** | web + IDE + plugin | **$300–$840/yr** | UE **5.1–5.6 only** — behind on 5.7/5.8 |
| **CodeFizz** | claims 900+ / 28 | commercial + OSS community ed. | unverified counts |

Plus corrections to the OSS set: **remiphilippe is 49 tools / 22 sections**
(README says 48 — both its own numbers are wrong), **chongdashu has no LICENSE
file** despite the README claiming MIT — a real risk, since it is the ancestor
most others forked.

### The counting warning
**Units differ and naive comparison is meaningless.** Monolith's 1,400,
Epic's 830, StraySpark's 409, GenOrca's 253 are *actions*. ChiR24's 23 and
IvanMurzak's 61 are *tool definitions* — ChiR24's 23 fat tools expose more
operations than GenOrca's 253. Published counts also contradict their own
repos (Nwiro 209/219/224). **Count operations or don't compare.**

---

## Whitespace — ranked, nobody is strong here

1. **Crash resilience** — **zero products document it.** Aura marketing-claims
   it; every other README is silent. Meanwhile Epic's own docs warn that tool
   calls run game-thread-serially. Cleanest open moat in the field, and the one
   we have real engineering in.
2. **Automated testing / regression loops** — only remiphilippe (headless
   `run_tests`) and flopperam-hosted (`pie_test_*`), both thin. Nobody has
   *build → run → assert → report → fix* as a loop.
3. **Quantified pre-flight validation** — dry-run exists in exactly two
   products. **Nobody ships constraint checking or quantified post-conditions.**
   PLUMB has no analogue anywhere in this field.
4. **Atomic transactions / undo done right** — **only StraySpark.** Aura
   *documents its own failure* here (VFX and GeometryScript bypass the undo
   stack). Every OSS server: absent.
5. **Build / cook / package** — one product (remiphilippe).
6. **Source control** — half a product. Studios live in Perforce.
7. **Profiling** — Aura (alpha, self-admittedly incomplete) and flopperam-hosted.
8. **Non-color texture generation** — **universal gap.** Aura explicitly
   *cannot* generate normal/roughness/AO maps; nobody else generates textures
   at all. Whoever ships full PBR-set generation owns the category.
9. **Multi-agent orchestration** — Aura and Ultimate Engine CoPilot only; no
   lane isolation or conflict handling anywhere.
10. **Docs / API grounding** — Monolith, remiphilippe, Aura. High-leverage
    because *these agents hallucinate UE APIs constantly* — Aura's own
    Blueprint docs admit hallucination on class refs and enum values.
11. **World Partition** — only ChiR24 covers it properly, including Epic.
12. **3D asset generation in-engine** — Aura and Ludus only; zero in OSS.
13. **Security / auth** — StraySpark (scoped tokens) and UAIP (session
    capabilities). **Epic ships no auth at all.**

## Table stakes — lacking any of these is disqualifying
Actor/level CRUD · Blueprint authoring · Materials · Asset operations ·
Reflection/introspection · Niagara · **Animation (Epic made this futile —
40% of its surface)** · Behavior Trees/EQS · **Vision/screenshots (now
standard)** · PIE + console + output log · **Token economy (newly demoted
here)**.

---

## What this means for Hayba

**Confirmed and strengthened:** the reliability layer is the moat, and it is
nearly empty. Crash resilience 0 products, quantified validation 0, atomic
transactions 1, testing loops ~1.5. Everything in Track R points at open field.

**Newly at risk:** token economy is no longer a differentiator. Any positioning
that leads with it is out of date.

**Newly required:** speak Epic's Toolset registry and register as a consumable
server via their MCP Client Toolset (E1, now elevated). Fighting on breadth is
lost; composing is sanctioned and cheap.

**Newly obvious gaps we should own:**
- **Named per-mutation undo + dry-run** — StraySpark is ahead of us here. We
  have router-owned transactions; we do not have *named* undo per mutation or
  a universal dry-run flag. That is a small, high-visibility catch-up.
- **Docs/API grounding** (Monolith's Reflection Intelligence, remiphilippe's
  bundled index) — already scoped as P6's offline UE doc search. This audit
  says it is more valuable than assumed, because hallucinated APIs are the
  field's admitted common failure.
- **Scoped auth tokens** — we have a capability token that fails open by
  design. StraySpark's read/scene/destructive scopes are a better model and
  a studio-sales wedge.
