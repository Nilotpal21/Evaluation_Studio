/**
 * Build Orchestrator — utilities for the BUILD phase generation pipeline.
 *
 * Exports:
 *  - buildCrossAgentInput: adapts session topology shape to validateCrossAgent input
 *  - validateSingleBuildAgentAgainstTopology: validates one generated agent against
 *    topology-aware placeholder siblings so parallel BUILD workers don't fail on
 *    unresolved sibling names
 *  - validateGeneratedBuildSession: validates the full generated BUILD artifact set
 *    together while isolating missing/invalid siblings behind placeholders
 *  - recoverFalseErrors: server-side compile recovery for agents marked error with stored files
 *  - clearStaleArtifacts: clears stale MongoDB artifacts for failed agents before retry
 */

import { createLogger } from '@abl/compiler/platform/logger.js';
import type { AgentBasedDocument } from '@abl/core';
import { ARCH_AI_TIMEOUTS } from './constants';
import {
  runIsolatedBuildSessionValidation,
  runIsolatedSingleAgentCompile,
} from './helpers/isolated-build-compiler';
import {
  renderManagedBehaviorProfileFilesForReferences,
  renderManagedBehaviorProfileFilesForTopology,
} from './managed-behavior-profiles';
import { collectGeneratedAgentReadinessErrors } from './build-readiness-gates';

const log = createLogger('arch-ai:build-orchestrator');
const INFO_WARNING_PREFIXES = ['W801:', 'W823:', 'W822:', 'W602:'] as const;
const INFO_WARNING_SUBSTRINGS = [
  'Normalized REMEMBER target',
  'Declared missing persistent memory path',
] as const;

// ─── Types ─────────────────────────────────────────────────────────────────

/** Session topology agent shape (from metadata.topology.agents) */
export interface SessionTopologyAgent {
  name: string;
  role: string;
  executionMode?: string;
  description?: string;
}

/** Session topology edge shape (from metadata.topology.edges) */
export interface SessionTopologyEdge {
  from: string;
  to: string;
  type: string;
  condition?: string;
  experienceMode?: string;
}

/** Session topology shape */
export interface SessionTopology {
  agents: SessionTopologyAgent[];
  edges: SessionTopologyEdge[];
}

/** Per-agent result passed in for cross-agent validation */
export interface AgentBuildResult {
  agentName: string;
  ablContent: string;
}

/** Cross-agent validator input format (expected by validateCrossAgent) */
export interface CrossAgentInput {
  nodes: Array<{
    id: string;
    name: string;
    type: 'supervisor' | 'agent';
    isEntry: boolean;
  }>;
  edges: Array<{
    from: string;
    to: string;
    type: string;
    returnsControl: boolean;
    experienceMode?: string;
  }>;
}

/** Cross-agent validator agent list entry */
export interface GeneratedAgentForValidation {
  name: string;
  ablContent: string;
  constructsUsed: string[];
}

/** Result entry for recoverFalseErrors */
export interface RecoveryResultEntry {
  agentName: string;
  status: 'compiled' | 'warning' | 'error';
  warnings: string[];
  errors: string[];
  recovered: boolean;
}

/** Input to recoverFalseErrors */
export interface RecoveryInput {
  results: Array<{
    agentName: string;
    status: 'compiled' | 'warning' | 'error';
    warnings: string[];
    errors: string[];
  }>;
  agentFiles: Record<string, { content: string }>;
}

/** Output of recoverFalseErrors */
export interface RecoveryOutput {
  results: RecoveryResultEntry[];
  recoveredCount: number;
}

/** Result entry for topology-aware BUILD validation */
export interface BuildSessionValidationEntry {
  agentName: string;
  status: 'compiled' | 'warning' | 'error';
  warnings: string[];
  errors: string[];
}

/** Input for validating a single BUILD worker output against topology siblings */
export interface SingleBuildAgentValidationInput {
  topology: SessionTopology;
  agentName: string;
  ablContent: string;
  behaviorProfileFiles?: Record<string, { content?: string }>;
}

/** Input for validating the full generated BUILD artifact set */
export interface BuildSessionValidationInput {
  topology: SessionTopology;
  agentFiles: Record<string, { content?: string }>;
  behaviorProfileFiles?: Record<string, { content?: string }>;
}

