/**
 * Scaffold generator — takes the architecture plan + topology + agent spec
 * and produces a fully structured ABL skeleton with creative slot placeholders.
 *
 * Pure function. Zero LLM. Zero I/O. All Maps/Sets are function-local.
 *
 * Dispatches to per-archetype builders. Slice 1 implements supervisor only;
 * specialist, pipeline_stage, and worker come in later slices.
 */

import type {
  AblSkeleton,
  AgentRuntimePattern,
  AgentArchitecturePlan,
  AgentSpecInput,
  CompleteSlotPair,
  DomainContextInput,
  HandoffEntry,
  ScaffoldResult,
  ToolStub,
  TopologyOutput,
} from './types';
import { filterRelationshipToolRefs } from '@agent-platform/arch-ai/planning/relationship-tool-filter';
import { z } from 'zod';
import { resolveManagedBehaviorProfileUses } from '../managed-behavior-profiles';
import { buildSpecialistSchema, buildSupervisorSchema } from './creative-schemas';
import {
  inferInputFieldNamesFromSignature,
  parseToolSignature,
  renderToolFields,
  renderToolReturn,
  type ToolSignatureField,
} from './tool-signature';

const NO_INPUT_COMPLETE_WHEN = 'true AND true';
const SILENT_COMPLETE_RESPOND = '';
const TRANSACTION_PATTERN =
  /\b(create|update|submit|book|schedule|send|notify|refund|payment|approve|deny|file|case|ticket|cancel|change|modify)\b/;
const ESCALATION_PATTERN = /\b(escalat|human|handoff|review|approval|exception|incident)\b/;
const LOOKUP_PATTERN = /\b(lookup|search|status|track|retrieve|fetch|find|get|check)\b/;
const READ_ONLY_TOOL_PATTERN =
  /^(classify|detect|extract|lookup|retrieve|get|search|check|validate|verify|score|calculate|estimate|summarize|draft|normalize|identify|authenticate|inspect|analyze|rank|recommend|parse|match)(?:_|$)/;
const SIDE_EFFECT_TOOL_PATTERN =
  /^(create|update|submit|book|schedule|send|notify|refund|charge|pay|approve|deny|file|cancel|change|modify|apply|assign|dispatch|transfer|close|open|resolve|store|save|record|provision|deprovision|delete|remove|escalate)(?:_|$)/;
const DECISION_AGENT_PATTERN =
  /\b(advisor|advisory|analysis|analy[sz]e|classif(?:y|ier|ication)|decide|decision|eligibility|policy|rank|recommend|reason|route|routing|validate|validator)\b/;
const CONVERSATIONAL_CONSENT_PATTERN =
  /\b(after|once|when)\b.{0,80}\b(customer|user)\b.{0,80}\b(asks?|chooses?|confirms?|approves?|consents?|wants?)\b|\b(customer|user)\b.{0,80}\b(asks?|chooses?|confirms?|approves?|consents?|wants?)\b.{0,80}\b(replacement|refund|credit|action|outcome)\b/;
const ORDER_TOOL_PATTERN = /\b(order|shipment|shipping|delivery|tracking)\b/;
const TRACKING_TOOL_PATTERN = /\b(track|tracking|shipment|shipping|delivery)\b/;
const CUSTOMER_TOOL_PATTERN = /\b(customer|account|user|contact)\b/;
const EMAIL_TOOL_PATTERN = /\b(email|mail)\b/;
const CASE_TOOL_PATTERN = /\b(case|ticket|incident|claim)\b/;
const SEARCH_TOOL_PATTERN = /\b(search|find|query)\b/;
const TEXT_ANALYSIS_TOOL_PATTERN = /\b(classify|detect|extract|summarize|analyze|parse|score)\b/;
const REPLACEMENT_TOOL_PATTERN = /\b(replacement|replace|reship)\b/;
const REFUND_TOOL_PATTERN = /\b(refund|reimburse)\b/;
const CREDIT_TOOL_PATTERN = /\b(credit|goodwill|coupon)\b/;
const NOTIFICATION_TOOL_PATTERN = /\b(send|notify|message)\b/;
const RESERVED_CONDITION_WORDS = new Set([
  'AND',
  'OR',
  'NOT',
  'and',
  'or',
  'not',
  'true',
  'false',
  'null',
  'intent',
  'category',
]);

/**
 * Preflight check — makes sure the creative schema is a root ZodObject
 * (not an intersection, union, etc.). Some LLM providers (OpenAI structured
 * output) reject any JSON Schema whose root `type` is not literally
 * `"object"`. Catching this at scaffold time, in-process, produces a much
 * clearer error than the opaque provider-side failure.
 */
function assertRootZodObject(schema: z.ZodTypeAny, archetype: string, agentName: string): void {
  // ZodObject is what we want; anything else (ZodIntersection, ZodUnion,
  // ZodEffects, ZodDiscriminatedUnion, ...) would convert to a JSON schema
  // without a direct `type: "object"` root.
  if (!(schema instanceof z.ZodObject)) {
    throw new Error(
      `Scaffold produced non-ZodObject root schema for archetype "${archetype}" (agent "${agentName}"). ` +
        `This will fail OpenAI structured output. Got: ${schema.constructor?.name ?? typeof schema}`,
    );
  }
}

/**
 * Public entry point. Routes to an archetype-specific builder.
 */
export function scaffoldAblAgent(
  plan: AgentArchitecturePlan,
  topology: TopologyOutput,
  spec: AgentSpecInput,
  domain: DomainContextInput,
): ScaffoldResult {
  switch (plan.archetype) {
    case 'supervisor':
      return scaffoldSupervisor(plan, topology, spec, domain);
    case 'specialist':
      // single_agent and worker reuse specialist scaffolding — their plans
      // already encode the right presence flags (no gather, no handoffs, etc.)
      return scaffoldSpecialist(plan, topology, spec, domain);
    case 'worker':
      return scaffoldSpecialist(plan, topology, spec, domain);
    case 'pipeline_stage':
      return scaffoldPipelineStage(plan, topology, spec, domain);
    default:
      throw new Error(
        `scaffoldAblAgent: unknown archetype "${plan.archetype}" for agent "${plan.agentName}"`,
      );
  }
}

// ─── Supervisor ─────────────────────────────────────────────────────────────

