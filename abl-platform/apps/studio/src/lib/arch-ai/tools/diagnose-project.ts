/**
 * diagnose_project tool — full project diagnostic report.
 * Runs all 3 tiers across the entire project, returns structured report.
 */

import { createLogger } from '@abl/compiler/platform/logger.js';
import { checkToolPermission, type ToolPermissionContext } from '../guards';
import {
  buildProjectAwareDiagnosticFindings,
  mergeScopedFindingsIntoReport,
} from './project-aware-diagnostic-report';

const log = createLogger('arch-ai:diagnose-project');

const TIMEOUT_MS = 30_000;

interface DiagnoseProjectInput {
  focus?: 'handoffs' | 'tools' | 'constraints' | 'data_flow' | 'all';
}

interface DiagnoseProjectResult {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

export async function executeDiagnoseProject(
  input: DiagnoseProjectInput,
  ctx: ToolPermissionContext,
): Promise<DiagnoseProjectResult> {
  const perm = await checkToolPermission('health_check', 'run_check', ctx);
  if (!perm.allowed) {
    return {
      success: false,
      error: { code: 'FORBIDDEN', message: perm.error ?? 'Permission denied' },
    };
  }

  const { projectId, user } = ctx;
  const tenantId = user.tenantId;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const diagnosis = runDiagnosis(projectId, tenantId, input.focus ?? 'all');
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Diagnosis timed out')), TIMEOUT_MS);
    });
    const result = await Promise.race([diagnosis, timeout]);
    return { success: true, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Diagnose project failed', { projectId, error: message });
    return { success: false, error: { code: 'DIAGNOSIS_ERROR', message } };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function runDiagnosis(projectId: string, tenantId: string, focus: string) {
  const { getProjectAgents } = await import('@/services/project-service');
  const agents = await getProjectAgents(projectId, tenantId);

  if (agents.length === 0) {
    return {
      overallSeverity: 'info',
      summary: { errors: 0, warnings: 0, infos: 0, total: 0 },
      sections: [],
      topIssues: [],
      architecturePattern: 'unknown',
      antiPatterns: [],
      agentSummary: {},
      note: 'No agents in project',
    };
  }

  const { compileProjectAgentsForDiagnostics } = await import('@/lib/abl/project-aware-compile');
  const projectAwareCompilation = await compileProjectAgentsForDiagnostics({
    agents,
    projectId,
    tenantId,
  });
  const projectAwareFindings = buildProjectAwareDiagnosticFindings(projectAwareCompilation);

  // Map focus to diagnostic category
  type DiagnosticCategory = import('@agent-platform/arch-ai').DiagnosticCategory;
  const focusMap: Record<string, DiagnosticCategory | null> = {
    handoffs: 'handoff',
    tools: 'tool',
    constraints: 'constraint',
    data_flow: 'gather',
    all: null,
  };

  const { runDiagnostics } = await import('@agent-platform/arch-ai');
  const irReport = projectAwareCompilation.compiled
    ? mergeScopedFindingsIntoReport(
        runDiagnostics(projectAwareCompilation.compiled, {
          depth: 'deep',
          focus: focusMap[focus] ?? null,
          maxFindings: 100,
        }),
        projectAwareFindings,
      )
    : {
        overallSeverity: 'warning',
        summary: {
          errors: projectAwareFindings.filter((finding) => finding.severity === 'error').length,
          warnings: projectAwareFindings.filter((finding) => finding.severity === 'warning').length,
          infos: projectAwareFindings.filter((finding) => finding.severity === 'info').length,
          total: projectAwareFindings.length,
        },
        sections: [],
        topIssues: projectAwareFindings,
        architecturePattern: 'unknown',
        antiPatterns: [],
        agentSummary: {},
      };

  // ─── Project-level tool diagnostics (T-01 through T-06) ────────────
  // These require DB access (ProjectTool, VariableNamespace, agent DSL)
  // and cannot run inside the pure-function runDiagnostics engine.
  if (focus === 'tools' || focus === 'all') {
    const toolFindings = await runToolDiagnostics(projectId, tenantId, agents);
    if (toolFindings.length > 0) {
      irReport.topIssues = [
        ...(irReport.topIssues ?? []),
        ...toolFindings.map((f) => ({
          code: f.code,
          severity: f.severity,
          message: f.message,
          category: 'tool' as const,
          agentName: f.agents?.[0] ?? null,
        })),
      ];
      const errors = toolFindings.filter((f) => f.severity === 'error').length;
      const warnings = toolFindings.filter((f) => f.severity === 'warning').length;
      const infos = toolFindings.filter((f) => f.severity === 'info').length;
      irReport.summary = {
        ...irReport.summary,
        errors: (irReport.summary?.errors ?? 0) + errors,
        warnings: (irReport.summary?.warnings ?? 0) + warnings,
        infos: (irReport.summary?.infos ?? 0) + infos,
        total: (irReport.summary?.total ?? 0) + toolFindings.length,
      };
    }
  }

  return irReport;
}

// ─── Tool-Level Diagnostics (T-01 through T-06) ──────────────────────

interface ToolDiagnosticFinding {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  tool?: string;
  agents?: string[];
}

async function runToolDiagnostics(
  projectId: string,
  tenantId: string,
  agents: Array<Record<string, unknown>>,
): Promise<ToolDiagnosticFinding[]> {
  const findings: ToolDiagnosticFinding[] = [];

  try {
    const { findProjectToolsByProject } = await import('@agent-platform/shared/repos');
    const toolsResult = await findProjectToolsByProject(tenantId, projectId);
    const tools = toolsResult.data;

    // Extract tool names from agent TOOLS sections
    const { extractAllTools } = await import('@agent-platform/arch-ai');
    const agentFiles: Record<string, { path: string; content: string }> = {};
    for (const agent of agents) {
      const name = agent.name as string;
      const dsl = agent.dslContent as string | undefined;
      if (name && dsl) {
        agentFiles[name] = { path: `agents/${name}.abl.yaml`, content: dsl };
      }
    }
    const allExtracted = extractAllTools(agentFiles);

    // Build lookup maps
    const existingToolNames = new Set(tools.map((t) => t.name));
    const toolNamesInAgents = new Map<string, string[]>();
    for (const t of allExtracted) {
      const existing = toolNamesInAgents.get(t.toolName) ?? [];
      if (!existing.includes(t.agentName)) existing.push(t.agentName);
      toolNamesInAgents.set(t.toolName, existing);
    }

    // T-01: Unresolved env vars
    for (const tool of tools) {
      const envMatches = tool.dslContent.matchAll(/\{\{env\.(\w+)\}\}/g);
      for (const match of envMatches) {
        // Check if env var exists in linked namespaces
        try {
          const { VariableNamespace } = await import('@agent-platform/database/models');
          const nsIds = (tool as unknown as Record<string, unknown>).variableNamespaceIds as
            | string[]
            | undefined;
          if (nsIds && nsIds.length > 0) {
            const ns = await VariableNamespace.findOne({
              _id: { $in: nsIds },
              tenantId,
              projectId,
            }).lean();
            if (!ns) {
              findings.push({
                code: 'T-01',
                severity: 'warning',
                message: `Unresolved env var: {{env.${match[1]}}} — variable namespace not found`,
                tool: tool.name,
              });
            }
          }
        } catch (nsErr: unknown) {
          log.warn('T-01 namespace lookup failed (non-fatal)', {
            tool: tool.name,
            error: nsErr instanceof Error ? nsErr.message : String(nsErr),
          });
        }
      }
    }

    // T-02: Orphan tools (exist as ProjectTool but no agent references them)
    for (const tool of tools) {
      if (!toolNamesInAgents.has(tool.name)) {
        findings.push({
          code: 'T-02',
          severity: 'info',
          message: `Tool "${tool.name}" exists but is not referenced by any agent`,
          tool: tool.name,
        });
      }
    }

    // T-03: Missing records (agent references tool but no ProjectTool exists)
    for (const [toolName, agentNames] of toolNamesInAgents) {
      if (!existingToolNames.has(toolName)) {
        findings.push({
          code: 'T-03',
          severity: 'error',
          message: `Tool "${toolName}" referenced by ${agentNames.join(', ')} but no ProjectTool record exists`,
          tool: toolName,
          agents: agentNames,
        });
      }
    }

    // T-04: Auth heuristic — HTTP tool with auth: none on API-like URL
    for (const tool of tools) {
      if (tool.toolType !== 'http') continue;
      const hasNoAuth =
        /\bauth:\s*none\b/i.test(tool.dslContent) || !/\bauth:/i.test(tool.dslContent);
      const hasApiUrl = /\/api\/|\/v[0-9]+\//i.test(tool.dslContent);
      if (hasNoAuth && hasApiUrl) {
        findings.push({
          code: 'T-04',
          severity: 'warning',
          message: `HTTP tool "${tool.name}" has no auth configured but endpoint looks like an API URL`,
          tool: tool.name,
        });
      }
    }

    // T-05: Corrupt DSL — fails parseDslToToolForm round-trip
    try {
      const { parseDslToToolForm } = await import('@agent-platform/shared/tools');
      for (const tool of tools) {
        const toolType = tool.toolType as 'http' | 'mcp' | 'sandbox';
        if (!['http', 'mcp', 'sandbox'].includes(toolType)) continue;
        const parsed = parseDslToToolForm(tool.dslContent, toolType);
        if (!parsed) {
          findings.push({
            code: 'T-05',
            severity: 'warning',
            message: `Tool "${tool.name}" DSL cannot be parsed — may be corrupt or hand-edited`,
            tool: tool.name,
          });
        }
      }
    } catch (parseErr: unknown) {
      log.warn('T-05 DSL parse check failed (non-fatal)', {
        error: parseErr instanceof Error ? parseErr.message : String(parseErr),
      });
    }

    // T-06: Signature conflict — same tool name, different parameters across agents
    const toolParamsByAgent = new Map<string, Map<string, string[]>>();
    for (const t of allExtracted) {
      if (!toolParamsByAgent.has(t.toolName)) {
        toolParamsByAgent.set(t.toolName, new Map());
      }
      toolParamsByAgent.get(t.toolName)?.set(t.agentName, t.parameters);
    }
    for (const [toolName, agentParams] of toolParamsByAgent) {
      if (agentParams.size < 2) continue;
      const paramSigs = new Set<string>();
      for (const params of agentParams.values()) {
        paramSigs.add([...params].sort().join(','));
      }
      if (paramSigs.size > 1) {
        findings.push({
          code: 'T-06',
          severity: 'warning',
          message: `Tool "${toolName}" has different parameter signatures across agents: ${Array.from(agentParams.keys()).join(', ')}`,
          tool: toolName,
          agents: Array.from(agentParams.keys()),
        });
      }
    }
  } catch (err: unknown) {
    log.warn('Tool diagnostics failed (non-fatal)', {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return findings;
}
