# Gemini Research Prompt — Erosion that CARVES a real Earth heightmap (not relaxes it away)

> Paste the section below into Gemini (Deep Research). Context first, then the questions.

---

## Context

I have a planet renderer. Step 1 of the pipeline produces a **real, fixed elevation
field** — either painted by the user or sampled from a real Earth equirectangular DEM
(ETOPO-style grayscale, normalized so ocean is `[-1, 0]` and land is `(0, ~1]`). This
field is defined **per cell on an icosphere / Goldberg-polyhedron geodesic graph**
(~10k–600k cells, irregular neighbour count 5–6, *not* a regular raster grid). Each cell
knows its neighbours and great-circle edge lengths on a sphere of radius 6371 km.

In the "bake" step I want to apply **fluvial + thermal erosion that INCISES this existing
relief** — carves river valleys, canyons, ridgelines, alluvial fans, talus — while
**preserving the large-scale shape of the input DEM** (continents, mountain belts, the
fact that the Himalaya is high and the Amazon basin is low must survive).

### The failure I am hitting

My current implementation does Barnes Priority-Flood depression filling → steepest-descent
flow receivers → Braun–Willett O(N) drainage area → a **stream-power update with a uniform
uplift term** `dz = (uplift − K · A^m · S^n) · dt`, iterated ~25 times, then `elev =
max(eroded, 0)` on land cells only.

Result: after baking, **the land elevation has nothing to do with the input DEM**. It
relaxes to a stream-power *steady state* that looks like "distance from the coast into the
continent" — completely independent of what was painted/sampled. Ocean is untouched
(erosion skips ocean cells) so the contrast makes it obvious the land was destroyed. The
input Himalaya/Andes/Sahara structure is gone.

I understand *why* in principle (detachment-limited stream power with spatially-uniform
uplift has a unique steady state `S = (U/K)^(1/n) · A^(−m/n)` that the input is driven
toward, erasing initial conditions over enough iterations), but I need the **correct
formulation and parameters** for the actual goal, which is *not* "evolve a landscape to
geomorphic equilibrium from a tectonic uplift field" — it is **"take a real, already-final
DEM and add erosional fine detail without changing its macro shape."**

## What I need from you

1. **Correct algorithm class for "erode an existing real DEM" vs "grow terrain from
   uplift".** Production tools (Gaea, World Machine, World Creator) and the
   `terrain-erosion` literature *carve* a provided heightfield. Contrast: (a)
   detachment-limited stream-power-law landscape evolution (Braun–Willett / FastScape,
   Cordonnier) which is uplift-driven and equilibrium-seeking, vs (b) **hydraulic
   erosion-deposition** (droplet / pipe / shallow-water, à la Mei et al. 2007, Št'ava
   2008, Sebastian Lague) which perturbs an existing field and conserves
   sediment. Which class actually preserves the input macro-shape, and exactly why?
   Give the governing equations for the recommended class.

2. **If stream-power is still desirable for crisp dendritic valley networks**, how do
   production/academic pipelines apply it to a *finished* DEM without destroying it?
   Specifically: dropping the uplift term entirely (pure incision, `dz = −K·A^m·S^n`,
   no equilibrium attractor); strict per-step incision clamp (`|dz| ≤ ε`, e.g. a few
   metres) so it can only *etch*; very small iteration counts; blending the eroded
   result back toward the original by a strength factor `h = lerp(h0, h_eroded, β)`;
   high-pass coupling so erosion only modifies wavelengths shorter than the macro relief.
   Give concrete recommended numbers (ε, β, K, m, n, iteration count) for a DEM
   normalized to elevations in `(0, 1]`.

3. **Sediment / deposition.** Detachment-limited (transport-unlimited) erosion only cuts.
   Real terrain needs deposition (fans, valley fills, deltas). Give the
   transport-limited or hybrid (e.g. `∂h/∂t = −∇·q_s`, Davy–Lague 2009; or the
   stream-power + linear-diffusion split) formulation, and how deposition stabilizes the
   result and prevents runaway incision.

4. **Thermal / hillslope diffusion** on an irregular spherical graph: the
   slope-limited creep `∂h/∂t = D ∇²h` discretized on a non-uniform geodesic mesh
   (cotangent / finite-volume Laplacian, talus-angle clamp). Stability condition (the
   diffusion CFL `D·dt/Δx² ≤ ½` analogue on irregular cells), and how to pick `D` for
   normalized elevations.

5. **Numerical stability & CFL** for all of the above on an irregular sphere mesh with
   variable edge length: explicit-step stability bounds, when implicit/semi-implicit is
   required (FastScape's implicit stream-power), and how Cordonnier 2019 ("Large-scale
   terrain authoring") keeps it stable and fast at >100k nodes.

6. **Operating on a Goldberg/icosphere graph rather than a raster.** Priority-Flood,
   flow routing (single vs multiple-flow-direction, D∞ analogue on a hex/penta graph),
   drainage accumulation, and the Laplacian — all on irregular neighbour topology with
   geodesic edge weights. Pitfalls vs the regular-grid versions in the literature.

7. **Order of operations in the bake**: depression filling → flow routing → drainage →
   fluvial incision → thermal diffusion → deposition — how many outer iterations, and
   how to interleave so the result is detailed but still recognizably the input Earth.

8. **Reference implementations** to study/port (prefer Rust, then C++/Python/GLSL):
   FastScape / `fastscapelib`, Cordonnier's code, Sebastian Lague hydraulic erosion,
   `terrain-erosion-3-ways`, Axel Paris's terrain code, Job Talle's hydraulic erosion,
   World Machine/Gaea technical talks. For each: which of the algorithm classes above it
   is, and whether it carves an input DEM or grows from uplift.

Give equations, recommended parameter values for a `(0,1]`-normalized DEM, and a concrete
recommended bake pipeline. Prioritize **"do not destroy the input macro relief"** as the
hard constraint.
