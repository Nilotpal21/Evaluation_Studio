import type { BlueprintV2Output, BlueprintV2PerAgentSpec } from '../blueprint/index.js';
import { assertValidBlueprintV2Output } from '../blueprint/index.js';
import type { AgentConstructPlan, ProjectConstructPlan } from './construct-plan.js';

export type OrchestrationPattern =
  | 'single_responder'
  | 'triage_router'
  | 'tool_lookup'
  | 'transactional_action'
  | 'policy_decision'
  | 'pipeline_workflow'
  | 'approval_gated'
  | 'long_running_state_machine'
  | 'event_api_workflow'
  | 'document_pipeline'
  | 'multilingual_channel_router'
  | 'human_escalation'
  | 'observer_audit_sidecar';

export type AgentResponsibility =
  | 'answer'
  | 'route'
  | 'collect'
  | 'lookup'
  | 'transact'
  | 'decide'
  | 'observe'
  | 'escalate'
  | 'coordinate';

export type AgentRiskLevel = 'low' | 'medium' | 'high' | 'regulated';

export interface OrchestrationPatternPlan {
  primaryPattern: OrchestrationPattern;
  secondaryPatterns: OrchestrationPattern[];
  requiredRuntimeCapabilities: string[];
  riskLevel: AgentRiskLevel;
  rationale: string[];
}

export interface AgentBehaviorProfile {
  agentName: string;
  responsibility: AgentResponsibility;
  executionMode: 'reasoning' | 'scripted' | 'hybrid';
  mustUseFlow: boolean;
  mustUseTool: boolean;
  mustConfirmAction: boolean;
  mustReturnToParent: boolean;
  mustMaintainState: boolean;
  mustCreateAuditTrail: boolean;
  unsupportedNotes: string[];
  rationale: string[];
}

export interface ProjectIntelligencePlan {
  projectName: string;
  orchestration: OrchestrationPatternPlan;
  agents: Record<string, AgentBehaviorProfile>;
}

export type IntelligenceValidationSeverity = 'error' | 'warning';

export interface IntelligenceValidationIssue {
  code: string;
  message: string;
  path: string;
  severity: IntelligenceValidationSeverity;
}

export interface IntelligenceValidationResult {
  valid: boolean;
  issues: IntelligenceValidationIssue[];
}

const TOOL_ACTION_RE =
  /\b(lookup|search|book|create|update|send|score|upload|parse|classify|schedule|submit|approve|deny|invite|connect|export|verify|check|pull|apply|file|generate|open|page|post|translate|detect|route|queue|draft|track|correlate|ingest)\b/i;

const TRANSACTION_RE =
  /\b(book|create|update|send|schedule|submit|approve|deny|invite|connect|export|apply|file|generate|open|page|post|queue|pull|execute|isolate|disable)\b/i;

const POLICY_RE =
  /\b(policy|eligib|criteria|rule|threshold|risk|score|fraud|aml|kyc|sanction|suitability|formulary|clinical|sla|compliance|regulator|credit|deny|approve)\b/i;

const APPROVAL_RE = /\b(confirm|confirmation|approval|authorize|authorization|consent|explicit)\b/i;

const LONG_RUNNING_RE =
  /\b(resume|multi-day|multiday|long-running|deadline|reminder|milestone|state machine|workflow state|persist|pending|callback|external waiting)\b/i;

const EVENT_API_RE = /\b(webhook|api|stream|alert|siem|event|callback|payload|statuspage|slack)\b/i;

const DOCUMENT_RE =
  /\b(upload|photo|image|pdf|docx|document|screenshot|har|evidence|artifact|contract|id upload|proof|attachment)\b/i;

const MULTILINGUAL_RE =
  /\b(multilingual|spanish|mandarin|arabic|portuguese|vietnamese|language|translate|voice|sms|whatsapp|slack|email|accessibility|screen-reader)\b/i;

const HUMAN_ESCALATION_RE =
  /\b(human|supervisor|caseworker|advisor|nurse|on-call|analyst|hrbp|senior counsel|manual review|licensed|peer-to-peer|p2p|escalat)\b/i;

