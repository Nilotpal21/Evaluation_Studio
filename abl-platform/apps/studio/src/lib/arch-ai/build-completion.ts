/**
 * Build Completion Module — deterministic summary, widget payload, and action handler.
 *
 * This module owns the final step of the BUILD phase:
 *   1. Format compile results as a markdown summary (buildCompletionSummary)
 *   2. Build the BuildComplete ask_user widget payload (buildCompletionWidgetPayload)
 *   3. Handle user choices from the completion widget without LLM (handleBuildAction)
 *
 * The completion widget is emitted as a standard `tool_call` SSE event with
 * toolName: 'ask_user' and widgetType: 'BuildComplete'. It flows through the
 * existing widget contract — same toolCallId, pendingInteraction, and
 * sendToolAnswer as every other widget.
 */

import { createLogger } from '@abl/compiler/platform/logger.js';
import type { ArchSession, ArchSSEEvent, BuildAgentStatus } from '@agent-platform/arch-ai/types';
import type { SessionService } from '@agent-platform/arch-ai/session/session-service';
import { executePhaseTransition } from './phase-transition';
import type { TransitionResult, JournalFn } from './phase-transition';
import { logArchTimeline, type ArchRequestTiming } from './request-timing';
import { getLockedTopology } from '@/lib/arch-ai/blueprint-flow';

const log = createLogger('arch-ai:build-completion');

const CREATE_ACTION_ALIASES = new Set([
  'create',
  'create_project',
  'confirm_create',
  'yes_create',
  'create_now',
  'provision_project',
  'launch_project',
]);

export function normalizeBuildAction(action: string): string {
  const normalized = action.trim().toLowerCase();
  if (CREATE_ACTION_ALIASES.has(normalized)) {
    return 'create';
  }
  return normalized;
}

export function isBuildCreateAction(action: string): boolean {
  return normalizeBuildAction(action) === 'create';
}

// =============================================================================
// WARNING CLASSIFICATION
// =============================================================================

/**
 * Info-level warning prefixes — these are informational notes that should NOT
 * prevent an agent from being marked as 'compiled'. They are common in
 * LLM-generated agents and do not affect runtime execution:
 *
 * - W801: Session variable has no population source (populated by __set_context__ at runtime)
 * - W823: Named constraint phases are labels only (valid ABL, cosmetic)
 * - W822: GATHER field with both required:false and default (minor redundancy)
 * - W602: Unused template (cosmetic)
 * - Normalization repairs: successful auto-fixes applied during source normalization
 */
const INFO_WARNING_PREFIXES = ['W801:', 'W823:', 'W822:', 'W602:'] as const;
const INFO_WARNING_SUBSTRINGS = [
  'Normalized REMEMBER target',
  'Declared missing persistent memory path',
] as const;

/**
 * Classify a warning string as info-level (does not affect compiled status)
 * or actionable (real issue that should mark the agent as 'warning').
 */
export function isInfoLevelWarning(warning: string): boolean {
  for (const prefix of INFO_WARNING_PREFIXES) {
    if (warning.includes(prefix)) return true;
  }
  for (const substring of INFO_WARNING_SUBSTRINGS) {
    if (warning.includes(substring)) return true;
  }
  return false;
}

/**
 * Partition warnings into actionable (affect status) and info (display only).
 */
export function classifyWarnings(warnings: string[]): {
  actionable: string[];
  info: string[];
} {
  const actionable: string[] = [];
  const info: string[] = [];
  for (const w of warnings) {
    if (isInfoLevelWarning(w)) {
      info.push(w);
    } else {
      actionable.push(w);
    }
  }
  return { actionable, info };
}

// =============================================================================
// TYPES
// =============================================================================

export interface AgentGenResult {
  agentName: string;
  status: 'compiled' | 'warning' | 'error';
  warnings: string[];
  errors: string[];
  diagnosticCodes?: string[];
  retryable?: boolean;
  retryReason?: string;
  mode: string;
  agentType: string;
  toolCount: number;
  handoffCount: number;
  quality: {
    guardrails: boolean;
    memory: boolean;
    errorHandlers: boolean;
    constraints: boolean;
    catchAllHandoff: boolean;
  };
  elapsed?: number;
  enrichedSections?: string[];
}