/** Output for validating the full generated BUILD artifact set */
export interface BuildSessionValidationOutput {
  results: BuildSessionValidationEntry[];
}

// ─── Supervisor role keywords ───────────────────────────────────────────────

const SUPERVISOR_ROLE_KEYWORDS = ['supervisor', 'triage', 'router'] as const;

function isSupervisorRole(role: string): boolean {
  const lower = role.toLowerCase();
  return SUPERVISOR_ROLE_KEYWORDS.some((kw) => lower.includes(kw));
}

function buildPlaceholderAbl(agent: SessionTopologyAgent): string {
  const header = isSupervisorRole(agent.role) ? 'SUPERVISOR' : 'AGENT';
  return `${header}: ${agent.name}
GOAL: "Placeholder agent used for BUILD validation context"
PERSONA: |
  Placeholder build artifact for cross-agent validation.
`;
}

function formatParseErrors(errors: Array<{ line?: number; message: string }>): string[] {
  return errors.map((error) =>
    typeof error.line === 'number' ? `Line ${error.line}: ${error.message}` : error.message,
  );
}

function pushMapValue(target: Map<string, string[]>, key: string, value: string): void {
  const existing = target.get(key);
  if (existing) {
    existing.push(value);
    return;
  }
  target.set(key, [value]);
}

async function parseAblDocument(content: string): Promise<{
  document: AgentBasedDocument | null;
  errors: string[];
}> {
  const { parseAgentBasedABL } = await import('@abl/core');
  const parseResult = parseAgentBasedABL(content);

  if ((parseResult.errors?.length ?? 0) > 0) {
    return {
      document: null,
      errors: formatParseErrors(parseResult.errors as Array<{ line?: number; message: string }>),
    };
  }

  if (!parseResult.document) {
    return {
      document: null,
      errors: ['No AGENT: or SUPERVISOR: declaration found.'],
    };
  }

  return {
    document: parseResult.document,
    errors: [],
  };
}

async function compileDocuments(documents: AgentBasedDocument[]): Promise<{
  errorsByAgent: Map<string, string[]>;
  warningsByAgent: Map<string, string[]>;
}> {
  const { compileABLtoIR } = await import('@abl/compiler');
  const compileResult = compileABLtoIR(documents, { mode: 'preview' });
  const errorsByAgent = new Map<string, string[]>();
  const warningsByAgent = new Map<string, string[]>();

  for (const error of compileResult.compilation_errors ?? []) {
    const agentName =
      typeof (error as { agent?: unknown }).agent === 'string'
        ? ((error as { agent: string }).agent as string)
        : null;
    if (!agentName) {
      continue;
    }
    pushMapValue(errorsByAgent, agentName, (error as { message: string }).message);
  }

  for (const warning of compileResult.compilation_warnings ?? []) {
    const agentName =
      typeof (warning as { agent?: unknown }).agent === 'string'
        ? ((warning as { agent: string }).agent as string)
        : null;
    if (!agentName) {
      continue;
    }
    pushMapValue(warningsByAgent, agentName, (warning as { message: string }).message);
  }

  return { errorsByAgent, warningsByAgent };
}

function buildValidationEntry(
  agentName: string,
  warnings: string[],
  errors: string[],
): BuildSessionValidationEntry {
  // Only actionable warnings affect status — info-level (W801, W823, etc.)
  // are common in LLM-generated agents and don't affect runtime execution.
  const actionable = warnings.filter((warning) => !isInfoLevelWarning(warning));
  return {
    agentName,
    status: errors.length > 0 ? 'error' : actionable.length > 0 ? 'warning' : 'compiled',
    warnings,
    errors,
  };
}

function isInfoLevelWarning(warning: string): boolean {
  return (
    INFO_WARNING_PREFIXES.some((prefix) => warning.includes(prefix)) ||
    INFO_WARNING_SUBSTRINGS.some((substring) => warning.includes(substring))
  );
}

function pushIssue(target: Map<string, string[]>, agentName: string, message: string): void {
  const existing = target.get(agentName);
  if (existing) {
    existing.push(message);
    return;
  }
  target.set(agentName, [message]);
}

