/**
 * Early-feedback mirror of the authoritative C++ python_run crash policy.
 *
 * This table is intentionally exported: the test suite executes every entry
 * with allow_unsafe=true and the native automation test carries the same
 * examples. A new fatal rule is incomplete until both boundaries reject it.
 * The C++ handler remains authoritative because a stale or direct TCP client
 * can bypass this process entirely.
 */

export interface PythonCrashRule {
  code: string;
  family: string;
  patterns: readonly string[];
  reason: string;
  alternative: string;
}

export interface CrashGuardHit {
  pattern: string;
  code: string;
  family: string;
  reason: string;
  alternative: string;
}

export const MAX_PYTHON_SCRIPT_CHARS = 256 * 1024;

export const PYTHON_CRASH_RULES: readonly PythonCrashRule[] = [
  {
    code: 'HCR-STATICMESH-001',
    family: 'known_static_mesh_crash',
    patterns: ['set_lod_build_settings', 'build_scale3d'],
    reason: 'the API is a confirmed native editor-crash path and does not reliably update bounds',
    alternative: 'use GeometryScript transform/append operations and copy_mesh_to_static_mesh',
  },
  {
    code: 'HCR-WORLD-001',
    family: 'world_switch_during_command',
    patterns: [
      'new_blank_map',
      'new_map_from_template',
      'editorloadingandsavingutils.load_map',
      'editorlevellibrary.load_level',
      'leveleditorsubsystem().new_level',
      'leveleditorsubsystem().load_level',
      '.load_map(',
      '.load_level(',
      '.new_level(',
    ],
    reason: 'it replaces GWorld during the MCP command tick and can leave EditorContext desynchronized',
    alternative: 'use a deferred typed map command or switch/create the map in the editor UI',
  },
  {
    code: 'HCR-UI-001',
    family: 'unvalidated_list_view_identity_mutation',
    patterns: ['.set_list_items(', '.bp_set_list_items(', '.add_item(', "set_editor_property('list_items'"],
    reason:
      'raw ListView item mutation can submit the same UObject identity twice and trigger Slate SListView.h:1154 on the next refresh',
    alternative:
      'use a typed ListView handler that rejects duplicate UObject identities before applying items and requesting one refresh',
  },
  {
    code: 'HCR-LIFE-001',
    family: 'unowned_lifetime_or_thread',
    patterns: [
      'unreal.register_',
      '.add_callable(',
      '.add_callable_unique(',
      '.bind_callable(',
      '.add_function(',
      '.bind_function(',
      'set_timer(',
      'threading.thread',
      'threading.timer',
      '_thread.start_new_thread',
      'asyncio.create_task',
      'asyncio.ensure_future',
      'run_in_executor(',
      'concurrent.futures',
      'multiprocessing.',
      'importmultiprocessing',
      'fromthreadingimportthread',
      'fromthreadingimporttimer',
      'fromasyncioimportcreate_task',
      'fromasyncioimportensure_future',
      'importthreadingas',
      'importasyncioas',
      'importconcurrent.futuresas',
    ],
    reason: 'it can outlive the one-shot namespace or run Unreal Python off the game thread',
    alternative: 'perform bounded work inline or implement an owned native job that unregisters on shutdown',
  },
  {
    code: 'HCR-BLOCK-001',
    family: 'blocking_or_unbounded_work',
    patterns: [
      'time.sleep(',
      'fromtimeimportsleep',
      'importtimeas',
      'socket.socket(',
      'socket.create_connection(',
      'fromsocketimportsocket',
      'fromsocketimportcreate_connection',
      'importsocketas',
      'requests.',
      'importrequestsas',
      'urllib.request',
      'importurllibas',
      'http.client',
      'importhttp.clientas',
      'httpx.',
      'importhttpxas',
      'aiohttp.',
      'importaiohttpas',
      'urllib3.',
      'importurllib3as',
      'urlopen(',
      'builtins.input(',
      'frombuiltinsimportinput',
      'input(',
      'breakpoint(',
      'whiletrue',
      'while(true)',
      'while1',
      'while(1)',
    ],
    reason: 'it can block the editor game thread or create work with no safe native interruption point',
    alternative: 'use a bounded loop, do I/O in the Node process, or return an owned job id and poll it',
  },
  {
    code: 'HCR-NATIVE-001',
    family: 'native_memory_escape',
    patterns: ['ctypes.', 'importctypes', 'fromctypesimport', 'faulthandler._'],
    reason: 'it escapes Unreal/Python memory safety or explicitly raises a native process fault',
    alternative: 'use a validated typed native handler; use the disposable survival harness for fault-injection tests',
  },
  {
    code: 'HCR-EXIT-001',
    family: 'process_exit',
    patterns: [
      'os._exit',
      '._exit(',
      '_exit(',
      'fromosimport_exit',
      'sys.exit(',
      'exit(',
      'quit(',
      'raisesystemexit',
      'signal.raise_signal(',
      '.raise_signal(',
      'fromsignalimportraise_signal',
      'os.kill(',
      'fromosimportkill',
      'request_exit(',
      'quit_editor(',
      'taskkill',
      'pkill',
      'kill-9',
      'stop-process',
    ],
    reason: 'it terminates or tears down the editor from inside an in-flight command',
    alternative: 'return from python_run and use the typed editor shutdown workflow',
  },
  {
    code: 'HCR-CONSOLE-001',
    family: 'unaudited_console_execution',
    patterns: ['execute_console_command(', 'fromunrealimportexecute_console_command'],
    reason: 'it bypasses typed policy and can invoke fatal, blocking, world-switch, or shutdown console commands',
    alternative: 'use editor_run_console_command for audited commands or use a purpose-built typed MCP tool',
  },
  {
    code: 'HCR-DYNAMIC-001',
    family: 'dynamic_code_hiding',
    patterns: [
      'exec(',
      'eval(',
      'compile(',
      '__import__(',
      'importlib.',
      'getattr(',
      '.__getattribute__(',
      'operator.attrgetter(',
      'operator.methodcaller(',
      'setattr(',
      'delattr(',
      '.__dict__',
      'globals(',
      'locals(',
      'vars(',
      'frombuiltinsimportexec',
      'frombuiltinsimporteval',
      'frombuiltinsimportcompile',
      'fromimportlibimportimport_module',
    ],
    reason: 'it can construct or hide a crash primitive from source preflight',
    alternative: 'submit the intended imports and operations directly as ordinary source',
  },
  {
    code: 'HCR-TIME-001',
    family: 'deadline_tampering',
    patterns: ['sys.settrace(', 'settrace(', 'sys.setprofile(', 'setprofile('],
    reason: 'it disables or replaces the cooperative execution deadline used to protect the editor game thread',
    alternative: 'leave the deadline hook intact and split long work into bounded requests',
  },
] as const;

