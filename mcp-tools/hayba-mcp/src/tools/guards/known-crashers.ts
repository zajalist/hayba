/**
 * Early-feedback mirror of the authoritative C++ python_run crash policy.
 *
 * This table is intentionally exported: the TypeScript test exercises every
 * entry against a mocked transport and native automation feeds the same
 * examples only to its pure matcher. A new fatal rule is incomplete until both
 * boundaries reject it; dangerous examples are never executed in the editor.
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
    code: 'HCR-ANIM-001',
    family: 'animation_timing_mutation',
    patterns: [
      'animationdatacontroller.set_frame_rate(',
      'animationdatacontroller.set_number_of_frames(',
      'animationdatacontroller.set_play_length(',
      'animationdatacontroller.resize_number_of_frames(',
      'animationdatacontroller.resize_play_length(',
      'animationdatacontroller.resize_in_frames(',
      'animationdatacontroller.resize(',
    ],
    reason: 'it can leave animation frame data and compression out of sync and trigger a native editor assertion',
    alternative: 'use a validated animation timing workflow outside python_run',
  },
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
      'concurrent.futures.threadpoolexecutor(',
      'concurrent.futures.processpoolexecutor(',
      'multiprocessing.',
      'importmultiprocessing',
      'fromthreadingimportthread',
      'fromthreadingimporttimer',
      'fromasyncioimportcreate_task',
      'fromasyncioimportensure_future',
      'importthreadingas',
      'importasyncioas',
      'fromconcurrent.futuresimportthreadpoolexecutor',
      'fromconcurrent.futuresimportprocesspoolexecutor',
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
      'threading.lock(',
      'threading.rlock(',
      'threading.event(',
      'threading.condition(',
      'threading.semaphore(',
      'threading.boundedsemaphore(',
      'threading.lock.acquire(',
      'threading.rlock.acquire(',
      'threading.event.wait(',
      'threading.condition.wait(',
      'threading.semaphore.acquire(',
      'threading.boundedsemaphore.acquire(',
      'queue.queue(',
      'queue.queue.get(',
      'queue.queue.join(',
      'concurrent.futures.future.result(',
      'concurrent.futures.wait(',
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

/** Remove inert comments and quoted string bodies while retaining executable
 * punctuation and identifiers. This is intentionally a small lexical pass,
 * not a Python parser; it exists for rules whose vocabulary is otherwise
 * indistinguishable from harmless documentation strings. */
function executablePythonPolicySource(script: string): string {
  let result = '';
  let index = 0;
  while (index < script.length) {
    const ch = script[index];
    if (ch === '#') {
      while (index < script.length && script[index] !== '\n' && script[index] !== '\r') index += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const triple = script.slice(index, index + 3) === quote.repeat(3);
      index += triple ? 3 : 1;
      while (index < script.length) {
        if (script[index] === '\\') {
          index += 2;
          continue;
        }
        if (triple ? script.slice(index, index + 3) === quote.repeat(3) : script[index] === quote) {
          index += triple ? 3 : 1;
          break;
        }
        index += 1;
      }
      result += "''";
      continue;
    }
    result += ch;
    index += 1;
  }
  return result;
}

const ANIMATION_TIMING_METHODS = new Set([
  'set_frame_rate',
  'set_number_of_frames',
  'set_play_length',
  'resize_number_of_frames',
  'resize_play_length',
  'resize_in_frames',
  'resize',
]);
const ANIMATION_CONTROLLER_GETTERS = new Set([
  'get_controller',
  'get_data_controller',
  'get_animation_data_controller',
]);
const ANIMATION_SEQUENCE_NAMES = new Set([
  'anim', 'animation', 'anim_sequence', 'animation_sequence',
  'animsequence', 'animationsequence', 'anim_seq', 'sequence',
]);

/** Only f-string replacement fields execute. Ignore its ordinary text, including
 * escaped braces, then apply the same comment/string stripping to each field. */
