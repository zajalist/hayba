import { describe, it, expect, vi, beforeEach } from 'vitest';

const disabled = new Set<string>();
vi.mock('./disabled-tools-watcher.js', () => ({
  isToolDisabled: (name: string) => disabled.has(name),
}));

const { registerTool } = await import('./register-tool.js');

/** Records what actually reached server.tool(). */
function fakeServer() {
  const registered: string[] = [];
  return {
    registered,
    tool: (name: string) => { registered.push(name); },
  };
}

const descriptor = (name: string) => ({
  name,
  description: `the ${name} tool`,
  schema: {},
  handler: async () => ({ content: [] }),
  meta: { cost: 'low' as const, effects: [], when: 'w', not_when: 'n' },
});

beforeEach(() => disabled.clear());

describe('a disabled tool', () => {
  it('is not registered', () => {
    // Turning a tool off used to work under Code Mode and do nothing without
    // it: the deferred path checked, the eager path did not. Same setting,
    // two answers, depending on a mode the user was not thinking about.
    disabled.add('pcg_execute_graph');
    const server = fakeServer();

    const did = registerTool(server as never, {} as never, descriptor('pcg_execute_graph') as never);

    expect(did).toBe(false);
    expect(server.registered).toEqual([]);
  });

  it('does not take its neighbours with it', () => {
    disabled.add('pcg_execute_graph');
    const server = fakeServer();

    registerTool(server as never, {} as never, descriptor('pcg_execute_graph') as never);
    registerTool(server as never, {} as never, descriptor('actor_spawn') as never);

    expect(server.registered).toEqual(['actor_spawn']);
  });

  it('reports that it skipped, rather than a quietly shorter list', () => {
    disabled.add('x');
    expect(registerTool(fakeServer() as never, {} as never, descriptor('x') as never)).toBe(false);
    expect(registerTool(fakeServer() as never, {} as never, descriptor('y') as never)).toBe(true);
  });
});
