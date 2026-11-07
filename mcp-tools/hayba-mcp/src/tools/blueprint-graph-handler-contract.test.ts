import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const source = readFileSync(join(root, 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Private', 'handlers', 'HaybaMCPBlueprintHandler.cpp'), 'utf8');

describe('Blueprint event-graph authoring contract', () => {
  it('exports exact nodes, pins and edges before mutation', () => {
    expect(source).toContain('blueprint_inspect_graph');
    expect(source).toContain('HaybaDescribeNode(Node)');
    // Edges name their target by the linked pin's owning node GUID (paged since restart 6, so the variable moved).
    expect(source).toMatch(/(Linked|\.To)->GetOwningNode\(\)->NodeGuid/);
  });

  it.each(['branch', 'select', 'timer_by_function', 'call_function'])(
    'supports %s nodes', (kind) => expect(source).toContain(`TEXT("${kind}")`),
  );

  it('uses schema-checked pin connections and defaults', () => {
    expect(source).toContain('Schema->CanCreateConnection');
    expect(source).toContain('Schema->TryCreateConnection');
    expect(source).toContain('Schema->TrySetDefaultValue');
  });

  it('saves only after a clean explicit compile', () => {
    expect(source).toMatch(/if \(bOk && bSave\)[\s\S]*UPackage::SavePackage/);
  });
});

const router = readFileSync(join(root, 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Private', 'HaybaMCPCommandHandler.cpp'), 'utf8');
const executor = readFileSync(join(root, 'mcp-tools', 'hayba-mcp', 'src', 'tools', 'tool-executor.ts'), 'utf8');
const heavy = readFileSync(join(root, 'mcp-tools', 'hayba-mcp', 'src', 'tools', 'heavy-ops.ts'), 'utf8');
const sidecar = JSON.parse(
  readFileSync(join(root, 'mcp-tools', 'hayba-mcp', 'src', 'legacy-commands', 'sidecar.json'), 'utf8'),
) as { commands: Record<string, { agent_callable: boolean; returns: { fields?: Array<{ name: string }> } }> };

/** The body of one handler method, from its signature to the next method. */
function method(name: string): string {
  const start = source.indexOf(`FHaybaHandlerResult FHaybaMCPBlueprintHandler::${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const next = source.indexOf('\nFHaybaHandlerResult FHaybaMCPBlueprintHandler::', start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

const GRAPH_TOOLS: Array<[string, string]> = [
  ['blueprint_graph_batch', 'GraphBatch'],
  ['blueprint_add_comment', 'AddComment'],
  ['blueprint_move_nodes', 'MoveNodes'],
  ['blueprint_remove_nodes', 'RemoveNodes'],
  ['blueprint_disconnect', 'Disconnect'],
  ['blueprint_fit_comments', 'FitComments'],
];

describe('Blueprint graph batch, comments, moves and removal', () => {
  it.each(GRAPH_TOOLS)('%s is advertised, dispatched, plan-gated and agent-callable', (cmd, fn) => {
    expect(source).toContain(`TEXT("${cmd}"),`);
    expect(source).toContain(`if (Cmd == TEXT("${cmd}"))`);
    expect(source).toMatch(new RegExp(`TEXT\\("${cmd}"\\)\\)\\s+return ${fn}\\(P\\)`));
    expect(router).toContain(`TEXT("${cmd}"),`);
    expect(sidecar.commands[cmd]?.agent_callable).toBe(true);
  });

  it.each(GRAPH_TOOLS)('%s documents exactly the fields it returns', (cmd, fn) => {
    const emitted = [...new Set([...method(fn).matchAll(/Out->Set(?:String|Bool|Number|Object|Array)Field\(TEXT\("([^"]+)"\)/g)].map((m) => m[1]!))].sort();
    const documented = (sidecar.commands[cmd]?.returns.fields ?? []).map((f) => f.name).sort();
    expect(documented).toEqual(emitted);
  });

  it('never blind-retries an append or removal, and moves stay retryable', () => {
    for (const cmd of ['blueprint_graph_batch', 'blueprint_add_comment', 'blueprint_remove_nodes', 'blueprint_disconnect']) {
      expect(executor).toContain(`'${cmd}',`);
    }
    expect(executor).not.toContain(`'blueprint_move_nodes',`);
    expect(heavy).toContain(`'blueprint_graph_batch',`);
  });

  it('regenerates the skeleton once per batch, not once per op', () => {
    const batch = method('GraphBatch');
    expect(batch.indexOf('bDeferStructuralMark = true')).toBeLessThan(batch.indexOf('for (int32 I = 0; I < Ops->Num()'));
    expect(batch).toContain('if (bStructuralPending) FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(BP)');
    // Per-op handlers go through the deferrable helper.
    expect(method('AddNode')).not.toContain('MarkBlueprintAsStructurallyModified');
    expect(method('ConnectNodes')).not.toContain('MarkBlueprintAsStructurallyModified');
  });

  it('stops at the first failed or unverified op and compiles only a complete batch', () => {
    const batch = method('GraphBatch');
    expect(batch).toContain('if (!Res.bOk || !bVerified)');
    expect(batch).toContain('if (bAllApplied && bCompile)');
  });

  it('closes the Blueprint editors before removing nodes, and checks every id first', () => {
    const remove = method('RemoveNodes');
    expect(remove.indexOf('nothing was removed')).toBeLessThan(remove.indexOf('CloseAllEditorsForAsset'));
    expect(remove.indexOf('CloseAllEditorsForAsset')).toBeLessThan(remove.indexOf('FBlueprintEditorUtils::RemoveNode'));
  });

  it('refuses Blueprint edits and compiles while PIE runs', () => {
    expect(source).toContain('GEditor->IsPlaySessionInProgress()');
    expect(source).toMatch(/MutatingCommands\.Contains\(Cmd\) \|\| Cmd == TEXT\("blueprint_compile"\)/);
  });

  it('measures real node sizes from a private panel and stays read-only', () => {
    expect(source).toContain('if (Cmd == TEXT("blueprint_measure_nodes"))  return MeasureNodes(P)');
    expect(router).not.toContain('TEXT("blueprint_measure_nodes")');
    const emitted = [...new Set([...method('MeasureNodes').matchAll(/Out->Set(?:String|Bool|Number|Object|Array)Field\(TEXT\("([^"]+)"\)/g)].map((m) => m[1]!))].sort();
    expect((sidecar.commands.blueprint_measure_nodes?.returns.fields ?? []).map((f) => f.name).sort()).toEqual(emitted);
    // Built, updated and prepassed, never added to a window.
    expect(source).toMatch(/SNew\(SGraphPanel\)[\s\S]*Panel->Update\(\);[\s\S]*Panel->SlatePrepass\(1\.f\);[\s\S]*GetBoundsForNode/);
    expect(source).toContain('FSlateApplication::IsInitialized() && !IsRunningCommandlet()');
  });

  it('fits comments with measured sizes, inner boxes first, never touching colour or bubble flags', () => {
    const fit = method('FitComments');
    expect(fit).toContain('HaybaNodeBoxes(Graph, AllBoxes)');
    expect(fit).toMatch(/Order\.Sort[\s\S]*W\) \* Boxes\[A\]\.H </);
    expect(fit).not.toMatch(/CommentColor\s*=|bCommentBubbleVisible_InDetailsPanel\s*=|bColorCommentBubble\s*=/);
    expect(fit).toContain('Comment->NodeDetails = FText::GetEmpty()');
  });

  it('writes comment fields after PostPlacedNewNode, which resets colour, bubble and title', () => {
    const comment = method('AddComment');
    const placed = comment.indexOf('Comment->PostPlacedNewNode()');
    for (const field of ['Comment->CommentColor', 'Comment->NodeComment', 'Comment->bCommentBubbleVisible_InDetailsPanel', 'Comment->bColorCommentBubble']) {
      expect(comment.indexOf(field), field).toBeGreaterThan(placed);
    }
  });
});
