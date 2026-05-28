/**
 * Integration Suggestions Engine (Task 5.2 of ABLP-162)
 *
 * Scans project agents for unbound TOOLS, matches against integration-hints,
 * surfaces broken active drafts, and returns up to 3 suggestions.
 *
 * Page-aware: biases ordering to the current entity if `pageContext` provides
 * one (currently scoped to `entity.type === 'agent'`).
 *
 * Throttled per (tenantId, projectId) for 30 minutes via Redis. If Redis is
 * unavailable, the suggestion engine still runs — caching becomes a no-op.
 */

import { createLogger } from '@abl/compiler/platform/logger.js';
import { parseAgentBasedABL } from '@abl/core/parser';
import type { PageContext } from '@agent-platform/arch-ai';
import { ArchIntegrationDraft, ProjectAgent, ProjectTool } from '@agent-platform/database/models';
import { getRedisClient } from '@/lib/redis-client';
import { matchProvidersForToolName } from '../integration-hints';

const log = createLogger('arch-ai:integration-suggestions');

const THROTTLE_TTL_S = 30 * 60;
const MAX_SUGGESTIONS = 3;

// Active draft statuses that still warrant a "fix me" surfacing.
// 'failed' drafts are the obvious candidates; others are healthy or terminal.
const BROKEN_DRAFT_STATUSES = ['failed'] as const;

export interface IntegrationSuggestionProviderOption {
  name: string;
  providerKey: string;
}

export interface IntegrationSuggestion {
  title: string;
  rationale: string;
  providerOptions: IntegrationSuggestionProviderOption[];
  targetAgentNames?: string[];
}

interface SuggestionContext {
  user: { tenantId: string };
  projectId: string;
}

interface AgentForSuggestion {
  name: string;
  dslContent: string | null;
}

/**
 * Compute integration suggestions for a project, optionally biased by page
 * context. Returns up to 3 suggestions. Throttled per project for 30 minutes.
 */
export async function computeIntegrationSuggestions(
  ctx: SuggestionContext,
  pageContext?: PageContext,
): Promise<IntegrationSuggestion[]> {
  const tenantId = ctx.user.tenantId;
  const projectId = ctx.projectId;

  const throttleKey = `arch:integration_suggestions:${tenantId}:${projectId}`;

  const cached = await readCache(throttleKey);
  if (cached) return cached;

  const [agentsRaw, toolsRaw, draftsRaw] = await Promise.all([
    ProjectAgent.find({ tenantId, projectId }).select('name dslContent').lean(),
    ProjectTool.find({ tenantId, projectId }).select('name').lean(),
    ArchIntegrationDraft.find({
      tenantId,
      projectId,
      status: { $in: BROKEN_DRAFT_STATUSES as unknown as string[] },
    })
      .select('providerKey title')
      .lean(),
  ]);

  const agents = (agentsRaw ?? []) as AgentForSuggestion[];
  const tools = (toolsRaw ?? []) as Array<{ name: string }>;
  const drafts = (draftsRaw ?? []) as Array<{ providerKey: string | null; title?: string }>;

  const toolNamesInDb = new Set(tools.map((t) => t.name));
  const suggestions: IntegrationSuggestion[] = [];

  const orderedAgents = orderAgentsByPageContext(agents, pageContext);

  for (const agent of orderedAgents) {
    if (suggestions.length >= MAX_SUGGESTIONS) break;
    const declaredToolNames = parseAgentToolNames(agent);
    for (const toolName of declaredToolNames) {
      if (suggestions.length >= MAX_SUGGESTIONS) break;
      if (toolNamesInDb.has(toolName)) continue;
      const match = matchProvidersForToolName(toolName);
      if (!match) continue;
      suggestions.push({
        title: `Connect ${match.providerKeys[0]} for ${agent.name}?`,
        rationale: `${agent.name} declares an unbound tool '${toolName}'. ${match.rationale}`,
        providerOptions: match.providerKeys.map((p) => ({ name: p, providerKey: p })),
        targetAgentNames: [agent.name],
      });
    }
  }

  for (const draft of drafts) {
    if (suggestions.length >= MAX_SUGGESTIONS) break;
    const providerKey = draft.providerKey ?? 'unknown';
    suggestions.push({
      title: `${providerKey} integration is failing`,
      rationale: 'Last test failed. Re-authorize or reconfigure?',
      providerOptions: [{ name: providerKey, providerKey }],
    });
  }

  await writeCache(throttleKey, suggestions);
  return suggestions;
}

function parseAgentToolNames(agent: AgentForSuggestion): string[] {
  if (!agent.dslContent || agent.dslContent.trim().length === 0) return [];
  try {
    const parsed = parseAgentBasedABL(agent.dslContent);
    if (!parsed.document?.tools) return [];
    return parsed.document.tools.map((t) => t.name);
  } catch (err) {
    log.warn('Failed to parse agent DSL for suggestion engine', {
      agentName: agent.name,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

function orderAgentsByPageContext(
  agents: AgentForSuggestion[],
  pageContext?: PageContext,
): AgentForSuggestion[] {
  if (!pageContext?.entity || pageContext.entity.type !== 'agent') return agents;
  const entityName = pageContext.entity.name;
  if (!entityName) return agents;
  const idx = agents.findIndex((a) => a.name === entityName);
  if (idx <= 0) return agents;
  const target = agents[idx];
  return [target, ...agents.slice(0, idx), ...agents.slice(idx + 1)];
}

async function readCache(key: string): Promise<IntegrationSuggestion[] | null> {
  const client = getRedisClient();
  if (!client) return null;
  try {
    const raw = await client.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as IntegrationSuggestion[];
  } catch (err) {
    log.warn('Failed to read suggestion cache', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function writeCache(key: string, value: IntegrationSuggestion[]): Promise<void> {
  const client = getRedisClient();
  if (!client) return;
  try {
    await client.set(key, JSON.stringify(value), 'EX', THROTTLE_TTL_S);
  } catch (err) {
    log.warn('Failed to write suggestion cache', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
