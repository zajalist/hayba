# PIE collision sightlines

`editor_pie_sightlines` observes a live PIE world's collision geometry. Supply one `target_location` and 1–32 explicit `eye_positions`, all `[x,y,z]` in centimetres. Each eye must be more than 0 and at most 10,000 cm from the target. Coordinates must be finite and within ±1,000,000,000 cm. When several PIE worlds are live, supply `pie_instance` from `editor_pie_actor_list`.

```json
{
  "pie_instance": 0,
  "eye_positions": [[0, 0, 170], [200, 0, 170]],
  "target_location": [500, 0, 170]
}
```

The tool runs one `ECC_Visibility` line trace per tested eye in the selected PIE world. Each sample reports `clear`, `blocked` with the first collision blocker, or `unknown` if the world ends during observation. The result identifies the selected PIE world and includes `observed_at_utc`. `tested_point_ratio` is `(clear_count + blocked_count) / eye_positions.length`; `clear_ratio_of_tested` is `clear_count / tested_count`, or `null` when no sample was tested. The tool refuses stopped PIE, ambiguous world selection, malformed positions, and rays over 100 m.

This is a collision sightline proxy. It does not measure rendered visibility, walkability, World Partition residency, or performance. It does not move players, advance ticks, stream cells, save assets, or change editor state.