function pythonFStringExpressions(source: string): string {
  const expressions: string[] = [];
  const skipQuoted = (start: number): number => {
    const quote = source[start];
    const triple = source.slice(start, start + 3) === quote.repeat(3);
    let at = start + (triple ? 3 : 1);
    while (at < source.length) {
      if (source[at] === '\\') { at += 2; continue; }
      if (triple ? source.slice(at, at + 3) === quote.repeat(3) : source[at] === quote) {
        return at + (triple ? 3 : 1);
      }
      at += 1;
    }
    return at;
  };

  for (let at = 0; at < source.length;) {
    if (source[at] === '#') {
      while (at < source.length && source[at] !== '\n' && source[at] !== '\r') at += 1;
      continue;
    }
    const start = at;
    if (/[a-z_]/i.test(source[at])) {
      while (at < source.length && /[a-z_0-9]/i.test(source[at])) at += 1;
    }
    const prefix = source.slice(start, at);
    if (source[at] !== "'" && source[at] !== '"') {
      if (at === start) at += 1;
      continue;
    }
    // A prefix must be an actual Python string prefix, not an identifier
    // preceding an unrelated quote.
    const isPrefix = prefix.length > 0 && prefix.length <= 3 && /^[frbu]+$/i.test(prefix);
    if (prefix && !isPrefix) continue;
    const quote = source[at];
    const triple = source.slice(at, at + 3) === quote.repeat(3);
    let bodyAt = at + (triple ? 3 : 1);
    if (!isPrefix || !prefix.toLowerCase().includes('f')) {
      at = skipQuoted(at);
      continue;
    }
    while (bodyAt < source.length) {
      if (source[bodyAt] === '\\') { bodyAt += 2; continue; }
      if (triple ? source.slice(bodyAt, bodyAt + 3) === quote.repeat(3) : source[bodyAt] === quote) {
        bodyAt += triple ? 3 : 1;
        break;
      }
      if (source[bodyAt] === '{') {
        if (source[bodyAt + 1] === '{') { bodyAt += 2; continue; }
        const expressionStart = ++bodyAt;
        let depth = 1;
        while (bodyAt < source.length && depth > 0) {
          if (source[bodyAt] === "'" || source[bodyAt] === '"') {
            bodyAt = skipQuoted(bodyAt);
            continue;
          }
          if (source[bodyAt] === '{') depth += 1;
          else if (source[bodyAt] === '}') depth -= 1;
          bodyAt += 1;
        }
        expressions.push(source.slice(expressionStart, depth === 0 ? bodyAt - 1 : bodyAt));
        continue;
      }
      bodyAt += 1;
    }
    at = bodyAt;
  }
  return expressions.join(';');
}

/** A small lexical mirror of the native animation-controller rule. The native
 * guard remains authoritative; this gives immediate feedback to Node clients.
 * Unlike a substring search, an exact receiver and method token are required. */
