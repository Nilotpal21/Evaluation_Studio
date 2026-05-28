import type { TopologyPattern } from './types';

export const TOPOLOGY_PATTERNS: TopologyPattern[] = [
  {
    id: 'single_agent',
    name: 'Single Agent',
    whenToUse:
      'One domain, no routing needed. Simple Q&A, task completion, or single-purpose assistant.',
    structure: '1 AGENT (reasoning or hybrid). No supervisor.',
    ablImplications:
      'No HANDOFF needed. Use GATHER + TOOLS + CONSTRAINTS. FLOW for scripted/hybrid mode.',
    edgeTypes: [],
    antiPatterns: [
      'Do not add a SUPERVISOR for a single agent — it adds latency and complexity with no benefit.',
      'Do not use this pattern when there are 2+ clearly distinct capability domains.',
    ],
  },
  {
    id: 'triage_specialists',
    name: 'Triage -> Specialists',
    whenToUse:
      'Multiple distinct domains where user intent determines which agent handles the request. Customer support, help desks, multi-purpose bots.',
    structure:
      '1 SUPERVISOR (NLU-driven routing) -> N specialist AGENTs. Supervisor classifies intent and routes.',
    ablImplications:
      'Supervisor needs NLU + HANDOFF. Each specialist is independent with its own TOOLS/GATHER/CONSTRAINTS. Most common pattern.',
    edgeTypes: ['routing', 'handoff', 'escalation'],
    antiPatterns: [
      'Do not use for sequential workflows — if step 2 always follows step 1, use Pipeline instead.',
      'Do not create specialists with overlapping responsibilities — each must have a clear domain boundary.',
    ],
  },
  {
    id: 'pipeline',
    name: 'Pipeline',
    whenToUse:
      'Sequential workflow where each stage transforms or enriches data before passing to the next. Loan processing, document intake, multi-step approval.',
    structure:
      'Chain of AGENTs connected by pipeline_next edges. Each agent completes its stage then hands off.',
    ablImplications:
      'Each agent does one job. FLOW-driven (scripted/hybrid). GATHER in early stages, TOOLS in middle stages, RESPOND at end. Use ON_START for stage initialization.',
    edgeTypes: ['pipeline_next', 'escalation'],
    antiPatterns: [
      'Do not use when steps can run in parallel — use Hub-and-Spoke with delegate instead.',
      'Do not use for conversational routing — Pipeline assumes fixed sequence, not dynamic intent.',
    ],
  },
  {
    id: 'hub_spoke',
    name: 'Hub-and-Spoke',
    whenToUse:
      'Central coordinator delegates subtasks to specialists and needs results back. Research assistants, complex analysis, multi-source aggregation.',
    structure:
      '1 SUPERVISOR with delegate edges -> N worker AGENTs that return_to_parent. Supervisor aggregates results.',
    ablImplications:
      'Supervisor uses DELEGATE (stack-based, not HANDOFF). Workers use __return_to_parent__. Supervisor needs MEMORY for aggregation state. HOOKS on_delegate_complete.',
    edgeTypes: ['delegate', 'escalation'],
    antiPatterns: [
      'Do not use for simple intent routing — if the coordinator does not need results back, use Triage instead.',
      'Do not delegate to more than 5 workers in parallel — aggregation complexity grows fast.',
    ],
  },
  {
    id: 'mesh',
    name: 'Mesh',
    whenToUse:
      'Peer agents that route to each other based on context. Highly dynamic conversations where topics shift unpredictably. Multi-department support where any agent can escalate to any other.',
    structure:
      'N AGENTs with bidirectional handoff edges. May have multiple entry points. Requires allowCycle on edges.',
    ablImplications:
      'Requires allowCycle on edges. Each agent needs CONSTRAINTS to know when to hand off. Complex — use sparingly. Every agent needs NLU for intent detection.',
    edgeTypes: ['handoff', 'escalation'],
    antiPatterns: [
      'Never use mesh for fewer than 3 agents — simpler patterns are always better.',
      'Avoid without explicit cycle limits — unbounded loops will confuse users.',
    ],
  },
];

export const TOPOLOGY_DECISION_TREE = `Q1: How many distinct capability domains?
  -> 1 domain -> SINGLE AGENT
  -> 2+ domains:
    Q2: Is the workflow sequential (each step feeds the next)?
      -> Yes -> PIPELINE
      -> No:
        Q3: Does a central agent need results back from sub-agents?
          -> Yes -> HUB-AND-SPOKE
          -> No:
            Q4: Can users enter from multiple points / agents are peers?
              -> Yes -> MESH
              -> No -> TRIAGE -> SPECIALISTS`;

export function getPatternCatalogPromptText(): string {
  let text = '## Topology Pattern Catalog\n\n';
  text += 'Choose the pattern that best fits the use case. Use the decision tree below.\n\n';

  for (const p of TOPOLOGY_PATTERNS) {
    text += `### ${p.name} (${p.id})\n`;
    text += `**When to use:** ${p.whenToUse}\n`;
    text += `**Structure:** ${p.structure}\n`;
    text += `**ABL implications:** ${p.ablImplications}\n`;
    if (p.edgeTypes.length > 0) {
      text += `**Edge types:** ${p.edgeTypes.join(', ')}\n`;
    }
    text += `**Anti-patterns:**\n`;
    for (const ap of p.antiPatterns) {
      text += `- ${ap}\n`;
    }
    text += '\n';
  }

  text += '## Pattern Selection Decision Tree\n\n```\n' + TOPOLOGY_DECISION_TREE + '\n```\n';
  return text;
}
