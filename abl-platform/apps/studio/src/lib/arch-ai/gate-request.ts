import type {
  GateActionOption,
  GateRequestAnswer,
  GateRequestInput,
} from '@/lib/arch-ai/components/arch/widgets/types';

const VALID_GATE_ACTION_VALUES = new Set<GateActionOption['value']>(['accept', 'modify', 'reject']);

const VALID_GATE_ACTION_TONES = new Set<NonNullable<GateActionOption['tone']>>([
  'primary',
  'secondary',
  'danger',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asPositiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}

function isGateActionValue(value: unknown): value is GateActionOption['value'] {
  return (
    typeof value === 'string' && VALID_GATE_ACTION_VALUES.has(value as GateActionOption['value'])
  );
}

function isGateActionTone(value: unknown): value is NonNullable<GateActionOption['tone']> {
  return (
    typeof value === 'string' &&
    VALID_GATE_ACTION_TONES.has(value as NonNullable<GateActionOption['tone']>)
  );
}

function normalizeGateActions(value: unknown): GateActionOption[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const actions = value.flatMap<GateActionOption>((entry) => {
    if (!isRecord(entry) || !isGateActionValue(entry.value)) {
      return [];
    }

    const label = asString(entry.label);
    if (!label) {
      return [];
    }

    const tone = isGateActionTone(entry.tone) ? entry.tone : undefined;
    const feedbackPlaceholder = asString(entry.feedbackPlaceholder);

    return [
      {
        value: entry.value,
        label,
        ...(tone ? { tone } : {}),
        ...(entry.requiresFeedback === true ? { requiresFeedback: true } : {}),
        ...(feedbackPlaceholder ? { feedbackPlaceholder } : {}),
      },
    ];
  });

  return actions.length > 0 ? actions : null;
}

function normalizeGateTemplatePayload(
  gateType: string,
  payload: Record<string, unknown>,
): GateRequestInput | null {
  const title = asString(payload.title);
  const question = asString(payload.question);
  const actions = normalizeGateActions(payload.actions);

  if (!title || !question || !actions) {
    return null;
  }

  const description = asString(payload.description);
  const details = asStringArray(payload.details);

  return {
    widgetType: 'GateRequest',
    gateType,
    title,
    question,
    ...(description ? { description } : {}),
    ...(details.length > 0 ? { details } : {}),
    actions,
  };
}

export function normalizeGateRequestInput(
  gateType: unknown,
  payload: unknown,
): GateRequestInput | null {
  if (!isRecord(payload) || typeof gateType !== 'string') {
    return null;
  }

  const templatePayload = normalizeGateTemplatePayload(gateType, payload);
  if (templatePayload) {
    return templatePayload;
  }

  if (gateType === 'topology_approval') {
    const agentCount = asPositiveNumber(payload.agentCount);
    const edgeCount = asPositiveNumber(payload.edgeCount);
    const entryPoint = asString(payload.entryPoint);

    const details: string[] = [];
    if (agentCount !== null) {
      details.push(`${agentCount} agent${agentCount === 1 ? '' : 's'}`);
    }
    if (edgeCount !== null) {
      details.push(`${edgeCount} connection${edgeCount === 1 ? '' : 's'}`);
    }
    if (entryPoint) {
      details.push(`Entry: ${entryPoint}`);
    }

    return {
      widgetType: 'GateRequest',
      gateType: 'topology_approval',
      title: 'Topology Review',
      question: 'Approve this topology, request changes, or reject it.',
      description:
        'Arch has proposed a system design and is waiting for your decision before continuing.',
      details,
      actions: [
        { value: 'accept', label: 'Accept Topology', tone: 'primary' },
        {
          value: 'modify',
          label: 'Request Changes',
          tone: 'secondary',
          requiresFeedback: true,
          feedbackPlaceholder: 'What should change in the topology?',
        },
        { value: 'reject', label: 'Reject Topology', tone: 'danger' },
      ],
    };
  }

  if (gateType === 'agent_review') {
    const agentName = asString(payload.agentName) ?? 'this agent';
    const generatedCount = asPositiveNumber(payload.generatedCount);
    const totalAgents = asPositiveNumber(payload.totalAgents);
    const details: string[] = [];

    if (generatedCount !== null && totalAgents !== null) {
      details.push(`${generatedCount} of ${totalAgents} agents reviewed`);
    }

    return {
      widgetType: 'GateRequest',
      gateType: 'agent_review',
      title: `Review ${agentName}`,
      question: 'Accept this generated agent, request changes, or reject it.',
      description: 'Arch pauses here so you can keep the build aligned before continuing.',
      details,
      actions: [
        { value: 'accept', label: 'Accept Agent', tone: 'primary' },
        {
          value: 'modify',
          label: 'Request Changes',
          tone: 'secondary',
          requiresFeedback: true,
          feedbackPlaceholder: `What should change in ${agentName}?`,
        },
        { value: 'reject', label: 'Reject Agent', tone: 'danger' },
      ],
    };
  }

  if (gateType === 'tool_generation') {
    const toolNames = [...asStringArray(payload.tools), ...asStringArray(payload.selectedTools)];
    const toolCount = asPositiveNumber(payload.toolCount) ?? toolNames.length;
    const details: string[] = [];

    if (toolCount > 0) {
      details.push(`${toolCount} tool${toolCount === 1 ? '' : 's'} proposed`);
    }
    if (toolNames.length > 0) {
      details.push(`Tools: ${toolNames.join(', ')}`);
    }

    return {
      widgetType: 'GateRequest',
      gateType: 'tool_generation',
      title: 'Tool Generation',
      question: 'Generate the recommended tools now?',
      description:
        'Arch can create the tool implementations needed by the proposed agents before continuing the build.',
      details,
      actions: [
        { value: 'accept', label: 'Generate Tools', tone: 'primary' },
        {
          value: 'modify',
          label: 'Adjust Tool Plan',
          tone: 'secondary',
          requiresFeedback: true,
          feedbackPlaceholder: 'What should change before Arch generates tools?',
        },
        { value: 'reject', label: 'Skip Tools', tone: 'danger' },
      ],
    };
  }

  return null;
}

export function normalizeGateRequestAnswer(answer: unknown): GateRequestAnswer | null {
  if (!isRecord(answer)) {
    return null;
  }

  const action = answer.action;
  if (action !== 'accept' && action !== 'modify' && action !== 'reject') {
    return null;
  }

  return {
    action,
    feedback: typeof answer.feedback === 'string' ? answer.feedback : undefined,
  };
}
