/**
 * Parallel BUILD Generation — spawns one streamText worker per agent.
 *
 * Exports `runParallelGeneration` which:
 *   1. Sets buildProgress.stage = 'generating' for requested agents
 *   2. Spawns parallel workers via Promise.allSettled
 *   3. Each worker: streamText with system prompt + agent spec + worker tools
 *   4. After all settle: reconciles results and updates buildProgress
 *   5. Returns AgentGenResult[] with elapsed times
 */

import { streamText, stepCountIs } from 'ai';
import type { LanguageModel } from 'ai';
import { createLogger } from '@abl/compiler/platform/logger.js';
import {
  ABL_CONSTRUCT_EXPERT_SYNTAX,
  type ArchSession,
  type ArchSSEEvent,
  type BuildAgentStatus,
} from '@agent-platform/arch-ai';
import { getSourceArchitectureContractFromMetadata } from '@agent-platform/arch-ai/blueprint';
import type { AgentGenResult, BuildActionContext } from './build-completion';
import {
  reconcileBuildResults,
  type ReconcileBuildResultsInput,
} from './build-result-reconciliation';
import { clearStaleArtifacts } from './build-orchestrator';
import { normalizeBuildAgentSource } from './build-source-normalization';
import { createBuildWorkerTools } from './build-worker-tools';
import { classifyBuildRetryPolicy, DEFAULT_BUILD_FIX_MAX_ROUNDS } from './build-retry-policy';
import { computeArchitecturePlans } from '@agent-platform/arch-ai';
import type { ABLAgentContext, AgentArchitecturePlan } from '@agent-platform/arch-ai';
import { ARCH_AI_BUILD, ARCH_AI_LLM_DEFAULTS, ARCH_AI_TIMEOUTS } from './constants';
import { buildTemperatureOption } from './model-options';
import { buildAgentSystemPrompt, type AgentGenerationContext } from './handbook-reference';
import { getModelRecommendation } from './helpers/get-model-recommendation';
import { classifyDataSensitivity } from './helpers/classify-data-sensitivity';
import { recordCompileFixLearning } from './learning-memory-bridge';
import {
  renderManagedBehaviorProfileDocumentsForTopology,
  renderSourceBehaviorProfileDocuments,
  renderSourceBehaviorProfileFiles,
} from './managed-behavior-profiles';
import { buildScaffoldWorkerDomainInput } from './scaffold/domain-input';
import { getBlueprintContextSummary } from '@/lib/arch-ai/blueprint-flow';
import {
  extractBuildTopology,
  inferAgentRequirementHints,
  resolveEdgeReturnExpectation,
  shouldUseDeterministicScaffold,
  type BuildTopologyAgent as TopologyAgent,
  type BuildTopologyEdge as TopologyEdge,
  type BuildTopologyContext,
} from './build-requirement-inference';

const log = createLogger('arch-ai:build-parallel-gen');
const WORKER_HEARTBEAT_INTERVAL_MS = 30_000;
const INCOMPLETE_COMPILE_WARNING = 'Compilation step may not have completed';
const FILE_PREVIEW_CHUNK_SIZE = 160;

// ---------------------------------------------------------------------------
// Concurrency pool
// ---------------------------------------------------------------------------

/**
 * Run async tasks with bounded concurrency.
 * Starts `concurrency` workers; as each completes, the next item is picked up.
 */
