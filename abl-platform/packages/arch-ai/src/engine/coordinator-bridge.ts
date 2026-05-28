/**
 * Coordinator bridge — thin adapter between the existing coordinator
 * (phase-machine, content-router, prompts) and the v2 turn engine.
 *
 * Source of truth: docs/plans/2026-04-17-arch-ai-orchestration-redesign-impl-plan.md Phase 3
 *
 * The engine calls `resolveTurnPlan()` at turn start to get:
 *   - which specialist handles this turn
 *   - the composed system prompt to send to the LLM
 *   - the filtered tool set for this phase/mode
 *
 * This module composes existing functions; it does NOT modify them.
 */

import { createLogger } from '@agent-platform/shared-observability';

import type { ArchPhase } from '../types/session.js';
import type { PageContext } from '../types/page-context.js';
import type { ToolDefinition, ToolRegistry } from '../tools/v2/registry.js';
import type { AnySpecialistId } from '../types/constants.js';
import { getSpecialistForPhase } from '../coordinator/phase-machine.js';
import type { RoutingDecision } from '../coordinator/content-router.js';
import { composeSystemPrompt, composeInProjectPrompt } from '../prompts/index.js';
import { PHASE_TOOL_MAP, getInProjectToolNamesForSpecialist } from '../types/tools.js';

const log = createLogger('arch-ai:coordinator-bridge');
const IN_PROJECT_ARCHITECT_SPECIALIST = 'in-project-architect' as const satisfies AnySpecialistId;

// ─── Public types ────────────────────────────────────────────────────────

export interface TurnPlan {
  specialist: string;
  systemPrompt: string;
  allowedTools: ReadonlyArray<ToolDefinition<unknown, unknown>>;
  /**
   * Routing decision for this turn — populated for both onboarding and
   * in-project paths. Carried through to the engine so a `routing_decision`
   * trace event can be emitted at turn-start with the matched regex source
   * and any pageContext bias that influenced the choice.
   */
  routing: RoutingDecision;
}

export interface ResolveTurnPlanInput {
  session: {
    _id: string;
    metadata: {
      phase: ArchPhase;
      mode: 'onboarding' | 'in-project';
      specification?: unknown;
      projectId?: string;
    };
  };
  /** For in-project content routing. */
  userInput?: string;
  /** Optional Studio page context for prompt grounding. */
  pageContext?: PageContext;
  /**
   * Optional specialist pin for follow-up interactive turns.
   * Used in IN_PROJECT when a widget/tool answer should resume under the same
   * specialist instead of re-routing from the answer text alone.
   */
  specialistOverride?: string;
  registry: ToolRegistry;

  // ── Optional context loaders (M5, M6, M7) ──────────────────────────
  // Production wiring injects these from Studio-side services.
  // Tests and lightweight callers can omit — prompts work without them.

  /** M5: Load full spec document for injection into system prompt. */
  specDocumentLoader?: (sessionId: string) => Promise<Record<string, unknown> | null>;
  /** M6: Load last N journal decisions for LLM context. */
  journalDecisionLoader?: (sessionId: string) => Promise<string | null>;
  /** M6.5: Load cross-session project memory section for IN_PROJECT mode. */
  projectMemoryLoader?: () => Promise<string | null>;
  /** M7: Load cross-project learning memory section. */
  learningMemoryLoader?: () => Promise<string | null>;
  /**
   * Project state summary (agents/tools/profiles/MCPs/active drafts) for
   * IN_PROJECT prompts. Lets the LLM skip exploratory `platform_context:list_*`
   * calls on every turn.
   */
  projectStateSummaryLoader?: () => Promise<string | null>;
  /**
   * If the session has an active integration draft pointer, render a snapshot
   * (provider, status, bound resources, pending steps, last test result).
   * Returns null when no active draft.
   */
  activeDraftSnapshotLoader?: (sessionId: string) => Promise<string | null>;
}

// ─── Phase-to-tool-name map ──────────────────────────────────────────────
// Canonical mapping: reuses PHASE_TOOL_MAP (onboarding phases) and the
// specialist-scoped in-project tool profiles from types/tools.ts. This keeps
// the coordinator as the single place that binds routing to tool ownership.

