import { createToolFilter, resolveArchetype, type AgentsManifest } from './agent-registry.js';

export interface SpecialistSelection {
  id: string;
  toolNames: string[];
  reason: 'pinned' | 'matched' | 'ambiguous' | 'no_match';
}

// Ignore conversational glue so routing reflects declared capabilities.
const STOP_WORDS = new Set(
  'a an and are as at be before by can do for from have how i in into is it me my of on or please the their this to use want we with you your'.split(
    ' ',
  ),
);

function terms(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
      .map((word) => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word)),
  );
}

/** Pure routing over enabled canonical names; a profile can only narrow that set. */
export function selectSpecialist(
  intent: string,
  manifest: AgentsManifest,
  availableTools: Iterable<string>,
  pinnedId?: string,
): SpecialistSelection {
  const enabled = [...new Set(availableTools)];
  const selection = (id: string, reason: SpecialistSelection['reason']): SpecialistSelection => ({
    id,
    toolNames: enabled.filter(createToolFilter(resolveArchetype(id, manifest).tool_filter)),
    reason,
  });
  if (pinnedId !== undefined) return selection(pinnedId, 'pinned');

  const coordinator =
    manifest.archetypes.find((profile) => profile.id === 'coordinator') ?? resolveArchetype('director', manifest);
  const requested = terms(intent);
  const candidates = manifest.archetypes
    .filter((profile) => profile.id !== coordinator.id)
    .map((profile) => {
      const guidance = terms(`${profile.id} ${profile.role} ${profile.system_prompt}`);
      const hasTools = enabled.some(createToolFilter(profile.tool_filter));
      const score = hasTools ? [...requested].filter((word) => guidance.has(word)).length : 0;
      return { id: profile.id, score };
    });
  const bestScore = Math.max(0, ...candidates.map((candidate) => candidate.score));
  const best = candidates.filter((candidate) => candidate.score === bestScore);
  if (bestScore === 0) return selection(coordinator.id, 'no_match');
  if (best.length !== 1) return selection(coordinator.id, 'ambiguous');
  return selection(best[0].id, 'matched');
}