const AUDIT_RE =
  /\b(audit|log|worm|immutable|trace|compliance|hipaa|pci|kyc|aml|coppa|ferpa|gdpr|tila|respa|soc2|pii|phi)\b/i;

const REGULATED_RE =
  /\b(hipaa|pci|kyc|aml|coppa|ferpa|gdpr|tila|respa|soc2|phi|pii|finra|fincen|regulator|clinical|medical|mortgage|financial|legal)\b/i;

const HIGH_IMPACT_RE =
  /\b(money|payment|refund|credit|payout|booking|appointment|medical|911|credit pull|containment|legal|contract|application|submit|approve|deny|sar|regulatory|identity|ssn|gov)\b/i;

function issue(
  code: string,
  message: string,
  path: string,
  severity: IntelligenceValidationSeverity = 'warning',
): IntelligenceValidationIssue {
  return { code, message, path, severity };
}

function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function projectText(blueprint: BlueprintV2Output): string {
  return [
    blueprint.metadata.projectName,
    blueprint.specification.summary,
    blueprint.specification.channels.join(' '),
    blueprint.specification.languages.join(' '),
    blueprint.specification.successCriteria.join(' '),
    blueprint.specification.assumptions.join(' '),
    blueprint.governance.compliance.join(' '),
    blueprint.governance.policies.map((policy) => `${policy.name} ${policy.description}`).join(' '),
    blueprint.integrations.tools.map((tool) => `${tool.name} ${tool.description}`).join(' '),
    blueprint.topology.agents.map((agent) => `${agent.role} ${agent.description}`).join(' '),
    Object.values(blueprint.perAgent)
      .map((agent) => `${agent.role} ${agent.goal} ${agent.persona.summary}`)
      .join(' '),
  ].join(' ');
}

function agentText(
  topologyAgent: BlueprintV2Output['topology']['agents'][number] | undefined,
  agent: BlueprintV2PerAgentSpec,
): string {
  return [
    topologyAgent?.role,
    topologyAgent?.description,
    agent.role,
    agent.goal,
    agent.persona.summary,
    agent.persona.limitations.join(' '),
    agent.tools.map((tool) => `${tool.ref} ${tool.purpose} ${tool.description ?? ''}`).join(' '),
    agent.gather.fields.map((field) => `${field.name} ${field.prompt}`).join(' '),
    agent.constraints.map((constraint) => `${constraint.condition} ${constraint.onFail}`).join(' '),
    agent.guardrails.map((guardrail) => `${guardrail.name} ${guardrail.check}`).join(' '),
  ]
    .filter(Boolean)
    .join(' ');
}

function pushPattern(
  patterns: OrchestrationPattern[],
  pattern: OrchestrationPattern,
  condition: boolean,
): void {
  if (condition) patterns.push(pattern);
}