/** Normalize the trivial spelling variants that must not bypass policy. */
export function compactPythonPolicySource(script: string): string {
  return script
    .toLowerCase()
    .replace(/"/g, "'")
    .replace(/\\\r?\n/g, '')
    .replace(/\r?\n/g, ';')
    .replace(/[\t\f\v ]+/g, '');
}

/** Bare call patterns must begin at a token boundary. Without this,
 * `set_input()` matches `input(` and `.recompile()` matches `compile(`. */
function compactContainsPolicyPattern(compact: string, pattern: string): boolean {
  const needle = compactPythonPolicySource(pattern);
  const needsCallableBoundary = needle.endsWith('(') && !needle.startsWith('.') && !needle.slice(0, -1).includes('.');
  let from = 0;
  while (from <= compact.length - needle.length) {
    const index = compact.indexOf(needle, from);
    if (index < 0) return false;
    if (!needsCallableBoundary || index === 0 || !/[a-z0-9_.]/.test(compact[index - 1])) return true;
    from = index + 1;
  }
  return false;
}

/** Return the first fatal policy match, or null for a script safe to forward. */
export function scanPythonForCrashers(script: string): CrashGuardHit | null {
  const compact = compactPythonPolicySource(script);
  for (const rule of PYTHON_CRASH_RULES) {
    for (const pattern of rule.patterns) {
      if (compactContainsPolicyPattern(compact, pattern)) {
        return { ...rule, pattern };
      }
    }
  }

  // A loopback connect to the plugin from python_run waits on the game thread
  // that is already executing this request. Keep the port check narrow so a
  // harmless remote address or an unrelated local service is not mislabeled.
  const selfConnect = /\.connect\(\(['"](?:127\.0\.0\.1|localhost|::1)['"],(\d+)/gi.exec(compact);
  const port = Number(selfConnect?.[1]);
  if (port >= 52342 && port <= 52350) {
    return {
      pattern: 'loopback MCP socket connection',
      code: 'HCR-BLOCK-001',
      family: 'self_reentrant_socket',
      reason: 'it deadlocks by waiting on the game thread currently executing python_run',
      alternative: 'call unreal.* directly or return and make a separate MCP request',
    };
  }
  return null;
}

/** Build stable, recovery-oriented refusal text for a crash-guard hit. */
export function crashGuardMessage(hit: CrashGuardHit): string {
  return [
    `python_run policy_blocked [${hit.code}]: matched "${hit.pattern}" (${hit.family}); ${hit.reason}.`,
    `Safe alternative: ${hit.alternative}.`,
    'Retry unchanged: forbidden.',
    'This guard is non-bypassable. allow_unsafe only overrides filesystem/subprocess policy, never editor-crash, deadline, or deadlock prevention.',
  ].join('\n');
}
