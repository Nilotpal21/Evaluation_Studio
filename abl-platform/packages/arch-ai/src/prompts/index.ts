/**
 * Prompt composition — Contract 9 (prompt-architecture).
 * systemPrompt = base + specialist + phase
 */

import { BASE_PROMPT } from './base.js';
import { ONBOARDING_SPECIALIST_PROMPT } from './specialists/onboarding.js';
import { MULTI_AGENT_ARCHITECT_PROMPT } from './specialists/multi-agent-architect.js';
import {
  ABL_CONSTRUCT_EXPERT_PROMPT,
  ABL_CONSTRUCT_EXPERT_SYNTAX,
} from './specialists/abl-construct-expert.js';
import { DIAGNOSTICIAN_PROMPT } from './specialists/diagnostician.js';
import { TESTING_EVAL_PROMPT } from './specialists/testing-eval.js';
import { CHANNEL_VOICE_PROMPT } from './specialists/channel-voice.js';
import { ENTITY_COLLECTION_PROMPT } from './specialists/entity-collection.js';
import { INTEGRATION_METHODOLOGIST_PROMPT } from './specialists/integration-methodologist.js';
import { ANALYST_PROMPT } from './specialists/analyst.js';
import { OBSERVER_PROMPT } from './specialists/observer.js';
import { IN_PROJECT_ARCHITECT_PROMPT } from './specialists/in-project-architect.js';
import { INTERVIEW_PHASE_PROMPT } from './phases/interview.js';
import { BLUEPRINT_PHASE_PROMPT } from './phases/blueprint.js';
import { BUILD_PHASE_PROMPT, renderBuildPhasePrompt } from './phases/build.js';

/**
 * @deprecated — BUILD_NARRATION_PROMPT was merged into BUILD_PHASE_PROMPT.
 * It was exported temporarily during transition. Task 8 removes the consumer (route.ts).
 * For now, export a stub to prevent build breakage.
 */
const BUILD_NARRATION_PROMPT_DEPRECATED = '';
import { CREATE_PHASE_PROMPT } from './phases/create.js';
import { IN_PROJECT_PHASE_PROMPT } from './phases/in-project.js';
import type { SpecialistId } from '../types/tools.js';
import type { AnySpecialistId } from '../types/constants.js';
import type { ArchPhase } from '../types/session.js';
import type { PageContext } from '../types/page-context.js';
import { selectKnowledgeCards } from '../knowledge/card-router.js';
import { renderInProjectKnowledgeCore } from '../knowledge/in-project-knowledge-core.generated.js';

const SPECIALIST_PROMPTS: Partial<Record<AnySpecialistId, string>> = {
  onboarding: ONBOARDING_SPECIALIST_PROMPT,
  'multi-agent-architect': MULTI_AGENT_ARCHITECT_PROMPT,
  'abl-construct-expert': ABL_CONSTRUCT_EXPERT_PROMPT,
  diagnostician: DIAGNOSTICIAN_PROMPT,
  'testing-eval': TESTING_EVAL_PROMPT,
  'channel-voice': CHANNEL_VOICE_PROMPT,
  'entity-collection': ENTITY_COLLECTION_PROMPT,
  'integration-methodologist': INTEGRATION_METHODOLOGIST_PROMPT,
  analyst: ANALYST_PROMPT,
  observer: OBSERVER_PROMPT,
};

const PHASE_PROMPTS: Partial<Record<ArchPhase, string>> = {
  INTERVIEW: INTERVIEW_PHASE_PROMPT,
  BLUEPRINT: BLUEPRINT_PHASE_PROMPT,
  BUILD: BUILD_PHASE_PROMPT,
  CREATE: CREATE_PHASE_PROMPT,
};

export function composeSystemPrompt(
  specialist: SpecialistId,
  phase: ArchPhase,
  pageContext?: PageContext,
  userMessage?: string,
  specDocument?: Record<string, unknown>,
  learningsSection?: string | null,
): string {
  const parts = [BASE_PROMPT];

  const specialistPrompt = SPECIALIST_PROMPTS[specialist];
  if (specialistPrompt) parts.push(specialistPrompt);

  // Knowledge layer: L0 (platform limits) + L2 (intent-triggered cards).
  // BLUEPRINT/BUILD force runtime decisioning so generated topology and ABL
  // choose constructs by use-case need instead of spraying every feature.
  const forceCards =
    phase === 'BUILD'
      ? ['runtime-construct-decision', 'handoff-delegate']
      : phase === 'BLUEPRINT'
        ? ['runtime-construct-decision']
        : undefined;
  const knowledge = selectKnowledgeCards(userMessage, undefined, forceCards);
  if (knowledge.content) parts.push(knowledge.content);

  // Layer 3: Arch's cross-project learning memory
  if (learningsSection) parts.push(learningsSection);

  const contextSection = formatContextSection(pageContext);
  if (contextSection) parts.push(contextSection);

  if (specDocument) {
    const specContext = renderSpecContext(specDocument);
    if (specContext) parts.push(specContext);
  }

  const phasePrompt = PHASE_PROMPTS[phase];
  if (phasePrompt) parts.push(phasePrompt);

  return parts.join('\n\n');
}