function getAllowedToolNames(
  phase: ArchPhase,
  mode: 'onboarding' | 'in-project',
  specialist?: string,
): readonly string[] {
  if (mode === 'in-project') {
    return getInProjectToolNamesForSpecialist(specialist);
  }
  return PHASE_TOOL_MAP[phase] ?? [];
}

// ─── resolveTurnPlan ─────────────────────────────────────────────────────

export async function resolveTurnPlan(input: ResolveTurnPlanInput): Promise<TurnPlan> {
  const { session, userInput, registry } = input;
  const { phase, mode, specification } = session.metadata;

  // ── M5: Load fresh spec document if a loader is provided ────────────
  let specDocument = specification as Record<string, unknown> | undefined;
  if (input.specDocumentLoader) {
    try {
      const loaded = await input.specDocumentLoader(session._id);
      if (loaded) specDocument = loaded;
    } catch (err) {
      log.warn('spec document loader failed; falling back to session metadata', {
        sessionId: session._id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── M6: Load journal decisions ──────────────────────────────────────
  let journalSection: string | null = null;
  if (input.journalDecisionLoader) {
    try {
      journalSection = await input.journalDecisionLoader(session._id);
    } catch (err) {
      log.warn('journal decision loader failed; continuing without journal context', {
        sessionId: session._id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── M6.5: Load project memory ───────────────────────────────────────
  let projectMemorySection: string | null = null;
  if (input.projectMemoryLoader) {
    try {
      projectMemorySection = await input.projectMemoryLoader();
    } catch (err) {
      log.warn('project memory loader failed; continuing without project context', {
        sessionId: session._id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── M7: Load learning memory ────────────────────────────────────────
  let learningsSection: string | null = null;
  if (input.learningMemoryLoader) {
    try {
      learningsSection = await input.learningMemoryLoader();
    } catch (err) {
      log.warn('learning memory loader failed; continuing without learning context', {
        sessionId: session._id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Project state summary (IN_PROJECT) ──────────────────────────────
  let projectStateSection: string | null = null;
  if (input.projectStateSummaryLoader) {
    try {
      projectStateSection = await input.projectStateSummaryLoader();
    } catch (err) {
      log.warn('project state summary loader failed; continuing without project snapshot', {
        sessionId: session._id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Active integration draft snapshot (IN_PROJECT) ──────────────────
  let activeDraftSection: string | null = null;
  if (input.activeDraftSnapshotLoader) {
    try {
      activeDraftSection = await input.activeDraftSnapshotLoader(session._id);
    } catch (err) {
      log.warn('active draft snapshot loader failed; continuing without draft snapshot', {
        sessionId: session._id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 1 + 2. Resolve specialist and build system prompt.
  // IN_PROJECT uses one deterministic architect identity so tool availability
  // and plan-before-author behavior cannot vary by regex routing.
  let specialist: string;
  let systemPrompt: string;
  let routing: RoutingDecision;

  if (mode === 'in-project') {
    const inProjectSpecialist = IN_PROJECT_ARCHITECT_SPECIALIST;
    specialist = inProjectSpecialist;
    routing = {
      specialist: inProjectSpecialist,
      matchedPattern: null,
      pageContextBias: null,
    };
    systemPrompt = composeInProjectPrompt(
      inProjectSpecialist,
      input.pageContext,
      userInput,
      specDocument,
      projectMemorySection,
      learningsSection,
    );
  } else {
    const onboardingSpecialist = getSpecialistForPhase(phase);
    specialist = onboardingSpecialist;
    routing = {
      specialist: onboardingSpecialist as AnySpecialistId,
      matchedPattern: null,
      pageContextBias: null,
    };
    systemPrompt = composeSystemPrompt(
      onboardingSpecialist,
      phase,
      input.pageContext,
      userInput,
      specDocument,
      learningsSection,
    );
  }

  // ── M6: Append journal decisions to system prompt ───────────────────
  if (journalSection) {
    systemPrompt += `\n\n${journalSection}`;
  }

  // ── Append project state + active draft (IN_PROJECT) ────────────────
  if (projectStateSection) {
    systemPrompt += `\n\n${projectStateSection}`;
  }
  if (activeDraftSection) {
    systemPrompt += `\n\n${activeDraftSection}`;
  }

  // 3. Filter tools from registry by phase/mode
  const allowedNames = getAllowedToolNames(phase, mode, specialist);
  const allowedTools = registry.listByNames(allowedNames);

  return { specialist, systemPrompt, allowedTools, routing };
}
