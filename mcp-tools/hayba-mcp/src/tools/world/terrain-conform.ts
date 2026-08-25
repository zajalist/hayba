// Find the ground under each scatter point.
//
// world_generate placed every instance at the area actor's z. On anything but
// a flat plane that is wrong for most of them, and the tool said "grounded" in
// its own description while doing it -- the constraint was validated against
// the plan's own flat assumption rather than against the world.
//
// One batched python_run for the whole set: N separate traces would be N
// round-trips to the game thread for a scatter of forty instances.

import { executeCommand } from '../tool-executor.js';

/** Result for one point. `z` is null when nothing was under it. */
export interface GroundHit {
  x: number;
  y: number;
  z: number | null;
}

export interface ConformOptions {
  /** How far above the start height to begin the downward trace, in cm. */
  searchUpCm?: number;
  /** How far below to give up, in cm. */
  searchDownCm?: number;
}

/**
 * Build the python that traces every point in one pass.
 *
 * Exported for testing: the script is the part that can be wrong in ways a
 * mocked executeCommand would never reveal, so it is worth asserting on
 * directly.
 */
export function buildTraceScript(
  points: ReadonlyArray<readonly [number, number]>,
  fromZ: number,
  opts: ConformOptions = {},
): string {
  const up = opts.searchUpCm ?? 10_000;
  const down = opts.searchDownCm ?? 50_000;

  const body = [
    'import json',
    'import unreal',
    `pts = ${JSON.stringify(points.map(([x, y]) => [x, y]))}`,
    `top = ${fromZ} + ${up}`,
    `bottom = ${fromZ} - ${down}`,
    // Every line here was wrong on the first attempt and corrected against a
    // live editor:
    //   unreal.EditorSubsystemLibrary does not exist -- get_editor_subsystem does
    //   a HitResult has no .impact_point attribute
    //   get_editor_property('impact_point') raises; to_dict() is the accessor
    // impact_point is the surface itself. `location` sits a trace-epsilon above
    // it, which is the wrong number to ground against.
    'world = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()',
    'out = []',
    'for p in pts:',
    '    start = unreal.Vector(p[0], p[1], top)',
    '    end = unreal.Vector(p[0], p[1], bottom)',
    '    hit = unreal.SystemLibrary.line_trace_single(',
    '        world, start, end, unreal.TraceTypeQuery.TRACE_TYPE_QUERY1,',
    '        False, [], unreal.DrawDebugTrace.NONE, True)',
    '    if hit:',
    '        out.append([p[0], p[1], hit.to_dict()["impact_point"].z])',
    '    else:',
    '        out.append([p[0], p[1], None])',
    'print("HAYBA_GROUND_JSON:" + json.dumps(out))',
  ].join('\n');

  return `exec(${JSON.stringify(body)})`;
}

/** Pull the payload back out of whatever else the script printed. */
export function parseTraceOutput(stdout: string): GroundHit[] | null {
  const marker = 'HAYBA_GROUND_JSON:';
  const at = stdout.lastIndexOf(marker);
  if (at === -1) return null;
  const json = stdout.slice(at + marker.length).trim().split('\n')[0] ?? '';
  try {
    const raw = JSON.parse(json) as Array<[number, number, number | null]>;
    return raw.map(([x, y, z]) => ({ x, y, z }));
  } catch {
    return null;
  }
}

export interface ConformResult {
  hits: GroundHit[];
  /** Why no conform happened at all. Absent on success. A conform that could
   *  not run must not look like a conform that found flat ground. */
  unavailable?: string;
}

/**
 * Trace every point down onto the world.
 *
 * Returns `unavailable` rather than throwing when the editor cannot be
 * reached or the script produced nothing readable -- the caller decides
 * whether to place unconformed, and must be able to say so.
 */
export async function conformToGround(
  points: ReadonlyArray<readonly [number, number]>,
  fromZ: number,
  opts: ConformOptions = {},
): Promise<ConformResult> {
  if (points.length === 0) return { hits: [] };

  let data: unknown;
  try {
    data = await executeCommand('python_run', { script: buildTraceScript(points, fromZ, opts) });
  } catch (e) {
    return { hits: [], unavailable: `python_run unavailable: ${e instanceof Error ? e.message : String(e)}` };
  }

  const reply = data as { ok?: boolean; stdout?: string; stderr?: string } | undefined;
  if (reply?.ok === false) {
    return { hits: [], unavailable: `trace script failed: ${(reply.stderr ?? '').slice(0, 200)}` };
  }

  const hits = parseTraceOutput(reply?.stdout ?? '');
  if (!hits) {
    return { hits: [], unavailable: 'trace script produced no readable result' };
  }
  if (hits.length !== points.length) {
    return { hits: [], unavailable: `trace returned ${hits.length} result(s) for ${points.length} point(s)` };
  }
  return { hits };
}
