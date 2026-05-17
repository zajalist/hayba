import type { ToolHandler } from '../types.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { deriveSignature, listRecordedCommands } from '../schema-registry.js';
import { isToolDisabled } from '../disabled-tools-watcher.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'reading the JSON schema of a specific HaybaOS command before invoking it',
  not_when: 'you only need a list of command names — use list_tool_categories instead',
};

function suggestClose(name: string, all: string[]): string[] {
  // Lightweight Levenshtein-like score so an LLM that guessed a wrong name
  // still gets a "did you mean" hint instead of a dead end.
  const lname = name.toLowerCase();
  const scored = all.map(n => {
    const ln = n.toLowerCase();
    let score = 0;
    if (ln === lname) score = 100;
    else if (ln.startsWith(lname) || lname.startsWith(ln)) score = 80;
    else if (ln.includes(lname) || lname.includes(ln)) score = 60;
    else {
      let i = 0;
      while (i < ln.length && i < lname.length && ln[i] === lname[i]) i++;
      score = i * 4;
    }
    return { n, score };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, 3).filter(x => x.score > 0).map(x => x.n);
}

export const getToolSignatureHandler: ToolHandler = async (args) => {
  const command = typeof args.command === 'string' ? args.command : '';
  if (!command) {
    return { content: [{ type: 'text', text: 'Error: command parameter is required' }], isError: true };
  }
  if (isToolDisabled(command)) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'tool_disabled',
          command,
          hint: 'This tool is disabled in the Hayba MCP panel — ask the user to re-enable it there.',
        }, null, 2),
      }],
    };
  }
  const sig = deriveSignature(command);
  if (!sig) {
    const did_you_mean = suggestClose(command, listRecordedCommands());
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'no_schema_available',
          command,
          hint: 'use list_tool_categories to discover commands, or python_run to invoke via UE Python',
          did_you_mean,
        }, null, 2),
      }],
    };
  }
  return { content: [{ type: 'text', text: JSON.stringify({ command, ...sig }, null, 2) }] };
};
