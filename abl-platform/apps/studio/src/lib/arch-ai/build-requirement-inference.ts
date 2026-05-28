import type { ArchSession } from '@agent-platform/arch-ai';
import type { AgentArchitecturePlan } from '@agent-platform/arch-ai';

export interface BuildTopologyAgent {
  name: string;
  role?: string;
  executionMode?: 'reasoning' | 'scripted' | 'hybrid';
  description?: string;
  tools?: string[];
  gatherFields?: string[];
  suggestedConstructs?: string[];
  flowStepSeeds?: string[];
  gatherFieldSource?: 'declared' | 'inferred' | 'none';
  flowStepSource?: 'declared' | 'inferred' | 'none';
  requirementReasoning?: string[];
}

export interface BuildTopologyEdge {
  from: string;
  to: string;
  type?: 'delegate' | 'escalate' | 'transfer';
  experienceMode?:
    | 'shared_voice_handoff'
    | 'visible_handoff'
    | 'silent_delegate'
    | 'human_escalation';
  condition?: string;
  expectReturn?: boolean;
}

export interface BuildTopologyContext {
  agents: BuildTopologyAgent[];
  edges: BuildTopologyEdge[];
  entryPoint?: string;
}

export interface BuildRequirementHints {
  gatherFields: string[];
  flowStepSeeds: string[];
  gatherFieldSource: 'declared' | 'inferred' | 'none';
  flowStepSource: 'declared' | 'inferred' | 'none';
  reasoning: string[];
}

interface AgentRequirementInferenceInput {
  agent: BuildTopologyAgent;
  topology: BuildTopologyContext;
  specification?:
    | {
        projectName?: string;
        description?: string | null;
        channels?: string[];
        conversationNotes?: Array<{
          label?: string;
          detail?: string;
          category?: string;
        }>;
      }
    | null
    | undefined;
  domain: {
    domain: string;
    channels: string[];
    compliance: string[];
    integrations: string[];
    tone: string;
    blueprintSummary?: string;
  };
}

interface RequirementTemplate {
  id:
    | 'billing'
    | 'shipping'
    | 'order'
    | 'booking'
    | 'support'
    | 'onboarding'
    | 'identity'
    | 'claims'
    | 'document';
  keywords: string[];
  fields: string[];
  flowSteps: string[];
}

const REQUIREMENT_TEMPLATES: RequirementTemplate[] = [
  {
    id: 'billing',
    keywords: ['billing', 'invoice', 'refund', 'payment', 'charge', 'subscription', 'pricing'],
    fields: ['invoice_id', 'billing_issue_summary', 'desired_outcome'],
    flowSteps: ['collect_billing_context', 'review_billing_request', 'confirm_resolution_path'],
  },
  {
    id: 'shipping',
    keywords: ['shipping', 'shipment', 'delivery', 'tracking', 'fulfillment'],
    fields: ['order_number', 'tracking_number', 'delivery_issue_summary'],
    flowSteps: ['collect_shipping_context', 'review_delivery_issue', 'confirm_next_step'],
  },
  {
    id: 'order',
    keywords: ['order', 'return', 'returns', 'exchange', 'commerce', 'cart', 'storefront'],
    fields: ['order_number', 'request_summary', 'desired_outcome'],
    flowSteps: ['collect_order_context', 'review_order_request', 'confirm_resolution_path'],
  },
  {
    id: 'booking',
    keywords: [
      'booking',
      'reservation',
      'appointment',
      'schedule',
      'travel',
      'hotel',
      'flight',
      'trip',
    ],
    fields: ['booking_reference', 'requested_date', 'travel_request_summary'],
    flowSteps: ['collect_booking_context', 'review_booking_needs', 'confirm_booking_plan'],
  },
  {
    id: 'support',
    keywords: [
      'support',
      'issue',
      'bug',
      'technical',
      'incident',
      'troubleshoot',
      'error',
      'diagnos',
    ],
    fields: ['issue_summary', 'affected_product', 'desired_outcome'],
    flowSteps: ['collect_issue_context', 'analyze_issue', 'confirm_next_step'],
  },
  {
    id: 'onboarding',
    keywords: [
      'onboarding',
      'onboard',
      'signup',
      'sign up',
      'register',
      'registration',
      'enroll',
      'enrollment',
      'application',
      'intake',
      'lead',
      'qualification',
      'setup',
    ],
    fields: ['full_name', 'email_address', 'company_name'],
    flowSteps: ['welcome_user', 'collect_profile', 'confirm_onboarding_readiness'],
  },
  {
    id: 'identity',
    keywords: [
      'auth',
      'authentication',
      'identity',
      'verify',
      'verification',
      'login',
      'account',
      'password',
    ],
    fields: ['account_id', 'verification_method', 'verification_context'],
    flowSteps: ['collect_identity_context', 'verify_identity', 'confirm_access_path'],
  },
  {
    id: 'claims',
    keywords: ['claim', 'claims', 'dispute', 'appeal', 'coverage', 'payer', 'provider'],
    fields: ['claim_id', 'claim_reason', 'supporting_evidence_summary'],
    flowSteps: ['collect_claim_context', 'review_claim_path', 'confirm_next_step'],
  },
  {
    id: 'document',
    keywords: ['document', 'paperwork', 'contract', 'form', 'upload', 'submission', 'file'],
    fields: ['document_type', 'document_reference', 'request_summary'],
    flowSteps: ['collect_document_context', 'review_submission', 'confirm_next_step'],
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function normalizeStringArray(value: unknown): string[] {
  return dedupeStrings(
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [],
  );
}

function normalizeNamedArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const values: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      values.push(entry);
      continue;
    }
    if (isRecord(entry) && typeof entry.name === 'string') {
      values.push(entry.name);
    }
  }

  return dedupeStrings(values);
}