/**
 * Compose system prompt for IN_PROJECT mode.
 *
 * Uses a single generalist prompt for all IN_PROJECT turns.
 * Domain-specific knowledge is injected via L2 knowledge cards
 * selected by `selectKnowledgeCards()` based on user message content.
 *
 * @param specialist — Kept for backward compatibility with existing call sites.
 *   Ignored for prompt selection — the generalist prompt is always used.
 *   @deprecated The specialist parameter is no longer used for IN_PROJECT prompt selection.
 * @param projectMemorySection — pre-formatted project memory section from
 *   ProjectMemoryService.formatMemoriesForPrompt(). Injected after knowledge
 *   cards and before the phase prompt to give the LLM cross-session context.
 */
export function composeInProjectPrompt(
  specialist: AnySpecialistId,
  pageContext?: PageContext,
  userMessage?: string,
  specDocument?: Record<string, unknown>,
  projectMemorySection?: string | null,
  learningsSection?: string | null,
): string {
  const parts = [BASE_PROMPT];

  // Unified architect prompt — stable identity for all IN_PROJECT turns.
  // Domain knowledge comes from L2 knowledge cards below, not specialist prompts.
  parts.push(IN_PROJECT_ARCHITECT_PROMPT);

  // Compiler-backed Knowledge Core — always loaded for in-project work so
  // proposals start from canonical constructs and explicit analysis gates.
  parts.push(renderInProjectKnowledgeCore());

  // Knowledge layer: L0 (platform limits) + L2 (intent-triggered cards)
  // Pass pageContext for page-aware card selection (channels, deployments, etc.)
  const knowledge = selectKnowledgeCards(
    userMessage,
    undefined,
    undefined,
    pageContext
      ? {
          area: 'project',
          page: pageContext.page,
          tab: pageContext.tab ?? undefined,
          entityType: pageContext.entity?.type,
        }
      : undefined,
  );
  if (knowledge.content) parts.push(knowledge.content);

  // Layer 3: Arch's cross-project learning memory
  if (learningsSection) parts.push(learningsSection);

  const contextSection = formatContextSection(pageContext);
  if (contextSection) parts.push(contextSection);

  if (specDocument) {
    const specContext = renderSpecContext(specDocument);
    if (specContext) parts.push(specContext);
  }

  // Cross-session project memory — injected after knowledge, before phase prompt
  if (projectMemorySection) parts.push(projectMemorySection);

  parts.push(IN_PROJECT_PHASE_PROMPT);

  return parts.join('\n\n');
}

// =============================================================================
// SPEC DOCUMENT CONTEXT
// =============================================================================

/**
 * Render a concise summary of the spec document for inclusion in the LLM
 * system prompt. Returns null if the spec has no meaningful content yet.
 */
function renderSpecContext(spec: Record<string, unknown>): string | null {
  const sections: string[] = [];
  sections.push('## Project Specification');

  const business = spec.business as Record<string, unknown> | undefined;
  const architecture = spec.architecture as Record<string, unknown> | undefined;
  const decisions = spec.decisions as Array<Record<string, unknown>> | undefined;

  if (business?.projectName) {
    sections.push(`**Project:** ${String(business.projectName)}`);
  }
  if (business?.objective) {
    sections.push(`**Objective:** ${String(business.objective)}`);
  }
  if (Array.isArray(business?.channels) && (business.channels as string[]).length > 0) {
    sections.push(`**Channels:** ${(business.channels as string[]).join(', ')}`);
  }
  if (Array.isArray(business?.compliance) && (business.compliance as unknown[]).length > 0) {
    sections.push('**Compliance:**');
    for (const c of business.compliance as Array<Record<string, unknown>>) {
      sections.push(`- ${String(c.standard)} (${String(c.severity)}): ${String(c.detail)}`);
    }
  }
  if (Array.isArray(business?.slas) && (business.slas as unknown[]).length > 0) {
    sections.push('**SLA Targets:**');
    for (const s of business.slas as Array<Record<string, unknown>>) {
      sections.push(`- ${String(s.metric)}: ${String(s.target)} ${String(s.unit)}`);
    }
  }
  if (Array.isArray(business?.constraints) && (business.constraints as unknown[]).length > 0) {
    sections.push('**Constraints:**');
    for (const c of business.constraints as string[]) {
      sections.push(`- ${String(c)}`);
    }
  }
  if (Array.isArray(architecture?.agents) && (architecture.agents as unknown[]).length > 0) {
    sections.push(
      `**Architecture:** ${String(architecture.pattern ?? 'custom')} with ${String(architecture.agentCount)} agents`,
    );
    sections.push(`**Entry Point:** ${String(architecture.entryPoint ?? 'unknown')}`);
  }
  if (Array.isArray(decisions) && decisions.length > 0) {
    const recent = decisions.slice(-5);
    sections.push('**Recent Decisions:**');
    for (const d of recent) {
      sections.push(`- ${String(d.what)}: ${String(d.why)}`);
    }
  }

  return sections.length > 1 ? sections.join('\n') : null;
}