export function deriveOrchestrationPatternPlan(
  blueprintInput: BlueprintV2Output,
): OrchestrationPatternPlan {
  const blueprint = assertValidBlueprintV2Output(blueprintInput);
  const text = projectText(blueprint);
  const lowerText = text.toLowerCase();
  const patterns: OrchestrationPattern[] = [];
  const capabilities: string[] = [];
  const rationale: string[] = [];

  pushPattern(patterns, 'pipeline_workflow', blueprint.topology.pattern === 'pipeline');
  pushPattern(patterns, 'triage_router', blueprint.topology.pattern === 'triage');
  pushPattern(patterns, 'tool_lookup', TOOL_ACTION_RE.test(text));
  pushPattern(patterns, 'transactional_action', TRANSACTION_RE.test(text));
  pushPattern(patterns, 'policy_decision', POLICY_RE.test(text));
  pushPattern(patterns, 'approval_gated', APPROVAL_RE.test(text) || HIGH_IMPACT_RE.test(text));
  pushPattern(patterns, 'long_running_state_machine', LONG_RUNNING_RE.test(text));
  pushPattern(patterns, 'event_api_workflow', EVENT_API_RE.test(text));
  pushPattern(patterns, 'document_pipeline', DOCUMENT_RE.test(text));
  pushPattern(patterns, 'multilingual_channel_router', MULTILINGUAL_RE.test(text));
  pushPattern(patterns, 'human_escalation', HUMAN_ESCALATION_RE.test(text));
  pushPattern(patterns, 'observer_audit_sidecar', AUDIT_RE.test(text));

  if (blueprint.topology.agents.length === 1 && patterns.length === 0) {
    patterns.push('single_responder');
  }

  if (TOOL_ACTION_RE.test(text) || blueprint.integrations.tools.length > 0) {
    capabilities.push('tool_call_planning');
    rationale.push('Project text or integrations indicate external lookup/action tools.');
  }
  if (POLICY_RE.test(text)) capabilities.push('policy_branching');
  if (APPROVAL_RE.test(text) || HIGH_IMPACT_RE.test(text)) capabilities.push('confirmation_gate');
  if (LONG_RUNNING_RE.test(text)) capabilities.push('workflow_state');
  if (EVENT_API_RE.test(text)) capabilities.push('event_or_api_entry');
  if (DOCUMENT_RE.test(text)) capabilities.push('attachment_or_document_handling');
  if (MULTILINGUAL_RE.test(text)) capabilities.push('channel_language_adaptation');
  if (HUMAN_ESCALATION_RE.test(text)) capabilities.push('human_escalation_packet');
  if (AUDIT_RE.test(text)) capabilities.push('audit_or_trace_logging');

  let riskLevel: AgentRiskLevel = 'low';
  if (REGULATED_RE.test(text)) riskLevel = 'regulated';
  else if (HIGH_IMPACT_RE.test(text)) riskLevel = 'high';
  else if (POLICY_RE.test(text) || TRANSACTION_RE.test(text)) riskLevel = 'medium';

  if (riskLevel === 'regulated') {
    rationale.push('Regulated or sensitive-domain language requires compliance-aware planning.');
  }

  const fallbackPrimary =
    blueprint.topology.pattern === 'hub_spoke' || blueprint.topology.pattern === 'mesh'
      ? 'triage_router'
      : 'single_responder';
  const uniquePatterns = uniq(patterns);
  return {
    primaryPattern: uniquePatterns[0] ?? fallbackPrimary,
    secondaryPatterns: uniquePatterns.slice(1),
    requiredRuntimeCapabilities: uniq(capabilities),
    riskLevel,
    rationale,
  };
}

export function deriveProjectIntelligencePlanFromBlueprint(
  blueprintInput: BlueprintV2Output,
): ProjectIntelligencePlan {
  const blueprint = assertValidBlueprintV2Output(blueprintInput);
  const orchestration = deriveOrchestrationPatternPlan(blueprint);
  const projectHasLongRunningState =
    orchestration.primaryPattern === 'long_running_state_machine' ||
    orchestration.secondaryPatterns.includes('long_running_state_machine');
  const projectNeedsAudit =
    orchestration.primaryPattern === 'observer_audit_sidecar' ||
    orchestration.secondaryPatterns.includes('observer_audit_sidecar') ||
    orchestration.riskLevel === 'regulated';
  const agents: Record<string, AgentBehaviorProfile> = {};

  for (const agentName of blueprint.buildOrder) {
    const topologyAgent = blueprint.topology.agents.find((agent) => agent.name === agentName);
    const agent = blueprint.perAgent[agentName];
    agents[agentName] = deriveAgentBehaviorProfile(
      agentName,
      agent,
      topologyAgent,
      blueprint,
      projectHasLongRunningState,
      projectNeedsAudit,
    );
  }

  return {
    projectName: blueprint.metadata.projectName,
    orchestration,
    agents,
  };
}

