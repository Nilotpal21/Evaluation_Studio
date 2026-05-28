import type { SourceArchitectureContract } from '@agent-platform/arch-ai';

export interface BlueprintDocumentTopologyAgent {
  name: string;
  role?: string;
  executionMode?: string;
  description?: string;
  tools?: string[];
  gatherFields?: string[];
  flowStepSeeds?: string[];
  suggestedConstructs?: string[];
}

export interface BlueprintDocumentTopologyEdge {
  from: string;
  to: string;
  type?: string;
  experienceMode?: string;
  condition?: string;
  returnsControl?: boolean;
}

export interface BlueprintDocumentTopology {
  agents?: BlueprintDocumentTopologyAgent[];
  edges?: BlueprintDocumentTopologyEdge[];
  entryPoint?: string;
  pattern?: string;
  reasoning?: string;
}

export interface BlueprintDocumentArtifact {
  markdown: string;
  sectionCount: number;
  agentCount: number;
  handoffCount: number;
  status: 'concept' | 'draft' | 'locked';
  stage?: string;
  topology: BlueprintDocumentTopology | null;
  sourceArchitectureContract: SourceArchitectureContract | null;
}

interface BlueprintDocumentInput {
  metadata: Record<string, unknown>;
  topology?: Record<string, unknown> | null;
  stage?: string;
  approved?: boolean;
  locked?: boolean;
}

const BLUEPRINT_SECTION_COUNT = 17;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
}

function asSourceArchitectureContract(value: unknown): SourceArchitectureContract | null {
  const contract = asRecord(value);
  const declaredAgents = Array.isArray(contract.declaredAgents)
    ? contract.declaredAgents
        .map((agent) => {
          const item = asRecord(agent);
          const provenance = asRecord(item.provenance);
          return {
            name: asString(item.name),
            role: asString(item.role),
            tools: asStringArray(item.tools),
            memoryVariables: asStringArray(item.memoryVariables),
            limitations: asStringArray(item.limitations),
            provenance: {
              fileName: asString(provenance.fileName, 'Uploaded source'),
              section: asString(provenance.section) || undefined,
            },
          };
        })
        .filter((agent) => agent.name.length > 0)
    : [];

  if (declaredAgents.length === 0) return null;

  return {
    sourceFiles: asStringArray(contract.sourceFiles),
    declaredAgents,
    entryAgent: asString(contract.entryAgent) || undefined,
    channels: asStringArray(contract.channels),
    requiredMcpServers: asStringArray(contract.requiredMcpServers),
    sharedMemoryVariables: asStringArray(contract.sharedMemoryVariables),
    universalRules: asStringArray(contract.universalRules),
    guardrails: asStringArray(contract.guardrails),
    tools: Array.isArray(contract.tools)
      ? contract.tools
          .map((tool) => {
            const item = asRecord(tool);
            const provenance = asRecord(item.provenance);
            return {
              name: asString(item.name),
              signature: asString(item.signature) || undefined,
              description: asString(item.description) || undefined,
              callWhen: asStringArray(item.callWhen),
              doNotCallWhen: asStringArray(item.doNotCallWhen),
              source: asString(item.source) || undefined,
              provenance: {
                fileName: asString(provenance.fileName, 'Uploaded source'),
                section: asString(provenance.section) || undefined,
              },
            };
          })
          .filter((tool) => tool.name.length > 0)
      : [],
    optionalExternalAgents: asStringArray(contract.optionalExternalAgents),
    confidence:
      typeof contract.confidence === 'number' && Number.isFinite(contract.confidence)
        ? contract.confidence
        : 0.75,
  };
}

function asTopology(input: Record<string, unknown> | null | undefined): BlueprintDocumentTopology {
  const topology = asRecord(input);
  return {
    agents: Array.isArray(topology.agents)
      ? topology.agents.map((agent) => {
          const item = asRecord(agent);
          return {
            name: asString(item.name, 'UnnamedAgent'),
            role: asString(item.role),
            executionMode: asString(item.executionMode),
            description: asString(item.description),
            tools: asStringArray(item.tools),
            gatherFields: asStringArray(item.gatherFields),
            flowStepSeeds: asStringArray(item.flowStepSeeds),
            suggestedConstructs: asStringArray(item.suggestedConstructs),
          };
        })
      : [],
    edges: Array.isArray(topology.edges)
      ? topology.edges.map((edge) => {
          const item = asRecord(edge);
          const experienceMode = asString(item.experienceMode);
          return {
            from: asString(item.from),
            to: asString(item.to),
            type: asString(item.type, 'delegate'),
            ...(experienceMode ? { experienceMode } : {}),
            condition: asString(item.condition, 'true'),
            returnsControl:
              typeof item.returnsControl === 'boolean'
                ? item.returnsControl
                : typeof item.expectReturn === 'boolean'
                  ? item.expectReturn
                  : undefined,
          };
        })
      : [],
    entryPoint: asString(topology.entryPoint),
    pattern: asString(topology.pattern),
    reasoning: asString(topology.reasoning),
  };
}

