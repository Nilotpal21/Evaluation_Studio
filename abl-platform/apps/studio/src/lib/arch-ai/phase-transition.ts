/**
 * Shared phase-transition logic — gate-free onboarding.
 *
 * Both the `continue` handler and the `proceed_to_next_phase` tool call
 * this function to advance the onboarding phase. It checks exit criteria,
 * runs phase-specific metadata updates (topologyApproved for BLUEPRINT,
 * buildProgress init for BUILD), diffs topology against existing BUILD
 * state, and emits the `phase_transition` SSE event.
 */

import { createLogger } from '@abl/compiler/platform/logger.js';
import {
  SessionService,
  transitionPhase,
  getNextPhase,
  diffTopologyAgainstBuildState,
} from '@agent-platform/arch-ai';
import type { ArchSession, ArchSSEEvent, TopologyOutput } from '@agent-platform/arch-ai';
import { logArchTimeline, type ArchRequestTiming } from './request-timing';

const log = createLogger('arch-ai:phase-transition');

export type EmitFn = (event: ArchSSEEvent) => void;
export type JournalFn = (
  summary: string,
  rationale: string,
  specialist: string,
  phase: string,
) => Promise<void>;

export interface TransitionResult {
  transitioned: boolean;
  from?: string;
  to?: string;
  error?: string;
}

interface SessionCollectionLike {
  updateOne?: (
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    opts?: unknown,
  ) => Promise<{ matchedCount: number }>;
}

interface TransitionPersistenceOptions {
  archSessionsCollection?: SessionCollectionLike;
}

async function resolveArchSessionsCollection(
  options?: TransitionPersistenceOptions,
): Promise<SessionCollectionLike | null> {
  if (typeof options?.archSessionsCollection?.updateOne === 'function') {
    return options.archSessionsCollection;
  }

  const mongoose = (await import('mongoose')).default;
  const db = mongoose.connection.db;
  if (!db) {
    return null;
  }

  return db.collection('arch_sessions') as unknown as SessionCollectionLike;
}

/**
 * Execute a deterministic phase transition with pre-transition metadata updates.
 *
 * @param ctx        Tenant + user scope (every DB write uses triple-filter)
 * @param session    Current session DTO
 * @param sessionService Session service for DB operations
 * @param emit       SSE emitter for the current stream
 * @param journal    Journal append helper
 */