function deriveAgentBehaviorProfile(
  agentName: string,
  agent: BlueprintV2PerAgentSpec,
  topologyAgent: BlueprintV2Output['topology']['agents'][number] | undefined,
  blueprint: BlueprintV2Output,
  projectHasLongRunningState: boolean,
  projectNeedsAudit: boolean,
): AgentBehaviorProfile {
  const text = agentText(topologyAgent, agent);
  const outgoingEdges = blueprint.topology.edges.filter((edge) => edge.from === agentName);
  const incomingReturnEdges = blueprint.topology.edges.filter(
    (edge) => edge.to === agentName && edge.expectReturn !== false,
  );
  const hasTools = agent.tools.length > 0;
  const hasManyFields = agent.gather.fields.length >= 3;
  const rationale: string[] = [];

  let responsibility: AgentResponsibility = 'answer';
  if (outgoingEdges.length >= 2 || /\b(router|triage|supervisor|coordinator)\b/i.test(text)) {
    responsibility = 'route';
    rationale.push('Agent routes across multiple downstream owners.');
  } else if (
    HUMAN_ESCALATION_RE.test(text) ||
    outgoingEdges.some((edge) => edge.type === 'escalate')
  ) {
    responsibility = 'escalate';
    rationale.push('Agent packages or routes human escalation work.');
  } else if (AUDIT_RE.test(text) && /\b(audit|log|timeline|deadline|status)\b/i.test(text)) {
    responsibility = 'observe';
    rationale.push('Agent records audit, timeline, status, or deadline side effects.');
  } else if (POLICY_RE.test(text)) {
    responsibility = 'decide';
    rationale.push('Agent applies policy, risk, eligibility, or criteria decisions.');
  } else if (TRANSACTION_RE.test(text)) {
    responsibility = 'transact';
    rationale.push(
      'Agent is expected to create, update, schedule, submit, send, or execute actions.',
    );
  } else if (TOOL_ACTION_RE.test(text) || hasTools) {
    responsibility = 'lookup';
    rationale.push('Agent needs external data or tool-backed lookup.');
  } else if (hasManyFields || /\b(intake|collect|capture|form|profile)\b/i.test(text)) {
    responsibility = 'collect';
    rationale.push('Agent primarily collects structured user-provided context.');
  } else if (blueprint.topology.pattern === 'pipeline') {
    responsibility = 'coordinate';
    rationale.push('Agent participates in an ordered pipeline.');
  }

  const mustUseTool =
    hasTools ||
    responsibility === 'lookup' ||
    responsibility === 'transact' ||
    responsibility === 'decide' ||
    responsibility === 'observe';
  const mustConfirmAction =
    responsibility === 'transact' && (HIGH_IMPACT_RE.test(text) || APPROVAL_RE.test(text));
  const mustMaintainState =
    projectHasLongRunningState ||
    LONG_RUNNING_RE.test(text) ||
    blueprint.topology.pattern === 'pipeline';
  const mustCreateAuditTrail = projectNeedsAudit || AUDIT_RE.test(text);
  const mustReturnToParent = incomingReturnEdges.length > 0;
  const mustUseFlow =
    agent.executionMode === 'scripted' ||
    agent.executionMode === 'hybrid' ||
    responsibility === 'transact' ||
    responsibility === 'decide' ||
    responsibility === 'observe' ||
    mustConfirmAction ||
    mustMaintainState ||
    mustReturnToParent;

  const unsupportedNotes: string[] = [];
  if (/\bhuman_approval\b/i.test(text)) {
    unsupportedNotes.push(
      'Use ESCALATE or a terminal human handoff packet instead of human_approval.',
    );
  }

  return {
    agentName,
    responsibility,
    executionMode: agent.executionMode,
    mustUseFlow,
    mustUseTool,
    mustConfirmAction,
    mustReturnToParent,
    mustMaintainState,
    mustCreateAuditTrail,
    unsupportedNotes,
    rationale,
  };
}

export function validateProjectIntelligenceFit(
  intelligencePlan: ProjectIntelligencePlan,
  constructPlan: ProjectConstructPlan,
): IntelligenceValidationResult {
  const issues: IntelligenceValidationIssue[] = [];

  for (const [agentName, profile] of Object.entries(intelligencePlan.agents)) {
    const agent = constructPlan.agents[agentName];
    if (!agent) {
      issues.push(
        issue(
          'INTELLIGENCE_AGENT_MISSING_CONSTRUCT_PLAN',
          `Agent "${agentName}" has an intelligence profile but no construct plan`,
          `agents.${agentName}`,
          'error',
        ),
      );
      continue;
    }
    issues.push(...validateAgentIntelligenceFit(profile, agent, `agents.${agentName}`));
  }

  return { valid: !issues.some((item) => item.severity === 'error'), issues };
}

