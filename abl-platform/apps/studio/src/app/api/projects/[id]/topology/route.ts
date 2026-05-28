/**
 * GET /api/projects/:id/topology - Get project topology and agent summaries
 *
 * Compiles all project agents to IR and extracts the inter-agent topology graph.
 * Returns simplified nodes/edges for visualization plus per-agent summaries.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getProjectAgents } from '@/services/project-service';
import { requireAuth, isAuthError } from '@/lib/auth';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { extractAppStaticGraph } from '@abl/compiler/platform/ir/app-graph-extractor.js';
import { compileProjectAgentsForDiagnostics } from '@/lib/abl/project-aware-compile';

const log = createLogger('api:projects:topology');

type RouteParams = { params: Promise<{ id: string }> };

interface TopologyNode {
  id: string;
  name: string;
  type: 'supervisor' | 'agent';
  isEntry: boolean;
  executionMode: 'reasoning' | 'scripted' | 'hybrid';
  flowStepCount: number;
}

interface TopologyEdge {
  from: string;
  to: string;
  type: 'handoff' | 'delegate';
  label?: string;
  condition?: string;
  returns?: boolean;
  experienceMode?:
    | 'shared_voice_handoff'
    | 'visible_handoff'
    | 'silent_delegate'
    | 'human_escalation';
}

interface AgentSummary {
  toolsCount: number;
  gatherFieldsCount: number;
  flowStepCount: number;
  executionMode: 'reasoning' | 'scripted' | 'hybrid';
  goal: string | null;
  description: string | null;
}

interface ErrorSummary {
  failedAgentCount: number;
  totalErrorCount: number;
}

interface TopologyResponse {
  topology: {
    nodes: TopologyNode[];
    edges: TopologyEdge[];
  };
  agentSummaries: Record<string, AgentSummary>;
  errors?: string[];
  errorSummary?: ErrorSummary;
}

/** Derive execution mode: reasoning-only, scripted (all deterministic), or hybrid (mixed). */
function deriveExecutionMode(agentIR: {
  flow?: { steps?: string[]; definitions?: Record<string, { reasoning_zone?: unknown }> };
}): 'reasoning' | 'scripted' | 'hybrid' {
  if (!agentIR.flow) return 'reasoning';
  const defs = agentIR.flow.definitions ?? {};
  const hasReasoningZone = Object.values(defs).some((d) => d.reasoning_zone);
  return hasReasoningZone ? 'hybrid' : 'scripted';
}

const EMPTY_RESPONSE: TopologyResponse = {
  topology: { nodes: [], edges: [] },
  agentSummaries: {},
};

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id } = await params;

  const access = await requireProjectAccess(id, user);
  if (isAccessError(access)) return access;

  try {
    const agents = await getProjectAgents(id, access.project.tenantId);

    const errors: string[] = [];
    const failedAgents = new Set<string>(); // Track unique failed agent names

    const diagnosticCompile = await compileProjectAgentsForDiagnostics({
      agents,
      projectId: id,
      tenantId: access.project.tenantId,
    });
    for (const parseError of diagnosticCompile.parseErrors) {
      failedAgents.add(parseError.agent);
      errors.push(
        ...parseError.errors.map(
          (e: { line?: number; message: string }) =>
            `${parseError.agent}: Line ${e.line ?? '?'}: ${e.message}`,
        ),
      );
    }
    errors.push(...diagnosticCompile.errors);
    errors.push(...diagnosticCompile.warnings);

    // No parseable agents — return empty topology with error summary
    if (!diagnosticCompile.compiled) {
      if (errors.length > 0) {
        const errorSummary: ErrorSummary = {
          failedAgentCount: failedAgents.size,
          totalErrorCount: errors.length,
        };
        return NextResponse.json({
          ...EMPTY_RESPONSE,
          errors,
          errorSummary,
        });
      }
      return NextResponse.json(EMPTY_RESPONSE);
    }

    const compilation = diagnosticCompile.compiled;

    // Collect compilation errors
    if (compilation.compilation_errors?.length) {
      for (const ce of compilation.compilation_errors) {
        if (ce.agent) {
          failedAgents.add(ce.agent); // Track agent with compilation error
        }
        errors.push(`${ce.agent}: ${ce.message}`);
      }
    }

    // Extract the app-level static graph
    const appGraph = extractAppStaticGraph(compilation, 'project');

    // Build simplified topology nodes
    const entryAgentName = appGraph.app.entryAgent;
    const nodes: TopologyNode[] = appGraph.app.agents
      .filter((agentName) => compilation.agents[agentName])
      .map((agentName) => {
        const agentIR = compilation.agents[agentName];
        return {
          id: agentName,
          name: agentName,
          type:
            agentIR.metadata.type === 'supervisor' ? ('supervisor' as const) : ('agent' as const),
          isEntry: agentName === entryAgentName,
          executionMode: deriveExecutionMode(agentIR),
          flowStepCount: agentIR.flow?.steps?.length ?? 0,
        };
      });

    // Build simplified topology edges (filter out edges referencing agents that failed to compile)
    const nodeIds = new Set(nodes.map((n) => n.id));
    const edges: TopologyEdge[] = appGraph.app.connections
      .filter((conn) => nodeIds.has(conn.from) && nodeIds.has(conn.to))
      .map((conn) => ({
        from: conn.from,
        to: conn.to,
        type: conn.type,
        condition: conn.when,
        returns: conn.returns,
        experienceMode: conn.experienceMode,
        ...(conn.label && { label: conn.label }),
      }));

    // Build per-agent summaries
    const agentSummaries: Record<string, AgentSummary> = {};
    for (const [name, agentIR] of Object.entries(compilation.agents)) {
      agentSummaries[name] = {
        toolsCount: agentIR.tools.length,
        gatherFieldsCount: agentIR.gather.fields.length,
        flowStepCount: agentIR.flow?.steps?.length ?? 0,
        executionMode: agentIR.flow ? 'scripted' : 'reasoning',
        goal: agentIR.identity.goal || null,
        description: agentIR.identity.persona || null,
      };
    }

    const response: TopologyResponse = {
      topology: { nodes, edges },
      agentSummaries,
      ...(errors.length > 0 && {
        errors,
        errorSummary: {
          failedAgentCount: failedAgents.size,
          totalErrorCount: errors.length,
        },
      }),
    };

    return NextResponse.json(response);
  } catch (error) {
    log.error('Topology route failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}