function scaffoldSupervisor(
  plan: AgentArchitecturePlan,
  topology: TopologyOutput,
  spec: AgentSpecInput,
  domain: DomainContextInput,
): ScaffoldResult {
  const routeGatherField = {
    name: 'routing_intent',
    type: 'string',
    source: 'user' as const,
    askSlot: 'gather.routing_intent.ask',
  };
  const handoffs: HandoffEntry[] = plan.handoffs.targets.map((target, i) => ({
    to: target.to,
    returnExpected: target.returnExpected,
    experienceMode:
      target.experienceMode ?? findTopologyExperienceMode(topology, plan.agentName, target.to),
    whenSlot: `handoff.${i}.when`,
  }));

  if (plan.handoffs.needsCatchAll) {
    const catchAllTarget = plan.handoffs.catchAllTarget;
    if (!catchAllTarget) {
      throw new Error(
        `scaffoldSupervisor: plan.handoffs.needsCatchAll=true but catchAllTarget is undefined for "${plan.agentName}"`,
      );
    }
    handoffs.push({
      to: catchAllTarget,
      returnExpected: true,
      experienceMode: findTopologyExperienceMode(topology, plan.agentName, catchAllTarget),
      whenSlot: null,
      whenLiteral: 'true',
    });
  }

  const skeleton: AblSkeleton = {
    agentName: plan.agentName,
    keyword: 'SUPERVISOR',
    runtimePattern: inferRuntimePattern(plan, spec),
    goalSlot: 'goal',
    personaSlot: 'persona',
    onStartRespond: buildEntryWelcomeMessage(spec, domain),
    behaviorProfileUses: buildBehaviorProfileUses(topology, plan.agentName, domain),
    handoffs,
    gatherFields: [routeGatherField],
    completeSlots: [],
    memorySessionVars: [routeGatherField.name],
    tools: buildToolStubs(spec.tools, collectRelationshipTargets(plan, topology, handoffs), {
      sourceToolFixtures: domain.sourceToolFixtures,
      sourceTools: domain.sourceTools,
      consentPolicies: domain.consentPolicies,
    }),
    includeGuardrails: true,
  };

  const creativeSchema = buildSupervisorSchema(skeleton);
  assertRootZodObject(creativeSchema, 'supervisor', plan.agentName);
  const prompt = renderSupervisorPrompt(plan, topology, spec, domain);

  return { skeleton, creativeSchema, prompt };
}

// ─── Prompt rendering ───────────────────────────────────────────────────────

function renderSupervisorPrompt(
  plan: AgentArchitecturePlan,
  _topology: TopologyOutput,
  spec: AgentSpecInput,
  domain: DomainContextInput,
): string {
  const targets = plan.handoffs.targets
    .map((t) => {
      const hint = t.condition ? ` — hint: "${t.condition}"` : '';
      return `  - ${t.to} (${t.edgeType}, RETURN: ${t.returnExpected})${hint}`;
    })
    .join('\n');
  const returnFieldSeeds = plan.handoffs.targets
    .filter((target) => target.returnExpected && (target.returnFieldSeeds?.length ?? 0) > 0)
    .map((target) => `  - ${target.to}: ${(target.returnFieldSeeds ?? []).join(', ')}`)
    .join('\n');
  const summaryHints = plan.handoffs.targets
    .filter((target) => target.historyHint?.summaryRecommended)
    .map((target) => {
      const focusFields =
        (target.historyHint?.summaryFocusFields?.length ?? 0) > 0
          ? ` Focus fields when known: ${target.historyHint?.summaryFocusFields.join(', ')}.`
          : '';
      return `  - ${target.to}: author CONTEXT.summary. Seed: "${target.historyHint?.summaryTemplateSeed}"${focusFields}`;
    })
    .join('\n');
  const historyHints = plan.handoffs.targets
    .filter((target) => target.historyHint)
    .map(
      (target) =>
        `  - ${target.to}: prefer history: ${target.historyHint?.suggestedHistory} when you author CONTEXT.summary. ${target.historyHint?.reason}`,
    )
    .join('\n');
  const returnContractHints = plan.handoffs.targets
    .filter((target) => target.returnExpected && target.returnContractHint)
    .map((target) => `  - ${target.to}: ${target.returnContractHint?.reason}`)
    .join('\n');

  const sections: string[] = [];
  sections.push(`You are filling the creative fields for an ABL SUPERVISOR agent.`);
  sections.push(
    `Structural fields (SUPERVISOR: keyword, HANDOFF TO: names, RETURN flags, and GUARDRAILS shell) are already scaffolded by code — you cannot modify them.`,
  );
  sections.push('');
  sections.push(`Agent: ${plan.agentName}`);
  sections.push(`Role: ${spec.role}`);
  if (spec.description) sections.push(`Description: ${spec.description}`);
  sections.push('');
  sections.push(`Domain: ${domain.domain}`);
  if (domain.channels.length > 0) sections.push(`Channels: ${domain.channels.join(', ')}`);
  sections.push(`Tone: ${domain.tone}`);
  if (domain.language && domain.language !== 'English') {
    sections.push(`Language: ${domain.language} — all output must be in ${domain.language}.`);
  }
  if (domain.compliance.length > 0) sections.push(`Compliance: ${domain.compliance.join(', ')}`);
  if (domain.blueprintSummary) sections.push(`Blueprint Summary: ${domain.blueprintSummary}`);
  sections.push('');
  sections.push(
    `The supervisor routes to these topology targets. Refine each WHEN condition into a clear, specific user-intent description (do not invent or drop targets — the list is authoritative):`,
  );
  sections.push(targets);
  sections.push('');
  sections.push(`Use runtime-actionable WHEN expressions for every routed target.
- Preferred supervisor form: intent.category == "billing"
- Avoid introducing new state variable names in supervisors. If a topology hint uses a state-like label, convert it to an intent.category value.
- Do not write plain-English WHEN values such as "user asks about billing" or "matching intent".`);
  sections.push('');
  sections.push(
    `The scaffold includes one required router GATHER field named routing_intent. Write a concise clarifying question that asks what the user needs without duplicating downstream specialist intake.`,
  );
  if (summaryHints.length > 0) {
    sections.push('');
    sections.push(
      `Runtime-aligned summary hints for these targets (derived from topology context):`,
    );
    sections.push(summaryHints);
  }
  if (historyHints.length > 0) {
    sections.push('');
    sections.push(
      `Runtime-aligned continuity hints for these targets (derived from execution mode):`,
    );
    sections.push(historyHints);
  }
  if (returnFieldSeeds.length > 0) {
    sections.push('');
    sections.push(
      `These target gather fields already default-merge back to the parent by same name on RETURN: true:`,
    );
    sections.push(returnFieldSeeds);
  }
  if (returnContractHints.length > 0) {
    sections.push('');
    sections.push(`Runtime-aligned return-contract hints for these targets:`);
    sections.push(returnContractHints);
  }
  sections.push('');
  sections.push(
    `Respond with a JSON object matching the schema. Do not include YAML, Markdown fences, or explanatory text.`,
  );

  return sections.join('\n');
}