export interface BuildCompleteWidgetPayload {
  widgetType: 'BuildComplete';
  question: string;
  agents: Array<{
    name: string;
    mode: string;
    agentType: string;
    status: 'compiled' | 'warning' | 'error';
    toolCount: number;
    handoffCount: number;
    quality: AgentGenResult['quality'];
    warnings: string[];
    error?: string;
    errors: string[];
    diagnosticCodes?: string[];
    retryable?: boolean;
    retryReason?: string;
  }>;
  stats: {
    total: number;
    compiled: number;
    warnings: number;
    errors: number;
    toolCount: number;
    elapsedMs: number;
  };
  projectName?: string;
  options: Array<{ label: string; value: string }>;
  allowCustom: boolean;
}

export interface BuildActionContext {
  tenantId: string;
  userId: string;
}

export interface BuildActionDeps {
  sessionService: SessionService;
  executePhaseTransitionFn?: typeof executePhaseTransition;
  journalFn: JournalFn;
  timing?: ArchRequestTiming;
  /**
   * Canonical project creation path. When provided, the BuildComplete "create"
   * action skips the legacy BUILD→CREATE transition and invokes the real
   * deterministic create_project flow directly.
   */
  createProject?: (
    ctx: BuildActionContext,
    session: ArchSession,
    emit: (event: ArchSSEEvent) => void,
    close: () => void,
  ) => Promise<void>;
  /** Filled in Task 8 when wiring the full orchestrator */
  runParallelGeneration?: (
    agentNames: string[],
    ctx: BuildActionContext,
    session: ArchSession,
    emit: (event: ArchSSEEvent) => void,
  ) => Promise<AgentGenResult[]>;
  /** Filled in Task 8 when wiring tool config generation */
  generateToolConfigs?: (
    ctx: BuildActionContext,
    session: ArchSession,
    emit: (event: ArchSSEEvent) => void,
  ) => Promise<void>;
}

function getBuildTopology(session: ArchSession): { agents?: Array<{ name: string }> } | null {
  return (
    (getLockedTopology(session) as { agents?: Array<{ name: string }> } | null) ??
    (session.metadata.topology as { agents?: Array<{ name: string }> } | undefined) ??
    null
  );
}

function buildAgentStatusesForTransition(
  session: ArchSession,
  results: AgentGenResult[],
): Record<string, BuildAgentStatus> {
  const topology = getBuildTopology(session);
  const topologyAgents = topology?.agents ?? [];
  const statusByName = new Map<string, BuildAgentStatus>(
    results.map((result) => [
      result.agentName,
      result.status === 'compiled' ? 'compiled' : result.status === 'warning' ? 'warning' : 'error',
    ]),
  );

  if (topologyAgents.length === 0) {
    return Object.fromEntries(statusByName) as Record<string, BuildAgentStatus>;
  }

  return Object.fromEntries(
    topologyAgents.map((agent) => [agent.name, statusByName.get(agent.name) ?? 'pending']),
  ) as Record<string, BuildAgentStatus>;
}

// =============================================================================
// EXPORT 1: buildCompletionSummary
// =============================================================================

/**
 * Generate a markdown summary of BUILD compile results.
 *
 * Each agent is formatted as:
 *   ▸ ✅ AgentName (TYPE · mode · N tools)
 *   ▸ ⚠ AgentName (TYPE · mode · N warnings)
 *   ▸ ❌ AgentName (TYPE · mode · compile error)
 *
 * Footer: "N agents built: X compiled, Y with warnings, Z errors"
 */
export function buildCompletionSummary(results: AgentGenResult[]): string {
  if (results.length === 0) {
    return 'No agents were generated.';
  }

  const lines: string[] = [];

  for (const r of results) {
    const toolLabel = r.toolCount === 1 ? '1 tool' : `${r.toolCount} tools`;
    const detail = `${r.agentType} · ${r.mode} · ${toolLabel}`;

    if (r.status === 'compiled') {
      lines.push(`▸ ✅ ${r.agentName} (${detail})`);
    } else if (r.status === 'warning') {
      lines.push(`▸ ⚠ ${r.agentName} (${detail} · ${r.warnings.length} warnings)`);
    } else {
      lines.push(`▸ ❌ ${r.agentName} (${detail} · compile error)`);
    }
  }

  const compiled = results.filter((r) => r.status === 'compiled').length;
  const warnings = results.filter((r) => r.status === 'warning').length;
  const errors = results.filter((r) => r.status === 'error').length;
  const total = results.length;

  const parts: string[] = [`${compiled} compiled`];
  if (warnings > 0) parts.push(`${warnings} with warnings`);
  if (errors > 0) parts.push(`${errors} errors`);

  lines.push('');
  lines.push(`${total} agent${total === 1 ? '' : 's'} built: ${parts.join(', ')}`);

  return lines.join('\n');
}

