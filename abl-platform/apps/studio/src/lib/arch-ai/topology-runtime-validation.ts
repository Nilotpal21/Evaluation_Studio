const TOPOLOGY_TOOL_INTENT_PATTERN =
  /\b(api|tool|lookup|search|book|booking|schedule|send|notify|notification|create|update|verify|verification|score|screen|screening|write|file|assign|upload|retrieve|fetch|pull|calculate|price|payment|credit|check|validate|connect|oauth|import|export)\b/i;

export interface TopologyRuntimeHintAgent {
  name: string;
  role: string;
  description: string;
  tools?: string[];
}

export interface TopologyRuntimeHintEdge {
  from: string;
  to: string;
  type: string;
  experienceMode?: string;
}

export interface TopologyRuntimeHintInput {
  agents: TopologyRuntimeHintAgent[];
  edges?: TopologyRuntimeHintEdge[];
  entryPoint: string;
}

function normalizeTopologyToolHint(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .toLowerCase();
}

export function validateTopologyRuntimeHints(input: TopologyRuntimeHintInput): string | null {
  const missingExperience = (input.edges ?? [])
    .filter((edge) => !edge.experienceMode)
    .map((edge) => `${edge.from} -> ${edge.to}`);
  if (missingExperience.length > 0) {
    return (
      'Error: these topology edges omit customer handoff experience mode: ' +
      `${missingExperience.join(', ')}. Re-call generate_topology with experienceMode on every edge: ` +
      'shared_voice_handoff for same-voice customer-facing specialists, human_escalation for human/escalation targets, visible_handoff for announced transfers, or silent_delegate only when DELEGATE agent-as-tool support is available.'
    );
  }

  const invalidExperience = (input.edges ?? []).find(
    (edge) =>
      (edge.type === 'escalate' && edge.experienceMode !== 'human_escalation') ||
      (edge.experienceMode === 'human_escalation' && edge.type !== 'escalate') ||
      (edge.experienceMode === 'silent_delegate' && edge.type !== 'delegate') ||
      ((edge.experienceMode === 'shared_voice_handoff' ||
        edge.experienceMode === 'visible_handoff') &&
        edge.type !== 'transfer'),
  );
  if (invalidExperience) {
    return (
      `Error: edge ${invalidExperience.from} -> ${invalidExperience.to} has type ` +
      `"${invalidExperience.type}" with incompatible experienceMode "${invalidExperience.experienceMode}". ` +
      'Use human_escalation only on escalate edges, silent_delegate only on delegate edges, and shared_voice_handoff or visible_handoff only on transfer edges.'
    );
  }

  const missing = input.agents
    .filter((agent) => agent.name !== input.entryPoint)
    .filter((agent) => (agent.tools ?? []).length === 0)
    .filter((agent) => TOPOLOGY_TOOL_INTENT_PATTERN.test(`${agent.role} ${agent.description}`))
    .map((agent) => {
      const suggested = normalizeTopologyToolHint(
        agent.name.replace(/(?:Agent|Specialist|Manager)$/u, ''),
      );
      return `${agent.name} (suggest tools like ${suggested || 'lookup_record'})`;
    });

  if (missing.length === 0) {
    return null;
  }

  return (
    'Error: these agents imply external lookup/action/calculation work but their tools arrays are empty: ' +
    `${missing.join(', ')}. Re-call generate_topology with snake_case callable names in each agent.tools array, ` +
    'plus gatherFields and flowStepSeeds when needed. Do not omit tools for API-backed, booking, notification, verification, scoring, search, update, or persistence work.'
  );
}
