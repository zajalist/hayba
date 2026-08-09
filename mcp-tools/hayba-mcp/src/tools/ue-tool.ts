// The body every pass-through wrapper was writing out by hand.
//
// A wrapper whose only job is "validate args, put them on the wire, return the
// reply" had ~8 lines of identical code in it. Ninety-three files carried a
// byte-identical copy of this line alone:
//
//   return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
//
// That is not a formatting nit. It is ninety-three places to edit when the
// error contract changes, and — since nothing enforces agreement — ninety-three
// chances for one of them to drift. src/tools/tool-result.ts was written to own
// this contract and reached 6 of 104 call sites, because its own docstring told
// readers not to adopt it broadly. The duplication was stable rather than
// shrinking. This is the same fix aimed at the wrappers instead: they keep their
// module (index.ts imports meta/schema/handler from each), and lose the body.
//
// Behaviour is deliberately unchanged, down to the error string. This is a
// substitution, not a redesign — a wrapper that needs to remap params, merge
// defaults, or shape the response differently should keep a hand-written
// handler and not use this.

import type { z } from 'zod';
import type { ToolHandler } from './types.js';
import { executeCommand } from './tool-executor.js';
import { resolveAliases, type AliasMap } from './param-aliases.js';

/** Build the handler for a wrapper that passes validated args straight to a
 *  plugin command and returns the reply as pretty-printed JSON.
 *
 *  @param command  The **wire** command name — a command the C++ plugin
 *                  implements, not another MCP tool's name. These are separate
 *                  namespaces that happen to look alike, and calling a TS-layer
 *                  tool name here produces "Unknown command" at runtime while
 *                  unit tests pass. `wire-command-names.test.ts` enforces this
 *                  statically; see docs/WORKFLOW-improving-the-mcp.md §3b.
 *  @param schema   Zod schema; its parsed output is the params object.
 *  @param aliases  Optional canonical->alternates param-name map (see
 *                  param-aliases.ts). Applied to the raw args BEFORE `schema`
 *                  parses them, so `schema` itself stays canonical-only —
 *                  get_tool_signature's documented signature is unaffected.
 */
export function ueTool(command: string, schema: z.ZodTypeAny, aliases?: AliasMap): ToolHandler {
  return async (args) => {
    let effectiveArgs: Record<string, unknown> = args;
    if (aliases) {
      const resolved = resolveAliases(args, aliases);
      if (!resolved.ok) {
        return { content: [{ type: 'text', text: `Validation error: ${resolved.error}` }], isError: true };
      }
      effectiveArgs = resolved.args;
    }
    const parsed = schema.safeParse(effectiveArgs);
    if (!parsed.success) {
      return {
        content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }],
        isError: true,
      };
    }
    const data = await executeCommand(command, parsed.data as Record<string, unknown>);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  };
}