function hasDslSection(content: string, sectionName: string): boolean {
  return new RegExp(`^\\s*${sectionName}\\s*:`, 'm').test(content);
}

function extractToolSideEffects(content: string): Map<string, boolean> {
  const tools = new Map<string, boolean>();
  const toolsMatch = content.match(/^\s*TOOLS\s*:\s*\n([\s\S]*?)(?=^\S[^:\n]*\s*:|(?![\s\S]))/m);
  const body = toolsMatch?.[1] ?? '';
  const entries = [
    ...body.matchAll(
      /^\s{2}([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)[^\n]*\n([\s\S]*?)(?=^\s{2}[A-Za-z_][A-Za-z0-9_]*\s*\(|(?![\s\S]))/gm,
    ),
  ];
  for (const entry of entries) {
    const name = entry[1];
    if (!name) continue;
    tools.set(name, /^\s{4}side_effects\s*:\s*true\b/im.test(entry[2] ?? ''));
  }
  return tools;
}

function extractFlowCalls(content: string): string[] {
  const flowMatch = content.match(/^\s*FLOW\s*:\s*\n([\s\S]*?)(?=^\S[^:\n]*\s*:|(?![\s\S]))/m);
  return [...(flowMatch?.[1] ?? '').matchAll(/^\s+CALL\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\b/gm)]
    .map((match) => match[1])
    .filter((name): name is string => Boolean(name));
}

function extractHandoffEntries(content: string): Array<{ to: string; when: string }> {
  const handoffMatch = content.match(
    /^\s*HANDOFF\s*:\s*\n([\s\S]*?)(?=^\S[^:\n]*\s*:|(?![\s\S]))/m,
  );
  const body = handoffMatch?.[1] ?? '';
  const entries: Array<{ to: string; when: string }> = [];
  const matches = body.matchAll(
    /^\s*-\s*TO\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\n([\s\S]*?)(?=^\s*-\s*TO\s*:|(?![\s\S]))/gm,
  );
  for (const match of matches) {
    const to = match[1];
    if (!to) continue;
    const when = match[2]?.match(/^\s*WHEN\s*:\s*(.+)$/m)?.[1]?.trim() ?? '';
    entries.push({ to, when });
  }
  return entries;
}

function isLiteralTrueCondition(value: string): boolean {
  return /^(?:["']?true["']?)$/i.test(value.trim());
}

function isDecisionRole(agent: SessionTopologyAgent, content: string): boolean {
  const text = `${agent.name} ${agent.role} ${agent.description ?? ''} ${content}`.toLowerCase();
  return /\b(advisor|advisory|analysis|analy[sz]e|classif(?:y|ier|ication)|decide|decision|eligibility|policy|rank|recommend|reason|route|routing|validate|validator)\b/.test(
    text,
  );
}

function collectTopologyConsistencyIssues(input: BuildSessionValidationInput): {
  errorsByAgent: Map<string, string[]>;
  warningsByAgent: Map<string, string[]>;
} {
  const errorsByAgent = new Map<string, string[]>();
  const warningsByAgent = new Map<string, string[]>();
  const agentByName = new Map(input.topology.agents.map((agent) => [agent.name, agent]));

  for (const agent of input.topology.agents) {
    const content = input.agentFiles[agent.name]?.content ?? '';
    if (!content.trim()) continue;

    const incomingEdges = input.topology.edges.filter((edge) => edge.to === agent.name);
    const silentDelegateOnly =
      incomingEdges.length > 0 &&
      incomingEdges.every((edge) => edge.experienceMode === 'silent_delegate');

    if (silentDelegateOnly && hasDslSection(content, 'GATHER')) {
      pushIssue(
        errorsByAgent,
        agent.name,
        'Topology consistency: silent_delegate agents must not emit customer-facing GATHER prompts; pass structured context from the parent delegate call instead.',
      );
    }

    if (
      isDecisionRole(agent, content) &&
      hasDslSection(content, 'FLOW') &&
      !/^\s*REASONING\s*:\s*true\b/im.test(content)
    ) {
      pushIssue(
        errorsByAgent,
        agent.name,
        'Topology consistency: decision/reasoning agents with FLOW must include a REASONING: true step instead of a fully scripted REASONING: false flow.',
      );
    }

    const sideEffectByTool = extractToolSideEffects(content);
    const sequentialSideEffectCalls = extractFlowCalls(content).filter(
      (toolName) => sideEffectByTool.get(toolName) === true,
    );
    if (new Set(sequentialSideEffectCalls).size > 1) {
      pushIssue(
        errorsByAgent,
        agent.name,
        `Topology consistency: FLOW sequentially calls multiple side-effect tools (${[
          ...new Set(sequentialSideEffectCalls),
        ].join(
          ', ',
        )}). Generate a reasoning dispatch step or split the mutex group into separate delegates.`,
      );
    }

    for (const entry of extractHandoffEntries(content)) {
      const targetEdge = input.topology.edges.find(
        (edge) => edge.from === agent.name && edge.to === entry.to,
      );
      if (targetEdge?.experienceMode === 'silent_delegate' && isLiteralTrueCondition(entry.when)) {
        pushIssue(
          errorsByAgent,
          agent.name,
          `Topology consistency: catch-all HANDOFF WHEN true routes all traffic to silent delegate "${entry.to}". Add a stateful guard or remove the catch-all.`,
        );
      }
    }

    for (const issue of collectGeneratedAgentReadinessErrors({
      content,
    })) {
      pushIssue(errorsByAgent, agent.name, issue);
    }
  }

  for (const edge of input.topology.edges) {
    if (!agentByName.has(edge.from) || !agentByName.has(edge.to)) {
      pushIssue(
        warningsByAgent,
        edge.from,
        `Topology consistency: edge ${edge.from} -> ${edge.to} references an agent missing from the generated topology.`,
      );
    }
  }

  return { errorsByAgent, warningsByAgent };
}

// ─── Export 1: buildCrossAgentInput ────────────────────────────────────────

/**
 * Adapts a session topology (agents[]+edges[]) to the shape expected by
 * validateCrossAgent (nodes[]+edges[] with derived type/isEntry/returnsControl).
 *
 * Mapping rules:
 * - agents[].name  → nodes[].id and nodes[].name  (same value)
 * - isEntry derived from: role contains 'triage'/'supervisor'/'router', OR first agent
 * - type: if role contains a supervisor keyword → 'supervisor', else → 'agent'
 * - edges[].type === 'delegate' → returnsControl: true, otherwise false
 * - agentResults → GeneratedAgent[] for HANDOFF reference checking
 */
export function buildCrossAgentInput(
  sessionTopology: SessionTopology,
  agentResults: AgentBuildResult[],
): {
  topology: CrossAgentInput;
  agents: GeneratedAgentForValidation[];
} {
  const { agents, edges } = sessionTopology;

  const nodes: CrossAgentInput['nodes'] = agents.map((agent, index) => {
    const type: 'supervisor' | 'agent' = isSupervisorRole(agent.role) ? 'supervisor' : 'agent';
    // isEntry: supervisor/triage/router roles are entry points, or the first agent
    const isEntry = isSupervisorRole(agent.role) || index === 0;

    return {
      id: agent.name,
      name: agent.name,
      type,
      isEntry,
    };
  });

  const mappedEdges: CrossAgentInput['edges'] = edges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    type: edge.type,
    returnsControl: edge.type === 'delegate',
    ...(edge.experienceMode ? { experienceMode: edge.experienceMode } : {}),
  }));

  const generatedAgents: GeneratedAgentForValidation[] = agentResults.map((r) => ({
    name: r.agentName,
    ablContent: r.ablContent,
    constructsUsed: [],
  }));

  return {
    topology: { nodes, edges: mappedEdges },
    agents: generatedAgents,
  };
}

// ─── Export 2: topology-aware single-agent validation ───────────────────────

/**
 * Validates one generated BUILD worker artifact against topology-aware placeholder
 * siblings. This preserves semantic validation of the current agent while avoiding
 * false routing/handoff failures caused by parallel workers not having generated
 * their siblings yet.
 */
export async function validateSingleBuildAgentAgainstTopology(
  input: SingleBuildAgentValidationInput,
): Promise<BuildSessionValidationEntry> {
  const targetAgent = input.topology.agents.find((agent) => agent.name === input.agentName);
  if (!targetAgent) {
    return buildValidationEntry(input.agentName, [], ['Agent is not present in topology.']);
  }

  const parsedTarget = await parseAblDocument(input.ablContent);
  if (!parsedTarget.document) {
    return buildValidationEntry(input.agentName, [], parsedTarget.errors);
  }

  const documents: AgentBasedDocument[] = [parsedTarget.document];
  for (const sibling of input.topology.agents) {
    if (sibling.name === input.agentName) {
      continue;
    }
    const parsedPlaceholder = await parseAblDocument(buildPlaceholderAbl(sibling));
    if (parsedPlaceholder.document) {
      documents.push(parsedPlaceholder.document);
    }
  }
  const managedProfileFiles = {
    ...renderManagedBehaviorProfileFilesForTopology(input.topology),
    ...renderManagedBehaviorProfileFilesForReferences({
      [input.agentName]: { content: input.ablContent },
    }),
    ...(input.behaviorProfileFiles ?? {}),
  };
  for (const file of Object.values(managedProfileFiles)) {
    const content = file.content;
    if (!content) {
      continue;
    }
    const parsedProfile = await parseAblDocument(content);
    if (parsedProfile.document) {
      documents.push(parsedProfile.document);
    }
  }

  const { errorsByAgent, warningsByAgent } = await compileDocuments(documents);
  return buildValidationEntry(
    input.agentName,
    warningsByAgent.get(input.agentName) ?? [],
    errorsByAgent.get(input.agentName) ?? [],
  );
}

// ─── Export 3: full generated BUILD session validation ──────────────────────

/**
 * Validates the generated BUILD artifact set together using the real compiler.
 * Missing or parse-broken siblings are replaced with topology-aware placeholders
 * so one bad file does not cascade false cross-agent errors onto every other file.
 */
export async function validateGeneratedBuildSession(
  input: BuildSessionValidationInput,
): Promise<BuildSessionValidationOutput> {
  const topologyConsistency = collectTopologyConsistencyIssues(input);
  const validation = await runIsolatedBuildSessionValidation(
    {
      topologyAgents: input.topology.agents.map((agent) => ({
        name: agent.name,
        role: agent.role,
      })),
      agentFiles: input.agentFiles,
      behaviorProfileFiles: {
        ...renderManagedBehaviorProfileFilesForTopology(input.topology),
        ...renderManagedBehaviorProfileFilesForReferences(input.agentFiles),
        ...(input.behaviorProfileFiles ?? {}),
      },
    },
    { timeoutMs: ARCH_AI_TIMEOUTS.BUILD_SESSION_VALIDATION_MS },
  );
  const results = input.topology.agents.map((agent) => {
    const parseErrors = validation.parseErrorsByAgent[agent.name] ?? [];
    if (parseErrors.length > 0) {
      return buildValidationEntry(agent.name, [], parseErrors);
    }

    return buildValidationEntry(
      agent.name,
      [
        ...(validation.warningsByAgent[agent.name] ?? []),
        ...(topologyConsistency.warningsByAgent.get(agent.name) ?? []),
      ],
      [
        ...(validation.errorsByAgent[agent.name] ?? []),
        ...(topologyConsistency.errorsByAgent.get(agent.name) ?? []),
      ],
    );
  });

  log.info('Validated generated BUILD session', {
    agentCount: input.topology.agents.length,
    parseDurationMs: validation.phaseDurationsMs.parse,
    compileDurationMs: validation.phaseDurationsMs.compile,
    totalDurationMs: validation.phaseDurationsMs.total,
  });

  return { results };
}

// ─── Internal: validateAbl ──────────────────────────────────────────────────

/**
 * Parses and compiles an ABL content string.
 * Uses dynamic imports to avoid bundling the entire compiler in non-server builds.
 */
async function validateAbl(
  ablContent: string,
): Promise<{ valid: boolean; parseErrors: string[]; compileErrors: string[] }> {
  try {
    const validation = await runIsolatedSingleAgentCompile(
      {
        code: ablContent,
        compileOptions: {
          mode: 'preview',
          skipCrossAgentValidation: true,
        },
      },
      { timeoutMs: ARCH_AI_TIMEOUTS.COMPILE_TOOL_MS },
    );

    const parseErrors = validation.parseErrors.map((entry) =>
      typeof entry.line === 'number' ? `Line ${entry.line}: ${entry.message}` : entry.message,
    );
    if (parseErrors.length > 0 || !validation.documentFound) {
      return { valid: false, parseErrors, compileErrors: [] };
    }

    const compileErrors = validation.compileErrors
      .filter((entry) => entry.severity === undefined || entry.severity === 'error')
      .map((entry) =>
        typeof entry.line === 'number' ? `Line ${entry.line}: ${entry.message}` : entry.message,
      );

    return {
      valid: compileErrors.length === 0,
      parseErrors: [],
      compileErrors,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { valid: false, parseErrors: [msg], compileErrors: [] };
  }
}

// ─── Export 2: recoverFalseErrors ───────────────────────────────────────────

/**
 * For each result with status === 'error', checks if agentFiles[result.agentName]
 * has content. If it does, runs a server-side compile on the content:
 *  - If it compiles → upgrades status to 'compiled' (or 'warning' if parse warnings)
 *  - If not → keeps as 'error'
 *
 * Does NOT touch the database — operates entirely on in-memory data.
 * The caller (route.ts) loads files from DB and passes them in.
 */
export async function recoverFalseErrors(input: RecoveryInput): Promise<RecoveryOutput> {
  const { results, agentFiles } = input;
  let recoveredCount = 0;

  const recoveredResults: RecoveryResultEntry[] = await Promise.all(
    results.map(async (result) => {
      if (result.status !== 'error') {
        return { ...result, recovered: false };
      }

      const storedFile = agentFiles[result.agentName];
      if (!storedFile?.content) {
        return { ...result, recovered: false };
      }

      try {
        const validation = await validateAbl(storedFile.content);

        if (validation.valid) {
          log.info('Recovered false-error agent via stored file compile', {
            agentName: result.agentName,
          });
          recoveredCount++;
          return {
            agentName: result.agentName,
            status: 'compiled' as const,
            warnings: [],
            errors: [],
            recovered: true,
          };
        }

        // Has parse/compile errors — not a false error, keep as error
        log.debug('Stored file did not compile — keeping error status', {
          agentName: result.agentName,
          parseErrors: validation.parseErrors.length,
          compileErrors: validation.compileErrors.length,
        });

        return {
          agentName: result.agentName,
          status: 'error' as const,
          warnings: result.warnings,
          errors: [...validation.parseErrors, ...validation.compileErrors],
          recovered: false,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('Recovery compile threw unexpectedly', {
          agentName: result.agentName,
          error: msg,
        });
        return { ...result, recovered: false };
      }
    }),
  );

  return { results: recoveredResults, recoveredCount };
}

// ─── Export 4: clearStaleArtifacts ─────────────────────────────────────────

/**
 * For each failed agent name:
 *  - $unset metadata.files.<agent>
 *  - Set metadata.buildProgress.agentStatuses.<agent> to 'pending'
 *
 * Uses a single atomic MongoDB update per agent to avoid partial-write races.
 * Errors are logged but do not throw — this is a best-effort pre-retry cleanup.
 */
export async function clearStaleArtifacts(
  failedAgentNames: string[],
  sessionId: string,
  ctx: { tenantId: string; userId: string },
): Promise<void> {
  if (failedAgentNames.length === 0) {
    return;
  }

  try {
    const mongoose = (await import('mongoose')).default;
    const db = mongoose.connection.db;

    if (!db) {
      log.warn('clearStaleArtifacts: database connection not available', { sessionId });
      return;
    }

    const $unset: Record<string, ''> = {};
    const $set: Record<string, string> = {};

    for (const agentName of failedAgentNames) {
      $unset[`metadata.files.${agentName}`] = '';
      $set[`metadata.buildProgress.agentStatuses.${agentName}`] = 'pending';
    }

    await db
      .collection('arch_sessions')
      .updateOne(
        { _id: sessionId, tenantId: ctx.tenantId, userId: ctx.userId } as Record<string, unknown>,
        { $unset, $set },
      );

    log.info('Cleared stale artifacts for failed agents', {
      sessionId,
      agentCount: failedAgentNames.length,
      agents: failedAgentNames,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('clearStaleArtifacts failed (non-fatal)', {
      sessionId,
      error: msg,
      agents: failedAgentNames,
    });
  }
}