// =============================================================================
// PAGE CONTEXT FORMATTING
// =============================================================================

/**
 * Format a PageContext into a markdown section for system prompt injection.
 * Returns null if no context or context is empty.
 */
export function formatContextSection(pageContext?: PageContext): string | null {
  if (!pageContext) return null;

  const lines: string[] = ['## Current Context', ''];
  lines.push(`You are on the **${pageContext.page}** page (area: ${pageContext.area}).`);
  if (pageContext.tab) {
    lines.push(`Focused tab: **${pageContext.tab}**.`);
  }
  if (pageContext.subSection) {
    lines.push(`Focused section: **${pageContext.subSection}**.`);
  }
  if (pageContext.timeZone) {
    lines.push(`Viewer timezone: **${pageContext.timeZone}**.`);
  }

  if (pageContext.project) {
    lines.push(
      `Project: **${pageContext.project.name}** (${pageContext.project.agentCount} agents).`,
    );
  }

  if (pageContext.entity) {
    const e = pageContext.entity;
    lines.push(`Currently viewing: **${e.name ?? e.id}** (${e.type}).`);
    if (e.metadata) {
      const metaEntries = Object.entries(e.metadata)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .slice(0, 5); // Limit metadata lines
      if (metaEntries.length > 0) {
        lines.push(`Details: ${metaEntries.join(', ')}.`);
      }
    }
  }

  if (pageContext.summary && !('sensitive' in pageContext.summary)) {
    const summaryEntries = Object.entries(pageContext.summary)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .slice(0, 5);
    if (summaryEntries.length > 0) {
      lines.push(`Page data: ${summaryEntries.join(', ')}.`);
    }
  }

  if (pageContext.capabilities && pageContext.capabilities.length > 0) {
    lines.push(`Relevant surface areas: ${pageContext.capabilities.slice(0, 6).join(', ')}.`);
  }

  const productionOptimizationFocus = getProductionOptimizationFocus(pageContext);
  if (productionOptimizationFocus) {
    lines.push(productionOptimizationFocus);
  }

  lines.push('');
  lines.push(
    'Use this context silently — do not say "I see you are on..." unless the user\'s question is ambiguous and you need to confirm which entity they mean.',
  );

  return lines.join('\n');
}

function getProductionOptimizationFocus(pageContext: PageContext): string | null {
  const capabilities = new Set(
    (pageContext.capabilities ?? []).map((capability) => capability.trim().toLowerCase()),
  );
  const page = pageContext.page.trim().toLowerCase();
  const entityType = pageContext.entity?.type.trim().toLowerCase();

  const isProductionOptimizationSurface =
    capabilities.has('production_agent_optimization') ||
    capabilities.has('containment_optimization') ||
    capabilities.has('quality_improvement');

  if (!isProductionOptimizationSurface) {
    return null;
  }

  if (
    entityType === 'session' ||
    page === 'sessions' ||
    capabilities.has('session_observability') ||
    capabilities.has('containment_analysis')
  ) {
    return [
      'Production session focus: use conversation outcomes, traces, and failure evidence to improve containment, escalation handling, quality, and reliability for agents already running in production.',
      'When the user asks for analysis or improvements, inspect the trace step-by-step, identify the flow pattern, read the relevant agent goal and flow steps, then explain performance gaps and propose targeted modifications without applying changes unless confirmed.',
    ].join(' ');
  }

  return [
    'Production optimization focus: use this page as evidence for improving agents already running in production, especially containment, escalation rate, quality score, and customer-impacting failure patterns.',
    'For Analytics menus, connect metrics to session and trace evidence before recommending changes; include the agent goal, flow-step behavior, observed flow patterns, and the modification rationale in the explanation.',
  ].join(' ');
}

export {
  BASE_PROMPT,
  ONBOARDING_SPECIALIST_PROMPT,
  MULTI_AGENT_ARCHITECT_PROMPT,
  INTERVIEW_PHASE_PROMPT,
  BLUEPRINT_PHASE_PROMPT,
  ABL_CONSTRUCT_EXPERT_PROMPT,
  ABL_CONSTRUCT_EXPERT_SYNTAX,
  BUILD_PHASE_PROMPT,
  renderBuildPhasePrompt,
  BUILD_NARRATION_PROMPT_DEPRECATED as BUILD_NARRATION_PROMPT,
  IN_PROJECT_PHASE_PROMPT,
  ANALYST_PROMPT,
  DIAGNOSTICIAN_PROMPT,
  OBSERVER_PROMPT,
  IN_PROJECT_ARCHITECT_PROMPT,
};
