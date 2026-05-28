import { createLogger } from '@abl/compiler/platform/logger.js';
import {
  extractRoutingEdgesFromDslFallback,
  extractRoutingEdgesFromParsedDocument,
} from '@/lib/arch-ai/routing-edge-extraction';
import { checkToolPermission, type ToolPermissionContext } from '../guards';

const log = createLogger('arch-ai:topology-ops');

interface TopologyOpsInput {
  action: 'read' | 'modify';
  changes?: {
    addAgents?: Array<{ name: string; type: string }>;
    removeAgents?: string[];
    addEdges?: Array<{ from: string; to: string; type: string; condition?: string }>;
    removeEdges?: Array<{ from: string; to: string }>;
  };
  confirmed?: boolean;
}

interface TopologyOpsResult {
  success?: boolean;
  data?: unknown;
  error?: { code: string; message: string };
  needsConfirmation?: boolean;
  warning?: string;
}

export async function executeTopologyOps(
  input: TopologyOpsInput,
  ctx: ToolPermissionContext,
): Promise<TopologyOpsResult> {
  const { action } = input;
  const { projectId, user } = ctx;
  const tenantId = user.tenantId;

  const perm = await checkToolPermission('topology_ops', action, ctx);
  if (!perm.allowed) {
    return {
      success: false,
      error: { code: 'FORBIDDEN', message: perm.error ?? 'Permission denied' },
    };
  }

  switch (action) {
    case 'read':
      return readTopology(projectId, tenantId);
    case 'modify':
      if (!input.confirmed) {
        return {
          needsConfirmation: true,
          warning: 'Modify project topology?',
          data: { preview: input.changes },
        };
      }
      return modifyTopology(projectId, input.changes!, tenantId);
    default:
      return {
        success: false,
        error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` },
      };
  }
}

async function readTopology(projectId: string, tenantId: string): Promise<TopologyOpsResult> {
  const { getProjectAgents } = await import('@/services/project-service');
  const agents = await getProjectAgents(projectId, tenantId);

  if (agents.length === 0) {
    return { success: true, data: { agents: [], edges: [] } };
  }

  // Parse all agents and extract handoff/delegate relationships
  const nodes: Array<{ name: string; type: string; hasDsl: boolean; description: string | null }> =
    [];
  const edges: Array<{ from: string; to: string; type: string }> = [];

  // TP-01/TP-02 fix: Use parser output for type detection and handoff extraction
  // instead of brittle regex that matches comments and misses complex syntax.
  const { parseAgentBasedABL } = await import('@abl/core');

  for (const agent of agents) {
    const a = agent as Record<string, unknown>;
    const dslContent = (a.dslContent as string) ?? '';
    const agentName = a.name as string;

    // Parse once per agent for both type detection and edge extraction
    let parsedType = 'agent';
    const parsedEdges: Array<{ from: string; to: string; type: string }> = [];

    if (dslContent.trim()) {
      try {
        const result = parseAgentBasedABL(dslContent);
        const doc = result.document as Record<string, unknown> | null;
        if (doc) {
          // TP-01: Parser-based type detection (not string includes)
          parsedType = (doc.type as string) === 'supervisor' ? 'supervisor' : 'agent';

          parsedEdges.push(...extractRoutingEdgesFromParsedDocument(doc, agentName));
        }
      } catch (err: unknown) {
        // Parser failed — fall back to regex extraction for this agent
        log.warn('ABL parser failed for agent — using regex fallback', {
          agentName,
          error: err instanceof Error ? err.message : String(err),
        });
        parsedType = detectAgentType(dslContent);
        parsedEdges.push(...extractRoutingEdgesFromDslFallback(dslContent, agentName));
      }
    }

    nodes.push({
      name: agentName,
      type: parsedType,
      hasDsl: Boolean(dslContent.trim()),
      description: (a.description as string) ?? null,
    });
    edges.push(...parsedEdges);
  }

  return {
    success: true,
    data: { agents: nodes, edges, agentCount: nodes.length, edgeCount: edges.length },
  };
}

function detectAgentType(dslContent: string | null): string {
  if (!dslContent) return 'agent';
  if (dslContent.includes('SUPERVISOR:')) return 'supervisor';
  return 'agent';
}

async function modifyTopology(
  projectId: string,
  changes: NonNullable<TopologyOpsInput['changes']>,
  tenantId: string,
): Promise<TopologyOpsResult> {
  // TODO: Implement topology modification (add/remove agents, update handoff sections)
  // This requires creating/deleting agents and updating DSL sections.
  // For now, return a description of what would change.
  log.info('Topology modification requested', { projectId, changes });
  return {
    success: false,
    error: {
      code: 'NOT_IMPLEMENTED',
      message: 'Topology modification is coming soon. Use agent_ops to modify individual agents.',
    },
  };
}