function normalizeExecutionMode(value: unknown): 'reasoning' | 'scripted' | 'hybrid' | undefined {
  if (value === 'reasoning' || value === 'scripted' || value === 'hybrid') {
    return value;
  }
  return undefined;
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .toLowerCase();
}

function resolveEdgeExpectReturn(edge: BuildTopologyEdge): boolean | undefined {
  if (typeof edge.expectReturn === 'boolean') {
    return edge.expectReturn;
  }
  if (edge.type === 'delegate') {
    return true;
  }
  if (edge.type === 'escalate' || edge.type === 'transfer') {
    return false;
  }
  return undefined;
}

export function extractBuildTopology(session: Pick<ArchSession, 'metadata'>): BuildTopologyContext {
  const rawTopology =
    (isRecord(session.metadata.lockedTopology) ? session.metadata.lockedTopology : null) ??
    (isRecord(session.metadata.topology) ? session.metadata.topology : null);

  if (!rawTopology) {
    return { agents: [], edges: [] };
  }

  const entryPoint = normalizeString(rawTopology.entryPoint);
  const agents = Array.isArray(rawTopology.agents)
    ? rawTopology.agents
        .filter(isRecord)
        .map((agent): BuildTopologyAgent | null => {
          const name = normalizeString(agent.name);
          if (!name) {
            return null;
          }

          return {
            name,
            role: normalizeString(agent.role),
            executionMode: normalizeExecutionMode(agent.executionMode),
            description: normalizeString(agent.description),
            tools: normalizeNamedArray(agent.tools),
            gatherFields: normalizeNamedArray(agent.gatherFields),
            suggestedConstructs: normalizeStringArray(agent.suggestedConstructs),
            flowStepSeeds: normalizeNamedArray(agent.flowStepSeeds),
          };
        })
        .filter((agent): agent is BuildTopologyAgent => agent !== null)
    : [];

  const edges = Array.isArray(rawTopology.edges)
    ? rawTopology.edges
        .filter(isRecord)
        .map((edge): BuildTopologyEdge | null => {
          const from = normalizeString(edge.from);
          const to = normalizeString(edge.to);
          if (!from || !to) {
            return null;
          }

          const type =
            edge.type === 'delegate' || edge.type === 'escalate' || edge.type === 'transfer'
              ? edge.type
              : undefined;
          const experienceMode =
            edge.experienceMode === 'shared_voice_handoff' ||
            edge.experienceMode === 'visible_handoff' ||
            edge.experienceMode === 'silent_delegate' ||
            edge.experienceMode === 'human_escalation'
              ? edge.experienceMode
              : undefined;

          return {
            from,
            to,
            type,
            ...(experienceMode ? { experienceMode } : {}),
            condition: normalizeString(edge.condition),
            expectReturn: typeof edge.expectReturn === 'boolean' ? edge.expectReturn : undefined,
          };
        })
        .filter((edge): edge is BuildTopologyEdge => edge !== null)
    : [];

  return {
    agents,
    edges,
    ...(entryPoint ? { entryPoint } : {}),
  };
}

