import {
  normalizeContent,
  type ArchSession,
  type BlueprintStage,
  type TopologyOutput,
} from './types/index.js';

export type BlueprintTopology = TopologyOutput;
type BlueprintAgent = BlueprintTopology['agents'][number];
type BlueprintEdge = BlueprintTopology['edges'][number];

export const BLUEPRINT_REVISION_TARGETS = [
  'agents',
  'responsibilities',
  'handoffs',
  'pattern',
] as const;

export type BlueprintRevisionTarget = (typeof BLUEPRINT_REVISION_TARGETS)[number];

export type BlueprintConfirmAnswer = 'generate_draft_topology' | 'refine_concept';

export interface BlueprintConfirmWidgetData {
  widgetType: 'BlueprintConfirm';
  question: string;
  title: string;
  description?: string;
  options: Array<{
    label: string;
    value: BlueprintConfirmAnswer;
    description?: string;
  }>;
  allowCustom: boolean;
}

export interface TopologyApprovalWidgetAnswer {
  action: 'accept' | 'request_changes' | 'reject';
  notes?: string;
}

export interface TopologyApprovalWidgetData {
  widgetType: 'TopologyApproval';
  question: string;
  title: string;
  description?: string;
  agentCount: number;
  edgeCount: number;
  entryPoint?: string;
  agents: string[];
  topology: BlueprintTopology;
}

export interface TopologyRevisionWidgetAnswer {
  targets: BlueprintRevisionTarget[];
  notes?: string;
}

export interface TopologyRevisionWidgetData {
  widgetType: 'TopologyRevision';
  question: string;
  title: string;
  description?: string;
  options: Array<{
    label: string;
    value: BlueprintRevisionTarget;
    description?: string;
  }>;
  minSelect: number;
  maxSelect: number;
  allowCustom: boolean;
  notesPlaceholder?: string;
}

