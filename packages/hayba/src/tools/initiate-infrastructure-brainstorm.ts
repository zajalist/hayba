import { z } from 'zod';

const schema = z.object({
  topic: z.string().min(1).describe('The infrastructure or system design topic to brainstorm'),
  context: z.string().optional().describe('Additional context about the project or constraints'),
  constraints: z.array(z.string()).optional().describe('Explicit constraints or requirements'),
});

export type InitiateInfrastructureBrainstormParams = z.infer<typeof schema>;

export interface BrainstormApproach {
  id: string;
  name: string;
  description: string;
  pros: string[];
  cons: string[];
  estimatedComplexity: 'low' | 'medium' | 'high';
}

export interface BrainstormProposal {
  topic: string;
  approaches: BrainstormApproach[];
  recommendation: string;
  risks: string[];
  approvalRequired: true;
  approvalPrompt: string;
}

function generateApproaches(topic: string, context?: string, constraints?: string[]): BrainstormApproach[] {
  // Return structured approaches based on common PCGEx infrastructure patterns
  const baseApproaches: BrainstormApproach[] = [
    {
      id: 'approach_a',
      name: 'Incremental / Layered Build',
      description: `Build ${topic} incrementally — start with a minimal working foundation and add layers of complexity. Each phase is independently testable in UE5.`,
      pros: [
        'Early validation of core logic in UE5',
        'Easy to stop/adjust if requirements change',
        'Low risk of large rewrites',
      ],
      cons: [
        'May require refactoring as later layers expose earlier limitations',
        'Slower initial progress visually',
      ],
      estimatedComplexity: 'low',
    },
    {
      id: 'approach_b',
      name: 'Template / Blueprint Pattern',
      description: `Design ${topic} as a reusable template or blueprint. Define the full interface upfront, then implement modules independently.`,
      pros: [
        'Clean separation of concerns',
        'Reusable across multiple graphs',
        'Easier to parameterize for different use cases',
      ],
      cons: [
        'Higher upfront design cost',
        'Template constraints may limit flexibility later',
      ],
      estimatedComplexity: 'medium',
    },
    {
      id: 'approach_c',
      name: 'Modular Subgraph Composition',
      description: `Decompose ${topic} into named subgraphs, each responsible for a single concern. Wire them together in a coordinator graph.`,
      pros: [
        'Maximum reusability per subgraph',
        'Easier to debug individual stages',
        'Composable and swappable',
      ],
      cons: [
        'More assets to manage',
        'Subgraph boundary pins require careful pin naming',
        'Cross-subgraph attribute flow is harder to trace',
      ],
      estimatedComplexity: 'high',
    },
  ];

  // Adjust based on constraints
  if (constraints?.some(c => c.toLowerCase().includes('performance'))) {
    baseApproaches.forEach(a => {
      a.pros.push('Can be profiled independently via execute_pcg_graph');
    });
  }

  return baseApproaches;
}

export async function initiateInfrastructureBrainstorm(params: InitiateInfrastructureBrainstormParams): Promise<BrainstormProposal> {
  const { topic, context, constraints } = schema.parse(params);

  const approaches = generateApproaches(topic, context, constraints);

  const risks = [
    'PCGEx pin names must be verified via get_node_details before any graph is built — mismatches cause silent failures',
    'Attribute flow assumptions may be incorrect until validate_attribute_flow confirms them',
    'Subgraph boundary pins are JSON-only transformations — actual UE5 subgraph assets must be created separately via create_pcg_graph',
    context ? `Context-specific risk: "${context}" may introduce undocumented UE5 behavior` : '',
  ].filter(Boolean);

  const proposal: BrainstormProposal = {
    topic,
    approaches,
    recommendation: `${approaches[0].name}: ${approaches[0].description.slice(0, 100)}`,
    risks,
    approvalRequired: true,
    approvalPrompt:
      `IMPORTANT: This is a planning proposal only. No graphs have been created or modified.\n` +
      `Review the ${approaches.length} approaches above and reply with:\n` +
      `  - The approach ID you want to proceed with (e.g. "approach_a")\n` +
      `  - Any adjustments or additional constraints\n` +
      `  - Explicit approval: "Proceed with [approach_id]"\n\n` +
      `DO NOT call create_pcg_graph, validate_attribute_flow, or any graph-mutation tool until you have explicitly approved an approach.`,
  };

  return proposal;
}