// ─── Specialist (sink with return contract) ─────────────────────────────────

function scaffoldSpecialist(
  plan: AgentArchitecturePlan,
  topology: TopologyOutput,
  spec: AgentSpecInput,
  domain: DomainContextInput,
): ScaffoldResult {
  const silentDelegateTarget = isSilentDelegateTarget(topology, plan.agentName);
  const relationshipTargets = collectRelationshipTargets(plan, topology, []);
  const tools = buildToolStubs(spec.tools, relationshipTargets, {
    conversationalConsent: hasConversationalConsent(plan, spec) || silentDelegateTarget,
    sourceToolFixtures: domain.sourceToolFixtures,
    sourceTools: domain.sourceTools,
    consentPolicies: domain.consentPolicies,
  });
  const gatherNames = silentDelegateTarget ? [] : collectGatherNames(plan, spec, tools, domain);

  const gatherFields = gatherNames.map((name) => ({
    name,
    type: 'string',
    source: 'user' as const,
    askSlot: `gather.${name}.ask`,
  }));

  const completeSlots = buildSinkCompleteSlots(plan, gatherNames);

  // Slice 2: sink specialist — outgoing handoffs are empty (escalate-only
  // specialists come in Slice 3 as pipeline_stage/worker).
  const skeleton: AblSkeleton = {
    agentName: plan.agentName,
    keyword: 'AGENT',
    runtimePattern: inferRuntimePattern(plan, spec),
    goalSlot: 'goal',
    personaSlot: 'persona',
    onStartRespond: buildEntryWelcomeMessage(spec, domain),
    behaviorProfileUses: buildBehaviorProfileUses(topology, plan.agentName, domain),
    handoffs: [],
    gatherFields,
    completeSlots,
    memorySessionVars: [...gatherNames],
    tools,
    includeGuardrails: true,
  };

  const creativeSchema = buildSpecialistSchema(skeleton);
  assertRootZodObject(creativeSchema, plan.archetype, plan.agentName);
  const prompt = renderSpecialistPrompt(
    plan,
    spec,
    domain,
    gatherNames,
    completeSlots,
    silentDelegateTarget,
  );

  return { skeleton, creativeSchema, prompt };
}

function renderSpecialistPrompt(
  plan: AgentArchitecturePlan,
  spec: AgentSpecInput,
  domain: DomainContextInput,
  gatherNames: ReadonlyArray<string>,
  completeSlots: ReadonlyArray<CompleteSlotPair>,
  silentDelegateTarget = false,
): string {
  const hasCodeOwnedCompletion = completeSlots.some(
    (slot) => slot.whenSlot === null && slot.respondSlot === null,
  );
  const sections: string[] = [];
  sections.push(`You are filling the creative fields for an ABL AGENT (specialist).`);
  sections.push(
    `Structural fields (AGENT: keyword, GATHER field names, COMPLETE reference targets, MEMORY/GUARDRAILS) are already scaffolded by code — you cannot modify them.`,
  );
  sections.push('');
  sections.push(`Agent: ${plan.agentName}`);
  sections.push(`Role: ${spec.role}`);
  if (spec.description) sections.push(`Description: ${spec.description}`);
  sections.push('');
  sections.push(`Domain: ${domain.domain}`);
  if (domain.channels.length > 0) sections.push(`Channels: ${domain.channels.join(', ')}`);
  sections.push(`Tone: ${domain.tone}`);
  if (domain.language && domain.language !== 'English') {
    sections.push(`Language: ${domain.language} — all output must be in ${domain.language}.`);
  }
  if (domain.compliance.length > 0) sections.push(`Compliance: ${domain.compliance.join(', ')}`);
  if (domain.blueprintSummary) sections.push(`Blueprint Summary: ${domain.blueprintSummary}`);
  sections.push('');
  if (silentDelegateTarget) {
    sections.push(
      `This is a silent delegate target. It receives structured context from the parent agent and must not ask customer-facing intake questions.`,
    );
  } else if (hasCodeOwnedCompletion) {
    sections.push(
      `This agent does not require structured GATHER input. The return-triggering COMPLETE block is already scaffolded by code, so focus only on GOAL and PERSONA.`,
    );
  } else {
    sections.push(
      `Control returns once the specialist has collected its GATHER fields and at least one COMPLETE condition is satisfied.`,
    );
  }
  sections.push(
    `Shared brand voice, channel rules, and handoff continuity should live in behavior profiles when authored. Keep this specialist PERSONA focused on domain responsibility instead of duplicating global voice rules.`,
  );
  if (gatherNames.length > 0) {
    sections.push(`Required GATHER fields: ${gatherNames.join(', ')}`);
  }
  if (completeSlots.length > 0) {
    sections.push(
      'The scaffold already emits COMPLETE RESPOND: "" for silent return. Do not invent a second completion message unless a later edit deliberately changes that runtime behavior.',
    );
  }
  sections.push('');
  sections.push(
    `Respond with a JSON object matching the schema. Do not include YAML, Markdown fences, or explanatory text.`,
  );
  return sections.join('\n');
}

// ─── Pipeline stage (incoming + outgoing delegates) ─────────────────────────