export async function executePhaseTransition(
  ctx: { tenantId: string; userId: string },
  session: ArchSession,
  _sessionService: SessionService,
  emit: EmitFn,
  journal: JournalFn,
  timing?: ArchRequestTiming,
  options?: TransitionPersistenceOptions,
): Promise<TransitionResult> {
  const phase = session.metadata.phase;
  const next = getNextPhase(phase);
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
        from: phase,
        to: next ?? null,
        mode: session.metadata.mode,
        ...(data ?? {}),
      },
    });
  };

  if (!next) {
    return { transitioned: false, error: 'No next phase from current phase.' };
  }

  logTimeline('phase_transition_started');

  const archSessionsCollection = await resolveArchSessionsCollection(options);
  if (!archSessionsCollection || typeof archSessionsCollection.updateOne !== 'function') {
    return { transitioned: false, error: 'Database connection lost.' };
  }

  const sessionFilter = {
    _id: session.id,
    tenantId: ctx.tenantId,
    userId: ctx.userId,
  } as Record<string, unknown>;
  const meta = session.metadata as unknown as Record<string, unknown>;
  const setFields: Record<string, unknown> = {};
  let unsetFields: Record<string, ''> | undefined;
  let transitionSession = session;

  // ─── BLUEPRINT → BUILD: auto-approve topology and diff against existing files ───
  if (phase === 'BLUEPRINT') {
    const topology = (meta.lockedTopology ??
      (meta.topologyApproved === true ? meta.topology : null)) as TopologyOutput | undefined;
    if (!topology) {
      return {
        transitioned: false,
        error: 'No locked topology exists. Approve a valid draft before proceeding to Build.',
      };
    }

    // Diff the newly-approved topology against existing BUILD state to
    // preserve already-generated agents and only regenerate new/changed ones.
    const oldFiles = (meta.files ?? {}) as Record<string, unknown>;
    const oldBlueprint = meta.blueprintOutput as { topology?: TopologyOutput } | undefined;
    const oldTopologySnapshot = oldBlueprint?.topology ?? null;

    let diffSummary = '';
    setFields['metadata.topologyApproved'] = true;
    setFields['metadata.blueprintStage'] = 'topology_locked';
    setFields['metadata.lockedTopology'] = topology;
    setFields['metadata.topology'] = topology;
    transitionSession = {
      ...session,
      metadata: {
        ...session.metadata,
        topologyApproved: true,
        blueprintStage: 'topology_locked',
        lockedTopology: topology,
        topology,
      },
    };

    if (Object.keys(oldFiles).length > 0) {
      const diff = diffTopologyAgainstBuildState(
        topology,
        oldFiles,
        [], // No approvedAgents in gate-free model
        oldTopologySnapshot,
      );

      // Unset removed files
      const $unset: Record<string, ''> = {};
      for (const name of diff.remove) {
        $unset[`metadata.files.${name}`] = '';
      }
      if (Object.keys($unset).length > 0) {
        unsetFields = $unset;
      }

      // Emit file_changed 'delete' events so the UI prunes its tree
      for (const name of diff.remove) {
        emit({
          type: 'file_changed',
          path: `agents/${name}.abl.yaml`,
          action: 'delete',
          content: '',
        });
      }

      await journal(
        `Topology diff: ${diff.preserve.length} preserved, ${diff.regenerate.length} to regenerate, ${diff.remove.length} removed`,
        diff.preserve.length > 0
          ? `Preserving existing agents: ${diff.preserve.join(', ')}.`
          : 'First build — no agents to preserve.',
        'coordinator',
        phase,
      );

      const preservedNote =
        diff.preserve.length > 0
          ? ` Keeping ${diff.preserve.length} existing agent(s): ${diff.preserve.join(', ')}.`
          : '';
      const removedNote = diff.remove.length > 0 ? ` Removed: ${diff.remove.join(', ')}.` : '';
      diffSummary = preservedNote + removedNote;
    }

    if (diffSummary) {
      emit({ type: 'text_delta', delta: `Topology approved.${diffSummary}\n\n` });
    }
  }

  try {
    const newPhase = transitionPhase(transitionSession, next);
    setFields['metadata.phase'] = newPhase;

    // ─── BUILD phase: initialize buildProgress ───────────────────────
    if (newPhase === 'BUILD') {
      const topology = (transitionSession.metadata as unknown as Record<string, unknown>)
        ?.lockedTopology as { agents?: Array<{ name: string }> } | undefined;
      const fallbackTopology = (transitionSession.metadata as unknown as Record<string, unknown>)
        ?.topology as { agents?: Array<{ name: string }> } | undefined;
      const topologySource = topology ?? fallbackTopology;
      const topologyAgents = topologySource?.agents ?? [];
      const agentStatuses: Record<string, string> = {};
      for (const agent of topologyAgents) {
        agentStatuses[agent.name] = 'pending';
      }

      setFields['metadata.buildProgress'] = {
        stage: 'initialized',
        agentStatuses,
        toolStatuses: {},
      };
      // Clear any pendingInteraction left over from BLUEPRINT so the
      // BUILD stream starts immediately without waiting for a stale widget.
      setFields['metadata.pendingInteraction'] = null;

      log.info('Initialized buildProgress', {
        sessionId: session.id,
        agentCount: topologyAgents.length,
        agents: topologyAgents.map((a) => a.name),
      });
      logTimeline('phase_transition_build_progress_initialized', {
        agentCount: topologyAgents.length,
      });
    }

    const updateOp: Record<string, unknown> = { $set: setFields };
    if (unsetFields && Object.keys(unsetFields).length > 0) {
      updateOp.$unset = unsetFields;
    }

    const writeResult = await archSessionsCollection.updateOne(sessionFilter, updateOp);
    if (writeResult.matchedCount === 0) {
      return { transitioned: false, error: 'Session not found.' };
    }

    emit({ type: 'phase_transition', from: phase, to: newPhase });

    await journal(
      `Phase transition: ${phase} → ${newPhase}`,
      'Exit criteria met, advancing to next phase.',
      'coordinator',
      phase,
    );

    log.info('Phase transition complete', {
      sessionId: session.id,
      from: phase,
      to: newPhase,
    });
    logTimeline('phase_transition_completed', {
      to: newPhase,
    });

    return { transitioned: true, from: phase, to: newPhase };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Exit criteria not met';
    log.warn('Phase transition failed', {
      sessionId: session.id,
      phase,
      targetPhase: next,
      error: message,
    });
    logTimeline(
      'phase_transition_failed',
      {
        error: message,
      },
      'warn',
    );
    return { transitioned: false, error: message };
  }
}
