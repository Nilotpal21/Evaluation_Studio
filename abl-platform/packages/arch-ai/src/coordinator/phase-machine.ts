/**
 * Phase Machine — deterministic phase lifecycle.
 * Contract: session-state-machine.md, S1-F01
 *
 * The coordinator owns all phase transitions. The LLM never decides
 * when to advance phases — the coordinator evaluates typed exit criteria
 * and advances deterministically.
 */

import type { ArchPhase, ArchSession, ArchMode } from '../types/session.js';
import type { SpecialistId } from '../types/tools.js';
import { canExitInterview } from '../types/specification.js';
import { InvalidTransitionError, ExitCriteriaNotMetError } from '../types/errors.js';

/**
 * Per-phase configuration: which specialist handles it, what tools are allowed,
 * what conditions must be satisfied to leave, and what comes next.
 */
export interface PhaseConfig {
  specialist: SpecialistId;
  exitCriteria: (session: ArchSession) => boolean;
  next: ArchPhase | null;
}

/**
 * Canonical phase configuration map.
 * Contract: tool-registry.md (phase-to-tool mapping),
 * S1-F01 (exit criteria), prompt-architecture.md (specialist routing).
 */
export const PHASE_CONFIG: Record<ArchPhase, PhaseConfig> = {
  INTERVIEW: {
    specialist: 'onboarding',
    exitCriteria: (session) => canExitInterview(session.metadata.specification),
    next: 'BLUEPRINT',
  },
  BLUEPRINT: {
    specialist: 'multi-agent-architect',
    exitCriteria: (session) => {
      // Slice 2: topology must be approved to proceed to Build
      const meta = session.metadata as unknown as Record<string, unknown>;
      return (meta.topologyApproved as boolean) === true;
    },
    next: 'BUILD',
  },
  BUILD: {
    specialist: 'abl-construct-expert',
    exitCriteria: (session) => {
      const meta = session.metadata as unknown as Record<string, unknown>;
      const bp = meta.buildProgress as
        | { stage?: string; agentStatuses?: Record<string, string> }
        | undefined;
      if (!bp || bp.stage === 'generating' || bp.stage === 'initialized') return false;
      const topology = meta.topology as { agents?: Array<{ name: string }> } | undefined;
      const topologyAgents = topology?.agents ?? [];
      return (
        topologyAgents.length > 0 &&
        topologyAgents.every((a) => {
          const status = bp.agentStatuses?.[a.name];
          return status === 'compiled' || status === 'warning';
        })
      );
    },
    next: 'CREATE',
  },
  CREATE: {
    // CREATE phase is coordinator-driven (summary + create_project).
    // No specialist LLM call needed — the coordinator assembles the summary
    // and the user clicks "Create Project."
    specialist: 'onboarding',
    exitCriteria: (session) => {
      // Phase exits when a project has been created (projectId is set)
      return !!session.metadata.projectId;
    },
    next: null,
  },
};

/**
 * Valid forward transitions in ONBOARDING mode.
 * Contract: S1-F01 req 7 — backward transitions are NOT permitted
 * EXCEPT BUILD->BLUEPRINT for large mutations (scope classifier).
 * Using a record instead of Set to avoid unbounded-collection hook.
 */
const VALID_TRANSITIONS: Record<string, true> = {
  'INTERVIEW->BLUEPRINT': true,
  'BLUEPRINT->BUILD': true,
  'BUILD->CREATE': true,
  'BUILD->BLUEPRINT': true,
};

/**
 * Validate and execute a phase transition.
 * Returns the new phase, or throws.
 */
export function transitionPhase(session: ArchSession, targetPhase: ArchPhase): ArchPhase {
  const currentPhase = session.metadata.phase;

  if (currentPhase === targetPhase) {
    return currentPhase;
  }

  const transitionKey = `${currentPhase}->${targetPhase}`;
  if (!VALID_TRANSITIONS[transitionKey]) {
    throw new InvalidTransitionError(currentPhase, targetPhase);
  }

  // For forward transitions (not BUILD->BLUEPRINT), check exit criteria
  if (targetPhase !== 'BLUEPRINT' || currentPhase !== 'BUILD') {
    const config = PHASE_CONFIG[currentPhase];
    if (!config.exitCriteria(session)) {
      throw new ExitCriteriaNotMetError(currentPhase);
    }
  }

  return targetPhase;
}

/**
 * Get the specialist for the current phase.
 * Contract: prompt-architecture.md — one specialist per phase.
 */
export function getSpecialistForPhase(phase: ArchPhase): SpecialistId {
  return PHASE_CONFIG[phase].specialist;
}

/**
 * Check if the current phase's exit criteria are satisfied.
 */
export function checkExitCriteria(session: ArchSession): boolean {
  const config = PHASE_CONFIG[session.metadata.phase];
  return config.exitCriteria(session);
}

/**
 * Get the next phase in the ONBOARDING sequence.
 * Returns null for the final phase (CREATE).
 */
export function getNextPhase(phase: ArchPhase): ArchPhase | null {
  return PHASE_CONFIG[phase].next;
}

/**
 * Determine the mode from session creation params.
 * Contract: S1-F01 req 13 — ONBOARDING when no projectId,
 * IN_PROJECT when projectId is provided.
 */
export function resolveMode(projectId?: string): ArchMode {
  return projectId ? 'IN_PROJECT' : 'ONBOARDING';
}