function scaffoldPipelineStage(
  plan: AgentArchitecturePlan,
  topology: TopologyOutput,
  spec: AgentSpecInput,
  domain: DomainContextInput,
): ScaffoldResult {
  // GATHER + COMPLETE: same logic as specialist (return contract)
  const silentDelegateTarget = isSilentDelegateTarget(topology, plan.agentName);
  const relationshipTargets = collectRelationshipTargets(plan, topology, []);
  const tools = buildToolStubs(spec.tools, relationshipTargets, {
    conversationalConsent: hasConversationalConsent(plan, spec) || silentDelegateTarget,
    sourceToolFixtures: domain.sourceToolFixtures,
    sourceTools: domain.sourceTools,
    consentPolicies: domain.consentPolicies,
  });
  const gatherNames = silentDelegateTarget ? [] : collectGatherNames(plan, spec, tools, domain);
  const gatherNameSet = new Set(gatherNames);

  // Outgoing handoffs: one per topology target. Pipeline stages do NOT need a
  // catch-all — they have a fixed next step. Keep the WHEN clause code-owned
  // instead of asking the LLM for a branch expression; otherwise the creative
  // fill can invent state like `outstanding_requirements_count` that this
  // scaffold does not populate, forcing an expensive fallback to legacy ABL
  // generation.
  const handoffs: HandoffEntry[] = plan.handoffs.targets.map((target) => ({
    to: target.to,
    returnExpected: target.returnExpected,
    experienceMode:
      target.experienceMode ?? findTopologyExperienceMode(topology, plan.agentName, target.to),
    whenSlot: null,
    whenLiteral: buildPipelineHandoffCondition(target, plan.handoffs.targets.length, gatherNameSet),
  }));

  const gatherFields = gatherNames.map((name) => ({
    name,
    type: 'string',
    source: 'user' as const,
    askSlot: `gather.${name}.ask`,
  }));
  const completeSlots = plan.complete.required
    ? [
        {
          whenSlot: null,
          respondSlot: null,
          whenLiteral:
            gatherNames.length > 0
              ? buildGatherCompletionCondition(gatherNames)
              : NO_INPUT_COMPLETE_WHEN,
          respondLiteral: SILENT_COMPLETE_RESPOND,
        },
      ]
    : [];

  const skeleton: AblSkeleton = {
    agentName: plan.agentName,
    keyword: 'AGENT',
    runtimePattern: inferRuntimePattern(plan, spec),
    goalSlot: 'goal',
    personaSlot: 'persona',
    onStartRespond: buildEntryWelcomeMessage(spec, domain),
    behaviorProfileUses: buildBehaviorProfileUses(topology, plan.agentName, domain),
    handoffs,
    gatherFields,
    completeSlots,
    memorySessionVars: [...gatherNames],
    tools,
    includeGuardrails: true,
  };

  // buildSpecialistSchema emits a single root ZodObject containing goal,
  // persona, gather, complete, AND handoff groups based on what the skeleton
  // declares. Must NOT use Zod intersection (.and()) — OpenAI's structured-
  // output rejects JSON schemas that aren't literal `type: "object"` at root.
  const creativeSchema = buildSpecialistSchema(skeleton);
  assertRootZodObject(creativeSchema, 'pipeline_stage', plan.agentName);
  const prompt = renderPipelineStagePrompt(plan, spec, domain);

  return { skeleton, creativeSchema, prompt };
}