export function validateAgentIntelligenceFit(
  profile: AgentBehaviorProfile,
  agent: AgentConstructPlan,
  path: string,
): IntelligenceValidationIssue[] {
  const issues: IntelligenceValidationIssue[] = [];

  if (profile.mustUseTool && agent.tools.length > 0 && agent.toolCalls.length === 0) {
    issues.push(
      issue(
        'INTELLIGENCE_TOOL_REQUIRED_BUT_NOT_CALLED',
        `Agent "${profile.agentName}" has tool-backed responsibility "${profile.responsibility}" but no tool call plan`,
        `${path}.toolCalls`,
        'error',
      ),
    );
  }

  if (profile.mustUseFlow && agent.flow.length === 0) {
    issues.push(
      issue(
        'INTELLIGENCE_FLOW_REQUIRED_BUT_MISSING',
        `Agent "${profile.agentName}" needs scripted/hybrid flow for responsibility "${profile.responsibility}"`,
        `${path}.flow`,
        profile.executionMode === 'reasoning' ? 'warning' : 'error',
      ),
    );
  }

  if (profile.mustReturnToParent && agent.completion.length === 0) {
    issues.push(
      issue(
        'INTELLIGENCE_RETURNABLE_AGENT_MISSING_COMPLETION',
        `Agent "${profile.agentName}" is returnable but has no completion plan`,
        `${path}.completion`,
        'error',
      ),
    );
  }

  if (
    profile.responsibility === 'escalate' &&
    agent.gathers.length === 0 &&
    agent.escalations.length === 0
  ) {
    issues.push(
      issue(
        'INTELLIGENCE_ESCALATION_PACKET_MISSING',
        `Escalation agent "${profile.agentName}" should collect or emit an escalation packet`,
        `${path}.gathers`,
      ),
    );
  }

  if (profile.mustMaintainState && agent.state.length === 0 && agent.gathers.length === 0) {
    issues.push(
      issue(
        'INTELLIGENCE_STATE_REQUIRED_BUT_MISSING',
        `Agent "${profile.agentName}" participates in a stateful workflow but declares no state or gather fields`,
        `${path}.state`,
      ),
    );
  }

  if (profile.mustConfirmAction && !hasConfirmationSignal(agent)) {
    issues.push(
      issue(
        'INTELLIGENCE_CONFIRMATION_REQUIRED_BUT_MISSING',
        `Agent "${profile.agentName}" performs high-impact action work but has no confirmation field or state`,
        `${path}.gathers`,
      ),
    );
  }

  if (profile.mustCreateAuditTrail && !hasAuditSignal(agent)) {
    issues.push(
      issue(
        'INTELLIGENCE_AUDIT_REQUIRED_BUT_NOT_MODELED',
        `Agent "${profile.agentName}" has audit/compliance obligations that are not modeled in tools, state, constraints, or guardrails`,
        path,
      ),
    );
  }

  for (const [index, note] of profile.unsupportedNotes.entries()) {
    issues.push(
      issue(
        'INTELLIGENCE_UNSUPPORTED_RUNTIME_PATTERN',
        note,
        `${path}.unsupportedNotes.${index}`,
        'error',
      ),
    );
  }

  return issues;
}

function hasConfirmationSignal(agent: AgentConstructPlan): boolean {
  const names = [
    ...agent.gathers.map((item) => item.name),
    ...agent.state.map((item) => item.name),
    ...agent.flow.flatMap((step) => Object.keys(step.set ?? {})),
  ].join(' ');
  return /(confirm|confirmed|approval|approved|authorize|authorized|consent)/i.test(names);
}

function hasAuditSignal(agent: AgentConstructPlan): boolean {
  const text = [
    agent.tools.map((tool) => `${tool.ref} ${tool.purpose}`).join(' '),
    agent.state.map((state) => state.name).join(' '),
    agent.gathers.map((gather) => `${gather.name} ${gather.prompt}`).join(' '),
    agent.completion.map((complete) => `${complete.when} ${complete.respond ?? ''}`).join(' '),
    agent.rationale.join(' '),
  ].join(' ');
  return /\b(audit|log|trace|compliance|worm|pii|phi)\b/i.test(text);
}