function list(items: readonly string[], fallback: string): string[] {
  if (items.length === 0) return [fallback];
  return items.map((item) => `- ${item}`);
}

function formatPattern(pattern: string | undefined): string {
  if (!pattern) return 'To be decided';
  return pattern.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function agentLine(agent: BlueprintDocumentTopologyAgent): string {
  const description = agent.description || agent.role || 'No role captured yet';
  const mode = agent.executionMode || 'reasoning';
  const tools = formatListValue(agent.tools, 'no tools');
  const gathers = formatListValue(agent.gatherFields, 'no required fields');
  return `**${agent.name}** (${mode}): ${description}. Inputs: ${gathers}. Tools: ${tools}.`;
}

function formatListValue(items: readonly string[] | undefined, fallback: string): string {
  return items && items.length > 0 ? items.join(', ') : fallback;
}

function formatAgentConstructs(agent: BlueprintDocumentTopologyAgent): string {
  const constructs = agent.suggestedConstructs ?? [];
  if (constructs.length > 0) {
    return constructs.join(', ');
  }

  const inferred = new Set<string>();
  if ((agent.gatherFields ?? []).length > 0) inferred.add('GATHER');
  if ((agent.tools ?? []).length > 0) inferred.add('TOOLS');
  if ((agent.flowStepSeeds ?? []).length > 0) inferred.add('FLOW');
  return inferred.size > 0 ? Array.from(inferred).join(', ') : 'Reasoning response';
}

function routeLine(edge: BlueprintDocumentTopologyEdge): string {
  const returns = edge.returnsControl === true ? '; returns to source' : '';
  return `${edge.from || 'Unknown'} -> ${edge.to || 'Unknown'} (${edge.type ?? 'delegate'}): ${edge.condition ?? 'true'}${returns}`;
}

function hasAnyAgentValue(
  agents: readonly BlueprintDocumentTopologyAgent[],
  key: keyof Pick<
    BlueprintDocumentTopologyAgent,
    'tools' | 'gatherFields' | 'flowStepSeeds' | 'suggestedConstructs'
  >,
): boolean {
  return agents.some((agent) => (agent[key] ?? []).length > 0);
}

export function buildBlueprintDocumentArtifact(
  input: BlueprintDocumentInput,
): BlueprintDocumentArtifact {
  const metadata = input.metadata;
  const spec = asRecord(metadata.specification);
  const sourceContract = asSourceArchitectureContract(metadata.sourceArchitectureContract);
  const topology = asTopology(input.topology);
  const agents = topology.agents ?? [];
  const edges = topology.edges ?? [];
  const sourceAgentNames = sourceContract?.declaredAgents.map((agent) => agent.name) ?? [];
  const topologyAgentNames = new Set(agents.map((agent) => agent.name));
  const missingSourceAgents = sourceAgentNames.filter((name) => !topologyAgentNames.has(name));
  const capturedSourceAgents = sourceAgentNames.filter((name) => topologyAgentNames.has(name));
  const sourceDeclaredTools = sourceContract?.tools.map((tool) => tool.name) ?? [];
  const hasTools = hasAnyAgentValue(agents, 'tools');
  const hasGathers = hasAnyAgentValue(agents, 'gatherFields');
  const hasFlowSteps = hasAnyAgentValue(agents, 'flowStepSeeds');
  const hasConstructHints = hasAnyAgentValue(agents, 'suggestedConstructs');
  const projectName =
    asString(spec.projectName) ||
    asString((metadata.specDocument as Record<string, unknown> | undefined)?.projectName) ||
    'Untitled Project';
  const summary =
    asString(spec.description) ||
    asString(spec.objective) ||
    (agents.length > 0
      ? `${projectName} is designed as a ${formatPattern(topology.pattern).toLowerCase()} assistant with ${agents.length} agent${agents.length === 1 ? '' : 's'}.`
      : `${projectName} is still in architecture discovery.`);
  const channels = asStringArray(spec.channels);
  const language = asString(spec.language, 'English');
  const notes = asStringArray(spec.conversationNotes);
  const successCriteria =
    notes.length > 0
      ? notes.slice(0, 6)
      : [
          'Route each user request to the right owner.',
          'Collect only the information required for the active task.',
          'Escalate cleanly when automation cannot safely finish the work.',
        ];
  const status: BlueprintDocumentArtifact['status'] =
    input.locked || input.approved ? 'locked' : agents.length > 0 ? 'draft' : 'concept';
  const lines: string[] = [];

  lines.push(`# ${projectName} Blueprint`);
  lines.push('');
  lines.push(`Status: ${status}`);
  lines.push('');
  lines.push('## 1. Executive Summary');
  lines.push('');
  lines.push(summary);
  lines.push('');
  lines.push('## 2. Why This Should Win');
  lines.push('');
  lines.push(...list(successCriteria, 'No success criteria captured yet.'));
  lines.push('');
  lines.push('## 3. Platform Config');
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('| --- | --- |');
  lines.push(
    `| Channels | ${channels.join(', ') || sourceContract?.channels.join(', ') || 'Not captured yet'} |`,
  );
  lines.push(`| Language | ${language} |`);
  lines.push(
    `| Entry point | ${topology.entryPoint || sourceContract?.entryAgent || 'Not selected yet'} |`,
  );
  if (sourceContract) {
    lines.push(
      `| Source files | ${sourceContract.sourceFiles.join(', ') || 'Uploaded document'} |`,
    );
    if (sourceContract.requiredMcpServers.length > 0) {
      lines.push(`| Required MCP/tools | ${sourceContract.requiredMcpServers.join(', ')} |`);
    }
  }
  if (sourceContract) {
    lines.push('');
    lines.push('Source coverage:');
    lines.push(
      `- Agents: ${capturedSourceAgents.length}/${sourceAgentNames.length} source-declared agents captured`,
    );
    lines.push(
      `- Tools: ${sourceDeclaredTools.length} source-declared tool${sourceDeclaredTools.length === 1 ? '' : 's'} carried into blueprint context`,
    );
    lines.push(
      `- Shared memory: ${formatListValue(sourceContract.sharedMemoryVariables, 'No shared memory variables declared')}`,
    );
    if (missingSourceAgents.length > 0) {
      lines.push(`- Missing source agents: ${missingSourceAgents.join(', ')}`);
    }
  }
  lines.push('');
  lines.push('## 4. Topology');
  lines.push('');
  lines.push(`Pattern: ${formatPattern(topology.pattern)}`);
  if (topology.reasoning) lines.push(`Rationale: ${topology.reasoning}`);
  lines.push('');
  if (agents.length > 0) {
    lines.push('| Agent | Mode | Responsibility | Inputs | Tools | Runtime constructs |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const agent of agents) {
      lines.push(
        `| ${agent.name} | ${agent.executionMode || 'reasoning'} | ${agent.description || agent.role || 'Pending responsibility'} | ${formatListValue(agent.gatherFields, 'None yet')} | ${formatListValue(agent.tools, 'None yet')} | ${formatAgentConstructs(agent)} |`,
      );
    }
  } else {
    lines.push('No agent topology has been generated yet.');
  }
  lines.push('');
  lines.push('Topology summary:');
  lines.push('');
  lines.push(...list(agents.map(agentLine), 'No agent topology has been generated yet.'));
  lines.push('');
  lines.push('## 5. Solution Architecture');
  lines.push('');
  lines.push(
    ...list(
      agents.map(
        (agent) =>
          `${agent.name} owns ${agent.role || agent.description || 'a pending responsibility'} with ${formatAgentConstructs(agent)}.`,
      ),
      'Architecture responsibilities will appear once the blueprint draft is generated.',
    ),
  );
  lines.push('');
  lines.push('## 6. Call Control');
  lines.push('');
  lines.push(
    ...list(edges.map(routeLine), 'Single-agent or undecided flow; no handoffs captured yet.'),
  );
  lines.push('');
  lines.push('## 7. System Prompts');
  lines.push('');
  lines.push(
    ...list(
      agents.map(
        (agent) =>
          `${agent.name}: ${agent.description || agent.role || 'Use the role-specific system prompt derived from this blueprint.'}`,
      ),
      'System prompt decisions have not been captured yet.',
    ),
  );
  lines.push('');
  lines.push('## 8. Knowledge');
  lines.push('');
  lines.push(
    ...list(
      [...notes, ...(sourceContract?.universalRules ?? []).map((rule) => `Source rule: ${rule}`)],
      'No knowledge sources or assumptions captured yet.',
    ),
  );
  lines.push('');
  lines.push('## 9. Inputs and Outputs');
  lines.push('');
  lines.push(
    ...list(
      agents.map(
        (agent) =>
          `${agent.name}: collects ${formatListValue(agent.gatherFields, 'no required fields yet')}; completes with ${formatListValue(agent.flowStepSeeds, 'a direct answer or routed outcome')}.`,
      ),
      'Inputs and outputs are pending blueprint details.',
    ),
  );
  lines.push('');
  lines.push('## 10. Tools');
  lines.push('');
  if (hasTools) {
    lines.push(
      ...list(
        agents
          .filter((agent) => (agent.tools ?? []).length > 0)
          .map((agent) => `${agent.name}: ${(agent.tools ?? []).join(', ')}`),
        'No project tools have been captured in the blueprint draft yet.',
      ),
    );
  } else {
    lines.push('No project tools have been captured in the blueprint draft yet.');
  }
  if (sourceDeclaredTools.length > 0) {
    lines.push('');
    lines.push('Source-declared tool catalog:');
    lines.push(
      ...list(
        (sourceContract?.tools ?? []).map((tool) => {
          const guidance = [
            tool.callWhen?.length ? `call when: ${tool.callWhen.join('; ')}` : '',
            tool.doNotCallWhen?.length ? `do not call when: ${tool.doNotCallWhen.join('; ')}` : '',
          ].filter(Boolean);
          return `${tool.name}${tool.signature ? ` ${tool.signature}` : ''}${tool.description ? ` — ${tool.description}` : ''}${guidance.length > 0 ? ` (${guidance.join(' | ')})` : ''}`;
        }),
        'No source tool catalog captured.',
      ),
    );
  }
  lines.push('');
  lines.push('## 11. Memory');
  lines.push('');
  if (sourceContract && sourceContract.sharedMemoryVariables.length > 0) {
    lines.push(
      `Session memory must preserve source-declared variables across routed agents: ${sourceContract.sharedMemoryVariables.join(', ')}.`,
    );
  } else {
    lines.push(
      hasGathers
        ? 'Session memory should preserve collected case context across routed agents when those fields are needed downstream.'
        : 'Session memory will stay minimal unless the locked blueprint introduces shared case context.',
    );
  }
  lines.push('');
  lines.push('## 12. Decision Logic');
  lines.push('');
  lines.push(
    ...list(
      edges.map(
        (edge) =>
          `${edge.from || 'Unknown'} routes to ${edge.to || 'Unknown'} when ${edge.condition ?? 'true'}.`,
      ),
      'Decision logic is pending agent/edge details.',
    ),
  );
  if (hasFlowSteps) {
    lines.push('');
    lines.push(
      ...list(
        agents
          .filter((agent) => (agent.flowStepSeeds ?? []).length > 0)
          .map((agent) => `${agent.name} flow: ${(agent.flowStepSeeds ?? []).join(' -> ')}`),
        'Flow steps are pending agent details.',
      ),
    );
  }
  lines.push('');
  lines.push('## 13. Multi-Agent Relationships');
  lines.push('');
  lines.push(
    ...list(
      edges.map(
        (edge) =>
          `${edge.from || 'Unknown'} coordinates with ${edge.to || 'Unknown'} via ${edge.type ?? 'delegate'}.`,
      ),
      'No multi-agent relationships captured yet.',
    ),
  );
  lines.push('');
  lines.push('## 14. Guardrails');
  lines.push('');
  lines.push(
    ...list(
      sourceContract?.guardrails ?? [],
      hasConstructHints
        ? 'Baseline content safety applies. BUILD should materialize the construct hints above without inventing unsupported runtime behavior.'
        : 'Baseline content safety applies. Domain guardrails need to be captured before deterministic BUILD.',
    ),
  );
  lines.push('');
  lines.push('## 15. Error Handling');
  lines.push('');
  lines.push(
    'Fallback behavior: ask clarifying questions, retry recoverable tool failures, and escalate when confidence is low.',
  );
  lines.push('');
  lines.push('## 16. Eval and QA');
  lines.push('');
  lines.push(
    ...list(
      successCriteria.map((item) => `Validate: ${item}`),
      'Add eval scenarios before production.',
    ),
  );
  lines.push('');
  lines.push('## 17. Configuration Checklist');
  lines.push('');
  lines.push(`- Review and lock this blueprint.`);
  lines.push(
    `- Confirm ${agents.length} agent${agents.length === 1 ? '' : 's'} and ${edges.length} handoff${edges.length === 1 ? '' : 's'}.`,
  );
  lines.push('- Render deterministic ABL from the locked blueprint.');
  lines.push('');

  return {
    markdown: `${lines.join('\n')}\n`,
    sectionCount: BLUEPRINT_SECTION_COUNT,
    agentCount: agents.length,
    handoffCount: edges.length,
    status,
    stage: input.stage,
    topology,
    sourceArchitectureContract: sourceContract,
  };
}
