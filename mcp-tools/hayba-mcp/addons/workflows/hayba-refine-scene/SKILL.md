---
name: hayba-refine-scene
description: Use when the user wants to improve an existing scene — captures viewport, scores against references, and applies targeted edits to low-score regions.
---

# hayba-refine-scene

## Workflow

1. `editor_capture_viewport` for the current angle.
2. Retrieve reference embeddings from shared memory (search by intent: "moodboard reference").
3. `editor_capture_viewport` per hero angle; name the elements that do not match
   the stated intent and why. Judge the image, not your memory of the plan.
4. For each low-scoring actor: try one of (lighting, material swap, displacement, foliage density change).
5. Re-capture, re-score. Stop when delta < 0.02 or 5 iterations.
