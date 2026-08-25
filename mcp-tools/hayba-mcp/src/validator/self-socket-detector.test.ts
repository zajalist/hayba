// The self-socket guard must cover the idioms people actually write.
//
// The original detector matched only `.connect((host, port))`. A live probe
// with `socket.create_connection(("127.0.0.1", 52342))` — arguably the more
// likely one-liner — sailed straight through to the game thread, while
// docs/RELIABILITY.md told readers the pattern was "refused outright".
//
// The port range matters as much as the idiom: 52342-52350 is the plugin's
// own range, and connecting into it from inside python_run deadlocks, because
// python_run is already running ON the game thread that would have to answer.

import { describe, it, expect } from 'vitest';
import { isSelfSocketScript } from './tool-hooks.js';

describe('idioms that deadlock', () => {
  it('catches the socket-method form', () => {
    expect(isSelfSocketScript('s.connect(("127.0.0.1", 52342))')).toBe(true);
  });

  it('catches the create_connection one-liner', () => {
    expect(isSelfSocketScript('socket.create_connection(("127.0.0.1", 52342))')).toBe(true);
  });

  it('catches localhost as well as the numeric address', () => {
    expect(isSelfSocketScript('socket.create_connection(("localhost", 52345))')).toBe(true);
    expect(isSelfSocketScript('s.connect(("localhost", 52342))')).toBe(true);
  });

  it('catches every port in the plugin range, not just the default', () => {
    // The server falls back through 52343-52350 when the default is taken, so
    // a guard that only knows 52342 misses every multi-instance setup.
    for (let port = 52342; port <= 52350; port++) {
      expect(isSelfSocketScript(`socket.create_connection(("127.0.0.1", ${port}))`)).toBe(true);
    }
  });

  it('tolerates whitespace the way a real script has it', () => {
    expect(isSelfSocketScript('s . connect ( ( "127.0.0.1" ,  52342 ) )')).toBe(true);
    expect(isSelfSocketScript("s.connect(('127.0.0.1',52342))")).toBe(true);
  });

  it('finds it anywhere in a longer script', () => {
    const script = [
      'import unreal, socket',
      'actors = unreal.EditorLevelLibrary.get_all_level_actors()',
      'for a in actors:',
      '    print(a.get_name())',
      'conn = socket.create_connection(("127.0.0.1", 52342))',
    ].join('\n');
    expect(isSelfSocketScript(script)).toBe(true);
  });
});

describe('things that must NOT be refused', () => {
  // A guard that fires on healthy scripts is worse than no guard: it teaches
  // people to pass allow_unsafe reflexively, which disables the real catches.
  it('allows connections to other ports on localhost', () => {
    expect(isSelfSocketScript('socket.create_connection(("127.0.0.1", 8000))')).toBe(false);
    expect(isSelfSocketScript('s.connect(("localhost", 5432))')).toBe(false);
  });

  it('allows the sidecar port', () => {
    // The visual sidecar is a separate process; talking to it is normal.
    expect(isSelfSocketScript('socket.create_connection(("127.0.0.1", 8765))')).toBe(false);
  });

  it('allows connections to other hosts even on a plugin port', () => {
    expect(isSelfSocketScript('socket.create_connection(("192.168.1.50", 52342))')).toBe(false);
  });

  it('does not fire on ordinary Unreal work', () => {
    expect(isSelfSocketScript('import unreal\nunreal.EditorLevelLibrary.get_all_level_actors()')).toBe(false);
  });

  it('does not fire on the port number appearing as data', () => {
    expect(isSelfSocketScript('PORT = 52342  # documented default')).toBe(false);
  });
});