// =============================================================================
// EXPORT 2: buildCompletionWidgetPayload
// =============================================================================

/**
 * Build the BuildComplete ask_user widget payload.
 *
 * Options depend on compile state:
 *   - All clean (0 errors, 0 warnings):     create, tools, modify, review
 *   - Some warnings, no errors:             create, fix_warnings, tools, modify
 *   - Some errors (not all failed):         retry, modify, back
 *   - All errors:                           retry_all, back
 *
 * Always sets allowCustom: true.
 */
export function buildCompletionWidgetPayload(
  results: AgentGenResult[],
  projectName?: string,
): BuildCompleteWidgetPayload {
  const total = results.length;
  const compiled = results.filter((r) => r.status === 'compiled').length;
  const warnings = results.filter((r) => r.status === 'warning').length;
  const errors = results.filter((r) => r.status === 'error').length;
  const toolCount = results.reduce((sum, r) => sum + r.toolCount, 0);
  const elapsedMs = results.reduce((sum, r) => sum + (r.elapsed ?? 0), 0);

  const allErrors = errors === total && total > 0;
  const someErrors = errors > 0 && !allErrors;
  const someWarnings = warnings > 0 && errors === 0;
  const allClean = errors === 0 && warnings === 0;
  const retryableErrors = results.filter((r) => r.status === 'error' && r.retryable !== false);
  const structuralErrors = results.filter((r) => r.status === 'error' && r.retryable === false);

  let question: string;
  let options: Array<{ label: string; value: string }>;

  if (allClean) {
    question =
      `${total} agent${total === 1 ? '' : 's'} built — all compiled successfully.` +
      (projectName ? ` "${projectName}" is ready.` : ' Ready to continue.');
    options = [
      { label: 'Create project', value: 'create' },
      { label: 'Manage tools', value: 'tools' },
      { label: 'Modify an agent', value: 'modify' },
      { label: 'Review agents', value: 'review' },
    ];
  } else if (someWarnings) {
    question =
      `${total} agent${total === 1 ? '' : 's'} built — all compiled successfully.` +
      (projectName ? ` "${projectName}" is ready.` : ' Ready to continue.');
    options = [
      { label: 'Create project', value: 'create' },
      { label: 'Fix warnings', value: 'fix_warnings' },
      { label: 'Manage tools', value: 'tools' },
      { label: 'Modify an agent', value: 'modify' },
    ];
  } else if (someErrors) {
    if (retryableErrors.length > 0) {
      question =
        `${total} agent${total === 1 ? '' : 's'} built — ${errors} with errors.` +
        (structuralErrors.length > 0
          ? ` ${structuralErrors.length} have structural contract failures and should be modified instead of blindly retried.`
          : '');
      options = [
        { label: 'Retry failed agents', value: 'retry' },
        { label: 'Modify an agent', value: 'modify' },
        { label: 'Back to design', value: 'back' },
      ];
    } else {
      question =
        `${total} agent${total === 1 ? '' : 's'} built — ${errors} with structural errors.` +
        ' Modify the failed agents instead of retrying the same spec.';
      options = [
        { label: 'Modify an agent', value: 'modify' },
        { label: 'Back to design', value: 'back' },
      ];
    }
  } else {
    // allErrors
    if (retryableErrors.length === total) {
      question = `${total} agent${total === 1 ? '' : 's'} built — all failed.`;
      options = [
        { label: 'Retry all agents', value: 'retry_all' },
        { label: 'Back to design', value: 'back' },
      ];
    } else if (retryableErrors.length > 0) {
      question =
        `${total} agent${total === 1 ? '' : 's'} built — all failed.` +
        ` ${retryableErrors.length} can be retried; ${structuralErrors.length} need modification.`;
      options = [
        { label: 'Retry retryable agents', value: 'retry' },
        { label: 'Modify an agent', value: 'modify' },
        { label: 'Back to design', value: 'back' },
      ];
    } else {
      question = `${total} agent${total === 1 ? '' : 's'} built — all failed with structural errors.`;
      options = [
        { label: 'Modify an agent', value: 'modify' },
        { label: 'Back to design', value: 'back' },
      ];
    }
  }

  const agentPayloads = results.map((r) => ({
    name: r.agentName,
    mode: r.mode,
    agentType: r.agentType,
    status: r.status,
    toolCount: r.toolCount,
    handoffCount: r.handoffCount,
    quality: r.quality,
    warnings: r.warnings,
    error: r.errors.length > 0 ? r.errors[0] : undefined,
    errors: r.errors,
    diagnosticCodes: r.diagnosticCodes,
    retryable: r.retryable,
    retryReason: r.retryReason,
  }));

  return {
    widgetType: 'BuildComplete',
    question,
    agents: agentPayloads,
    stats: {
      total,
      compiled,
      warnings,
      errors,
      toolCount,
      elapsedMs,
    },
    projectName,
    options,
    allowCustom: true,
  };
}