function buildSignalCorpus(input: AgentRequirementInferenceInput): string {
  const noteText = (input.specification?.conversationNotes ?? [])
    .flatMap((note) => [note.label, note.detail])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ');

  return [
    input.agent.name,
    input.agent.role,
    input.agent.description,
    input.specification?.projectName,
    input.specification?.description,
    input.domain.domain,
    input.domain.blueprintSummary,
    input.domain.compliance.join(' '),
    input.domain.integrations.join(' '),
    input.domain.channels.join(' '),
    noteText,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .toLowerCase();
}

function pickBestTemplate(signalCorpus: string): RequirementTemplate | null {
  let bestTemplate: RequirementTemplate | null = null;
  let bestScore = 0;

  for (const template of REQUIREMENT_TEMPLATES) {
    const score = template.keywords.reduce(
      (count, keyword) => count + (signalCorpus.includes(keyword) ? 1 : 0),
      0,
    );

    if (score > bestScore) {
      bestScore = score;
      bestTemplate = template;
    }
  }

  return bestScore > 0 ? bestTemplate : null;
}

function inferFallbackGatherFields(signalCorpus: string): string[] {
  if (signalCorpus.includes('support') || signalCorpus.includes('issue')) {
    return ['issue_summary', 'desired_outcome'];
  }
  if (signalCorpus.includes('intake') || signalCorpus.includes('onboard')) {
    return ['request_summary', 'contact_email'];
  }
  return ['request_summary', 'desired_outcome'];
}

export function inferAgentRequirementHints(
  input: AgentRequirementInferenceInput,
): BuildRequirementHints {
  const declaredGatherFields = normalizeNamedArray(input.agent.gatherFields);
  const declaredFlowStepSeeds = normalizeNamedArray(input.agent.flowStepSeeds);
  const signalCorpus = buildSignalCorpus(input);
  const template = pickBestTemplate(signalCorpus);
  const incomingEdges = input.topology.edges.filter((edge) => edge.to === input.agent.name);
  const outgoingEdges = input.topology.edges.filter((edge) => edge.from === input.agent.name);
  const delegateReturnRequired = incomingEdges.some(
    (edge) => resolveEdgeExpectReturn(edge) === true,
  );
  const isSilentDelegateTarget = incomingEdges.some(
    (edge) => edge.experienceMode === 'silent_delegate',
  );
  const isEntrySupervisor =
    input.topology.entryPoint === input.agent.name &&
    outgoingEdges.some((edge) => edge.type === 'delegate' || edge.type === 'transfer');
  const reasoning: string[] = [];

  let gatherFields = declaredGatherFields;
  let gatherFieldSource: BuildRequirementHints['gatherFieldSource'] =
    declaredGatherFields.length > 0 ? 'declared' : 'none';

  if (isEntrySupervisor) {
    reasoning.push('Entry routing agent detected — skip structured gather inference.');
    gatherFields = [];
    gatherFieldSource = declaredGatherFields.length > 0 ? 'declared' : 'none';
  } else if (isSilentDelegateTarget) {
    reasoning.push(
      'Silent delegate target detected — skip customer-facing gather inference; parent delegate input supplies context.',
    );
    gatherFields = [];
    gatherFieldSource = 'none';
  } else if (
    gatherFields.length === 0 &&
    (delegateReturnRequired || input.agent.executionMode !== 'reasoning')
  ) {
    const extraFields: string[] = [];
    if (signalCorpus.includes('sla') || signalCorpus.includes('urgent')) {
      extraFields.push('urgency_level');
    }
    if (
      (signalCorpus.includes('voice') ||
        signalCorpus.includes('phone') ||
        signalCorpus.includes('callback')) &&
      (template?.id === 'onboarding' || template?.id === 'support' || template?.id === 'identity')
    ) {
      extraFields.push('callback_number');
    }
    if (
      (signalCorpus.includes('human handoff') || signalCorpus.includes('escalat')) &&
      !signalCorpus.includes('supervisor')
    ) {
      extraFields.push('handoff_reason');
    }

    gatherFields = dedupeStrings([
      ...(template?.fields ?? inferFallbackGatherFields(signalCorpus)),
      ...extraFields,
    ]).slice(0, 4);
    gatherFieldSource = gatherFields.length > 0 ? 'inferred' : 'none';

    if (template) {
      reasoning.push(`Inferred ${template.id} requirement pattern for structured gather fields.`);
    }
    if (delegateReturnRequired) {
      reasoning.push(
        'Delegate return contract detected — inferred state needed to drive COMPLETE.',
      );
    }
    if (input.agent.executionMode === 'scripted' || input.agent.executionMode === 'hybrid') {
      reasoning.push(
        'Non-reasoning execution mode detected — inferred fields to support a real FLOW.',
      );
    }
  }

  let flowStepSeeds = declaredFlowStepSeeds;
  let flowStepSource: BuildRequirementHints['flowStepSource'] =
    declaredFlowStepSeeds.length > 0 ? 'declared' : 'none';

  if (
    flowStepSeeds.length === 0 &&
    (input.agent.executionMode === 'scripted' || input.agent.executionMode === 'hybrid')
  ) {
    const inferredSteps: string[] = [...(template?.flowSteps ?? [])];
    const firstTool = normalizeNamedArray(input.agent.tools)[0];
    const firstOutgoingDelegate = outgoingEdges.find(
      (edge) => edge.type === 'delegate' || edge.type === 'transfer',
    );

    if (inferredSteps.length === 0) {
      inferredSteps.push(
        gatherFields.length > 0 ? 'collect_context' : 'understand_request',
        input.agent.executionMode === 'hybrid' ? 'analyze_request' : 'review_request',
      );
    }

    if (firstTool) {
      inferredSteps.push(`run_${toSnakeCase(firstTool)}`);
    }

    if (firstOutgoingDelegate) {
      inferredSteps.push(`prepare_${toSnakeCase(firstOutgoingDelegate.to)}_handoff`);
    } else {
      inferredSteps.push(
        input.agent.executionMode === 'hybrid' ? 'deliver_resolution' : 'complete_request',
      );
    }

    flowStepSeeds = dedupeStrings(inferredSteps).slice(0, 5);
    flowStepSource = flowStepSeeds.length > 0 ? 'inferred' : 'none';
    reasoning.push('Inferred a requirement-aware FLOW outline for scripted/hybrid generation.');
  }

  return {
    gatherFields,
    flowStepSeeds,
    gatherFieldSource,
    flowStepSource,
    reasoning,
  };
}

export function shouldUseDeterministicScaffold(input: {
  plan: AgentArchitecturePlan | undefined;
  agent: BuildTopologyAgent;
}): { allowed: boolean; reason: string } {
  if (!input.plan) {
    return { allowed: false, reason: 'missing_architecture_plan' };
  }

  if (
    input.plan.complexity.selectedExecutionMode !== 'reasoning' ||
    (input.agent.tools ?? []).length > 0 ||
    (input.agent.flowStepSeeds ?? []).length > 0
  ) {
    return { allowed: true, reason: 'eligible_construct_safe_baseline' };
  }

  return { allowed: true, reason: 'eligible' };
}

export function resolveEdgeReturnExpectation(edge: BuildTopologyEdge): boolean {
  return resolveEdgeExpectReturn(edge) ?? false;
}
