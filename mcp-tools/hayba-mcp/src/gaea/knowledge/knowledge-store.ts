import { readFileSync, existsSync } from 'fs';
import path from 'path';
import type { NodeReference, NodeReferenceMap, BestPractice, WorkflowPattern } from './knowledge-types.js';

export class KnowledgeStore {
  private nodeRef: NodeReferenceMap = {};
  private bestPractices: BestPractice[] = [];
  private workflowPatterns: Record<string, WorkflowPattern> = {};

  constructor(private docsDir: string) {
    this.loadSync();
  }

  private loadSync(): void {
    const nodeRefPath = path.join(this.docsDir, 'node-reference.json');
    if (existsSync(nodeRefPath)) {
      this.nodeRef = JSON.parse(readFileSync(nodeRefPath, 'utf-8')) as NodeReferenceMap;
    }

    const bpPath = path.join(this.docsDir, 'best-practices.json');
    if (existsSync(bpPath)) {
      const data = JSON.parse(readFileSync(bpPath, 'utf-8')) as { rules: BestPractice[] };
      this.bestPractices = data.rules;
    }

    const wpPath = path.join(this.docsDir, 'workflow-patterns.json');
    if (existsSync(wpPath)) {
      this.workflowPatterns = JSON.parse(readFileSync(wpPath, 'utf-8')) as Record<string, WorkflowPattern>;
    }
  }

  getNode(nodeType: string): NodeReference | null {
    return this.nodeRef[nodeType] ?? null;
  }

  getBestPractices(filter: { phase?: string; nodeTypes?: string[] }): BestPractice[] {
    return this.bestPractices.filter(rule => {
      if (filter.phase && rule.category !== filter.phase && rule.category !== 'workflow' && rule.category !== 'performance') {
        return false;
      }
      if (filter.nodeTypes && filter.nodeTypes.length > 0) {
        const ruleLower = rule.rule.toLowerCase();
        return filter.nodeTypes.some(n => {
          const exact = n.toLowerCase();
          // Also try stripping trailing digits (e.g. "Erosion2" → "erosion")
          const stem = exact.replace(/\d+$/, '');
          return ruleLower.includes(exact) || (stem !== exact && ruleLower.includes(stem));
        });
      }
      return true;
    });
  }

  findPatterns(query: { phase?: string; description?: string }): WorkflowPattern[] {
    return Object.values(this.workflowPatterns).filter(p => {
      if (query.phase && p.phase !== query.phase) return false;
      if (query.description) {
        const lower = query.description.toLowerCase();
        if (!p.description.toLowerCase().includes(lower) && !p.when_to_use.toLowerCase().includes(lower)) {
          return false;
        }
      }
      return true;
    });
  }

  getNodeNeighbors(nodeType: string): { predecessors: string[]; successors: string[] } {
    const node = this.nodeRef[nodeType];
    if (!node) return { predecessors: [], successors: [] };
    return {
      predecessors: node.typical_predecessors,
      successors: node.typical_successors,
    };
  }

  get nodeTypes(): string[] {
    return Object.keys(this.nodeRef);
  }

  get allNodes(): NodeReferenceMap {
    return this.nodeRef;
  }
}