// =============================================================================
// INTERNAL: mergeRetryResults
// =============================================================================

/**
 * After a retry, merge the retried subset back into the full session state.
 *
 * Reads topology agents and persisted buildProgress.agentStatuses from MongoDB,
 * then for each topology agent:
 *   - If it was retried: use the fresh AgentGenResult
 *   - If not retried: synthesize an AgentGenResult from the persisted status
 *
 * Returns the merged list so that buildCompletionSummary/Widget show ALL agents.
 */
async function mergeRetryResults(
  retriedResults: AgentGenResult[],
  previousResults: AgentGenResult[],
  session: ArchSession,
  ctx: BuildActionContext,
): Promise<AgentGenResult[]> {
  const retriedByName = new Map<string, AgentGenResult>(
    retriedResults.map((r) => [r.agentName, r]),
  );
  const previousByName = new Map<string, AgentGenResult>(
    previousResults.map((r) => [r.agentName, r]),
  );

  // Read topology agents from session metadata
  const topology = getBuildTopology(session);
  const topologyAgents = topology?.agents ?? [];

  if (topologyAgents.length === 0) {
    // No topology — fall back to just the retried results
    return retriedResults;
  }

  // Read persisted buildProgress.agentStatuses from MongoDB
  let persistedStatuses: Record<string, string> = {};
  try {
    const mongoose = (await import('mongoose')).default;
    const db = mongoose.connection.db;
    if (db) {
      const doc = await db
        .collection('arch_sessions')
        .findOne(
          { _id: session.id, tenantId: ctx.tenantId, userId: ctx.userId } as Record<
            string,
            unknown
          >,
          { projection: { 'metadata.buildProgress.agentStatuses': 1 } },
        );
      const statuses = doc?.metadata?.buildProgress?.agentStatuses;
      if (statuses && typeof statuses === 'object') {
        persistedStatuses = statuses as Record<string, string>;
      }
    }
  } catch (err: unknown) {
    log.warn('mergeRetryResults: failed to read persisted agentStatuses', {
      sessionId: session.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Merge: retried results take priority, non-retried agents use persisted status
  const merged: AgentGenResult[] = [];
  for (const agent of topologyAgents) {
    const retried = retriedByName.get(agent.name);
    if (retried) {
      merged.push(retried);
    } else {
      const previous = previousByName.get(agent.name);
      if (previous) {
        merged.push(previous);
        continue;
      }
    }
    if (!retried) {
      // Synthesize an AgentGenResult from persisted status
      const status = persistedStatuses[agent.name] ?? 'pending';
      const mappedStatus: AgentGenResult['status'] =
        status === 'compiled' || status === 'warning'
          ? status
          : status === 'error'
            ? 'error'
            : 'compiled';
      merged.push({
        agentName: agent.name,
        status: mappedStatus,
        warnings: [],
        errors: [],
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
      });
    }
  }

  // Include any retried agents that are NOT in topology (defensive)
  for (const result of retriedResults) {
    if (!topologyAgents.some((a) => a.name === result.agentName)) {
      merged.push(result);
    }
  }

  return merged;
}

// =============================================================================
// EXPORT 3: handleBuildAction
// =============================================================================

/**
 * Deterministic handler for user choices from the BuildComplete widget.
 *
 * Handles:
 *   create       → set buildProgress.stage='complete', transition phase, emit done, close
 *   back         → BUILD→BLUEPRINT backtrack, emit done, close
 *   review       → emit ask_user SingleSelect with agent names, persist pendingInteraction
 *   modify       → emit ask_user SingleSelect with agent names, persist pendingInteraction
 *
 * Stubs (filled in Task 8):
 *   retry        → log warning, re-emit widget
 *   retry_all    → log warning, re-emit widget
 *   tools        → log warning, re-emit widget
 *   fix_warnings → log warning, re-emit widget
 *
 * Default → enter BUILD LLM flow (caller falls through to LLM handler).
 *
 * Returns { continueToLLM: boolean } — when true, the caller should NOT return
 * and instead fall through to the LLM streaming path (reusing the same SSE stream).
 */
export async function handleBuildAction(
  action: string,
  ctx: BuildActionContext,
  session: ArchSession,
  results: AgentGenResult[],
  emit: (event: ArchSSEEvent) => void,
  close: () => void,
  deps: BuildActionDeps,
  projectName?: string,
): Promise<{ continueToLLM: boolean }> {
  const { sessionService, journalFn, timing } = deps;
  const normalizedAction = normalizeBuildAction(action);
  const execTransition = deps.executePhaseTransitionFn ?? executePhaseTransition;
  const logTimeline = (
    step: string,
    data?: Record<string, unknown>,
    level: 'info' | 'warn' | 'error' = 'info',
  ) => {
    const logFn =
      level === 'error'
        ? log.error.bind(log)
        : level === 'warn'
          ? log.warn.bind(log)
          : log.info.bind(log);
    logArchTimeline({
      timing,
      log: logFn,
      step,
      data: {
        sessionId: session.id,
        action,
        normalizedAction,
        phase: session.metadata.phase,
        ...(data ?? {}),
      },
    });
  };

  switch (normalizedAction) {
    case 'create': {
      log.info('BuildAction: create — marking complete and transitioning', {
        sessionId: session.id,
      });
      logTimeline('build_create_action_started', {
        resultCount: results.length,
      });

      const agentStatuses = buildAgentStatusesForTransition(session, results);
      const incompleteAgents = Object.entries(agentStatuses)
        .filter(([, status]) => status !== 'compiled' && status !== 'warning')
        .map(([agentName, status]) => `${agentName} (${status})`);

      if (incompleteAgents.length > 0) {
        log.warn('BuildAction create: widget results still contain incomplete agents', {
          sessionId: session.id,
          incompleteAgents,
        });
        logTimeline(
          'build_create_action_blocked',
          {
            incompleteAgents,
          },
          'warn',
        );
        emit({
          type: 'error',
          code: 'BUILD_AGENTS_INCOMPLETE',
          message:
            `Cannot create project yet — ${incompleteAgents.length} agent(s) still need successful compilation: ` +
            `${incompleteAgents.join(', ')}.`,
          retryable: false,
        });
        emit({ type: 'done' });
        close();
        return { continueToLLM: false };
      }

      // Persist the exact build statuses shown in the completion widget before
      // transitioning so CREATE is not blocked by stale buildProgress state.
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
                  'metadata.buildProgress.stage': 'complete',
                  'metadata.buildProgress.agentStatuses': agentStatuses,
                },
              },
            );
        }
        logTimeline('build_create_action_build_progress_marked_complete', {
          compiledAgents: Object.values(agentStatuses).filter((status) => status === 'compiled')
            .length,
          warningAgents: Object.values(agentStatuses).filter((status) => status === 'warning')
            .length,
        });
      } catch (err: unknown) {
        log.warn('BuildAction create: failed to update buildProgress', {
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
        logTimeline(
          'build_create_action_build_progress_update_failed',
          {
            error: err instanceof Error ? err.message : String(err),
          },
          'warn',
        );
      }

      if (deps.createProject) {
        logTimeline('build_create_action_delegate_to_finalize_project', {
          projectName: projectName ?? null,
        });
        await deps.createProject(ctx, session, emit, close);
        return { continueToLLM: false };
      }

      const transitionResult: TransitionResult = await execTransition(
        ctx,
        session,
        sessionService,
        emit,
        journalFn,
        timing,
      );

      if (!transitionResult.transitioned) {
        log.warn('BuildAction create: phase transition failed', {
          sessionId: session.id,
          error: transitionResult.error,
        });
        logTimeline(
          'build_create_action_transition_failed',
          {
            error: transitionResult.error ?? null,
          },
          'warn',
        );
        emit({
          type: 'error',
          code: 'TRANSITION_FAILED',
          message: transitionResult.error ?? 'Phase transition failed.',
          retryable: true,
        });
      } else {
        logTimeline('build_create_action_transition_completed', {
          from: transitionResult.from ?? null,
          to: transitionResult.to ?? null,
        });
      }

      emit({ type: 'done' });
      close();
      return { continueToLLM: false };
    }

    case 'back': {
      log.info('BuildAction: back — BUILD→BLUEPRINT backtrack', {
        sessionId: session.id,
      });
      const topology = getBuildTopology(session);

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
                  'metadata.phase': 'BLUEPRINT',
                  'metadata.blueprintStage': topology ? 'draft_ready' : 'concept_ready',
                  'metadata.topology': topology,
                  'metadata.draftTopology': topology,
                  'metadata.topologyApproved': false,
                  'metadata.buildProgress': null,
                },
              },
            );
        }
      } catch (err: unknown) {
        log.warn('BuildAction back: failed to reset phase metadata', {
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      await journalFn(
        'BUILD → BLUEPRINT backtrack (user choice)',
        'User chose to go back to the design step from the BUILD completion widget.',
        'coordinator',
        'BUILD',
      ).catch((err: unknown) => {
        log.warn('BuildAction back: journal failed (non-fatal)', {
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      emit({ type: 'phase_transition', from: 'BUILD', to: 'BLUEPRINT' });
      emit({
        type: 'text_delta',
        delta: 'Going back to the design step. Your existing agents are preserved.\n\n',
      });
      emit({ type: 'done' });
      close();
      return { continueToLLM: false };
    }

    case 'review': {
      log.info('BuildAction: review — emitting agent list widget', {
        sessionId: session.id,
      });

      const toolCallId = `review-select-${crypto.randomUUID()}`;
      const agentOptions = results.map((r) => ({
        label: r.agentName,
        value: r.agentName,
      }));

      const widgetInput = {
        question: 'Which agent would you like to review?',
        widgetType: 'SingleSelect' as const,
        options: agentOptions,
        allowCustom: false,
      };

      emit({
        type: 'tool_call',
        toolCallId,
        toolName: 'ask_user',
        input: widgetInput as Record<string, unknown>,
      });

      await sessionService
        .setPendingInteraction(ctx, session.id, {
          kind: 'widget',
          id: toolCallId,
          payload: widgetInput as Record<string, unknown>,
          createdAt: new Date().toISOString(),
        })
        .catch((err: unknown) => {
          log.warn('BuildAction review: failed to persist pendingInteraction', {
            sessionId: session.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });

      emit({ type: 'done' });
      // Do NOT close — widget is pending, stream stays open until user answers
      return { continueToLLM: false };
    }

    case 'modify': {
      log.info('BuildAction: modify — emitting agent list widget', {
        sessionId: session.id,
      });

      const toolCallId = `modify-select-${crypto.randomUUID()}`;
      const agentOptions = results.map((r) => ({
        label: r.agentName,
        value: r.agentName,
      }));

      const widgetInput = {
        question: 'Which agent would you like to modify?',
        widgetType: 'SingleSelect' as const,
        options: agentOptions,
        allowCustom: false,
      };

      emit({
        type: 'tool_call',
        toolCallId,
        toolName: 'ask_user',
        input: widgetInput as Record<string, unknown>,
      });

      await sessionService
        .setPendingInteraction(ctx, session.id, {
          kind: 'widget',
          id: toolCallId,
          payload: widgetInput as Record<string, unknown>,
          createdAt: new Date().toISOString(),
        })
        .catch((err: unknown) => {
          log.warn('BuildAction modify: failed to persist pendingInteraction', {
            sessionId: session.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });

      emit({ type: 'done' });
      // Do NOT close — widget is pending, stream stays open until user answers
      return { continueToLLM: false };
    }

    case 'retry': {
      const failedAgentNames = results
        .filter((result) => result.status === 'error' && result.retryable !== false)
        .map((result) => result.agentName);

      if (failedAgentNames.length === 0 || !deps.runParallelGeneration) {
        log.warn('BuildAction retry: no failed agents or retry runner unavailable', {
          sessionId: session.id,
          failedAgentCount: failedAgentNames.length,
        });
        if (results.some((result) => result.status === 'error' && result.retryable === false)) {
          emit({
            type: 'text_delta',
            delta:
              'The remaining failed agents have structural contract errors. Modify them instead of retrying the same generation.\n\n',
          });
        }
        const retryWidget = buildCompletionWidgetPayload(results, projectName);
        const retryToolCallId = `build-complete-${crypto.randomUUID()}`;
        emit({
          type: 'tool_call',
          toolCallId: retryToolCallId,
          toolName: 'ask_user',
          input: retryWidget as unknown as Record<string, unknown>,
        });
        emit({ type: 'done' });
        close();
        return { continueToLLM: false };
      }

      log.info('BuildAction retry: rerunning failed agents', {
        sessionId: session.id,
        failedAgentNames,
      });

      emit({
        type: 'text_delta',
        delta: `Retrying ${failedAgentNames.length} failed agent${failedAgentNames.length === 1 ? '' : 's'}...\n\n`,
      });

      const retriedResults = await deps.runParallelGeneration(failedAgentNames, ctx, session, emit);

      // Merge retried results into full session state so ALL agents appear
      const mergedResults = await mergeRetryResults(retriedResults, results, session, ctx);
      const retrySummary = buildCompletionSummary(mergedResults);
      const retryWidget = buildCompletionWidgetPayload(mergedResults, projectName);
      const retryToolCallId = `build-complete-${crypto.randomUUID()}`;

      emit({ type: 'text_delta', delta: `${retrySummary}\n\n` });
      emit({
        type: 'tool_call',
        toolCallId: retryToolCallId,
        toolName: 'ask_user',
        input: retryWidget as unknown as Record<string, unknown>,
      });

      await sessionService.appendMessage(ctx, session.id, {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: retrySummary,
        timestamp: new Date().toISOString(),
        specialist: 'coordinator',
        toolCalls: [
          {
            toolCallId: retryToolCallId,
            toolName: 'ask_user',
            input: retryWidget as unknown as Record<string, unknown>,
          },
        ],
        phase: 'BUILD',
      });

      await sessionService.setPendingInteraction(ctx, session.id, {
        kind: 'widget',
        id: retryToolCallId,
        payload: retryWidget as unknown as Record<string, unknown>,
        createdAt: new Date().toISOString(),
      });

      emit({ type: 'done' });
      close();
      return { continueToLLM: false };
    }

    case 'retry_all': {
      const retryableResults = results.filter((result) => result.retryable !== false);
      if (retryableResults.length === 0 || !deps.runParallelGeneration) {
        log.warn('BuildAction retry_all: no results or retry runner unavailable', {
          sessionId: session.id,
          resultCount: retryableResults.length,
        });
        if (results.some((result) => result.status === 'error' && result.retryable === false)) {
          emit({
            type: 'text_delta',
            delta:
              'The failed agents are marked as structural errors. Modify them instead of retrying the same generation.\n\n',
          });
        }
        const retryAllWidget = buildCompletionWidgetPayload(results, projectName);
        const retryAllToolCallId = `build-complete-${crypto.randomUUID()}`;
        emit({
          type: 'tool_call',
          toolCallId: retryAllToolCallId,
          toolName: 'ask_user',
          input: retryAllWidget as unknown as Record<string, unknown>,
        });
        emit({ type: 'done' });
        close();
        return { continueToLLM: false };
      }

      const retryAgentNames = retryableResults.map((result) => result.agentName);
      log.info('BuildAction retry_all: rerunning all agents', {
        sessionId: session.id,
        retryAgentNames,
      });

      emit({
        type: 'text_delta',
        delta: `Retrying all ${retryAgentNames.length} agents...\n\n`,
      });

      const retriedResults = await deps.runParallelGeneration(retryAgentNames, ctx, session, emit);

      // Merge retried results into full session state so ALL agents appear
      const mergedResults = await mergeRetryResults(retriedResults, results, session, ctx);
      const retrySummary = buildCompletionSummary(mergedResults);
      const retryWidget = buildCompletionWidgetPayload(mergedResults, projectName);
      const retryAllToolCallId = `build-complete-${crypto.randomUUID()}`;

      emit({ type: 'text_delta', delta: `${retrySummary}\n\n` });
      emit({
        type: 'tool_call',
        toolCallId: retryAllToolCallId,
        toolName: 'ask_user',
        input: retryWidget as unknown as Record<string, unknown>,
      });

      await sessionService.appendMessage(ctx, session.id, {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: retrySummary,
        timestamp: new Date().toISOString(),
        specialist: 'coordinator',
        toolCalls: [
          {
            toolCallId: retryAllToolCallId,
            toolName: 'ask_user',
            input: retryWidget as unknown as Record<string, unknown>,
          },
        ],
        phase: 'BUILD',
      });

      await sessionService.setPendingInteraction(ctx, session.id, {
        kind: 'widget',
        id: retryAllToolCallId,
        payload: retryWidget as unknown as Record<string, unknown>,
        createdAt: new Date().toISOString(),
      });

      emit({ type: 'done' });
      close();
      return { continueToLLM: false };
    }

    case 'tools': {
      // Extract tools from compiled agent files
      const { extractAllTools } = await import('@agent-platform/arch-ai/mock-server');
      const typedFiles = (session.metadata.files ?? {}) as Record<
        string,
        { path: string; content: string }
      >;
      const allTools = extractAllTools(typedFiles);

      if (allTools.length === 0) {
        emit({
          type: 'text_delta',
          delta:
            'No external tool integrations detected in your agents. You can add tools later from project settings.\n',
        });
        emit({ type: 'done' });
        close();
        return { continueToLLM: false };
      }

      // Deduplicate tool names and count
      const toolAgentMap = new Map<string, string[]>();
      for (const t of allTools) {
        const existing = toolAgentMap.get(t.toolName) ?? [];
        if (!existing.includes(t.agentName)) existing.push(t.agentName);
        toolAgentMap.set(t.toolName, existing);
      }

      // Set BUILD:TOOLS state (same as gate flow at route.ts:4780)
      const mongooseTools = (await import('mongoose')).default;
      const dbTools = mongooseTools.connection.db;
      if (!dbTools) {
        emit({
          type: 'error',
          code: 'DB_UNAVAILABLE',
          message: 'Database connection lost. Please try again.',
          retryable: true,
        });
        close();
        return { continueToLLM: false };
      }

      await dbTools
        .collection('arch_sessions')
        .updateOne(
          { _id: session.id, tenantId: ctx.tenantId, userId: ctx.userId } as Record<
            string,
            unknown
          >,
          {
            $set: {
              'metadata.buildSubPhase': 'TOOLS',
              'metadata.toolDsls': {},
              'metadata.toolBootstrapStatus': {},
              'metadata.selectedTools': null,
              'metadata.toolDslTurnCount': 0,
            },
          },
        );

      emit({
        type: 'text_delta',
        delta: `Found ${toolAgentMap.size} tool${toolAgentMap.size === 1 ? '' : 's'} across your agents. Generating configurations...\n\n`,
      });

      log.info('BuildAction tools: entering BUILD:TOOLS sub-phase', {
        sessionId: session.id,
        toolCount: toolAgentMap.size,
        toolNames: Array.from(toolAgentMap.keys()),
      });

      // Do NOT emit 'done' or call close() — SSE stream stays open for LLM continuation
      return { continueToLLM: true };
    }

    case 'fix_warnings': {
      // Stub — Task 8 will wire in enrichment
      log.warn('BuildAction fix_warnings: enrichment not yet wired — re-emitting widget', {
        sessionId: session.id,
      });
      const fwWidget = buildCompletionWidgetPayload(results, projectName);
      const fwToolCallId = `build-complete-${crypto.randomUUID()}`;
      emit({
        type: 'tool_call',
        toolCallId: fwToolCallId,
        toolName: 'ask_user',
        input: fwWidget as unknown as Record<string, unknown>,
      });
      emit({ type: 'done' });
      close();
      return { continueToLLM: false };
    }

    default: {
      // Unrecognised action — caller should fall through to BUILD LLM flow
      log.info('BuildAction: unrecognised action, falling through to LLM', {
        sessionId: session.id,
        action,
      });
      // Do not emit or close — caller handles the LLM flow
      return { continueToLLM: true };
    }
  }
}
