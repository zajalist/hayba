/**
 * Every legacy command must describe itself in words an agent can search.
 *
 * A legacy tool's whole description is synthesised as
 *   `UE command "<name>" (<HandlerClass>::Handle). <notes>`
 * so a command with no `notes` is described entirely by its own name and a C++
 * class name. That is invisible to intent-based search — nobody looks for
 * "FHaybaMCPLevelHandler" — and useless for choosing between two tools. 34 of
 * the 84 commands were in that state, including level_load (which can lose
 * unsaved work) and editor_get_output_log (the first thing to read when a
 * command lied about succeeding).
 *
 * This is a floor, not a style guide: it only asserts that a human wrote
 * something of substance.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sidecar = JSON.parse(readFileSync(join(here, 'sidecar.json'), 'utf-8')) as {
  commands: Record<string, { notes?: string; handler_cpp?: string }>;
};

const entries = Object.entries(sidecar.commands);

describe('legacy command descriptions', () => {
  it('has a plausible number of commands (guards the fixture itself)', () => {
    expect(entries.length).toBeGreaterThan(50);
  });

  it.each(entries)('%s explains what it does', (name, entry) => {
    const notes = (entry.notes ?? '').trim();
    expect(notes, `"${name}" has no notes, so its description is just its own name plus a C++ class`).not.toBe('');

    // An alias's most useful description IS the name of the command it aliases;
    // padding it to a length quota would make it worse, not better.
    if (/^alias of \w+\.?$/i.test(notes)) return;

    // Otherwise: long enough to say what the tool is for and when to reach for
    // it, rather than restating the signature.
    expect(notes.length, `"${name}" notes are too short to be useful: ${notes}`).toBeGreaterThan(60);
  });

  it('never describes a command by restating its own name and nothing else', () => {
    const lazy = entries.filter(([name, e]) => {
      const notes = (e.notes ?? '').trim().toLowerCase();
      const words = name.replace(/_/g, ' ');
      return notes === words || notes === `${words}.`;
    });
    expect(lazy.map(([n]) => n)).toEqual([]);
  });
});