async function runWithPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      try {
        const value = await fn(items[i]);
        results[i] = { status: 'fulfilled', value };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Diagnostic summary returned from compile_abl tool output */
interface CompileResultDiagnostics {
  overallSeverity: string;
  errors: number;
  warnings: number;
  infos: number;
  total: number;
  errorCodes: string[];
  warningCodes: string[];
  topFindings: Array<{
    code: string;
    message: string;
    severity: string;
    category: string;
    fix?: { description: string; effort: string };
  }>;
  architecturePattern?: string;
  antiPatterns?: Array<{
    name: string;
    description: string;
    agents: string[];
    severity: string;
  }>;
}

interface CompilePhaseDurations {
  parse?: number;
  compile?: number;
  diagnostics?: number;
  total: number;
}

interface WorkerRetryFeedback {
  errors: string[];
  warnings: string[];
  hint?: string;
  diagnosticCodes?: string[];
  retryable?: boolean;
  retryReason?: string;
}

/** Internal per-worker raw result before reconciliation */
interface WorkerRawResult {
  agentName: string;
  status: 'compiled' | 'warning' | 'error';
  warnings: string[];
  errors: string[];
  elapsed: number;
  toolCount?: number;
  handoffCount?: number;
  fixRounds?: number;
  retryFeedback?: WorkerRetryFeedback;
}

export interface ParallelGenerationOptions {
  buildRunId?: string;
  trigger?: string;
}

function createBuildTraceId(sessionId: string, buildRunId: string | undefined): string {
  return `arch-build:${sessionId}:${buildRunId ?? 'no-run-id'}`;
}

/**
 * Shared context precomputed ONCE before dispatching parallel workers.
 * Avoids each of the 5 concurrent workers independently rebuilding
 * topology, domain extraction, data sensitivity classification,
 * and model recommendation (~1-2s duplicated per agent).
 */
interface SharedBuildContext {
  topology: { agents: TopologyAgent[]; edges: TopologyEdge[] };
  domainContext: ReturnType<typeof extractDomainFromSession>;
  /** Per-agent sensitivity results keyed by agent name */
  sensitivityByAgent: Map<string, { categories: string[]; evidence: string[] }>;
  /** Per-agent model recommendations keyed by agent name */
  modelRecByAgent: Map<
    string,
    { provider: string; model: string; temperature: number; maxTokens: number }
  >;
  /** Entry point agent name from topology metadata */
  entryPointName: string | undefined;
  /** Enriched edges with defaults applied */
  enrichedEdges: Array<{
    from: string;
    to: string;
    type: string;
    experienceMode?: TopologyEdge['experienceMode'];
    condition: string;
    expectReturn: boolean;
  }>;
  /** Pre-computed architecture plans keyed by agent name */
  architecturePlans: Map<string, AgentArchitecturePlan>;
  sourceBehaviorProfileDocuments: string[];
  sourceBehaviorProfileFiles: Record<string, { content: string }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractTopology(session: ArchSession): BuildTopologyContext {
  return extractBuildTopology(session);
}

function countLines(value: string): number {
  return value.length === 0 ? 0 : value.split('\n').length;
}

function emitAgentFilePreview(
  emit: (event: ArchSSEEvent) => void,
  agentName: string,
  content: string,
): void {
  for (let i = 0; i < content.length; i += FILE_PREVIEW_CHUNK_SIZE) {
    emit({
      type: 'file_content_delta',
      agentName,
      delta: content.slice(i, i + FILE_PREVIEW_CHUNK_SIZE),
    });
  }
}

/** Coerce session topology edge type (string) to the planner's strict union */
const VALID_EDGE_TYPES: ReadonlyArray<string> = ['delegate', 'escalate', 'transfer'];
function coerceEdgeType(raw: string | undefined): 'delegate' | 'escalate' | 'transfer' {
  if (raw && VALID_EDGE_TYPES.includes(raw)) return raw as 'delegate' | 'escalate' | 'transfer';
  return 'delegate';
}

/**
 * Count HANDOFF TO: entries in generated ABL content. Catches the fix-loop
 * regression where the LLM deletes required HANDOFF rules to "resolve"
 * self-reference errors (diagnostic 3dd30d8e).
 */
export function countHandoffTargets(ablContent: string): number {
  const matches = ablContent.match(/^\s*-\s*TO:\s*\S+/gm);
  return matches?.length ?? 0;
}

/**
 * Check whether the generated ABL has at least the HANDOFF rules the plan
 * requires. Returns null when the agent is not subject to the check or
 * when the plan is not available.
 */
export function detectHandoffRegression(
  ablContent: string,
  plan: AgentArchitecturePlan | undefined,
): { reason: string; expected: number; actual: number } | null {
  if (!plan) return null;
  if (plan.handoffs.targets.length === 0) return null;

  const expected = plan.handoffs.targets.length + (plan.handoffs.needsCatchAll ? 1 : 0);
  const actual = countHandoffTargets(ablContent);

  if (actual >= expected) return null;

  return {
    reason: `Expected at least ${expected} HANDOFF rule${expected === 1 ? '' : 's'} (topology: ${plan.handoffs.targets.length} targets${plan.handoffs.needsCatchAll ? ' + catch-all' : ''}); found ${actual}.`,
    expected,
    actual,
  };
}

function dedupeMessages(messages: string[]): string[] {
  return [
    ...new Set(messages.map((message) => message.trim()).filter((message) => message.length > 0)),
  ];
}

function buildGenerationErrorResult(
  agentName: string,
  errors: string[],
  elapsed = 0,
): AgentGenResult {
  return {
    agentName,
    status: 'error',
    warnings: [],
    errors,
    elapsed,
    mode: 'unknown',
    agentType: 'unknown',
    toolCount: 0,
    handoffCount: 0,
    quality: {
      guardrails: false,
      memory: false,
      errorHandlers: false,
      constraints: false,
      catchAllHandoff: false,
    },
  };
}

function formatCompileFixErrors(
  errors: Array<{ line?: number; message: string; severity: string }> | undefined,
): string[] {
  return (errors ?? []).map((error) =>
    error.line ? `Line ${error.line}: ${error.message}` : error.message,
  );
}

function formatCompileFixWarnings(
  warnings: Array<{ line?: number; message: string }> | undefined,
): string[] {
  return (warnings ?? []).map((warning) =>
    warning.line ? `Line ${warning.line}: ${warning.message}` : warning.message,
  );
}

function formatDiagnosticFixMessages(
  diagnostics: CompileResultDiagnostics | undefined,
  severities: Array<'error' | 'warning' | 'info'>,
): string[] {
  return dedupeMessages(
    (diagnostics?.topFindings ?? [])
      .filter((finding) => severities.includes(finding.severity as 'error' | 'warning' | 'info'))
      .map(
        (finding) =>
          `[${finding.code}] ${finding.message}${
            finding.fix ? ` Fix: ${finding.fix.description}` : ''
          }`,
      ),
  );
}

function summarizeBuildIssue(message: string | undefined, maxLength = 180): string {
  const normalized = (message ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return 'No compiler detail was returned';
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function collectCompileWarnings(
  result:
    | {
        warnings?: string[];
        qualityWarnings?: string[];
      }
    | null
    | undefined,
): string[] {
  return dedupeMessages([...(result?.warnings ?? []), ...(result?.qualityWarnings ?? [])]);
}

function isTerminalBuildStatus(
  status: BuildAgentStatus | undefined,
): status is 'compiled' | 'validated' | 'warning' | 'error' {
  return (
    status === 'compiled' || status === 'validated' || status === 'warning' || status === 'error'
  );
}

function buildWorkerRetryFeedback(input: {
  errors?: string[];
  warnings?: string[];
  hint?: string;
  diagnosticCodes?: string[];
  retryable?: boolean;
  retryReason?: string;
}): WorkerRetryFeedback | undefined {
  const errors = dedupeMessages(input.errors ?? []);
  const warnings = dedupeMessages(input.warnings ?? []);
  const hint = input.hint?.trim();
  const retryPolicy = classifyBuildRetryPolicy({
    diagnosticCodes: input.diagnosticCodes,
    messages: errors,
  });
  const explicitRetryable = typeof input.retryable === 'boolean';
  const retryable = input.retryable ?? retryPolicy.retryable;
  const retryReason =
    input.retryReason?.trim() ||
    (!explicitRetryable || retryable === false ? retryPolicy.reason : undefined);

  if (
    errors.length === 0 &&
    warnings.length === 0 &&
    !hint &&
    retryPolicy.diagnosticCodes.length === 0 &&
    !retryReason
  ) {
    return undefined;
  }

  return {
    errors,
    warnings,
    ...(hint ? { hint } : {}),
    ...(retryPolicy.diagnosticCodes.length > 0
      ? { diagnosticCodes: retryPolicy.diagnosticCodes }
      : {}),
    ...(retryable === false ? { retryable: false } : {}),
    ...(retryReason ? { retryReason } : {}),
  };
}

function hasRuntimeReadinessFeedback(messages: string[]): boolean {
  return messages.some((message) => message.includes('Runtime readiness:'));
}

function determineComplexity(agent: {
  tools?: string[];
  gatherFields?: string[];
  suggestedConstructs?: string[];
  flowStepSeeds?: string[];
}): 'simple' | 'moderate' | 'complex' {
  const toolCount = (agent.tools ?? []).length;
  const gatherCount = (agent.gatherFields ?? []).length;
  const constructCount = (agent.suggestedConstructs ?? []).length;
  const flowStepCount = (agent.flowStepSeeds ?? []).length;

  if (toolCount > 3 || constructCount > 5 || flowStepCount > 3) {
    return 'complex';
  }

  if (toolCount > 1 || gatherCount > 2 || constructCount > 3 || flowStepCount > 1) {
    return 'moderate';
  }

  return 'simple';
}

function summarizeWorkerToolInput(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {};

  if (typeof input.agentName === 'string') {
    summary.agentName = input.agentName;
  }

  const codeField =
    typeof input.code === 'string'
      ? input.code
      : typeof input.updatedCode === 'string'
        ? input.updatedCode
        : undefined;

  if (codeField) {
    summary.codeChars = codeField.length;
    summary.codeLines = countLines(codeField);
  }

  if (toolName === 'generate_agent' && typeof input.code === 'string') {
    summary.generatedChars = input.code.length;
  }

  return summary;
}

function summarizeWorkerToolOutput(toolName: string, output: unknown): Record<string, unknown> {
  if (typeof output === 'string') {
    return {
      outputChars: output.length,
      outputLines: countLines(output),
    };
  }

  if (typeof output !== 'object' || output === null || Array.isArray(output)) {
    return {};
  }

  const data = output as Record<string, unknown>;
  const summary: Record<string, unknown> = { toolName };

  if (typeof data.status === 'string') {
    summary.resultStatus = data.status;
  }
  if (Array.isArray(data.errors)) {
    summary.errorCount = data.errors.length;
  }
  if (Array.isArray(data.warnings)) {
    summary.warningCount = data.warnings.length;
  }
  if (Array.isArray(data.qualityWarnings)) {
    summary.qualityWarningCount = data.qualityWarnings.length;
  }
  if (typeof data.failureCode === 'string') {
    summary.failureCode = data.failureCode;
  }
  if (typeof data.timedOutPhase === 'string') {
    summary.timedOutPhase = data.timedOutPhase;
  }
  if (typeof data.hint === 'string') {
    summary.hasHint = true;
  }
  if (typeof data.phaseDurationsMs === 'object' && data.phaseDurationsMs !== null) {
    const durations = data.phaseDurationsMs as Record<string, unknown>;
    summary.compileTotalDurationMs =
      typeof durations.total === 'number' ? durations.total : undefined;
  }

  return summary;
}

/** Extract domain context from session.metadata.specification */
function extractDomainFromSession(session: ArchSession): AgentGenerationContext['domain'] {
  const spec = session.metadata.specification as
    | {
        projectName?: string;
        description?: string | null;
        channels?: string[];
        language?: string;
        conversationNotes?: Array<{
          label: string;
          category: string;
          detail?: string;
        }>;
      }
    | undefined;

  const notes = spec?.conversationNotes ?? [];
  const complianceNotes = notes.filter((n) => n.category === 'compliance').map((n) => n.label);
  const integrationNotes = notes.filter((n) => n.category === 'integration').map((n) => n.label);
  const generalNotes = notes.filter((n) => n.category === 'general');
  const sourceContract = getSourceArchitectureContractFromMetadata(
    session.metadata as unknown as Record<string, unknown>,
  );

  const domain = spec?.description
    ? `${spec.projectName ?? 'Project'}: ${spec.description}`
    : (spec?.projectName ?? 'General');

  const toneNote = generalNotes.find((n) => /tone|style|voice/i.test(n.label));
  const tone = toneNote?.detail ?? toneNote?.label ?? 'professional';

  return {
    domain,
    channels: spec?.channels ?? [],
    language: spec?.language,
    compliance: complianceNotes,
    integrations: integrationNotes,
    tone,
    blueprintSummary: getBlueprintContextSummary(session) ?? undefined,
    universalRules: sourceContract?.universalRules ?? [],
    channelRules: sourceContract?.channelRules?.map((rule) => ({
      channel: rule.channel,
      ...(rule.responseMaxWords !== undefined ? { responseMaxWords: rule.responseMaxWords } : {}),
      ...(rule.abbreviationPolicy ? { abbreviationPolicy: rule.abbreviationPolicy } : {}),
      ...(rule.toolLatencyBridge !== undefined
        ? { toolLatencyBridge: rule.toolLatencyBridge }
        : {}),
      rules: [...rule.rules],
    })),
    sourceToolFixtures: sourceContract?.scenarioFixtures?.flatMap((fixture) =>
      fixture.toolFixtures.map((toolFixture) => ({
        toolName: toolFixture.toolName,
        sampleInput: toolFixture.sampleInput,
        response: toolFixture.response,
      })),
    ),
    sharedMemoryVariables: sourceContract?.sharedMemoryVariables ?? [],
    sourceTools: sourceContract?.tools.map((tool) => ({
      name: tool.name,
      ...(tool.signature ? { signature: tool.signature } : {}),
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.callWhen?.length ? { callWhen: [...tool.callWhen] } : {}),
      ...(tool.doNotCallWhen?.length ? { doNotCallWhen: [...tool.doNotCallWhen] } : {}),
    })),
    consentPolicies: sourceContract?.consentPolicies?.map((policy) => ({
      ...(policy.toolName ? { toolName: policy.toolName } : {}),
      action: policy.action,
      mode: policy.mode,
      requiredIn: policy.requiredIn,
      scopeFields: [...policy.scopeFields],
      fallback: policy.fallback,
    })),
  };
}

function buildScaffoldGatherFieldSources(
  agent: TopologyAgent,
  domain: AgentGenerationContext['domain'],
): Record<string, 'user' | 'context' | 'tool' | 'memory'> | undefined {
  const sharedMemoryVariables = new Set(domain.sharedMemoryVariables ?? []);
  const sources: Record<string, 'user' | 'context' | 'tool' | 'memory'> = {};

  for (const field of agent.gatherFields ?? []) {
    if (sharedMemoryVariables.has(field)) {
      sources[field] = 'memory';
    }
  }

  return Object.keys(sources).length > 0 ? sources : undefined;
}

// ---------------------------------------------------------------------------
// Per-agent worker
// ---------------------------------------------------------------------------

async function runAgentWorker(
  agentName: string,
  ctx: BuildActionContext,
  session: ArchSession,
  emit: (event: ArchSSEEvent) => void,
  model: LanguageModel,
  attempt: number,
  shared: SharedBuildContext,
  buildTraceId: string,
  retryFeedback?: WorkerRetryFeedback,
  buildRunId?: string,
  parentSignal?: AbortSignal,
): Promise<WorkerRawResult> {
  const start = Date.now();
  const workerLog = log.child({
    buildTraceId,
    sessionId: session.id,
    agentName,
    attempt,
    buildRunId,
  });
  const { agents: topologyAgents } = shared.topology;
  const agentSpec = topologyAgents.find((a) => a.name === agentName);

  if (!agentSpec) {
    workerLog.error('Parallel build worker agent missing from topology');
    return {
      agentName,
      status: 'error',
      warnings: [],
      errors: [`Agent "${agentName}" not found in topology.`],
      elapsed: Date.now() - start,
      retryFeedback: buildWorkerRetryFeedback({
        errors: [`Agent "${agentName}" not found in topology.`],
      }),
    };
  }

  const scaffoldPlan = shared.architecturePlans.get(agentName);
  const effectiveExecutionMode =
    scaffoldPlan?.complexity.selectedExecutionMode ?? agentSpec.executionMode ?? 'reasoning';

  emit({
    type: 'build_agent_start',
    agent: agentName,
    mode: effectiveExecutionMode,
    role: agentSpec.role ?? 'agent',
  });

  workerLog.info('Parallel build worker started', {
    buildStep: 'worker_started',
    mode: effectiveExecutionMode,
    role: agentSpec.role ?? 'agent',
    toolCount: agentSpec.tools?.length ?? 0,
    timeoutMs: ARCH_AI_BUILD.AGENT_TIMEOUT_MS,
  });

  // Per-worker abort: whichever fires first — timeout or parent signal
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), ARCH_AI_BUILD.AGENT_TIMEOUT_MS);

  const signals: AbortSignal[] = [timeoutController.signal];
  if (parentSignal) {
    signals.push(parentSignal);
  }
  const combinedSignal = AbortSignal.any(signals);

  // --- Scaffold+fill path (FEATURE_SCAFFOLD_GENERATION) ---
  // Use the deterministic scaffold pipeline only for agents whose current
  // construct surface it can faithfully express. Tool-backed and FLOW-heavy
  // agents stay on the legacy generator so onboarding does not regress into
  // generic gather fields or placeholder step logic.
  const scaffoldDecision =
    process.env.FEATURE_SCAFFOLD_GENERATION === 'false'
      ? { allowed: false, reason: 'feature_flag_disabled' }
      : shouldUseDeterministicScaffold({
          plan: scaffoldPlan,
          agent: agentSpec,
        });

  workerLog.info('Parallel build worker generation strategy selected', {
    buildStep: 'worker_strategy_selected',
    effectiveExecutionMode,
    topologyExecutionMode: agentSpec.executionMode ?? 'reasoning',
    plannerComplexityLevel: scaffoldPlan?.complexity.level,
    plannerComplexitySignals: scaffoldPlan?.complexity.signals,
    plannerSelectedExecutionMode: scaffoldPlan?.complexity.selectedExecutionMode,
    scaffoldAllowed: scaffoldDecision.allowed,
    scaffoldReason: scaffoldDecision.reason,
    gatherFieldCount: agentSpec.gatherFields?.length ?? 0,
    flowStepCount: agentSpec.flowStepSeeds?.length ?? 0,
    toolCount: agentSpec.tools?.length ?? 0,
  });

  if (!scaffoldDecision.allowed && scaffoldPlan) {
    workerLog.info('Scaffold path skipped for legacy generation', {
      buildStep: 'scaffold_skipped',
      reason: scaffoldDecision.reason,
      executionMode: effectiveExecutionMode,
      toolCount: agentSpec.tools?.length ?? 0,
      flowStepCount: agentSpec.flowStepSeeds?.length ?? 0,
    });
  }

  if (scaffoldDecision.allowed && scaffoldPlan) {
    const scaffoldStart = Date.now();
    const gatherFieldSources = buildScaffoldGatherFieldSources(agentSpec, shared.domainContext);
    workerLog.info('Scaffold path entering', {
      buildStep: 'scaffold_entering',
      archetype: scaffoldPlan.archetype,
      keyword: scaffoldPlan.keyword,
      outgoingHandoffs: scaffoldPlan.handoffs.targets.length,
      needsCatchAll: scaffoldPlan.handoffs.needsCatchAll,
      gatherRequired: scaffoldPlan.gather.required,
      completeRequired: scaffoldPlan.complete.required,
      gatherFieldCount: (scaffoldPlan.gather.suggestedFields ?? []).length,
    });
    try {
      // Keep the per-worker timeout armed and pass its signal into the
      // scaffold model calls. If Sonnet/structured output stalls, the worker
      // emits a terminal error instead of leaving the BUILD tile compiling.
      const { runScaffoldWorker } = await import('./scaffold/worker-runner');
      const scaffoldResult = await runScaffoldWorker({
        plan: scaffoldPlan,
        topology: {
          agents: shared.topology.agents.map((a) => ({
            name: a.name,
            role: a.role ?? 'agent',
            executionMode: (a.executionMode ?? 'reasoning') as 'reasoning' | 'scripted' | 'hybrid',
            description: a.description ?? '',
          })),
          edges: shared.enrichedEdges.map((e) => ({
            from: e.from,
            to: e.to,
            type: coerceEdgeType(e.type),
            ...(e.experienceMode ? { experienceMode: e.experienceMode } : {}),
            condition: e.condition ?? '',
            expectReturn: e.expectReturn,
          })),
          entryPoint: shared.entryPointName ?? agentSpec.name,
        },
        spec: {
          name: agentSpec.name,
          role: agentSpec.role ?? 'agent',
          executionMode: effectiveExecutionMode,
          ...(typeof agentSpec.description === 'string'
            ? { description: agentSpec.description }
            : {}),
          ...(agentSpec.tools ? { tools: agentSpec.tools } : {}),
          ...(agentSpec.gatherFields ? { gatherFields: agentSpec.gatherFields } : {}),
          ...(gatherFieldSources ? { gatherFieldSources } : {}),
          isEntry: shared.entryPointName === agentSpec.name,
        },
        domain: buildScaffoldWorkerDomainInput(shared.domainContext),
        entryAgentName: shared.entryPointName,
        model,
        maxRetriesPerSlot: 3,
        abortSignal: combinedSignal,
        onProgress: (event) => {
          if (combinedSignal.aborted) {
            return;
          }
          // Mirror each progress event to BOTH structured logs AND an SSE
          // build_agent_stage event so the BUILD tile shows live state.
          switch (event.kind) {
            case 'scaffolding':
              workerLog.info('Scaffold: skeleton generated', {
                archetype: event.archetype,
                slotCount: event.slotCount,
                handoffCount: event.handoffCount,
              });
              emit({
                type: 'build_agent_stage',
                agent: agentName,
                stage: 'scaffolding',
                detail: `Generated ${event.archetype} skeleton with ${event.handoffCount} handoff${event.handoffCount === 1 ? '' : 's'} and ${event.slotCount} creative slot${event.slotCount === 1 ? '' : 's'}`,
              });
              break;
            case 'filling':
              workerLog.info('Scaffold: filling creative slots', { slotCount: event.slotCount });
              emit({
                type: 'build_agent_stage',
                agent: agentName,
                stage: 'filling',
                detail: `Filling ${event.slotCount} creative slot${event.slotCount === 1 ? '' : 's'} (GOAL, PERSONA, WHEN conditions, …)`,
              });
              break;
            case 'validating':
              workerLog.info('Scaffold: validated slots', { failingSlots: event.failingSlots });
              emit({
                type: 'build_agent_stage',
                agent: agentName,
                stage: 'validating',
                detail:
                  event.failingSlots > 0
                    ? `Validating slots — ${event.failingSlots} need refinement`
                    : 'All slots validated',
              });
              break;
            case 'retrying_slot':
              workerLog.warn('Scaffold: retrying slot', {
                slot: event.slot,
                attempt: event.attempt,
                maxAttempts: event.maxAttempts,
                validatorError: event.error,
              });
              emit({
                type: 'build_agent_stage',
                agent: agentName,
                stage: 'retrying_slot',
                detail: `Refining "${event.slot}" (attempt ${event.attempt}/${event.maxAttempts}): ${event.error}`,
              });
              break;
            case 'slot_passed':
              workerLog.info('Scaffold: slot passed', {
                slot: event.slot,
                attempts: event.attempts,
              });
              break;
            case 'slot_fallback':
              workerLog.warn('Scaffold: slot fell back to default', {
                slot: event.slot,
                reason: event.reason,
              });
              emit({
                type: 'build_agent_stage',
                agent: agentName,
                stage: 'retrying_slot',
                detail: `Slot "${event.slot}" used fallback default — retries exhausted`,
              });
              break;
            case 'construct_validating':
              workerLog.info('Scaffold: construct plan validated', {
                issueCount: event.issueCount,
              });
              emit({
                type: 'build_agent_stage',
                agent: agentName,
                stage: 'validating',
                detail:
                  event.issueCount > 0
                    ? `Checking runtime construct plan — ${event.issueCount} issue${event.issueCount === 1 ? '' : 's'}`
                    : 'Runtime construct plan is clean',
              });
              break;
            case 'assembling':
              workerLog.info('Scaffold: assembling YAML', { yamlLines: event.yamlLines });
              emit({
                type: 'build_agent_stage',
                agent: agentName,
                stage: 'assembling',
                detail: `Assembling ABL YAML (${event.yamlLines} lines)`,
              });
              break;
            case 'done':
              workerLog.info('Scaffold: done', {
                fallbackSlotCount: event.fallbackSlotCount,
                elapsedMs: event.elapsedMs,
              });
              emit({
                type: 'build_agent_stage',
                agent: agentName,
                stage: 'done',
                detail:
                  event.fallbackSlotCount > 0
                    ? `Completed with ${event.fallbackSlotCount} fallback slot${event.fallbackSlotCount === 1 ? '' : 's'} (${event.elapsedMs}ms)`
                    : `Completed (${event.elapsedMs}ms)`,
              });
              break;
            case 'llm_tick': {
              const seconds = Math.round(event.elapsedMs / 1000);
              // Keep-alive: emits an SSE event every 10s while the LLM is in
              // flight so the browser's stall timer resets and the user sees
              // a live counter instead of a silent "Generating…".
              const where = event.slot ? `refining ${event.slot}` : 'filling creative slots';
              emit({
                type: 'build_agent_stage',
                agent: agentName,
                stage: 'filling',
                detail: `Model thinking — ${where} (${seconds}s)`,
              });
              break;
            }
          }
        },
      });

      if (scaffoldResult.compileStatus === 'error') {
        throw new Error(
          scaffoldResult.compileErrors[0] ??
            'Scaffold sanity check failed without a specific error message.',
        );
      }

      const scaffoldWarnings = dedupeMessages([
        ...scaffoldResult.fallbackSlots.map((s) => `Fallback default used for slot: ${s}`),
        ...scaffoldResult.compileWarnings,
      ]);
      const scaffoldStatus =
        scaffoldWarnings.length > 0 || scaffoldResult.compileStatus === 'warning'
          ? ('warning' as const)
          : ('compiled' as const);

      // Persist the assembled YAML
      const mongoose = (await import('mongoose')).default;
      const db = mongoose.connection.db;
      if (db) {
        await db
          .collection('arch_sessions')
          .updateOne(
            { _id: session.id, tenantId: ctx.tenantId, userId: ctx.userId } as Record<
              string,
              unknown
            >,
            {
              $set: {
                [`metadata.files.${agentName}.content`]: scaffoldResult.yaml,
                [`metadata.buildProgress.agentStatuses.${agentName}`]: scaffoldStatus,
              },
            },
          );
      }

      // Emit file-content for the UI tile (chunk to existing SSE event shape)
      emitAgentFilePreview(emit, agentName, scaffoldResult.yaml);
      emit({
        type: 'build_agent_validated',
        agent: agentName,
        toolCount: agentSpec.tools?.length ?? 0,
        handoffCount:
          scaffoldPlan.handoffs.targets.length + (scaffoldPlan.handoffs.needsCatchAll ? 1 : 0),
        warnings: scaffoldWarnings,
      });

      workerLog.info('Scaffold worker succeeded', {
        fallbackSlotCount: scaffoldResult.fallbackSlots.length,
        fallbackSlots: scaffoldResult.fallbackSlots,
        compileStatus: scaffoldResult.compileStatus,
        compileWarningCount: scaffoldResult.compileWarnings.length,
        handoffCount: scaffoldPlan.handoffs.targets.length,
        elapsedMs: Date.now() - start,
      });

      return {
        agentName,
        status: scaffoldStatus,
        warnings: scaffoldWarnings,
        errors: [],
        elapsed: Date.now() - start,
        toolCount: agentSpec.tools?.length ?? 0,
        handoffCount:
          scaffoldPlan.handoffs.targets.length + (scaffoldPlan.handoffs.needsCatchAll ? 1 : 0),
      };
    } catch (scaffoldErr) {
      const scaffoldAborted = combinedSignal.aborted || timeoutController.signal.aborted;
      if (scaffoldAborted) {
        const parentAborted = parentSignal?.aborted ?? false;
        const errMsg = timeoutController.signal.aborted
          ? `Scaffold generation timed out after ${ARCH_AI_BUILD.AGENT_TIMEOUT_MS}ms.`
          : 'Scaffold generation was aborted before completion.';
        workerLog.warn('Scaffold worker aborted before completion', {
          buildStep: 'scaffold_aborted',
          error: scaffoldErr instanceof Error ? scaffoldErr.message : String(scaffoldErr),
          timedOut: timeoutController.signal.aborted,
          parentAborted,
          elapsedMs: Date.now() - scaffoldStart,
        });
        emit({
          type: 'build_agent_error',
          agent: agentName,
          error: errMsg,
          stage: 'generation',
        });
        clearTimeout(timeoutId);
        return {
          agentName,
          status: 'error' as const,
          warnings: [],
          errors: [errMsg],
          elapsed: Date.now() - start,
          retryFeedback: buildWorkerRetryFeedback({
            errors: [errMsg],
            retryable: false,
            retryReason: timeoutController.signal.aborted
              ? 'Scaffold generation timed out; stop blind regeneration and surface the stalled model call.'
              : 'Scaffold generation was aborted by the request.',
          }),
        };
      }

      // On any unexpected scaffold-path error, log with full context and
      // fall through to the legacy streamText path so the build still has
      // a chance to succeed. Also emit an SSE event so the UI shows the
      // fallback explicitly instead of looking stuck.
      const errMsg = scaffoldErr instanceof Error ? scaffoldErr.message : String(scaffoldErr);
      const errStack = scaffoldErr instanceof Error ? scaffoldErr.stack?.slice(0, 500) : undefined;
      workerLog.warn('Scaffold worker failed — falling back to legacy streamText path', {
        error: errMsg,
        errorStack: errStack,
        archetype: scaffoldPlan.archetype,
        keyword: scaffoldPlan.keyword,
        outgoingHandoffs: scaffoldPlan.handoffs.targets.length,
        elapsedMs: Date.now() - scaffoldStart,
        // Common error classes so we can search+count without regex on the message
        errorClass: /type: "?None"?/.test(errMsg)
          ? 'SCHEMA_TYPE_NONE'
          : errMsg.includes('timeout') || errMsg.includes('abort')
            ? 'TIMEOUT_OR_ABORT'
            : errMsg.includes('rate_limit') || errMsg.includes('429')
              ? 'RATE_LIMIT'
              : 'UNKNOWN',
      });
      emit({
        type: 'build_agent_stage',
        agent: agentName,
        stage: 'fixing',
        detail: `Scaffold path failed, retrying with legacy generator: ${errMsg.slice(0, 120)}`,
      });
    }
  }

  // --- Build ABL pipeline context from topology ---
  const outgoingEdges = shared.enrichedEdges.filter((e) => e.from === agentName);
  const incomingEdges = shared.enrichedEdges.filter((e) => e.to === agentName);

  const executionMode = effectiveExecutionMode;
  const isEntryAgent = shared.entryPointName === agentSpec.name;
  const pipelineType: ABLAgentContext['type'] = isEntryAgent
    ? 'supervisor'
    : executionMode === 'scripted'
      ? 'scripted'
      : executionMode === 'hybrid'
        ? 'hybrid'
        : 'specialist';

  const agentPipelineContext: ABLAgentContext = {
    name: agentName,
    type: pipelineType,
    role: agentSpec.role ?? 'agent',
    domain: shared.domainContext.domain,
    tools: agentSpec.tools?.map((t) => ({ name: t, description: t })),
    handoffTargets: outgoingEdges.map((e) => ({
      name: e.to,
      returnExpected: e.expectReturn,
    })),
    handoffSources: incomingEdges.map((e) => e.from),
  };

  const workerTools = createBuildWorkerTools({
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    sessionId: session.id,
    buildRunId,
    workerAttempt: attempt,
    agentPipelineContext,
    managedBehaviorProfileDocuments: renderManagedBehaviorProfileDocumentsForTopology(
      shared.topology,
      shared.domainContext,
    ).concat(shared.sourceBehaviorProfileDocuments),
    entryAgentName: shared.entryPointName,
  });

  // --- Pipeline Stage 1: Build rich context (from precomputed shared context) ---
  let currentStage = 'building_context';
  let lastActivityAt = start;
  const streamStats = {
    textDeltaCount: 0,
    toolCallCount: 0,
    toolResultCount: 0,
    errorPartCount: 0,
    generateAgentCallCount: 0,
  };
  let heartbeatId: ReturnType<typeof setInterval> | undefined;
  workerLog.info('Parallel build worker pipeline starting (using precomputed shared context)', {
    buildStep: 'legacy_pipeline_starting',
  });

  // Read precomputed context — no per-worker recomputation
  const domainContext = shared.domainContext;
  const isEntry = shared.entryPointName === agentSpec.name;

  // Local topology: only this agent's direct edges + neighbor specs.
  // Each worker doesn't need the full topology — just its local view.
  const directEdges = shared.enrichedEdges.filter(
    (e) => e.from === agentName || e.to === agentName,
  );
  const neighborNames = new Set<string>();
  for (const e of directEdges) {
    if (e.from !== agentName) neighborNames.add(e.from);
    if (e.to !== agentName) neighborNames.add(e.to);
  }
  const localAgents = topologyAgents.filter(
    (a) => a.name === agentName || neighborNames.has(a.name),
  );

  // Read precomputed per-agent results
  const sensitivityData = shared.sensitivityByAgent.get(agentName) ?? {
    categories: [],
    evidence: [],
  };
  const modelRecData = shared.modelRecByAgent.get(agentName);

  const genContext: AgentGenerationContext = {
    agentSpec: {
      name: agentSpec.name,
      role: agentSpec.role ?? 'agent',
      executionMode: effectiveExecutionMode,
      description: agentSpec.description,
      tools: agentSpec.tools,
      gatherFields: agentSpec.gatherFields,
      flowStepSeeds: agentSpec.flowStepSeeds,
      gatherFieldSource: agentSpec.gatherFieldSource,
      flowStepSource: agentSpec.flowStepSource,
      suggestedConstructs: agentSpec.suggestedConstructs,
      isEntry,
    },
    topology: {
      agents: topologyAgents.map((a) => ({
        name: a.name,
        role: a.role ?? 'agent',
        executionMode: a.executionMode ?? 'reasoning',
        description: a.description,
        tools: a.tools,
      })),
      edges: directEdges,
    },
    domain: domainContext,
    sensitivity: sensitivityData,
    modelRec: modelRecData,
    ...(retryFeedback ? { retryFeedback: { attempt, ...retryFeedback } } : {}),
    plan: shared.architecturePlans.get(agentName),
  };

  workerLog.info('Parallel build worker context prepared (precomputed)', {
    buildStep: 'worker_context_prepared',
    localAgentCount: localAgents.length,
    directEdgeCount: directEdges.length,
    neighborCount: neighborNames.size,
    isEntry,
    gatherFieldCount: agentSpec.gatherFields?.length ?? 0,
    flowStepCount: agentSpec.flowStepSeeds?.length ?? 0,
    sensitivityCategoryCount: sensitivityData.categories.length,
    recommendedProvider: modelRecData?.provider ?? 'none',
    recommendedModel: modelRecData?.model ?? 'none',
  });

  let systemPrompt: string;
  try {
    systemPrompt = buildAgentSystemPrompt(genContext);
  } catch (promptErr) {
    workerLog.error('Parallel build worker failed while building prompt', {
      error: promptErr instanceof Error ? promptErr.message : String(promptErr),
      stack: promptErr instanceof Error ? promptErr.stack?.slice(0, 500) : undefined,
    });
    return {
      agentName,
      status: 'error' as const,
      warnings: [],
      errors: [
        `Prompt build failed: ${promptErr instanceof Error ? promptErr.message : String(promptErr)}`,
      ],
      elapsed: Date.now() - start,
      retryFeedback: buildWorkerRetryFeedback({
        errors: [
          `Prompt build failed: ${promptErr instanceof Error ? promptErr.message : String(promptErr)}`,
        ],
      }),
    };
  }

  // Construct reference removed — ABL_CONSTRUCT_EXPERT_SYNTAX already provides
  // syntax examples and rules. The duplicate construct catalog added ~1.8K tokens
  // and caused workers to exceed the 60s timeout.

  // Fix 1 (cont): On retry, append stronger instruction to prevent
  // LLM from describing the agent instead of calling generate_agent.
  const retryReinforcement =
    attempt > 1
      ? retryFeedback
        ? '\n\nCRITICAL: This is a retry. Fix the build validation feedback from the previous attempt before you call generate_agent again. If the feedback is runtime-readiness or contract-related, repair the behavior and routing contract, not just syntax. Then call compile_abl immediately.'
        : '\n\nCRITICAL: You MUST call the generate_agent tool with the complete ABL YAML code. Do not just describe the agent — generate it by calling the tool. After generating, call compile_abl to validate.'
      : '';

  const fullPrompt = systemPrompt + retryReinforcement;
  currentStage = 'starting_llm';
  workerLog.info('Parallel build worker starting LLM generation', {
    buildStep: 'llm_generation_starting',
    promptChars: fullPrompt.length,
    promptTokensEstimate: Math.round(fullPrompt.length / 4),
    maxSteps: ARCH_AI_BUILD.AGENT_MAX_STEPS,
    timeoutMs: ARCH_AI_BUILD.AGENT_TIMEOUT_MS,
  });

  let lastCompileResult:
    | {
        status: string;
        errors?: string[];
        warnings?: string[];
        qualityWarnings?: string[];
        hint?: string;
        failureCode?: string;
        timedOutPhase?: string;
        phaseDurationsMs?: CompilePhaseDurations;
      }
    | undefined;
  let lastDiagnostics: CompileResultDiagnostics | undefined;
  let nextRetryFeedback: WorkerRetryFeedback | undefined;
  let previewStreamed = false;
  let fixRounds: number | undefined;

  try {
    emit({ type: 'build_agent_stage', agent: agentName, stage: 'compiling' });
    currentStage = 'streaming';
    heartbeatId = setInterval(() => {
      workerLog.info('Parallel build worker heartbeat', {
        buildStep: 'worker_heartbeat',
        stage: currentStage,
        elapsedMs: Date.now() - start,
        idleMs: Date.now() - lastActivityAt,
        ...streamStats,
      });
    }, WORKER_HEARTBEAT_INTERVAL_MS);

    // --- LLM generation with enriched prompt ---
    const result = streamText({
      model,
      system: fullPrompt,
      messages: [
        {
          role: 'user',
          content: `Generate the ABL YAML for agent "${agentName}". Call generate_agent with the full code, then compile_abl to validate.`,
        },
      ],
      tools: workerTools,
      stopWhen: stepCountIs(ARCH_AI_BUILD.AGENT_MAX_STEPS),
      maxRetries: ARCH_AI_LLM_DEFAULTS.MAX_RETRIES,
      timeout: {
        totalMs: ARCH_AI_BUILD.AGENT_TIMEOUT_MS,
        stepMs: ARCH_AI_BUILD.AGENT_TIMEOUT_MS,
        chunkMs: ARCH_AI_TIMEOUTS.LLM_STREAM_CHUNK_MS,
      },
      maxOutputTokens: ARCH_AI_BUILD.MAX_OUTPUT_TOKENS,
      ...buildTemperatureOption(modelRecData?.model, ARCH_AI_BUILD.TEMPERATURE),
      abortSignal: combinedSignal,
    });

    // Consume the full stream, capturing compile_abl tool results
    for await (const part of result.fullStream) {
      lastActivityAt = Date.now();
      switch (part.type) {
        case 'text-delta':
          streamStats.textDeltaCount += 1;
          break;
        case 'tool-call':
          streamStats.toolCallCount += 1;
          if (part.toolName === 'generate_agent') {
            streamStats.generateAgentCallCount += 1;
          }
          currentStage = part.toolName === 'compile_abl' ? 'compiling' : 'tool_execution';
          workerLog.info('Parallel build worker tool call', {
            toolName: part.toolName,
            toolCallId: part.toolCallId,
            ...summarizeWorkerToolInput(
              part.toolName,
              (part.input ?? {}) as Record<string, unknown>,
            ),
          });
          if (part.toolName === 'generate_agent' && !previewStreamed) {
            const previewInput = (part.input ?? {}) as Record<string, unknown>;
            const previewAgentName =
              typeof previewInput.agentName === 'string' ? previewInput.agentName : agentName;
            const previewCode =
              typeof previewInput.code === 'string' ? previewInput.code : undefined;

            if (previewCode && previewCode.length > 0) {
              previewStreamed = true;
              emitAgentFilePreview(emit, previewAgentName, previewCode);
            }
          }
          break;
        case 'tool-result':
          streamStats.toolResultCount += 1;
          currentStage = part.toolName === 'compile_abl' ? 'validation_result' : 'tool_result';
          workerLog.info('Parallel build worker tool result', {
            toolName: part.toolName,
            ...summarizeWorkerToolOutput(part.toolName, part.output),
          });
          if (part.toolName === 'compile_abl') {
            const output = part.output as {
              status: string;
              errors?: string[];
              warnings?: string[];
              qualityWarnings?: string[];
              hint?: string;
              diagnostics?: CompileResultDiagnostics;
            };
            lastCompileResult = output;
            // Capture diagnostics if the compile tool returned them
            if (output.diagnostics) {
              lastDiagnostics = output.diagnostics;
            }
          }
          break;
        case 'error':
          streamStats.errorPartCount += 1;
          workerLog.error('Parallel build worker stream emitted error part', {
            stage: currentStage,
            error: String(part.error),
          });
          throw part.error instanceof Error ? part.error : new Error(String(part.error));
        default:
          break;
      }
    }

    workerLog.info('Parallel build worker stream completed', {
      buildStep: 'llm_stream_completed',
      hadCompileResult: !!lastCompileResult,
      compileStatus: lastCompileResult?.status,
      errorCount: lastCompileResult?.errors?.length ?? 0,
      generateAgentCallCount: streamStats.generateAgentCallCount,
      elapsedMs: Date.now() - start,
    });

    // Fix 1: Detect when LLM never called generate_agent — 40% of failures.
    // The LLM sometimes describes the agent instead of calling the tool.
    if (streamStats.generateAgentCallCount === 0) {
      workerLog.warn('Parallel build worker LLM did not call generate_agent', {
        buildStep: 'llm_missing_generate_agent',
        toolCallCount: streamStats.toolCallCount,
        textDeltaCount: streamStats.textDeltaCount,
        elapsedMs: Date.now() - start,
      });
      emit({
        type: 'build_agent_error',
        agent: agentName,
        error: 'LLM did not generate agent code. Retrying with stronger instructions.',
        stage: 'generation',
      });

      // Clean up and signal retry by returning error status
      clearTimeout(timeoutId);
      if (heartbeatId) {
        clearInterval(heartbeatId);
      }
      return {
        agentName,
        status: 'error' as const,
        warnings: [],
        errors: ['LLM completed without calling generate_agent tool.'],
        elapsed: Date.now() - start,
        retryFeedback: buildWorkerRetryFeedback({
          errors: ['LLM completed without calling generate_agent tool.'],
          hint: 'Call generate_agent with the full ABL YAML, then call compile_abl.',
        }),
      };
    }

    const diagnosticErrorCodes = lastDiagnostics?.errorCodes ?? [];
    const hasBlockingDiagnosticErrors =
      (lastDiagnostics?.errors ?? 0) > 0 && diagnosticErrorCodes.some((code) => code !== 'T-04');
    const compileTimedOut = lastCompileResult?.failureCode === 'timeout';

    // Post-stream: if compilation passed on first attempt, emit validated immediately
    // so downstream status can move out of the compiling state before diagnostics.
    if (lastCompileResult?.status === 'pass' && !hasBlockingDiagnosticErrors) {
      emit({
        type: 'build_agent_stage',
        agent: agentName,
        stage: 'enriching',
        detail: 'Compiled successfully on first attempt',
      });
    }

    // Post-stream: if compilation failed or semantic diagnostics found blocking issues,
    // run the fix loop against the stored ABL artifact.
    if (
      (!compileTimedOut &&
        lastCompileResult?.status === 'fail' &&
        (lastCompileResult.errors?.length ?? 0) > 0) ||
      hasBlockingDiagnosticErrors
    ) {
      const isDiagnosticFix = hasBlockingDiagnosticErrors && lastCompileResult?.status === 'pass';
      const diagnosticRetryPolicy = isDiagnosticFix
        ? classifyBuildRetryPolicy({
            diagnosticCodes: lastDiagnostics?.errorCodes,
          })
        : classifyBuildRetryPolicy({});
      const fixMaxRounds = isDiagnosticFix
        ? diagnosticRetryPolicy.fixMaxRounds
        : DEFAULT_BUILD_FIX_MAX_ROUNDS;
      const initialFixWarnings = isDiagnosticFix
        ? formatDiagnosticFixMessages(lastDiagnostics, ['error', 'warning'])
        : [...(lastCompileResult?.warnings ?? []), ...(lastCompileResult?.qualityWarnings ?? [])];
      const initialFixErrors = isDiagnosticFix
        ? formatDiagnosticFixMessages(lastDiagnostics, ['error'])
        : [...(lastCompileResult?.errors ?? [])];
      const initialIssueCount = isDiagnosticFix
        ? (lastDiagnostics?.errors ?? 0)
        : (lastCompileResult?.errors?.length ?? 0);
      const primaryFixError = summarizeBuildIssue(initialFixErrors[0]);

      // Tell the UI we're refining quality — semantic diagnostics trigger silent improvement
      emit({
        type: 'build_agent_stage',
        agent: agentName,
        stage: 'fixing',
        detail: isDiagnosticFix
          ? `Refining quality (1/${fixMaxRounds}) — ${primaryFixError}`
          : `Fix attempt 1/${fixMaxRounds}: ${initialIssueCount} error${initialIssueCount === 1 ? '' : 's'} found — ${primaryFixError}`,
      });
      currentStage = 'compile_fix';
      workerLog.warn('Parallel build worker starting compile-fix loop', {
        buildStep: 'compile_fix_started',
        reason: isDiagnosticFix ? 'semantic_diagnostics' : 'compiler_errors',
        issueCount: initialIssueCount,
        initialFixErrors: initialFixErrors.slice(0, 5),
        initialFixWarnings: initialFixWarnings.slice(0, 5),
        primaryFixError,
        ...(isDiagnosticFix
          ? {
              diagnosticCodes: diagnosticRetryPolicy.diagnosticCodes,
              structuralCodes: diagnosticRetryPolicy.structuralCodes,
              retryableAfterFixFailure: diagnosticRetryPolicy.retryable,
              fixMaxRounds,
            }
          : {}),
      });

      // Log detailed findings for prompt improvement analysis (not shown to users)
      if (isDiagnosticFix && lastDiagnostics?.topFindings) {
        const errorFindings = lastDiagnostics.topFindings
          .filter((f) => f.severity === 'error')
          .slice(0, 10);
        if (errorFindings.length > 0) {
          workerLog.warn('Semantic validation findings (for prompt improvement)', {
            sessionId: session.id,
            agentName,
            errorCount: errorFindings.length,
            findings: errorFindings.map((f) => ({
              code: f.code,
              message: f.message,
              category: f.category,
            })),
          });
        }
      }

      try {
        const mongoose = (await import('mongoose')).default;
        const db = mongoose.connection.db;
        if (db) {
          const doc = await db.collection('arch_sessions').findOne({
            _id: session.id,
            tenantId: ctx.tenantId,
            userId: ctx.userId,
          } as Record<string, unknown>);
          const files = ((doc?.metadata as Record<string, unknown>)?.files ?? {}) as Record<
            string,
            { content?: string }
          >;
          const ablContent = files[agentName]?.content;

          if (ablContent) {
            const { compileAndFixWithModel } = await import('./helpers/compile-and-fix');
            const plan = shared.architecturePlans.get(agentName);
            const fixTopologyContext = plan
              ? {
                  agentName,
                  archetype: plan.archetype,
                  isEntry: plan.isEntry,
                  keyword: plan.keyword,
                  outgoingTargets: plan.handoffs.targets.map((t) => ({
                    name: t.to,
                    edgeType: t.edgeType,
                    expectReturn: t.returnExpected,
                    whenHint: t.condition ?? '',
                  })),
                  ...(plan.handoffs.catchAllTarget
                    ? { catchAllTarget: plan.handoffs.catchAllTarget }
                    : {}),
                }
              : undefined;

            const fixResult = await compileAndFixWithModel({
              agentName,
              ablContent,
              maxRounds: fixMaxRounds,
              constructContext: ABL_CONSTRUCT_EXPERT_SYNTAX,
              model,
              compilerFeedback: {
                warnings: initialFixWarnings,
                hint: lastCompileResult?.hint,
              },
              ...(isDiagnosticFix ? { treatDiagnosticErrorsAsBlocking: true } : {}),
              ...(fixTopologyContext ? { topologyContext: fixTopologyContext } : {}),
              onProgress: (progress) => {
                emit({
                  type: 'build_agent_stage',
                  agent: agentName,
                  stage: progress.stage,
                  detail:
                    progress.stage === 'fixing'
                      ? isDiagnosticFix
                        ? `Refining quality (${progress.round}/${progress.maxRounds})`
                        : `Fix attempt ${progress.round}/${progress.maxRounds}: ${progress.errorCount} error${progress.errorCount === 1 ? '' : 's'} found`
                      : isDiagnosticFix
                        ? `Validating improvements (pass ${progress.round})`
                        : `Recompiling after fix attempt ${progress.round}`,
                });
              },
            });

            // Safety net: if the fix-loop LLM deleted required HANDOFF rules
            // to resolve self-reference errors (observed in diagnostic 3dd30d8e),
            // treat as failure so the worker retry kicks in with fresh generation.
            const handoffRegression =
              fixResult.success && fixResult.finalAbl
                ? detectHandoffRegression(fixResult.finalAbl, plan)
                : null;

            if (fixResult.success && fixResult.finalAbl && !handoffRegression) {
              await db.collection('arch_sessions').updateOne(
                {
                  _id: session.id,
                  tenantId: ctx.tenantId,
                  userId: ctx.userId,
                } as Record<string, unknown>,
                {
                  $set: {
                    [`metadata.files.${agentName}.content`]: fixResult.finalAbl,
                    [`metadata.buildProgress.agentStatuses.${agentName}`]: 'validated',
                  },
                },
              );
              workerLog.info('Parallel build worker compile-fix succeeded', {
                buildStep: 'compile_fix_succeeded',
                rounds: fixResult.rounds,
              });

              // Record error→fix pattern for Arch's learning memory (Layer 3)
              const compileErrors = lastCompileResult?.errors ?? [];
              const domainStr =
                typeof shared.domainContext?.domain === 'string'
                  ? shared.domainContext.domain
                  : undefined;
              recordCompileFixLearning(compileErrors, agentName, fixResult.rounds, {
                domain: domainStr,
                agentRole: agentSpec.role,
              }).catch((learnErr: unknown) => {
                workerLog.warn('Failed to record compile-fix learning', {
                  error: learnErr instanceof Error ? learnErr.message : String(learnErr),
                });
              });

              // Transition UI: fixing -> enriching -> validated
              emit({
                type: 'build_agent_stage',
                agent: agentName,
                stage: 'enriching',
                detail: isDiagnosticFix
                  ? `Resolved semantic issues after ${fixResult.rounds} fix round${fixResult.rounds === 1 ? '' : 's'}`
                  : `Compiled successfully after ${fixResult.rounds} fix round${fixResult.rounds === 1 ? '' : 's'}`,
              });
              if (isDiagnosticFix) {
                lastDiagnostics = undefined;
              }
              fixRounds = fixResult.rounds;
            } else {
              const fixErrors = formatCompileFixErrors(fixResult.errors);
              const fixWarnings = formatCompileFixWarnings(fixResult.warnings);

              // When fix-loop succeeds but drops required HANDOFFs, surface that
              // explicitly as an error so the retry attempt regenerates fresh
              // instead of shipping a supervisor with missing specialists.
              const regressionError = handoffRegression
                ? [
                    `HANDOFF regression during fix: ${handoffRegression.reason} The fix-loop must preserve all topology-required HANDOFF rules; never delete them.`,
                  ]
                : [];

              nextRetryFeedback = buildWorkerRetryFeedback({
                errors: [...regressionError, ...initialFixErrors, ...fixErrors],
                warnings: [...initialFixWarnings, ...fixWarnings],
                hint: lastCompileResult?.hint,
                ...(isDiagnosticFix
                  ? {
                      diagnosticCodes: diagnosticRetryPolicy.diagnosticCodes,
                      retryable: diagnosticRetryPolicy.retryable,
                      retryReason: diagnosticRetryPolicy.reason,
                    }
                  : {}),
              });

              await db.collection('arch_sessions').updateOne(
                {
                  _id: session.id,
                  tenantId: ctx.tenantId,
                  userId: ctx.userId,
                } as Record<string, unknown>,
                {
                  $set: {
                    [`metadata.buildProgress.agentStatuses.${agentName}`]: 'error',
                  },
                },
              );

              emit({
                type: 'build_agent_error',
                agent: agentName,
                error:
                  nextRetryFeedback?.errors[0] ??
                  `Auto-fix failed after ${fixResult.rounds} round${fixResult.rounds === 1 ? '' : 's'}.`,
                stage: 'compile_fix',
              });

              workerLog.warn('Parallel build worker compile-fix exhausted rounds', {
                buildStep: 'compile_fix_exhausted',
                reason: handoffRegression
                  ? 'handoff_regression'
                  : isDiagnosticFix
                    ? 'semantic_diagnostics'
                    : 'compiler_errors',
                rounds: fixResult.rounds,
                errorCount: fixErrors.length,
                ...(handoffRegression
                  ? {
                      expectedHandoffs: handoffRegression.expected,
                      actualHandoffs: handoffRegression.actual,
                    }
                  : {}),
              });
            }
          }
        }
      } catch (fixErr: unknown) {
        // Fix 4: Compile-fix loop failure is NOT silent — emit error event
        // and update agent status so the UI shows the real state.
        const fixErrMsg = fixErr instanceof Error ? fixErr.message : String(fixErr);
        workerLog.warn('Parallel build worker compile-fix failed', {
          buildStep: 'compile_fix_failed',
          error: fixErrMsg,
        });
        emit({
          type: 'build_agent_error',
          agent: agentName,
          error: `Auto-fix failed: ${fixErrMsg}`,
          stage: 'compile_fix',
        });
        nextRetryFeedback = buildWorkerRetryFeedback({
          errors: [
            ...(isDiagnosticFix ? initialFixErrors : [...(lastCompileResult?.errors ?? [])]),
            `Auto-fix failed: ${fixErrMsg}`,
          ],
          warnings: isDiagnosticFix
            ? initialFixWarnings
            : [
                ...(lastCompileResult?.warnings ?? []),
                ...(lastCompileResult?.qualityWarnings ?? []),
              ],
          hint: lastCompileResult?.hint,
          ...(isDiagnosticFix
            ? {
                diagnosticCodes: diagnosticRetryPolicy.diagnosticCodes,
                retryable: true,
              }
            : {}),
        });

        // Persist error status — don't leave agent in an ambiguous state
        try {
          const mongooseForStatus = (await import('mongoose')).default;
          const dbForStatus = mongooseForStatus.connection.db;
          if (dbForStatus) {
            await dbForStatus.collection('arch_sessions').updateOne(
              {
                _id: session.id,
                tenantId: ctx.tenantId,
                userId: ctx.userId,
              } as Record<string, unknown>,
              {
                $set: {
                  [`metadata.buildProgress.agentStatuses.${agentName}`]: 'error',
                },
              },
            );
          }
        } catch (statusErr: unknown) {
          workerLog.warn('Failed to update agent status after compile-fix failure', {
            error: statusErr instanceof Error ? statusErr.message : String(statusErr),
          });
        }
      }
    }

    if (compileTimedOut) {
      emit({
        type: 'build_agent_error',
        agent: agentName,
        error:
          lastCompileResult?.errors?.[0] ??
          'ABL validation timed out before compile results were returned.',
        stage: 'validation',
      });
      nextRetryFeedback = buildWorkerRetryFeedback({
        errors: lastCompileResult?.errors ?? [
          'ABL validation timed out before compile results were returned.',
        ],
        warnings: [
          ...(lastCompileResult?.warnings ?? []),
          ...(lastCompileResult?.qualityWarnings ?? []),
        ],
        hint: lastCompileResult?.hint,
      });
      workerLog.warn('Parallel build worker skipping compile-fix after validation timeout', {
        buildStep: 'compile_fix_skipped_timeout',
        timedOutPhase: lastCompileResult?.timedOutPhase,
        phaseDurationsMs: lastCompileResult?.phaseDurationsMs,
      });
    }

    // Emit diagnostic findings as SSE event (after compile or fix loop)
    if (lastDiagnostics && lastDiagnostics.total > 0) {
      emit({
        type: 'build_agent_diagnostics',
        agent: agentName,
        overallSeverity: lastDiagnostics.overallSeverity as 'error' | 'warning' | 'info',
        summary: {
          errors: lastDiagnostics.errors,
          warnings: lastDiagnostics.warnings,
          infos: lastDiagnostics.infos,
          total: lastDiagnostics.total,
        },
        findings: (lastDiagnostics.topFindings ?? []).map((f) => ({
          code: f.code,
          message: f.message,
          severity: f.severity as 'error' | 'warning' | 'info',
          category: f.category,
          ...(f.fix && {
            fix: {
              description: f.fix.description,
              effort: f.fix.effort as 'S' | 'M' | 'L',
            },
          }),
        })),
        architecturePattern: lastDiagnostics.architecturePattern,
        antiPatterns: lastDiagnostics.antiPatterns?.map((ap) => ({
          name: ap.name,
          description: ap.description,
          agents: ap.agents,
          severity: ap.severity as 'error' | 'warning' | 'info',
        })),
      });
      workerLog.info('Parallel build worker emitted diagnostics', {
        buildStep: 'diagnostics_emitted',
        overallSeverity: lastDiagnostics.overallSeverity,
        findingCount: lastDiagnostics.total,
      });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const timedOut = timeoutController.signal.aborted;
    const parentAborted = parentSignal?.aborted ?? false;
    const isAbort = timedOut || parentAborted || /abort/i.test(message);

    if (isAbort) {
      workerLog.warn('Parallel build worker aborted', {
        stage: currentStage,
        error: message,
        timedOut,
        parentAborted,
        elapsedMs: Date.now() - start,
        idleMs: Date.now() - lastActivityAt,
        ...streamStats,
      });
    } else {
      workerLog.warn('Parallel build worker stream failed', {
        stage: currentStage,
        error: message,
        elapsedMs: Date.now() - start,
        ...streamStats,
      });
    }

    emit({
      type: 'build_agent_error',
      agent: agentName,
      error: isAbort ? 'Worker timed out' : message,
      stage: 'streaming',
    });
    nextRetryFeedback = buildWorkerRetryFeedback({
      errors: [
        ...(lastCompileResult?.errors ?? []),
        isAbort ? 'Worker timed out before generation completed.' : message,
      ],
      warnings: [
        ...(lastCompileResult?.warnings ?? []),
        ...(lastCompileResult?.qualityWarnings ?? []),
      ],
      hint: lastCompileResult?.hint,
    });
  } finally {
    clearTimeout(timeoutId);
    if (heartbeatId) {
      clearInterval(heartbeatId);
    }
  }

  // Read result from DB — the tools wrote to metadata.files and buildProgress
  const workerResult = await readAgentResultFromDb(agentName, session.id, ctx);
  const elapsed = Date.now() - start;
  const compileWarnings = collectCompileWarnings(lastCompileResult);
  const effectiveRetryFeedback =
    nextRetryFeedback ??
    (lastCompileResult?.status === 'fail'
      ? buildWorkerRetryFeedback({
          errors: lastCompileResult.errors,
          warnings: [
            ...(lastCompileResult.warnings ?? []),
            ...(lastCompileResult.qualityWarnings ?? []),
          ],
          hint: lastCompileResult.hint,
        })
      : undefined);
  const effectiveWarnings =
    workerResult.status === 'warning' && compileWarnings.length > 0
      ? compileWarnings
      : workerResult.status === 'error' && (effectiveRetryFeedback?.warnings.length ?? 0) > 0
        ? (effectiveRetryFeedback?.warnings ?? workerResult.warnings)
        : workerResult.warnings;
  const effectiveErrors =
    workerResult.status === 'error' && (effectiveRetryFeedback?.errors.length ?? 0) > 0
      ? (effectiveRetryFeedback?.errors ?? workerResult.errors)
      : workerResult.errors;

  workerLog.info('Parallel build worker finished', {
    buildStep: 'worker_finished',
    finalStatus: workerResult.status,
    warningCount: effectiveWarnings.length,
    errorCount: effectiveErrors.length,
    elapsedMs: elapsed,
  });

  return {
    agentName,
    status: workerResult.status,
    warnings: effectiveWarnings,
    errors: effectiveErrors,
    elapsed,
    ...(typeof fixRounds === 'number' ? { fixRounds } : {}),
    retryFeedback: effectiveRetryFeedback,
  };
}

/** Read the persisted agent file + status from MongoDB after worker completes */
async function readAgentResultFromDb(
  agentName: string,
  sessionId: string,
  ctx: BuildActionContext,
): Promise<{ status: 'compiled' | 'warning' | 'error'; warnings: string[]; errors: string[] }> {
  try {
    const mongoose = (await import('mongoose')).default;
    const db = mongoose.connection.db;
    if (!db) {
      return { status: 'error', warnings: [], errors: ['Database not connected'] };
    }

    const doc = await db.collection('arch_sessions').findOne({
      _id: sessionId,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
    } as Record<string, unknown>);

    if (!doc) {
      return { status: 'error', warnings: [], errors: ['Session not found'] };
    }

    const metadata = doc.metadata as Record<string, unknown> | undefined;
    const files = (metadata?.files ?? {}) as Record<string, { content?: string }>;
    const buildProgress = metadata?.buildProgress as
      | { agentStatuses?: Record<string, BuildAgentStatus> }
      | undefined;

    const persistedStatus = buildProgress?.agentStatuses?.[agentName];
    const fileData = files[agentName];

    if (!fileData?.content) {
      return {
        status: 'error',
        warnings: [],
        errors: ['No agent file was generated by the worker.'],
      };
    }

    if (persistedStatus === 'compiled') {
      return { status: 'compiled', warnings: [], errors: [] };
    }
    if (persistedStatus === 'validated') {
      return { status: 'compiled', warnings: [], errors: [] };
    }
    if (persistedStatus === 'warning') {
      return { status: 'warning', warnings: ['Quality floor issues detected'], errors: [] };
    }
    if (persistedStatus === 'error') {
      return { status: 'error', warnings: [], errors: ['Compilation failed'] };
    }

    // Status is 'generated' or 'pending' — file exists but compile wasn't called
    return { status: 'warning', warnings: [INCOMPLETE_COMPILE_WARNING], errors: [] };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('readAgentResultFromDb failed', {
      sessionId,
      agentName,
      error: message,
    });
    return { status: 'error', warnings: [], errors: [message] };
  }
}

// ---------------------------------------------------------------------------
// Normalize + emit per-agent results
// ---------------------------------------------------------------------------

async function normalizeAndEmitAgent(
  agentName: string,
  sessionId: string,
  ctx: BuildActionContext,
  emit: (event: ArchSSEEvent) => void,
  rawResult?: Pick<
    WorkerRawResult,
    'status' | 'warnings' | 'errors' | 'fixRounds' | 'toolCount' | 'handoffCount'
  >,
): Promise<void> {
  try {
    const mongoose = (await import('mongoose')).default;
    const db = mongoose.connection.db;
    if (!db) return;

    const doc = await db.collection('arch_sessions').findOne({
      _id: sessionId,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
    } as Record<string, unknown>);

    const metadata = doc?.metadata as Record<string, unknown> | undefined;
    const files = (metadata?.files ?? {}) as Record<string, { path?: string; content?: string }>;
    const fileData = files[agentName];

    if (!fileData?.content) return;

    // Normalize the source (REMEMBER target repairs, section sanitization)
    const normalized = await normalizeBuildAgentSource(fileData.content);

    if (normalized.repairs.length > 0) {
      // Write normalized code back to DB
      await db
        .collection('arch_sessions')
        .updateOne(
          { _id: sessionId, tenantId: ctx.tenantId, userId: ctx.userId } as Record<string, unknown>,
          {
            $set: {
              [`metadata.files.${agentName}.content`]: normalized.code,
            },
          },
        );
    }

    const effectiveContent = normalized.repairs.length > 0 ? normalized.code : fileData.content;

    // Emit file_changed with full canonical content (clears streaming state in the frontend)
    emit({
      type: 'file_changed',
      path: `agents/${agentName}.abl.yaml`,
      action: 'create',
      content: effectiveContent,
    });

    // Emit compile_result only once the worker has reached a terminal validation status.
    const buildProgress = metadata?.buildProgress as
      | { agentStatuses?: Record<string, BuildAgentStatus> }
      | undefined;
    const persistedStatus = buildProgress?.agentStatuses?.[agentName];
    const normalizedWarnings = dedupeMessages([
      ...(rawResult?.warnings ?? []).filter((warning) => warning !== INCOMPLETE_COMPILE_WARNING),
      ...normalized.repairs,
    ]);
    const status =
      rawResult?.status ??
      (isTerminalBuildStatus(persistedStatus)
        ? persistedStatus === 'validated'
          ? 'compiled'
          : persistedStatus
        : null);

    if (!status) {
      log.debug('Skipping compile_result emission for non-terminal build status', {
        sessionId,
        agentName,
        persistedStatus: persistedStatus ?? null,
      });
      return;
    }

    if (status === 'warning' && normalizedWarnings.length === 0) {
      log.debug('Skipping warning emission without actionable warning details', {
        sessionId,
        agentName,
      });
      return;
    }

    const isPass = status === 'compiled' || status === 'warning';
    const emittedErrors = status === 'error' ? (rawResult?.errors ?? ['Compilation failed']) : [];

    emit({
      type: 'compile_result',
      agent: agentName,
      status: isPass ? 'pass' : 'fail',
      errors: emittedErrors,
      warnings: normalizedWarnings,
    });

    // Emit structured validation event (new SSE protocol)
    if (!isPass) {
      emit({
        type: 'build_agent_error',
        agent: agentName,
        error: emittedErrors[0] ?? 'Compilation failed',
        stage: 'validation',
      });
    } else {
      emit({
        type: 'build_agent_validated',
        agent: agentName,
        warnings: normalizedWarnings,
        toolCount: rawResult?.toolCount ?? 0,
        handoffCount: rawResult?.handoffCount ?? 0,
        ...(typeof rawResult?.fixRounds === 'number' ? { fixRounds: rawResult.fixRounds } : {}),
      });
    }
  } catch (err: unknown) {
    log.warn('normalizeAndEmitAgent failed (non-fatal)', {
      sessionId,
      agentName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Main export: runParallelGeneration
// ---------------------------------------------------------------------------

/**
 * Run parallel BUILD generation for the specified agent names.
 *
 * Each agent gets its own streamText worker with per-agent timeout.
 * After all workers settle, results are reconciled against the full
 * topology and buildProgress is updated atomically.
 */
export async function runParallelGeneration(
  agentNames: string[],
  ctx: BuildActionContext,
  session: ArchSession,
  emit: (event: ArchSSEEvent) => void,
  model: LanguageModel,
  requestSignal?: AbortSignal,
  options?: ParallelGenerationOptions,
): Promise<AgentGenResult[]> {
  const startedAt = Date.now();
  const buildTraceId = createBuildTraceId(session.id, options?.buildRunId);
  const topologyContext = extractTopology(session);
  const sourceContract = getSourceArchitectureContractFromMetadata(
    session.metadata as unknown as Record<string, unknown>,
  );
  const domainContext = extractDomainFromSession(session);
  const topologyAgents = topologyContext.agents.map((agent) => {
    const hints = inferAgentRequirementHints({
      agent,
      topology: topologyContext,
      specification:
        (session.metadata.specification as
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
          | undefined) ?? null,
      domain: domainContext,
    });

    return {
      ...agent,
      gatherFields: hints.gatherFields,
      flowStepSeeds: hints.flowStepSeeds,
      gatherFieldSource: hints.gatherFieldSource,
      flowStepSource: hints.flowStepSource,
      requirementReasoning: hints.reasoning,
    };
  });
  const topologyEdges = topologyContext.edges;
  const entryPointName = topologyContext.entryPoint ?? topologyAgents[0]?.name;
  const parallelLog = log.child({
    buildTraceId,
    sessionId: session.id,
    buildRunId: options?.buildRunId,
    trigger: options?.trigger ?? 'parallel_build',
    agentCount: agentNames.length,
    concurrency: ARCH_AI_BUILD.AGENT_CONCURRENCY,
  });

  if (agentNames.length === 0) {
    parallelLog.warn('Parallel build trace: empty agent list', {
      buildStep: 'empty_agent_list',
    });
    return [];
  }

  // Pre-spawn validation: verify all agent names exist in the topology
  // and the topology has valid structure before spawning workers.
  const topologyNameSet = new Set(topologyAgents.map((a) => a.name));
  const missingAgents = agentNames.filter((name) => !topologyNameSet.has(name));
  if (missingAgents.length > 0) {
    parallelLog.error('Parallel build trace: agents missing from topology', {
      buildStep: 'preflight_missing_agents',
      missingAgents,
      topologyAgentNames: [...topologyNameSet],
    });
    emit({
      type: 'build_agent_error',
      agent: missingAgents[0],
      error: `Agents not found in topology: ${missingAgents.join(', ')}. Cannot generate.`,
      stage: 'validation',
    });
    return missingAgents.map((name) =>
      buildGenerationErrorResult(name, [`Agent "${name}" not found in topology.`]),
    );
  }

  if (topologyAgents.length === 0) {
    parallelLog.error('Parallel build trace: topology has no agents', {
      buildStep: 'preflight_empty_topology',
    });
    emit({
      type: 'build_agent_error',
      agent: agentNames[0],
      error: 'Topology has no agents defined. Cannot generate.',
      stage: 'validation',
    });
    return agentNames.map((name) =>
      buildGenerationErrorResult(name, ['Topology has no agents defined.']),
    );
  }

  parallelLog.info('Parallel build trace: generation started', {
    buildStep: 'generation_started',
    topologyAgentCount: topologyAgents.length,
    topologyEdgeCount: topologyEdges.length,
    agents: agentNames,
    requestAborted: requestSignal?.aborted ?? false,
  });

  parallelLog.info('Parallel build trace: requirement hints prepared', {
    buildStep: 'requirement_hints_prepared',
    inferredGatherAgents: topologyAgents.filter((agent) => agent.gatherFieldSource === 'inferred')
      .length,
    inferredFlowAgents: topologyAgents.filter((agent) => agent.flowStepSource === 'inferred')
      .length,
    toolBackedAgents: topologyAgents.filter((agent) => (agent.tools?.length ?? 0) > 0).length,
  });

  // 1. Set buildProgress.stage = 'generating' for requested agents
  try {
    const mongoose = (await import('mongoose')).default;
    const db = mongoose.connection.db;
    if (db) {
      const $set: Record<string, unknown> = {
        'metadata.buildProgress.stage': 'generating',
      };
      for (const name of agentNames) {
        $set[`metadata.buildProgress.agentStatuses.${name}`] = 'pending';
      }
      await db
        .collection('arch_sessions')
        .updateOne(
          { _id: session.id, tenantId: ctx.tenantId, userId: ctx.userId } as Record<
            string,
            unknown
          >,
          { $set },
        );
      parallelLog.info('Parallel build trace: status initialized', {
        buildStep: 'status_initialized',
        initializedAgentCount: agentNames.length,
      });
    } else {
      parallelLog.warn(
        'Parallel build trace: status initialization skipped because DB is unavailable',
        {
          buildStep: 'status_init_db_unavailable',
        },
      );
    }
  } catch (err: unknown) {
    parallelLog.warn('Parallel build trace: failed to initialize generating stage', {
      buildStep: 'status_init_failed',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 2. Precompute shared context ONCE (instead of per-worker)
  const enrichedEdges = topologyEdges.map((e) => ({
    from: e.from,
    to: e.to,
    type: e.type ?? 'delegate',
    ...(e.experienceMode ? { experienceMode: e.experienceMode } : {}),
    condition: e.condition ?? '',
    expectReturn: resolveEdgeReturnExpectation(e),
  }));

  // Precompute architecture plans from topology (deterministic, <100ms)
  let architecturePlans = new Map<string, AgentArchitecturePlan>();
  try {
    const planResult = computeArchitecturePlans({
      agents: topologyAgents.map((a) => ({
        name: a.name,
        role: a.role ?? 'agent',
        executionMode: (a.executionMode ?? 'reasoning') as 'reasoning' | 'scripted' | 'hybrid',
        description: a.description,
        tools: a.tools,
        gatherFields: a.gatherFields,
      })),
      edges: topologyEdges.map((e) => ({
        from: e.from,
        to: e.to,
        type: coerceEdgeType(e.type),
        ...(e.experienceMode ? { experienceMode: e.experienceMode } : {}),
        // Pass the actual edge condition so HANDOFF targets in the plan section
        // include WHEN clauses the LLM can use. Stripping to undefined caused
        // the plan to emit targets with no routing intent, leading small models
        // (Haiku) to generate HANDOFF blocks with self-referential TO: fields.
        condition: e.condition,
        expectReturn: resolveEdgeReturnExpectation(e),
      })),
      entryPoint: entryPointName ?? '',
    });
    architecturePlans = planResult.plans;
    parallelLog.info('Parallel build trace: architecture plans computed', {
      buildStep: 'architecture_plans_computed',
      planCount: architecturePlans.size,
      agentsWithRequiredGather: Array.from(architecturePlans.values()).filter(
        (p) => p.gather.required,
      ).length,
      agentsWithRequiredComplete: Array.from(architecturePlans.values()).filter(
        (p) => p.complete.required,
      ).length,
      globalBlockedCount: planResult.globalBlocked.length,
    });
    if (planResult.globalBlocked.length > 0) {
      const errors = planResult.globalBlocked.map(
        (blocked) => `${blocked.pattern}: ${blocked.agentName} — ${blocked.detail}`,
      );
      parallelLog.error('Parallel build trace: topology has blocked patterns', {
        buildStep: 'preflight_global_blocked',
        blockedCount: planResult.globalBlocked.length,
        errors,
      });
      emit({
        type: 'build_agent_error',
        agent: agentNames[0],
        error: `Topology cannot be generated safely: ${errors.join('; ')}`,
        stage: 'validation',
      });
      const blockedAgentNames = topologyAgents.map((agent) => agent.name);
      const errorStatuses = Object.fromEntries(
        blockedAgentNames.map((name) => [name, 'error' as BuildAgentStatus]),
      );
      const statusSet: Record<string, unknown> = {
        'metadata.buildProgress.stage': 'agents_complete',
        'metadata.buildProgress.agentStatuses': errorStatuses,
      };
      try {
        const mongoose = (await import('mongoose')).default;
        const db = mongoose.connection.db;
        if (db) {
          await db
            .collection('arch_sessions')
            .updateOne(
              { _id: session.id, tenantId: ctx.tenantId, userId: ctx.userId } as Record<
                string,
                unknown
              >,
              { $set: statusSet },
            );
        }
      } catch (err: unknown) {
        parallelLog.warn('Parallel build trace: failed to persist blocked topology status', {
          buildStep: 'preflight_global_blocked_persist_failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
      emit({
        type: 'build_reconciled',
        agents: Object.fromEntries(
          blockedAgentNames.map((name) => [
            name,
            {
              status: 'error' as const,
              errors,
              warnings: [],
            },
          ]),
        ),
        summary: {
          total: blockedAgentNames.length,
          compiled: 0,
          warnings: 0,
          errors: blockedAgentNames.length,
        },
      } as ArchSSEEvent);
      return blockedAgentNames.map((name) => buildGenerationErrorResult(name, errors));
    }
  } catch (planErr: unknown) {
    parallelLog.warn('Parallel build trace: architecture planner failed', {
      buildStep: 'architecture_planner_failed',
      error: planErr instanceof Error ? planErr.message : String(planErr),
    });
  }

  // Precompute per-agent sensitivity and model recommendations
  const sensitivityByAgent = new Map<string, { categories: string[]; evidence: string[] }>();
  const modelRecByAgent = new Map<
    string,
    { provider: string; model: string; temperature: number; maxTokens: number }
  >();

  for (const agentName of agentNames) {
    const agentSpec = topologyAgents.find((a) => a.name === agentName);
    if (!agentSpec) continue;

    const sensitivityResult = classifyDataSensitivity(
      (agentSpec.tools ?? []).map((t) => ({ name: t })),
    );
    sensitivityByAgent.set(agentName, {
      categories: sensitivityResult.categories,
      evidence: sensitivityResult.evidence.map((e) => e.match),
    });

    const modelRec = getModelRecommendation({
      agentRole: agentSpec.role ?? 'agent',
      executionMode: (agentSpec.executionMode ?? 'reasoning') as
        | 'reasoning'
        | 'scripted'
        | 'hybrid',
      requiresToolCalling: (agentSpec.tools ?? []).length > 0,
      requiresVision: false,
      requiresStructuredOutput: false,
      complexityTier: determineComplexity(agentSpec),
      constraints: domainContext.compliance,
      channels: domainContext.channels,
    });
    modelRecByAgent.set(agentName, {
      provider: modelRec.primary.provider,
      model: modelRec.primary.model,
      temperature: modelRec.executionConfig.temperature,
      maxTokens: modelRec.executionConfig.maxTokens,
    });
  }

  const sharedContext: SharedBuildContext = {
    topology: { agents: topologyAgents, edges: topologyEdges },
    domainContext,
    sensitivityByAgent,
    modelRecByAgent,
    entryPointName,
    enrichedEdges,
    architecturePlans,
    sourceBehaviorProfileDocuments: renderSourceBehaviorProfileDocuments(sourceContract),
    sourceBehaviorProfileFiles: renderSourceBehaviorProfileFiles(sourceContract),
  };

  parallelLog.info('Parallel build trace: shared context prepared', {
    buildStep: 'shared_context_prepared',
    topologyAgentCount: topologyAgents.length,
    enrichedEdgeCount: enrichedEdges.length,
    sensitivityAgentCount: sensitivityByAgent.size,
    modelRecAgentCount: modelRecByAgent.size,
    entryPoint: sharedContext.entryPointName ?? 'none',
  });

  // 3. Emit status text
  emit({
    type: 'text_delta',
    delta: `Building ${agentNames.length} agent${agentNames.length === 1 ? '' : 's'} in parallel...\n\n`,
  });

  // 4. Spawn workers with bounded concurrency pool
  parallelLog.info('Parallel build trace: workers dispatching', {
    buildStep: 'workers_dispatching',
    agentNames,
  });

  const settled = await runWithPool(agentNames, ARCH_AI_BUILD.AGENT_CONCURRENCY, async (name) => {
    const raw = await runAgentWorkerWithRetry(
      name,
      ctx,
      session,
      emit,
      model,
      sharedContext,
      buildTraceId,
      undefined,
      requestSignal,
      options?.buildRunId,
    );

    await normalizeAndEmitAgent(raw.agentName, session.id, ctx, emit, raw);
    return raw;
  });

  // Collect raw results
  let rawResults: WorkerRawResult[] = settled.map((outcome, idx) => {
    if (outcome.status === 'fulfilled') {
      return outcome.value;
    }
    // Rejected promise — unexpected
    const reason = outcome.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    parallelLog.warn('Agent worker promise rejected unexpectedly', {
      agentName: agentNames[idx],
      error: message,
    });
    return {
      agentName: agentNames[idx],
      status: 'error' as const,
      warnings: [],
      errors: [message],
      elapsed: 0,
    };
  });

  parallelLog.info('Parallel build trace: workers settled', {
    buildStep: 'workers_settled',
    compiled: rawResults.filter((result) => result.status === 'compiled').length,
    warnings: rawResults.filter((result) => result.status === 'warning').length,
    errors: rawResults.filter((result) => result.status === 'error').length,
    results: rawResults.map((result) => ({
      agentName: result.agentName,
      status: result.status,
      warningCount: result.warnings.length,
      errorCount: result.errors.length,
      elapsedMs: result.elapsed,
    })),
  });

  // 5. Read fresh session for reconciliation
  // Fix 6: Small delay to let any in-flight MongoDB writes from workers settle.
  // Workers write to metadata.files and agentStatuses via updateOne — without
  // this delay, the reconciliation read may arrive before the last write completes.
  await new Promise((resolve) => setTimeout(resolve, 200));

  let freshFiles: Record<string, { content?: string }> = {};
  let freshStatuses: Record<string, BuildAgentStatus> = {};
  parallelLog.info('Parallel build trace: reading fresh session for reconciliation', {
    buildStep: 'fresh_session_read_started',
  });
  try {
    const mongoose = (await import('mongoose')).default;
    const db = mongoose.connection.db;
    if (db) {
      const freshDoc = await db.collection('arch_sessions').findOne({
        _id: session.id,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
      } as Record<string, unknown>);
      const meta = freshDoc?.metadata as Record<string, unknown> | undefined;
      freshFiles = (meta?.files ?? {}) as Record<string, { content?: string }>;
      const bp = meta?.buildProgress as
        | { agentStatuses?: Record<string, BuildAgentStatus> }
        | undefined;
      freshStatuses = bp?.agentStatuses ?? {};
    }
  } catch (err: unknown) {
    parallelLog.warn('Parallel build trace: failed to read fresh session for reconciliation', {
      buildStep: 'fresh_session_read_failed',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Fix 6 (cont): Protect against status downgrades in fresh read.
  // If a worker reported 'compiled' or 'warning' but the DB read happened before
  // the write completed, prefer the worker's result over the DB status.
  for (const raw of rawResults) {
    const workerStatus = raw.status;
    const dbStatus = freshStatuses[raw.agentName];
    if (
      (workerStatus === 'compiled' || workerStatus === 'warning') &&
      dbStatus !== 'compiled' &&
      dbStatus !== 'warning' &&
      dbStatus !== 'validated'
    ) {
      parallelLog.warn('Preventing status downgrade — worker succeeded but DB not yet updated', {
        agentName: raw.agentName,
        workerStatus,
        dbStatus,
      });
      freshStatuses[raw.agentName] =
        workerStatus === 'compiled' ? 'validated' : (workerStatus as BuildAgentStatus);
    }
  }

  // 6. Reconcile: use ALL topology agents, not just the ones we generated
  const reconcileInput: ReconcileBuildResultsInput = {
    topologyAgents: topologyAgents.map((a) => ({
      name: a.name,
      role: a.role,
      executionMode: a.executionMode,
    })),
    topologyEdges: topologyEdges.map((e) => ({
      from: e.from,
      to: e.to,
      type: e.type,
      ...(e.experienceMode ? { experienceMode: e.experienceMode } : {}),
    })),
    rawResults: rawResults.map((r) => ({
      agentName: r.agentName,
      status: r.status,
      warnings: r.warnings,
      errors: r.errors,
    })),
    persistedStatuses: freshStatuses,
    agentFiles: freshFiles,
    behaviorProfileFiles: sharedContext.sourceBehaviorProfileFiles,
  };

  parallelLog.info('Parallel build trace: reconciliation started', {
    buildStep: 'reconciliation_started',
    rawResultCount: rawResults.length,
    agentFileCount: Object.keys(freshFiles).length,
  });

  let reconciled = await reconcileBuildResults(reconcileInput);

  const repairCandidates = reconciled.results.filter((result) => {
    const raw = rawResults.find((entry) => entry.agentName === result.agentName);
    return (
      agentNames.includes(result.agentName) &&
      result.status === 'error' &&
      raw?.status !== 'error' &&
      result.errors.length > 0
    );
  });

  if (repairCandidates.length > 0) {
    parallelLog.info('Parallel build trace: targeted repair started', {
      buildStep: 'targeted_repair_started',
      repairAgents: repairCandidates.map((candidate) => candidate.agentName),
    });

    await clearStaleArtifacts(
      repairCandidates.map((candidate) => candidate.agentName),
      session.id,
      ctx,
    );

    const repairedSettled = await runWithPool(
      repairCandidates,
      Math.min(ARCH_AI_BUILD.AGENT_CONCURRENCY, repairCandidates.length),
      async (candidate) => {
        const hasReadinessFeedback = hasRuntimeReadinessFeedback(candidate.errors);
        const feedback = buildWorkerRetryFeedback({
          errors: candidate.errors,
          warnings: candidate.warnings,
          retryable: true,
          hint: hasReadinessFeedback
            ? 'This is a runtime-readiness contract failure, not a syntax-only failure. Repair the generated agent behavior so the project can answer through Runtime: use one routing state vocabulary, add an executable fallback, and ensure terminal paths produce a non-empty customer-facing response or structured parent return.'
            : undefined,
          retryReason: hasReadinessFeedback
            ? 'Full-session runtime-readiness validation failed after initial parallel generation.'
            : 'Full-session build validation failed after initial parallel generation.',
        });
        const raw = await runAgentWorkerWithRetry(
          candidate.agentName,
          ctx,
          session,
          emit,
          model,
          sharedContext,
          buildTraceId,
          feedback,
          requestSignal,
          options?.buildRunId,
        );
        await normalizeAndEmitAgent(raw.agentName, session.id, ctx, emit, raw);
        return raw;
      },
    );

    const repairedRawResults = repairedSettled.map((outcome, idx): WorkerRawResult => {
      if (outcome.status === 'fulfilled') return outcome.value;
      const candidate = repairCandidates[idx];
      const message =
        outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      return {
        agentName: candidate.agentName,
        status: 'error',
        warnings: [],
        errors: [message],
        elapsed: 0,
      };
    });

    const repairedByName = new Map(repairedRawResults.map((result) => [result.agentName, result]));
    rawResults = rawResults.map((result) => repairedByName.get(result.agentName) ?? result);

    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      const mongoose = (await import('mongoose')).default;
      const db = mongoose.connection.db;
      if (db) {
        const freshDoc = await db.collection('arch_sessions').findOne({
          _id: session.id,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
        } as Record<string, unknown>);
        const meta = freshDoc?.metadata as Record<string, unknown> | undefined;
        freshFiles = (meta?.files ?? {}) as Record<string, { content?: string }>;
        const bp = meta?.buildProgress as
          | { agentStatuses?: Record<string, BuildAgentStatus> }
          | undefined;
        freshStatuses = bp?.agentStatuses ?? {};
      }
    } catch (err: unknown) {
      parallelLog.warn('Parallel build trace: failed to read fresh session after targeted repair', {
        buildStep: 'targeted_repair_fresh_read_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }

    reconciled = await reconcileBuildResults({
      ...reconcileInput,
      rawResults: rawResults.map((r) => ({
        agentName: r.agentName,
        status: r.status,
        warnings: r.warnings,
        errors: r.errors,
      })),
      persistedStatuses: freshStatuses,
      agentFiles: freshFiles,
    });
  }

  // 7. Update buildProgress with reconciled statuses
  try {
    const mongoose = (await import('mongoose')).default;
    const db = mongoose.connection.db;
    if (db) {
      await db
        .collection('arch_sessions')
        .updateOne(
          { _id: session.id, tenantId: ctx.tenantId, userId: ctx.userId } as Record<
            string,
            unknown
          >,
          {
            $set: {
              'metadata.buildProgress.agentStatuses': reconciled.agentStatuses,
              // All workers have settled at this point (Promise.allSettled completed),
              // so the generation run is done regardless of per-agent error status.
              'metadata.buildProgress.stage': 'agents_complete',
            },
          },
        );
      parallelLog.info('Parallel build trace: progress updated after reconciliation', {
        buildStep: 'progress_updated_after_reconciliation',
        stage: 'agents_complete',
      });
    } else {
      parallelLog.warn('Parallel build trace: progress update skipped because DB is unavailable', {
        buildStep: 'progress_update_db_unavailable',
      });
    }
  } catch (err: unknown) {
    parallelLog.warn('Parallel build trace: failed to update reconciled buildProgress', {
      buildStep: 'progress_update_failed',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 7b. Emit build_reconciled for UI state transition
  const reconciledAgents: Record<
    string,
    { status: 'compiled' | 'warning' | 'error'; errors: string[]; warnings: string[] }
  > = {};
  for (const r of reconciled.results) {
    reconciledAgents[r.agentName] = {
      status: r.status as 'compiled' | 'warning' | 'error',
      errors: r.errors,
      warnings: r.warnings,
    };
  }
  const summary = {
    total: reconciled.results.length,
    compiled: reconciled.results.filter((r) => r.status === 'compiled').length,
    warnings: reconciled.results.filter((r) => r.status === 'warning').length,
    errors: reconciled.results.filter((r) => r.status === 'error').length,
  };

  emit({
    type: 'build_reconciled',
    agents: reconciledAgents,
    summary,
  } as ArchSSEEvent);

  parallelLog.info('Parallel build trace: reconciliation complete', {
    buildStep: 'reconciliation_complete',
    summary,
    recoveredCount: reconciled.recoveredCount,
    statuses: reconciled.agentStatuses,
    elapsedMs: Date.now() - startedAt,
  });

  // 8. Build AgentGenResult[] with elapsed times from raw results
  const elapsedByName = new Map(rawResults.map((r) => [r.agentName, r.elapsed]));
  const rawByName = new Map(rawResults.map((r) => [r.agentName, r]));
  const finalResults = reconciled.results.map((r) => ({
    ...r,
    elapsed: elapsedByName.get(r.agentName) ?? 0,
    ...(rawByName.get(r.agentName)?.retryFeedback?.diagnosticCodes?.length
      ? { diagnosticCodes: rawByName.get(r.agentName)?.retryFeedback?.diagnosticCodes }
      : {}),
    ...(typeof rawByName.get(r.agentName)?.retryFeedback?.retryable === 'boolean'
      ? { retryable: rawByName.get(r.agentName)?.retryFeedback?.retryable }
      : {}),
    ...(rawByName.get(r.agentName)?.retryFeedback?.retryReason
      ? { retryReason: rawByName.get(r.agentName)?.retryFeedback?.retryReason }
      : {}),
  }));

  parallelLog.info('Parallel build trace: generation completed', {
    buildStep: 'generation_completed',
    summary,
    totalElapsedMs: Date.now() - startedAt,
  });

  return finalResults;
}

// ---------------------------------------------------------------------------
// Worker with retry
// ---------------------------------------------------------------------------

async function runAgentWorkerWithRetry(
  agentName: string,
  ctx: BuildActionContext,
  session: ArchSession,
  emit: (event: ArchSSEEvent) => void,
  model: LanguageModel,
  shared: SharedBuildContext,
  buildTraceId: string,
  initialRetryFeedback?: WorkerRetryFeedback,
  parentSignal?: AbortSignal,
  buildRunId?: string,
): Promise<WorkerRawResult> {
  const retryLog = log.child({
    buildTraceId,
    sessionId: session.id,
    agentName,
    buildRunId,
  });
  let lastResult: WorkerRawResult | undefined;
  let retryFeedback: WorkerRetryFeedback | undefined = initialRetryFeedback;

  for (let attempt = 0; attempt <= ARCH_AI_BUILD.AGENT_MAX_RETRIES; attempt++) {
    const attemptNumber = attempt + 1;
    retryLog.info('Parallel build worker attempt starting', {
      attempt: attemptNumber,
      maxAttempts: ARCH_AI_BUILD.AGENT_MAX_RETRIES + 1,
    });

    if (attempt > 0) {
      retryLog.info('Retrying agent worker', {
        attempt: attemptNumber,
      });
      // Clear stale artifacts before retry
      await clearStaleArtifacts([agentName], session.id, ctx);
      emit({
        type: 'file_changed',
        path: `agents/${agentName}.abl.yaml`,
        action: 'delete',
      });
    }

    lastResult = await runAgentWorker(
      agentName,
      ctx,
      session,
      emit,
      model,
      attemptNumber,
      shared,
      buildTraceId,
      retryFeedback,
      buildRunId,
      parentSignal,
    );

    retryLog.info('Parallel build worker attempt finished', {
      attempt: attemptNumber,
      status: lastResult.status,
      warningCount: lastResult.warnings.length,
      errorCount: lastResult.errors.length,
      elapsedMs: lastResult.elapsed,
    });

    // Success — no need to retry
    if (lastResult.status === 'compiled' || lastResult.status === 'warning') {
      return lastResult;
    }

    // Check if the file was actually generated despite error status
    // (the compile tool may have set error but the file exists)
    const dbResult = await readAgentResultFromDb(agentName, session.id, ctx);
    if (dbResult.status === 'compiled' || dbResult.status === 'warning') {
      retryLog.warn('Parallel build worker recovered from persisted result', {
        attempt: attemptNumber,
        persistedStatus: dbResult.status,
        warningCount: dbResult.warnings.length,
      });
      return {
        ...lastResult,
        status: dbResult.status,
        warnings: dbResult.warnings,
        errors: [],
      };
    }

    retryFeedback =
      lastResult.retryFeedback ??
      buildWorkerRetryFeedback({
        errors: lastResult.errors,
        warnings: lastResult.warnings,
      });

    if (retryFeedback?.retryable === false) {
      retryLog.warn('Parallel build worker stopped retries for structural diagnostics', {
        attempt: attemptNumber,
        diagnosticCodes: retryFeedback.diagnosticCodes ?? [],
        retryReason: retryFeedback.retryReason ?? null,
      });
      return {
        ...lastResult,
        retryFeedback,
      };
    }
  }

  // All retries exhausted
  emit({
    type: 'build_agent_error',
    agent: agentName,
    error: `Failed after ${ARCH_AI_BUILD.AGENT_MAX_RETRIES + 1} attempts`,
    stage: 'generation',
  });

  retryLog.error('Parallel build worker exhausted retries', {
    maxAttempts: ARCH_AI_BUILD.AGENT_MAX_RETRIES + 1,
    lastError: lastResult?.errors[0] ?? null,
  });

  return (
    lastResult ?? {
      agentName,
      status: 'error',
      warnings: [],
      errors: [`Failed after ${ARCH_AI_BUILD.AGENT_MAX_RETRIES + 1} attempts`],
      elapsed: 0,
      retryFeedback: buildWorkerRetryFeedback({
        errors: [`Failed after ${ARCH_AI_BUILD.AGENT_MAX_RETRIES + 1} attempts`],
      }),
    }
  );
}