export type BlueprintWidgetData =
  | BlueprintConfirmWidgetData
  | TopologyApprovalWidgetData
  | TopologyRevisionWidgetData;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asBlueprintStage(value: unknown): BlueprintStage | null {
  switch (value) {
    case 'concept_ready':
    case 'draft_generating':
    case 'draft_ready':
    case 'revising':
    case 'topology_locked':
      return value;
    default:
      return null;
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export function asBlueprintTopology(value: unknown): BlueprintTopology | null {
  if (!isRecord(value)) {
    return null;
  }

  const entryPoint = typeof value.entryPoint === 'string' ? value.entryPoint : '';
  if (!entryPoint) {
    return null;
  }

  const agents = Array.isArray(value.agents)
    ? value.agents
        .filter(isRecord)
        .map((agent): BlueprintAgent | null => {
          const name = typeof agent.name === 'string' ? agent.name : '';
          const role = typeof agent.role === 'string' ? agent.role : '';
          const executionMode =
            agent.executionMode === 'reasoning' ||
            agent.executionMode === 'scripted' ||
            agent.executionMode === 'hybrid'
              ? agent.executionMode
              : 'reasoning';
          const description = typeof agent.description === 'string' ? agent.description : '';
          return name
            ? {
                name,
                role,
                executionMode,
                description,
                tools: asStringArray(agent.tools),
                gatherFields: asStringArray(agent.gatherFields),
                flowStepSeeds: asStringArray(agent.flowStepSeeds),
                suggestedConstructs: asStringArray(agent.suggestedConstructs),
              }
            : null;
        })
        .filter((agent): agent is BlueprintAgent => agent !== null)
    : [];

  if (agents.length === 0) {
    return null;
  }

  const edges = Array.isArray(value.edges)
    ? value.edges
        .filter(isRecord)
        .map((edge): BlueprintEdge | null => {
          const from = typeof edge.from === 'string' ? edge.from : '';
          const to = typeof edge.to === 'string' ? edge.to : '';
          const type: BlueprintEdge['type'] =
            edge.type === 'delegate' || edge.type === 'escalate' || edge.type === 'transfer'
              ? edge.type
              : 'delegate';
          const experienceMode: BlueprintEdge['experienceMode'] =
            edge.experienceMode === 'shared_voice_handoff' ||
            edge.experienceMode === 'visible_handoff' ||
            edge.experienceMode === 'silent_delegate' ||
            edge.experienceMode === 'human_escalation'
              ? edge.experienceMode
              : undefined;
          const condition = typeof edge.condition === 'string' ? edge.condition : '';
          if (!from || !to || !condition) {
            return null;
          }
          return {
            from,
            to,
            type,
            experienceMode,
            condition,
            allowCycle: edge.allowCycle === true,
            expectReturn: edge.expectReturn === true,
          };
        })
        .filter((edge): edge is BlueprintEdge => edge !== null)
    : [];

  return {
    agents,
    edges,
    entryPoint,
  };
}

export function getDraftTopology(session: Pick<ArchSession, 'metadata'>): BlueprintTopology | null {
  const meta = session.metadata;
  return (
    asBlueprintTopology(meta.draftTopology) ??
    (meta.topologyApproved === true ? null : asBlueprintTopology(meta.topology))
  );
}

export function getLockedTopology(
  session: Pick<ArchSession, 'metadata'>,
): BlueprintTopology | null {
  const meta = session.metadata;
  return (
    asBlueprintTopology(meta.lockedTopology) ??
    (meta.topologyApproved === true ? asBlueprintTopology(meta.topology) : null)
  );
}

export function getEffectiveTopology(
  session: Pick<ArchSession, 'metadata'>,
): BlueprintTopology | null {
  return (
    getLockedTopology(session) ??
    getDraftTopology(session) ??
    asBlueprintTopology(session.metadata.topology)
  );
}

export function getBlueprintStage(session: Pick<ArchSession, 'metadata'>): BlueprintStage {
  const explicit = asBlueprintStage(session.metadata.blueprintStage);
  if (explicit) {
    return explicit;
  }

  if (getLockedTopology(session)) {
    return 'topology_locked';
  }

  if (getDraftTopology(session)) {
    return 'draft_ready';
  }

  return 'concept_ready';
}

function extractAgentNames(topology: BlueprintTopology): string[] {
  return topology.agents.map((agent) => agent.name);
}

export function getBlueprintContextSummary(
  session: Pick<ArchSession, 'metadata'>,
  fallback?: string | null,
): string | null {
  const summary = session.metadata.blueprintContextSummary?.trim();
  if (summary) {
    return summary;
  }

  if (fallback?.trim()) {
    return fallback.trim();
  }

  const latestAssistant = [...session.metadata.messages]
    .reverse()
    .find((message) => message.role === 'assistant' && message.phase === 'BLUEPRINT');
  if (!latestAssistant) {
    return null;
  }

  const text = normalizeContent(latestAssistant.content).trim();
  return text.length > 0 ? text : null;
}

export function buildBlueprintConfirmWidget(summary?: string | null): BlueprintConfirmWidgetData {
  return {
    widgetType: 'BlueprintConfirm',
    question:
      'Would you like to turn this concept into a draft topology or refine the approach first?',
    title: 'Blueprint direction',
    description:
      summary?.trim() ||
      'We can lock in the architectural direction now or refine the concept before drawing the agent graph.',
    options: [
      {
        label: 'Generate draft topology',
        value: 'generate_draft_topology',
        description: 'Create the first agent graph and explain the structure.',
      },
      {
        label: 'Refine concept first',
        value: 'refine_concept',
        description: 'Stay in BLUEPRINT and adjust the approach before generating the graph.',
      },
    ],
    allowCustom: false,
  };
}

export function buildTopologyApprovalWidget(
  topology: BlueprintTopology,
  summary?: string | null,
): TopologyApprovalWidgetData {
  const agents = extractAgentNames(topology);
  return {
    widgetType: 'TopologyApproval',
    question:
      'Review this draft topology. Accept it, request changes, or reject it and restart the concept.',
    title: 'Draft topology ready',
    description:
      summary?.trim() ||
      `This draft has ${agents.length} agents and ${topology.edges.length} handoffs.`,
    agentCount: agents.length,
    edgeCount: topology.edges.length,
    entryPoint: topology.entryPoint,
    agents,
    topology,
  };
}

export function buildTopologyRevisionWidget(
  draftTopology: BlueprintTopology | null,
): TopologyRevisionWidgetData {
  const agentCount = draftTopology?.agents.length ?? 0;
  return {
    widgetType: 'TopologyRevision',
    question: 'What should change in this draft topology?',
    title: 'Refine the draft topology',
    description:
      agentCount > 0
        ? `Keep the current ${agentCount}-agent draft visible while you describe the revision.`
        : 'Describe what should change before we regenerate the draft.',
    options: [
      {
        label: 'Agents',
        value: 'agents',
        description: 'Add, remove, split, or rename agents.',
      },
      {
        label: 'Responsibilities',
        value: 'responsibilities',
        description: 'Adjust what each agent owns.',
      },
      {
        label: 'Handoffs',
        value: 'handoffs',
        description: 'Change routing, escalation, or collaboration edges.',
      },
      {
        label: 'Pattern',
        value: 'pattern',
        description: 'Change the overall architecture style or structure.',
      },
    ],
    minSelect: 1,
    maxSelect: BLUEPRINT_REVISION_TARGETS.length,
    allowCustom: false,
    notesPlaceholder:
      'Describe the change you want. Example: split notifications from scheduling and reduce cross-agent handoffs.',
  };
}

function isWidgetPayload(
  payload: unknown,
  widgetType?: BlueprintWidgetData['widgetType'],
): payload is BlueprintWidgetData {
  if (!isRecord(payload) || typeof payload.widgetType !== 'string') {
    return false;
  }

  if (widgetType) {
    return payload.widgetType === widgetType;
  }

  return (
    payload.widgetType === 'BlueprintConfirm' ||
    payload.widgetType === 'TopologyApproval' ||
    payload.widgetType === 'TopologyRevision'
  );
}

export function hasPendingBlueprintWidget(
  session: Pick<ArchSession, 'metadata'>,
  widgetType?: BlueprintWidgetData['widgetType'],
): boolean {
  const pending = session.metadata.pendingInteraction;
  return pending?.kind === 'widget' && isWidgetPayload(pending.payload, widgetType);
}

export function normalizeBlueprintConfirmAnswer(answer: unknown): BlueprintConfirmAnswer | null {
  if (answer === 'generate_draft_topology' || answer === 'refine_concept') {
    return answer;
  }
  return null;
}

export function normalizeTopologyApprovalAnswer(
  answer: unknown,
): TopologyApprovalWidgetAnswer | null {
  if (typeof answer === 'string') {
    if (answer === 'accept' || answer === 'request_changes' || answer === 'reject') {
      return { action: answer };
    }
    return null;
  }

  if (!isRecord(answer)) {
    return null;
  }

  const action = answer.action;
  if (action !== 'accept' && action !== 'request_changes' && action !== 'reject') {
    return null;
  }

  return {
    action,
    notes: typeof answer.notes === 'string' ? answer.notes.trim() : undefined,
  };
}

export function normalizeTopologyRevisionAnswer(
  answer: unknown,
): TopologyRevisionWidgetAnswer | null {
  if (!isRecord(answer)) {
    return null;
  }

  const targets = asStringArray(answer.targets).filter(
    (target): target is BlueprintRevisionTarget =>
      (BLUEPRINT_REVISION_TARGETS as readonly string[]).includes(target),
  );

  if (targets.length === 0) {
    return null;
  }

  return {
    targets,
    notes: typeof answer.notes === 'string' ? answer.notes.trim() : undefined,
  };
}

export function buildTopologyRevisionPrompt(
  answer: TopologyRevisionWidgetAnswer,
  mode: 'revise' | 'restart' = 'revise',
): string {
  const targetText = answer.targets.map((target) => `"${target}"`).join(', ');
  const notes = answer.notes?.trim();

  if (mode === 'restart') {
    return notes
      ? `The user rejected the current draft topology and wants a different direction. Focus the redesign on ${targetText}. User notes: ${notes}. Explain the new architecture clearly in chat and regenerate a fresh draft topology.`
      : `The user rejected the current draft topology and wants a different direction. Focus the redesign on ${targetText}. Explain the new architecture clearly in chat and regenerate a fresh draft topology.`;
  }

  return notes
    ? `Revise the current draft topology. Focus on ${targetText}. User notes: ${notes}. Explain the revised architecture clearly in chat and regenerate the draft topology.`
    : `Revise the current draft topology. Focus on ${targetText}. Explain the revised architecture clearly in chat and regenerate the draft topology.`;
}

export function buildBlueprintConceptPrompt(summary?: string | null): string {
  const trimmedSummary = summary?.trim();
  return trimmedSummary
    ? `Refine and explain the architecture concept based on this direction: ${trimmedSummary}`
    : 'Refine and explain the architecture concept for this project.';
}