function animationTimingPattern(script: string): string | null {
  const executable = executablePythonPolicySource(script);
  const fStringExpressions = pythonFStringExpressions(script);
  const source = executable + (fStringExpressions ? `;${executablePythonPolicySource(fStringExpressions)}` : '');
  const tokens = source.match(/[a-z_][a-z_0-9]*|\r\n|[\r\n]|[.();:=]/gi)?.map((part) => part.toLowerCase()) ?? [];
  const controllerNames = new Map<string, boolean>();
  const classAliases = new Set<string>(['animationdatacontroller']);
  const importedClass = /\bfrom\s+unreal\s+import\s+animationdatacontroller\s+as\s+([a-z_]\w*)/gi;
  for (const match of executable.matchAll(importedClass)) classAliases.add(match[1].toLowerCase());
  const isId = (part: string | undefined): part is string => !!part && /^[a-z_][a-z_0-9]*$/.test(part);
  const skipNewlines = (from: number): number => {
    while (tokens[from] === '\n' || tokens[from] === '\r' || tokens[from] === '\r\n') from += 1;
    return from;
  };
  const dotted = (from: number): { path: string; after: number } | null => {
    if (!isId(tokens[from])) return null;
    const components = [tokens[from]];
    let at = from + 1;
    while (tokens[at] === '.' && isId(tokens[at + 1])) {
      components.push(tokens[at + 1]);
      at += 2;
    }
    return { path: components.join('.'), after: at };
  };
  const canonical = (method: string): string | null =>
    ANIMATION_TIMING_METHODS.has(method) ? `animationdatacontroller.${method}(` : null;
  const requiresEvidence = (method: string): boolean => method === 'resize' || method === 'set_frame_rate';
  const animationNamed = (path: string): boolean => ANIMATION_SEQUENCE_NAMES.has(path.split('.').at(-1) ?? '');
  const getterPath = (path: string): boolean => ANIMATION_CONTROLLER_GETTERS.has(path.split('.').at(-1) ?? '') && path.includes('.');
  // Python source cannot prove an object's runtime type. Treat Unreal's explicit
  // animation getter and the conventional `asset.get_controller()` spelling as
  // animation evidence; leave unrelated `widget.get_controller()` alone.
  const getterHasAnimationEvidence = (path: string): boolean => {
    const parts = path.split('.');
    return parts.at(-1) === 'get_animation_data_controller'
      || parts.at(-2) === 'asset'
      || animationNamed(parts.slice(0, -1).join('.'));
  };
  const classPath = (path: string): boolean => {
    const parts = path.split('.');
    return classAliases.has(parts.at(-1) ?? '');
  };
  const zeroArgCallEnd = (from: number): number | null => {
    if (tokens[from] !== '(') return null;
    const close = skipNewlines(from + 1);
    return tokens[close] === ')' ? close + 1 : null;
  };
  const controllerExpression = (from: number): boolean | null => {
    let at = from;
    let wrappers = 0;
    while (tokens[at] === '(') { wrappers += 1; at = skipNewlines(at + 1); }
    const name = dotted(at);
    if (!name) return null;
    at = name.after;
    const aliasEvidence = controllerNames.get(name.path);
    const getter = getterPath(name.path);
    const klass = classPath(name.path);
    if (aliasEvidence === undefined && !getter && !klass) return null;
    if (getter || klass) {
      const afterCall = zeroArgCallEnd(at);
      if (afterCall === null) return null;
      at = afterCall;
    }
    while (wrappers-- > 0) {
      at = skipNewlines(at);
      if (tokens[at] !== ')') return null;
      at += 1;
    }
    if (at < tokens.length && !['\n', '\r', '\r\n', ';'].includes(tokens[at])) return null;
    return aliasEvidence ?? (klass || getterHasAnimationEvidence(name.path));
  };

  for (let at = 0; at < tokens.length; at += 1) {
    if (!isId(tokens[at])) continue;
    const statementStart = at === 0 || ['\n', '\r', '\r\n', ';', ':'].includes(tokens[at - 1]);
    if (statementStart && tokens[at + 1] === '=' && tokens[at + 2] !== '=') {
      const evidence = controllerExpression(at + 2);
      if (evidence === null) controllerNames.delete(tokens[at]);
      else controllerNames.set(tokens[at], evidence);
    }
    if (tokens[at - 1] === '.') continue;
    const name = dotted(at);
    if (!name) continue;
    const pathParts = name.path.split('.');
    const method = pathParts.at(-1) ?? '';
    if (pathParts.length >= 2 && ANIMATION_TIMING_METHODS.has(method)) {
      const receiver = pathParts.slice(0, -1).join('.');
      if (classPath(receiver)) return canonical(method);
      const evidence = controllerNames.get(receiver);
      if (evidence !== undefined && (!requiresEvidence(method) || evidence)) return canonical(method);
    }
    if (getterPath(name.path)) {
      const afterCall = zeroArgCallEnd(name.after);
      if (afterCall !== null) {
        const afterGetter = skipNewlines(afterCall);
        const chainedMethod = tokens[afterGetter + 1];
        if (tokens[afterGetter] === '.' && isId(chainedMethod)
          && tokens[afterGetter + 2] === '(' && ANIMATION_TIMING_METHODS.has(chainedMethod)
          && (!requiresEvidence(chainedMethod) || getterHasAnimationEvidence(name.path))) {
          return canonical(chainedMethod);
        }
      }
    }
  }
  return null;
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
  const executableCompact = compactPythonPolicySource(executablePythonPolicySource(script));
  // Wildcard imports erase the callable spellings that both policy boundaries
  // rely on for alias analysis. The native lexer remains authoritative; this
  // is the matching early-feedback refusal for ordinary executable syntax.
  if (/\bfrom\s+[A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*\s+import\s*(?:\(\s*)?\*/i.test(script)) {
    return {
      pattern: 'wildcard import',
      code: 'HCR-DYNAMIC-001',
      family: 'dynamic_code_hiding',
      reason: 'it imports policy-denied callables without names that source alias analysis can prove',
      alternative: 'import only the specific policy-visible names required by the request',
    };
  }

  const compactDeadlineFrameWrite = compact.includes(".f_locals['_hb_deadline']");
  if (executableCompact.includes('_hb_deadline') || compactDeadlineFrameWrite) {
    return {
      pattern: '_hb_deadline',
      code: 'HCR-TIME-001',
      family: 'deadline_tampering',
      reason: 'it attempts to access reserved cooperative-deadline state',
      alternative: 'use application-owned variable names and leave the deadline hook private',
    };
  }
  const animationPattern = animationTimingPattern(script);
  if (animationPattern) {
    return { ...PYTHON_CRASH_RULES[0], pattern: animationPattern };
  }
  for (const rule of PYTHON_CRASH_RULES) {
    if (rule.code === 'HCR-ANIM-001') continue;
    for (const pattern of rule.patterns) {
      const policySource = pattern === 'importlib.' ? executableCompact : compact;
      if (compactContainsPolicyPattern(policySource, pattern)) {
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
    'This guard is non-bypassable. allow_unsafe is deprecated and ineffective for every embedded-Python policy; use typed brokered tools (#412/#415) for supported host work.',
  ].join('\n');
}
