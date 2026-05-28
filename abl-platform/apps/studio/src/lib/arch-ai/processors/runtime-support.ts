import type { ArchSession } from '@agent-platform/arch-ai';
import type { ResolveTurnPlanInput, TurnEngineDeps } from '@agent-platform/arch-ai/engine';
import { LearningMemoryService } from '@agent-platform/arch-ai/session';
import {
  ArchLearningMemory,
  ArchSession as ArchSessionModel,
  ArchIntegrationDraft,
  AuthProfile,
  MCPServerConfig,
  ProjectAgent,
  ProjectTool,
} from '@agent-platform/database/models';
import { createLogger } from '@abl/compiler/platform/logger.js';
import {
  journalService,
  projectMemoryService,
  specDocumentService,
} from '@/lib/arch-ai/message-services';
import { generateSuggestions as generateStudioSuggestions } from '@/lib/arch-ai/suggestions';

const log = createLogger('arch-ai:runtime-support');

interface ProcessorContext {
  tenantId: string;
  userId: string;
}

const learningMemoryService = new LearningMemoryService(ArchLearningMemory);

// ─── Project state summary cache ────────────────────────────────────────
//
// 5-minute in-memory TTL keyed by tenantId:projectId. Keeps prompt-injection
// fresh enough that recent edits show up but avoids re-querying Mongo on
// every turn. Cache is process-local — multi-pod inconsistency is acceptable
// because the LLM prompt is only stale by at most 5 minutes.

const PROJECT_STATE_TTL_MS = 5 * 60 * 1000;
const PROJECT_STATE_CACHE = new Map<string, { value: string; expires: number }>();

// Active integration draft statuses that are still meaningful for prompt context.
// 'archived' drafts are filtered out so abandoned setups don't leak into prompts.
const ACTIVE_DRAFT_STATUSES_FOR_SUMMARY = [
  'draft',
  'needs_input',
  'ready_to_test',
  'ready_to_apply',
  'failed',
  'complete',
];

function getSessionDescription(session: ArchSession): string | undefined {
  const description = (
    session.metadata.specification as { description?: string | null } | undefined
  )?.description;
  return typeof description === 'string' && description.trim().length > 0
    ? description.trim()
    : undefined;
}

function getTopologyAgentCount(session: ArchSession): number {
  const agents = (session.metadata.topology as { agents?: unknown[] } | undefined)?.agents;
  return Array.isArray(agents) ? agents.length : 0;
}

function hasBuildWarnings(session: ArchSession): boolean {
  const buildProgress = session.metadata.buildProgress as
    | {
        agentStatuses?: Record<string, string>;
        toolStatuses?: Record<string, string>;
      }
    | undefined;

  const statuses = [
    ...Object.values(buildProgress?.agentStatuses ?? {}),
    ...Object.values(buildProgress?.toolStatuses ?? {}),
  ];
  return statuses.some((status) => status === 'warning');
}

/**
 * Build a 200-500 token markdown summary of project state for prompt injection.
 *
 * Lists agents, tools, auth profiles (project + tenant scope), MCP servers,
 * and active integration drafts. Cached for 5 minutes per tenant:project to
 * avoid hitting Mongo on every turn.
 *
 * Without this, the LLM calls `platform_context:list_*` 3-5 times on the
 * first turn — every turn — to learn what exists in the project.
 */