function buildToolStubs(
  toolNames: ReadonlyArray<string> | undefined,
  relationshipTargets: ReadonlyArray<string>,
  options: {
    conversationalConsent?: boolean;
    sourceToolFixtures?: DomainContextInput['sourceToolFixtures'];
    sourceTools?: DomainContextInput['sourceTools'];
    consentPolicies?: DomainContextInput['consentPolicies'];
  } = {},
): ToolStub[] {
  if (!toolNames || toolNames.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const stubs: ToolStub[] = [];
  for (const rawName of filterRelationshipToolRefs(
    toolNames,
    relationshipTargets,
    (name) => name,
  )) {
    const name = normalizeToolName(rawName);
    if (name.length === 0 || seen.has(name)) {
      continue;
    }
    seen.add(name);
    const contract = inferToolContract(name, rawName, {
      sourceToolFixtures: options.sourceToolFixtures,
      sourceTools: options.sourceTools,
    });
    const consentPolicy = findConsentPolicyForTool(name, contract.description, options);
    const sideEffects = contract.sideEffects || Boolean(consentPolicy);
    stubs.push({
      name,
      signatureLiteral: contract.signature,
      descriptionLiteral: contract.description,
      sideEffects,
      confirmPolicy: deriveConfirmPolicy(sideEffects, consentPolicy, {
        conversationalConsent: options.conversationalConsent,
      }),
      inputFieldsAreContractDriven: contract.inputFieldsAreContractDriven,
      paramDescriptions: contract.paramDescriptions,
      signatureSlot: `tool.${name}.signature`,
      descriptionSlot: `tool.${name}.description`,
    });
  }
  return stubs;
}

type ScaffoldConsentPolicy = NonNullable<DomainContextInput['consentPolicies']>[number];

function findConsentPolicyForTool(
  toolName: string,
  toolDescription: string,
  options: { consentPolicies?: DomainContextInput['consentPolicies'] },
): ScaffoldConsentPolicy | undefined {
  const policies = options.consentPolicies ?? [];
  if (policies.length === 0) {
    return undefined;
  }

  const normalizedToolName = normalizeToolName(toolName);
  const explicitPolicy = policies.find(
    (policy) => policy.toolName && normalizeToolName(policy.toolName) === normalizedToolName,
  );
  if (explicitPolicy) {
    return explicitPolicy;
  }

  const searchable = `${toolName} ${toolDescription}`.toLowerCase();
  return policies.find(
    (policy) =>
      !policy.toolName &&
      policy.action.trim().length > 0 &&
      searchable.includes(policy.action.toLowerCase()),
  );
}

function deriveConfirmPolicy(
  sideEffects: boolean,
  consentPolicy: ScaffoldConsentPolicy | undefined,
  options: { conversationalConsent?: boolean },
): ToolStub['confirmPolicy'] {
  if (!sideEffects) {
    return 'never';
  }
  if (consentPolicy?.mode === 'never' || consentPolicy?.requiredIn === 'conversation') {
    return 'never';
  }
  if (options.conversationalConsent === true) {
    return 'never';
  }
  return 'when_side_effects';
}

function collectRelationshipTargets(
  plan: AgentArchitecturePlan,
  topology: TopologyOutput,
  handoffs: ReadonlyArray<HandoffEntry>,
): string[] {
  const targets = new Set<string>();
  for (const handoff of handoffs) {
    targets.add(handoff.to);
  }
  for (const target of plan.handoffs.targets) {
    targets.add(target.to);
  }
  if (plan.handoffs.catchAllTarget) {
    targets.add(plan.handoffs.catchAllTarget);
  }
  for (const edge of topology.edges) {
    if (edge.from === plan.agentName) {
      targets.add(edge.to);
    }
  }
  return [...targets];
}

function buildEntryWelcomeMessage(
  spec: AgentSpecInput,
  domain: DomainContextInput,
): string | undefined {
  if (!spec.isEntry) {
    return undefined;
  }

  const channelNames = new Set(domain.channels.map((channel) => channel.toLowerCase()));
  if (channelNames.has('voice')) {
    return 'Hi, how can I help?';
  }

  return 'Hi. What can I help with?';
}

function buildBehaviorProfileUses(
  topology: TopologyOutput,
  agentName: string,
  domain: DomainContextInput,
): string[] {
  return resolveManagedBehaviorProfileUses(topology, agentName, domain);
}

function findTopologyExperienceMode(
  topology: TopologyOutput,
  from: string,
  to: string,
): HandoffEntry['experienceMode'] {
  return topology.edges.find((edge) => edge.from === from && edge.to === to)?.experienceMode;
}

function isSilentDelegateTarget(topology: TopologyOutput, agentName: string): boolean {
  return topology.edges.some(
    (edge) => edge.to === agentName && edge.experienceMode === 'silent_delegate',
  );
}

function inferRuntimePattern(
  plan: AgentArchitecturePlan,
  spec: AgentSpecInput,
): AgentRuntimePattern {
  if (plan.archetype === 'supervisor') {
    return 'router';
  }

  if (plan.archetype === 'pipeline_stage') {
    return 'pipeline_stage';
  }

  const text = normalizePatternText(plan, spec);
  const hasTools = (spec.tools?.length ?? 0) > 0;
  const hasGather = collectGatherNames(plan, spec).length > 0;
  const hasReturnContract =
    plan.complete.required || plan.complexity.signals.includes('return_contract');

  if (ESCALATION_PATTERN.test(text)) {
    return 'escalation';
  }

  if (
    spec.executionMode === 'reasoning' &&
    DECISION_AGENT_PATTERN.test(text) &&
    !hasSideEffectTools(spec.tools)
  ) {
    return 'reasoning';
  }

  if (hasTools && TRANSACTION_PATTERN.test(text)) {
    return 'transaction';
  }

  if (hasTools) {
    return 'tool_worker';
  }

  if (hasReturnContract) {
    return 'returnable_child';
  }

  if (hasGather) {
    return 'intake';
  }

  return 'reasoning';
}

function normalizePatternText(plan: AgentArchitecturePlan, spec: AgentSpecInput): string {
  return [
    plan.agentName,
    plan.archetype,
    spec.name,
    spec.role,
    spec.description,
    ...(spec.tools ?? []),
    ...plan.complexity.signals,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLowerCase();
}

function hasSideEffectTools(toolNames: ReadonlyArray<string> | undefined): boolean {
  return (toolNames ?? []).some((toolName) => {
    const name = normalizeToolName(toolName);
    const label = toolName.replace(/[_./-]+/g, ' ');
    return inferToolSideEffects(name, `${name} ${toolName} ${label}`.toLowerCase());
  });
}

function hasConversationalConsent(plan: AgentArchitecturePlan, spec: AgentSpecInput): boolean {
  return CONVERSATIONAL_CONSENT_PATTERN.test(normalizePatternText(plan, spec));
}

function inferToolContract(
  normalizedName: string,
  rawName: string,
  options: {
    sourceToolFixtures?: DomainContextInput['sourceToolFixtures'];
    sourceTools?: DomainContextInput['sourceTools'];
  } = {},
): {
  signature: string;
  description: string;
  sideEffects: boolean;
  inputFieldsAreContractDriven: boolean;
  paramDescriptions: Record<string, string>;
} {
  const label = rawName.replace(/[_./-]+/g, ' ');
  const text = `${normalizedName} ${rawName} ${label}`.toLowerCase();
  const sideEffects = inferToolSideEffects(normalizedName, text);
  const sourceTool = options.sourceTools?.find(
    (tool) => normalizeToolName(tool.name).toLowerCase() === normalizedName.toLowerCase(),
  );
  const fixtureSignature = inferToolSignatureFromSourceFixture(normalizedName, options);
  const sourceSignature = normalizeSourceToolSignature(normalizedName, sourceTool?.signature);
  const sourceSignatureShape = parseToolSignature(sourceSignature);
  const inputFieldsAreContractDriven = Boolean(
    sourceSignatureShape?.inputFields.length || fixtureSignature?.inputFields.length,
  );
  const inputFields = mergeToolFields(
    sourceSignatureShape?.inputFields,
    fixtureSignature?.inputFields,
    sourceSignatureShape || fixtureSignature ? undefined : inferToolInputFields(text),
  );
  const outputFields = mergeToolFields(
    sourceSignatureShape?.outputIsObject === false ? [] : sourceSignatureShape?.outputFields,
    sourceSignatureShape?.outputIsObject === false ? [] : fixtureSignature?.outputFields,
    sourceSignatureShape || fixtureSignature ? undefined : inferToolOutputFields(text),
  );
  const signature = `${sourceSignatureShape?.toolName ?? normalizedName}(${renderToolFields(
    inputFields,
  )}) -> ${renderToolReturn(sourceSignatureShape, outputFields)}`;
  const paramDescriptions = Object.fromEntries(
    inputFields.map((field) => [field.name, describeToolParameter(field.name, label)]),
  );

  if (TRANSACTION_PATTERN.test(text)) {
    const fallbackDescription = `Call when the customer has chosen or approved the ${label} action and the agent has ${renderToolFieldNames(
      inputFields,
    )}. Do not call for lookup-only questions or before customer consent is established.`;
    return {
      signature,
      description: renderSourceToolDescription(sourceTool, fallbackDescription),
      sideEffects,
      inputFieldsAreContractDriven,
      paramDescriptions,
    };
  }

  if (LOOKUP_PATTERN.test(text)) {
    const fallbackDescription = `Call when the agent needs fresh ${label} information using ${renderToolFieldNames(
      inputFields,
    )}. Do not call again if this turn already has a fresh result for the same request.`;
    return {
      signature,
      description: renderSourceToolDescription(sourceTool, fallbackDescription),
      sideEffects,
      inputFieldsAreContractDriven,
      paramDescriptions,
    };
  }

  const fallbackDescription = `Call for the ${label} workflow when the required inputs are available: ${renderToolFieldNames(
    inputFields,
  )}. Do not call when the agent is only explaining policy or options.`;
  return {
    signature,
    description: renderSourceToolDescription(sourceTool, fallbackDescription),
    sideEffects,
    inputFieldsAreContractDriven,
    paramDescriptions,
  };
}

type SourceToolContext = NonNullable<DomainContextInput['sourceTools']>[number];

function renderSourceToolDescription(
  sourceTool: SourceToolContext | undefined,
  fallbackDescription: string,
): string {
  if (!sourceTool) return fallbackDescription;
  const parts = [sourceTool.description?.trim() || fallbackDescription];
  if (sourceTool.callWhen?.length) {
    parts.push(`Call when ${sourceTool.callWhen.join('; ')}.`);
  }
  if (sourceTool.doNotCallWhen?.length) {
    parts.push(`Do not call when ${sourceTool.doNotCallWhen.join('; ')}.`);
  }
  return parts.join(' ');
}

function normalizeSourceToolSignature(
  normalizedName: string,
  sourceSignature: string | undefined,
): string | undefined {
  const signature = sourceSignature?.trim();
  if (!signature) return undefined;
  const namedSignature = signature.match(
    /^[A-Za-z_][A-Za-z0-9_]*(?:[./-][A-Za-z_][A-Za-z0-9_]*)*\s*(\(.*)$/s,
  );
  if (namedSignature?.[1]) return `${normalizedName}${namedSignature[1]}`;
  if (/^\(/.test(signature)) return `${normalizedName}${signature}`;
  return undefined;
}

function inferInputFieldsFromSignature(signature: string): string[] {
  return inferInputFieldNamesFromSignature(signature);
}

function mergeToolFields(
  ...fieldSets: Array<ReadonlyArray<ToolSignatureField> | undefined>
): ToolSignatureField[] {
  const merged: ToolSignatureField[] = [];
  const seen = new Set<string>();

  for (const fields of fieldSets) {
    for (const field of fields ?? []) {
      if (seen.has(field.name)) {
        continue;
      }
      seen.add(field.name);
      merged.push(field);
    }
  }

  return merged;
}

function inferToolSignatureFromSourceFixture(
  normalizedName: string,
  options: {
    sourceToolFixtures?: DomainContextInput['sourceToolFixtures'];
  },
): { inputFields: ToolSignatureField[]; outputFields: ToolSignatureField[] } | null {
  const fixtures = (options.sourceToolFixtures ?? []).filter(
    (candidate) =>
      normalizeToolName(candidate.toolName).toLowerCase() === normalizedName.toLowerCase(),
  );
  if (fixtures.length === 0) {
    return null;
  }

  const inputFields = mergeToolFields(
    ...fixtures.map((fixture) => inferFieldsFromRecord(fixture.sampleInput)),
  );
  const outputFields = mergeToolFields(
    ...fixtures.map((fixture) => inferFieldsFromRecord(parseFixtureResponse(fixture.response))),
  );
  if (inputFields.length === 0 && outputFields.length === 0) {
    return null;
  }

  return {
    inputFields: inputFields.length > 0 ? inputFields : inferToolInputFields(normalizedName),
    outputFields: outputFields.length > 0 ? outputFields : inferToolOutputFields(normalizedName),
  };
}

function parseFixtureResponse(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function inferFieldsFromRecord(record: Record<string, unknown> | undefined): ToolSignatureField[] {
  if (!record) {
    return [];
  }

  return Object.entries(record)
    .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .map(([name, value]) => ({
      name,
      type: inferToolFieldType(value),
    }));
}

function inferToolFieldType(value: unknown): string {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  if (Array.isArray(value)) {
    const first = value[0];
    if (typeof first === 'boolean') return 'boolean[]';
    if (typeof first === 'number') return 'number[]';
    if (typeof first === 'string') return 'string[]';
    return 'object[]';
  }
  if (value && typeof value === 'object') return 'object';
  return 'string';
}

function inferToolInputFields(text: string): ToolSignatureField[] {
  const fields: ToolSignatureField[] = [];

  const needsOrderScope =
    ORDER_TOOL_PATTERN.test(text) ||
    REPLACEMENT_TOOL_PATTERN.test(text) ||
    REFUND_TOOL_PATTERN.test(text) ||
    CREDIT_TOOL_PATTERN.test(text);

  if (needsOrderScope) {
    fields.push({ name: 'order_id', type: 'string' });
  }
  if (
    TRACKING_TOOL_PATTERN.test(text) &&
    !fields.some((field) => field.name === 'tracking_number')
  ) {
    fields.push({ name: 'tracking_number', type: 'string' });
  }
  if (EMAIL_TOOL_PATTERN.test(text)) {
    fields.push({ name: 'email', type: 'string' });
  } else if (CUSTOMER_TOOL_PATTERN.test(text)) {
    fields.push({ name: 'customer_id', type: 'string' });
  }
  if (CASE_TOOL_PATTERN.test(text)) {
    fields.push({ name: 'case_id', type: 'string' });
  }
  if (SEARCH_TOOL_PATTERN.test(text)) {
    fields.push({ name: 'query', type: 'string' });
  }
  if (TEXT_ANALYSIS_TOOL_PATTERN.test(text)) {
    fields.push({ name: 'text', type: 'string' });
  }
  if (
    REPLACEMENT_TOOL_PATTERN.test(text) ||
    REFUND_TOOL_PATTERN.test(text) ||
    CREDIT_TOOL_PATTERN.test(text)
  ) {
    fields.push({ name: 'reason', type: 'string' });
  }
  if (NOTIFICATION_TOOL_PATTERN.test(text)) {
    fields.push({ name: 'recipient', type: 'string' }, { name: 'message', type: 'string' });
  }

  return dedupeToolFields(fields.length > 0 ? fields : [{ name: 'request', type: 'string' }]);
}

function inferToolOutputFields(text: string): ToolSignatureField[] {
  if (REPLACEMENT_TOOL_PATTERN.test(text)) {
    return [
      { name: 'success', type: 'boolean' },
      { name: 'replacement_id', type: 'string' },
      { name: 'promised_delivery_date', type: 'string' },
    ];
  }
  if (REFUND_TOOL_PATTERN.test(text)) {
    return [
      { name: 'success', type: 'boolean' },
      { name: 'refund_id', type: 'string' },
      { name: 'refund_eta', type: 'string' },
    ];
  }
  if (CREDIT_TOOL_PATTERN.test(text)) {
    return [
      { name: 'success', type: 'boolean' },
      { name: 'credit_id', type: 'string' },
      { name: 'amount', type: 'number' },
    ];
  }
  if (CASE_TOOL_PATTERN.test(text) && SIDE_EFFECT_TOOL_PATTERN.test(text)) {
    return [
      { name: 'success', type: 'boolean' },
      { name: 'case_id', type: 'string' },
      { name: 'status', type: 'string' },
    ];
  }
  if (ORDER_TOOL_PATTERN.test(text) || TRACKING_TOOL_PATTERN.test(text)) {
    return [
      { name: 'status', type: 'string' },
      { name: 'last_scan_at', type: 'string' },
      { name: 'promised_delivery_date', type: 'string' },
      { name: 'eligible_options', type: 'string' },
    ];
  }
  if (NOTIFICATION_TOOL_PATTERN.test(text)) {
    return [
      { name: 'success', type: 'boolean' },
      { name: 'message_id', type: 'string' },
    ];
  }
  if (LOOKUP_PATTERN.test(text) || TEXT_ANALYSIS_TOOL_PATTERN.test(text)) {
    return [
      { name: 'summary', type: 'string' },
      { name: 'confidence', type: 'number' },
    ];
  }
  if (SIDE_EFFECT_TOOL_PATTERN.test(text)) {
    return [
      { name: 'success', type: 'boolean' },
      { name: 'reference_id', type: 'string' },
      { name: 'summary', type: 'string' },
    ];
  }

  return [{ name: 'summary', type: 'string' }];
}

function renderToolFieldNames(fields: ReadonlyArray<ToolSignatureField>): string {
  if (fields.length === 0) {
    return 'the required inputs';
  }
  return fields.map((field) => field.name).join(', ');
}

function dedupeToolFields(fields: ReadonlyArray<ToolSignatureField>): ToolSignatureField[] {
  const seen = new Set<string>();
  return fields.filter((field) => {
    if (seen.has(field.name)) {
      return false;
    }
    seen.add(field.name);
    return true;
  });
}

function describeToolParameter(fieldName: string, label: string): string {
  switch (fieldName) {
    case 'order_id':
      return `Order identifier for the ${label} workflow.`;
    case 'tracking_number':
      return `Carrier tracking number for the ${label} workflow.`;
    case 'email':
      return `Customer email address for the ${label} workflow.`;
    case 'customer_id':
      return `Customer or account identifier for the ${label} workflow.`;
    case 'case_id':
      return `Case, ticket, or incident identifier for the ${label} workflow.`;
    case 'query':
      return `Search query for the ${label} workflow.`;
    case 'text':
      return `Text to inspect for the ${label} workflow.`;
    case 'reason':
      return `Customer-safe reason for the ${label} action.`;
    case 'recipient':
      return `Recipient for the ${label} message.`;
    case 'message':
      return `Message body for the ${label} workflow.`;
    default:
      return `Request value for the ${label} workflow.`;
  }
}

function inferToolSideEffects(normalizedName: string, text: string): boolean {
  if (READ_ONLY_TOOL_PATTERN.test(normalizedName)) {
    return false;
  }

  return SIDE_EFFECT_TOOL_PATTERN.test(normalizedName) || TRANSACTION_PATTERN.test(text);
}

function buildPipelineHandoffCondition(
  target: AgentArchitecturePlan['handoffs']['targets'][number],
  targetCount: number,
  gatheredStateVars: ReadonlySet<string>,
): string {
  if (targetCount <= 1) {
    return 'true';
  }

  const condition = target.condition?.trim();
  if (condition && isRuntimeActionableTopologyCondition(condition, gatheredStateVars)) {
    return condition;
  }

  return `intent.category == "${deriveIntentCategory(target.condition ?? target.to)}"`;
}

const CEL_COMPARISON_OPERATOR_PATTERN = /(==|!=|>=|<=|>|<)/;

function isRuntimeActionableTopologyCondition(
  condition: string,
  gatheredStateVars: ReadonlySet<string>,
): boolean {
  if (!CEL_COMPARISON_OPERATOR_PATTERN.test(condition)) {
    return false;
  }
  if (condition.includes('{{') || condition.includes('}}')) {
    return false;
  }

  const referencedStateVars = collectConditionStateVars([condition]);
  return referencedStateVars.length > 0
    ? referencedStateVars.every((name) => gatheredStateVars.has(name))
    : false;
}

function deriveIntentCategory(value: string): string {
  const explicitIntent = value.match(/intent\.category\s*==\s*["']([^"']+)["']/i);
  if (explicitIntent?.[1]) {
    return slugIntentCategory(explicitIntent[1]);
  }

  const negatedQuotedCategory = value.match(/!=\s*["']([a-zA-Z0-9_-]{3,})["']/);
  if (negatedQuotedCategory?.[1]) {
    return `not_${slugIntentCategory(negatedQuotedCategory[1])}`;
  }

  const negatedBoolean = value.match(/!=\s*(true|false)\b/i);
  if (negatedBoolean?.[1]) {
    return `not_${slugIntentCategory(value)}`;
  }

  const quotedCategory = value.match(/["']([a-zA-Z0-9_-]{3,})["']/);
  if (quotedCategory?.[1]) {
    return slugIntentCategory(quotedCategory[1]);
  }

  return slugIntentCategory(value);
}

function slugIntentCategory(value: string): string {
  const slug = value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .toLowerCase();
  return slug || 'next_step';
}

function normalizeToolName(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

function collectConditionStateVars(conditions: ReadonlyArray<string | undefined>): string[] {
  const vars: string[] = [];
  const seen = new Set<string>();
  for (const condition of conditions) {
    if (!condition) continue;
    const withoutStrings = condition.replace(/"[^"]*"|'[^']*'/g, ' ');
    const matches = withoutStrings.match(/[a-zA-Z_][a-zA-Z0-9_.]*/g) ?? [];
    for (const match of matches) {
      const root = match.split('.')[0];
      if (RESERVED_CONDITION_WORDS.has(root) || seen.has(root)) {
        continue;
      }
      seen.add(root);
      vars.push(root);
    }
  }
  return vars;
}

function renderPipelineStagePrompt(
  plan: AgentArchitecturePlan,
  spec: AgentSpecInput,
  domain: DomainContextInput,
): string {
  const targets = plan.handoffs.targets
    .map((t) => {
      const hint = t.condition ? ` — hint: "${t.condition}"` : '';
      return `  - ${t.to} (${t.edgeType}, RETURN: ${t.returnExpected})${hint}`;
    })
    .join('\n');
  const returnFieldSeeds = plan.handoffs.targets
    .filter((target) => target.returnExpected && (target.returnFieldSeeds?.length ?? 0) > 0)
    .map((target) => `  - ${target.to}: ${(target.returnFieldSeeds ?? []).join(', ')}`)
    .join('\n');
  const summaryHints = plan.handoffs.targets
    .filter((target) => target.historyHint?.summaryRecommended)
    .map((target) => {
      const focusFields =
        (target.historyHint?.summaryFocusFields?.length ?? 0) > 0
          ? ` Focus fields when known: ${target.historyHint?.summaryFocusFields.join(', ')}.`
          : '';
      return `  - ${target.to}: author CONTEXT.summary. Seed: "${target.historyHint?.summaryTemplateSeed}"${focusFields}`;
    })
    .join('\n');
  const historyHints = plan.handoffs.targets
    .filter((target) => target.historyHint)
    .map(
      (target) =>
        `  - ${target.to}: prefer history: ${target.historyHint?.suggestedHistory} when you author CONTEXT.summary. ${target.historyHint?.reason}`,
    )
    .join('\n');
  const returnContractHints = plan.handoffs.targets
    .filter((target) => target.returnExpected && target.returnContractHint)
    .map((target) => `  - ${target.to}: ${target.returnContractHint?.reason}`)
    .join('\n');
  const sections: string[] = [];
  sections.push(`You are filling the creative fields for an ABL pipeline-stage AGENT.`);
  sections.push(
    `Structural fields (AGENT: keyword, HANDOFF TO: names, RETURN flags, GATHER field names, COMPLETE references, MEMORY/GUARDRAILS) are already scaffolded by code.`,
  );
  sections.push('');
  sections.push(`Agent: ${plan.agentName}`);
  sections.push(`Role: ${spec.role}`);
  if (spec.description) sections.push(`Description: ${spec.description}`);
  sections.push('');
  sections.push(`Domain: ${domain.domain}`);
  if (domain.channels.length > 0) sections.push(`Channels: ${domain.channels.join(', ')}`);
  sections.push(`Tone: ${domain.tone}`);
  if (domain.language && domain.language !== 'English') {
    sections.push(`Language: ${domain.language} — all output must be in ${domain.language}.`);
  }
  if (domain.compliance.length > 0) sections.push(`Compliance: ${domain.compliance.join(', ')}`);
  if (domain.blueprintSummary) sections.push(`Blueprint Summary: ${domain.blueprintSummary}`);
  sections.push('');
  sections.push(
    `This stage collects GATHER fields, then delegates to the next pipeline stage. HANDOFF conditions are code-owned, so fill only GATHER ask prompts + COMPLETE conditions.`,
  );
  if (plan.complete.required) {
    sections.push(
      'The scaffold already emits COMPLETE RESPOND: "" for silent return. Focus on the WHEN expression and the data path that makes it true.',
    );
  }
  sections.push(`Next-stage targets:`);
  sections.push(targets);
  if (summaryHints.length > 0) {
    sections.push('');
    sections.push(
      `Runtime-aligned summary hints for these targets (derived from topology context):`,
    );
    sections.push(summaryHints);
  }
  if (historyHints.length > 0) {
    sections.push('');
    sections.push(
      `Runtime-aligned continuity hints for these targets (derived from execution mode):`,
    );
    sections.push(historyHints);
  }
  if (returnFieldSeeds.length > 0) {
    sections.push('');
    sections.push(
      `These target gather fields already default-merge back to the parent by same name on RETURN: true:`,
    );
    sections.push(returnFieldSeeds);
  }
  if (returnContractHints.length > 0) {
    sections.push('');
    sections.push(`Runtime-aligned return-contract hints for these targets:`);
    sections.push(returnContractHints);
  }
  sections.push('');
  sections.push(
    `Respond with a JSON object matching the schema. Do not include YAML, Markdown fences, or explanatory text.`,
  );
  return sections.join('\n');
}

function collectGatherNames(
  plan: AgentArchitecturePlan,
  spec: AgentSpecInput,
  tools: ReadonlyArray<ToolStub> = [],
  domain?: DomainContextInput,
): string[] {
  const gatherNames: string[] = [];
  const seen = new Set<string>();
  const contractGatherFields = [
    ...(plan.gather.suggestedFields ?? []),
    ...(spec.gatherFields ?? []),
  ];
  const contractDrivenToolInputFields = tools.flatMap((tool) =>
    tool.inputFieldsAreContractDriven ? inferInputFieldsFromSignature(tool.signatureLiteral) : [],
  );
  const fallbackToolInputFields = tools.flatMap((tool) =>
    inferInputFieldsFromSignature(tool.signatureLiteral),
  );
  const candidateNames =
    contractGatherFields.length > 0
      ? [...contractGatherFields, ...contractDrivenToolInputFields]
      : fallbackToolInputFields;
  for (const name of candidateNames) {
    const source = resolveGatherFieldSource(name, spec, domain);
    if (source !== 'user') {
      continue;
    }
    if (!seen.has(name)) {
      seen.add(name);
      gatherNames.push(name);
    }
  }
  return gatherNames;
}

function resolveGatherFieldSource(
  name: string,
  spec: AgentSpecInput,
  domain: DomainContextInput | undefined,
): 'user' | 'context' | 'tool' | 'memory' {
  const explicitSource = spec.gatherFieldSources?.[name];
  if (explicitSource) {
    return explicitSource;
  }
  if (domain?.sharedMemoryVariables?.includes(name)) {
    return 'memory';
  }
  return 'user';
}

function buildSinkCompleteSlots(
  plan: AgentArchitecturePlan,
  gatherNames: ReadonlyArray<string>,
): CompleteSlotPair[] {
  if (!plan.complete.required) {
    return [];
  }

  if (gatherNames.length === 0) {
    return [
      {
        whenSlot: null,
        respondSlot: null,
        whenLiteral: NO_INPUT_COMPLETE_WHEN,
        respondLiteral: SILENT_COMPLETE_RESPOND,
      },
    ];
  }

  return [
    {
      whenSlot: null,
      respondSlot: null,
      whenLiteral: buildGatherCompletionCondition(gatherNames),
      respondLiteral: SILENT_COMPLETE_RESPOND,
    },
  ];
}

function buildGatherCompletionCondition(gatherNames: ReadonlyArray<string>): string {
  return gatherNames.map((field) => `${field} != null`).join(' AND ');
}