export async function projectStateSummaryLoader(
  ctx: { tenantId: string },
  projectId: string,
): Promise<string | null> {
  const tenantId = ctx.tenantId;
  if (!tenantId || !projectId) {
    return null;
  }

  const cacheKey = `${tenantId}:${projectId}`;
  const now = Date.now();
  const cached = PROJECT_STATE_CACHE.get(cacheKey);
  if (cached && cached.expires > now) {
    return cached.value;
  }

  try {
    const [agentsRaw, toolsRaw, profilesRaw, mcpsRaw, draftsRaw] = await Promise.all([
      ProjectAgent.find({ tenantId, projectId }).select('name').lean(),
      ProjectTool.find({ tenantId, projectId }).select('name toolType').lean(),
      AuthProfile.find({
        tenantId,
        $or: [{ projectId }, { scope: 'tenant' }],
      })
        .select('name authType visibility scope')
        .lean(),
      MCPServerConfig.find({ tenantId, projectId }).select('name').lean(),
      ArchIntegrationDraft.find({
        tenantId,
        projectId,
        status: { $in: ACTIVE_DRAFT_STATUSES_FOR_SUMMARY },
      })
        .select('providerKey status title')
        .lean(),
    ]);

    const agents = agentsRaw as Array<{ name: string }>;
    const tools = toolsRaw as Array<{ name: string; toolType: string }>;
    const profiles = profilesRaw as Array<{ name: string; authType: string }>;
    const mcps = mcpsRaw as Array<{ name: string }>;
    const drafts = draftsRaw as Array<{
      providerKey: string | null;
      status: string;
      title: string;
    }>;

    const agentList = agents.map((a) => a.name).filter(Boolean);
    const profileList = profiles
      .map((p) => `${p.name} (${p.authType})`)
      .filter((s) => s.trim().length > 0);
    const mcpList = mcps.map((m) => m.name).filter(Boolean);
    const draftList = drafts.map((d) => `${d.providerKey ?? d.title} (${d.status})`);

    const lines: string[] = ['## Project State'];
    lines.push(`- Agents (${agentList.length}): ${agentList.join(', ') || '(none)'}`);
    lines.push(`- Tools: ${tools.length} ProjectTool(s) defined`);
    lines.push(`- Auth profiles (${profileList.length}): ${profileList.join(', ') || '(none)'}`);
    lines.push(`- MCP servers (${mcpList.length}): ${mcpList.join(', ') || '(none)'}`);
    if (draftList.length > 0) {
      lines.push(`- Active integration drafts: ${draftList.join(', ')}`);
    }
    lines.push(
      'Use this snapshot silently — only call platform_context:list_* when you need fresh details (DSL bodies, full configs).',
    );

    const value = lines.join('\n');
    PROJECT_STATE_CACHE.set(cacheKey, { value, expires: now + PROJECT_STATE_TTL_MS });
    return value;
  } catch (err) {
    log.warn('projectStateSummaryLoader failed', {
      tenantId,
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Test-only helper to clear the project state cache between runs.
 * Not exported through any public barrel.
 */
export function __resetProjectStateCacheForTests(): void {
  PROJECT_STATE_CACHE.clear();
}

/**
 * If the session has an `activeIntegrationDraftId` pointer, render a snapshot
 * of the draft (provider, status, counts of bound resources, target agents,
 * pending steps, last test result) for prompt injection.
 *
 * Returns null when there is no active draft — the caller skips the section
 * entirely so no empty header is added to the prompt.
 */
export async function activeDraftSnapshotLoader(
  ctx: { tenantId: string },
  sessionId: string,
): Promise<string | null> {
  const tenantId = ctx.tenantId;
  if (!tenantId || !sessionId) {
    return null;
  }

  try {
    const sessionRaw = await ArchSessionModel.findOne({ _id: sessionId, tenantId })
      .select('metadata.activeIntegrationDraftId')
      .lean();
    const session = sessionRaw as {
      metadata?: { activeIntegrationDraftId?: string | null };
    } | null;
    const draftId = session?.metadata?.activeIntegrationDraftId;
    if (!draftId) {
      return null;
    }

    const draftRaw = await ArchIntegrationDraft.findOne({ _id: draftId, tenantId }).lean();
    const draft = draftRaw as {
      _id: string;
      providerKey: string | null;
      status: string;
      title: string;
      authProfileIds: string[];
      toolIds: string[];
      connectionIds: string[];
      targetAgentNames: string[];
      pendingSteps: string[];
      lastTestStatus: 'pass' | 'fail' | 'pending' | null;
      lastTestAt: Date | null;
    } | null;
    if (!draft) {
      return null;
    }

    const providerLabel = draft.providerKey ?? draft.title ?? 'unknown';
    const lines: string[] = ['## Active Integration'];
    lines.push('You are mid-flow on an integration setup. Current draft snapshot:');
    lines.push(`- Provider: ${providerLabel} | Status: ${draft.status}`);
    lines.push(
      `- Auth profiles: ${draft.authProfileIds.length} | Tools: ${draft.toolIds.length} | Connections: ${draft.connectionIds.length}`,
    );
    lines.push(
      `- Wired agents: ${
        draft.targetAgentNames.length > 0 ? draft.targetAgentNames.join(', ') : '(none)'
      }`,
    );
    if (Array.isArray(draft.pendingSteps) && draft.pendingSteps.length > 0) {
      lines.push(`- Pending steps: ${draft.pendingSteps.join('; ')}`);
    }
    if (draft.lastTestStatus) {
      const at = draft.lastTestAt instanceof Date ? draft.lastTestAt.toISOString() : 'unknown';
      lines.push(`- Last test: ${draft.lastTestStatus} at ${at}`);
    }
    lines.push(
      'Do not call integration_ops:get_active to learn this — call it only when making changes.',
    );

    return lines.join('\n');
  } catch (err) {
    log.warn('activeDraftSnapshotLoader failed', {
      tenantId,
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function buildTurnPlanLoaders(
  ctx: ProcessorContext,
  session: ArchSession,
): Pick<
  ResolveTurnPlanInput,
  | 'specDocumentLoader'
  | 'journalDecisionLoader'
  | 'projectMemoryLoader'
  | 'learningMemoryLoader'
  | 'projectStateSummaryLoader'
  | 'activeDraftSnapshotLoader'
> {
  return {
    specDocumentLoader: async (sessionId: string) => {
      const doc =
        session.metadata.mode === 'IN_PROJECT' && session.metadata.projectId
          ? await specDocumentService.getByProject(ctx, session.metadata.projectId, {
              unsafeProjectScope: true,
            })
          : await specDocumentService.getBySession(ctx, sessionId);
      return doc ? (doc as unknown as Record<string, unknown>) : null;
    },
    journalDecisionLoader: async (sessionId: string) => {
      const decisions = await journalService.getRecentDecisions(ctx, sessionId, 10);
      if (decisions.length === 0) {
        return null;
      }

      const bullets = decisions
        .map((decision) => {
          const content = decision.content as { summary?: string; rationale?: string };
          return `- [${decision.phase}] ${content.summary ?? decision.type}${
            content.rationale ? ` (${content.rationale})` : ''
          }`;
        })
        .join('\n');

      return `Key decisions so far:\n${bullets}`;
    },
    projectMemoryLoader: async () => {
      if (session.metadata.mode !== 'IN_PROJECT' || !session.metadata.projectId) {
        return null;
      }

      const memories = await projectMemoryService.getProjectMemories(
        ctx,
        session.metadata.projectId,
      );
      return projectMemoryService.formatMemoriesForPrompt(memories);
    },
    learningMemoryLoader: async () => {
      const learningContext: { domain?: string; phase?: string } = {
        phase: session.metadata.phase,
      };
      const description = getSessionDescription(session);
      if (description) {
        learningContext.domain = description;
      }
      const learnings = await learningMemoryService.getRelevantLearnings(learningContext);
      return learningMemoryService.formatLearningsForPrompt(learnings);
    },
    projectStateSummaryLoader: async () => {
      const projectId = session.metadata.projectId;
      if (session.metadata.mode !== 'IN_PROJECT' || !projectId) {
        return null;
      }
      return projectStateSummaryLoader({ tenantId: ctx.tenantId }, projectId);
    },
    activeDraftSnapshotLoader: async (sessionId: string) => {
      if (session.metadata.mode !== 'IN_PROJECT') {
        return null;
      }
      return activeDraftSnapshotLoader({ tenantId: ctx.tenantId }, sessionId);
    },
  };
}

export function buildSuggestionGenerator(
  session: ArchSession,
): NonNullable<TurnEngineDeps['generateSuggestions']> {
  const suggestionContext = {
    agentCount: getTopologyAgentCount(session),
    hasWarnings: hasBuildWarnings(session),
  };

  return async ({ mode, projectId }) => {
    if (mode !== 'in-project' && !projectId) {
      return [];
    }

    return generateStudioSuggestions('read_topology', null, suggestionContext).map(
      (suggestion) => suggestion.prompt,
    );
  };
}
