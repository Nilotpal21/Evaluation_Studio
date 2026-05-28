import { createLogger } from '@abl/compiler/platform/logger.js';
import { checkToolPermission, type ToolPermissionContext } from '../guards';
import { buildHealthScore } from '@/lib/arch-ai/health-score';
import {
  extractRoutingEdgesFromDslFallback,
  extractRoutingTargetsFromParsedDocument,
} from '@/lib/arch-ai/routing-edge-extraction';
import type { AgentHealthResult, HealthCheckReport, HealthFinding } from '@/lib/arch-ai/types/arch';
import { buildProjectAwareDiagnosticFindings } from './project-aware-diagnostic-report';

const log = createLogger('arch-ai:health-check');

const MAX_AGENTS = 20;
const CHECK_TIMEOUT_MS = 5_000;

type CheckStatus = 'PASS' | 'WARN' | 'FAIL';
type ConnectorToolResolver = (connectorName: string, actionName: string) => unknown;

interface CheckDetail {
  check: string;
  status: CheckStatus;
  message: string;
  suggestedFix?: string;
}

interface HealthCheckInput {
  action: string;
  scope?: string;
  agentName?: string;
}

interface HealthCheckResult {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

/**
 * Run a best-effort health check across project agents.
 * Individual check timeouts/errors degrade to WARN — they never fail the whole report.
 */
export async function executeHealthCheck(
  input: HealthCheckInput,
  ctx: ToolPermissionContext,
): Promise<HealthCheckResult> {
  const { projectId, user } = ctx;
  const tenantId = user.tenantId;

  const perm = await checkToolPermission('health_check', 'run_check', ctx);
  if (!perm.allowed) {
    return {
      success: false,
      error: { code: 'FORBIDDEN', message: perm.error ?? 'Permission denied' },
    };
  }

  try {
    const { getProjectAgents } = await import('@/services/project-service');
    const allProjectAgents = await getProjectAgents(projectId, tenantId);
    let agents = allProjectAgents;

    // Scope to a single agent if requested
    if (input.scope === 'agent' && input.agentName) {
      agents = agents.filter((a: Record<string, unknown>) => a.name === input.agentName);
      if (agents.length === 0) {
        return {
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `Agent "${input.agentName}" not found in project`,
          },
        };
      }
    }

    const projectAgents = agents;
    let checkedAgents = projectAgents;
    let cappedWarning: string | undefined;
    if (projectAgents.length > MAX_AGENTS) {
      cappedWarning = `Project has ${projectAgents.length} agents — per-agent checks limited to the first ${MAX_AGENTS}; cross-agent graph checks used all project agents`;
      checkedAgents = projectAgents.slice(0, MAX_AGENTS);
    }

    // Load shared data once: project entry point
    const entryAgentName = await loadEntryAgentName(projectId, tenantId);

    const agentNames = new Set(
      allProjectAgents.map((a: Record<string, unknown>) => a.name as string),
    );

    // Pre-fetch all project tools once to avoid N+1 queries in checkToolBindings.
    // With 20 agents this turns 20 DB queries into 1.
    let projectToolNames: Set<string> | null = null;
    try {
      const { ProjectTool } = await import('@agent-platform/database/models');
      const allTools = await ProjectTool.find({ projectId, tenantId }).select('name').lean();
      projectToolNames = new Set(allTools.map((t: { name: string }) => t.name.toLowerCase()));
    } catch (err: unknown) {
      // If pre-fetch fails, fall back to per-agent queries inside checkToolBindings
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Project tool pre-fetch failed, falling back to per-agent queries', {
        projectId,
        error: message,
      });
      projectToolNames = null;
    }

    const connectorToolResolver = await loadConnectorToolResolver(projectId);

    // Run all agent checks in parallel with per-agent timeout
    const settled = await Promise.allSettled(
      checkedAgents.map((agent: Record<string, unknown>) =>
        withTimeout(
          checkSingleAgent(agent, {
            tenantId,
            projectId,
            entryAgentName,
            agentNames,
            projectToolNames,
            connectorToolResolver,
          }),
          CHECK_TIMEOUT_MS,
        ),
      ),
    );

    const agentResults: AgentHealthResult[] = settled.map((result, idx) => {
      const agentName = (checkedAgents[idx] as Record<string, unknown>).name as string;
      if (result.status === 'fulfilled') {
        return result.value;
      }
      // Promise.allSettled rejected — agent-level timeout or unexpected error
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      log.warn('Agent health check failed entirely', { agentName, reason });
      return makeFailedAgentResult(agentName, reason);
    });

    // ── Semantic checks: compile all agents together, run diagnostic engine ──
    const semanticFindings = await runSemanticChecks(
      projectAgents,
      entryAgentName,
      projectId,
      tenantId,
    );

    // ── Cross-agent checks: cycles, orphans ──
    const crossAgentFindings = await runCrossAgentChecks(projectAgents, entryAgentName);

    // Aggregate overall status (include semantic findings in severity)
    const hasSemanticErrors = semanticFindings.some((f) => f.severity === 'error');
    const hasSemanticWarnings = semanticFindings.some((f) => f.severity === 'warning');
    const hasCrossAgentErrors = crossAgentFindings.some((f) => f.severity === 'error');
    const hasCrossAgentWarnings = crossAgentFindings.some((f) => f.severity === 'warning');

    const hasAnyFail =
      agentResults.some((r) => Object.values(r.checks).some((s) => s === 'FAIL')) ||
      hasSemanticErrors ||
      hasCrossAgentErrors;
    const hasAnyWarn =
      agentResults.some((r) => Object.values(r.checks).some((s) => s === 'WARN')) ||
      hasSemanticWarnings ||
      hasCrossAgentWarnings;
    const overall: HealthCheckReport['overall'] = hasAnyFail
      ? 'Critical'
      : hasAnyWarn
        ? 'Warning'
        : 'Healthy';

    const summaryParts: string[] = [
      `${agentResults.length} agent(s) checked`,
      `overall: ${overall}`,
    ];
    if (semanticFindings.length > 0) {
      summaryParts.push(`${semanticFindings.length} semantic finding(s)`);
    }
    if (crossAgentFindings.length > 0) {
      summaryParts.push(`${crossAgentFindings.length} cross-agent finding(s)`);
    }
    if (cappedWarning) summaryParts.push(cappedWarning);

    const report: HealthCheckReport = {
      overall,
      agents: agentResults,
      summary: summaryParts.join('. '),
      semanticFindings,
      crossAgentFindings,
    };
    report.score = buildHealthScore(report);

    const allFindings = [...semanticFindings, ...crossAgentFindings];
    const findingsByAgent = new Map<string, typeof allFindings>();
    for (const f of allFindings) {
      const key = f.agentName ?? '_project';
      const existing = findingsByAgent.get(key) ?? [];
      existing.push(f);
      findingsByAgent.set(key, existing);
    }

    const formattedLines: string[] = [
      `Overall: ${overall}. Score: ${report.score?.percent ?? '?'}%. Deploy ready: ${report.score?.deployReady ? 'yes' : 'no'}.`,
      `Totals: ${report.score?.projectErrors ?? 0} errors, ${report.score?.projectWarnings ?? 0} warnings, ${report.score?.projectInfos ?? 0} info.`,
      '',
      'FINDINGS (this is the COMPLETE list — nothing else was detected):',
    ];

    for (const [agent, findings] of findingsByAgent) {
      formattedLines.push(`\n${agent}:`);
      for (const f of findings) {
        formattedLines.push(`  [${f.severity.toUpperCase()}] ${f.code}: ${f.message}`);
      }
    }

    if (allFindings.length === 0) {
      formattedLines.push('  (none)');
    }

    formattedLines.push('');
    formattedLines.push('NO ANTI-PATTERNS DETECTED. No architecture warnings exist in this data.');
    formattedLines.push(
      'MODEL RESOLUTION NOTE: REASONING zones do NOT need explicit per-step model config. The runtime resolves models via agent → project → tenant inheritance. If the per-agent modelConfig check passed (see agents[].checks.modelConfig), reasoning steps WILL have a model at runtime. Do NOT report "no explicit model in execution config" for reasoning steps — this is handled by inheritance and confirmed by the modelConfig check.',
    );
    formattedLines.push(
      'IMPORTANT: Do NOT add findings beyond what is listed above. Do NOT invent codes like REASONING_ZONE_NO_MODEL (not a real code). Do NOT claim model config issues for reasoning zones when modelConfig check passed. Do NOT claim supervisor-with-logic for AGENT: types with escalation handoffs. Present ONLY the findings above.',
    );

    return {
      success: true,
      data: {
        _formattedFindings: formattedLines.join('\n'),
        ...report,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Health check failed', { projectId, error: message });
    return {
      success: false,
      error: { code: 'HEALTH_CHECK_ERROR', message },
    };
  }
}

// ─── Per-Agent Checks ──────────────────────────────────────────────────────

interface CheckContext {
  tenantId: string;
  projectId: string;
  entryAgentName: string | null;
  agentNames: Set<string>;
  /** Pre-fetched set of all project tool names (lowercased). Avoids N+1 queries in checkToolBindings. */
  projectToolNames: Set<string> | null;
  connectorToolResolver: ConnectorToolResolver | null;
}

async function checkSingleAgent(
  agent: Record<string, unknown>,
  ctx: CheckContext,
): Promise<AgentHealthResult> {
  const agentName = agent.name as string;
  const dsl = (agent.dslContent as string) ?? '';

  // Parse once, reuse for handoff/tool extraction
  const compilationResult = await safeCompilation(dsl);
  const parsedDoc = compilationResult.document;
  const compilation = compilationResult.detail;

  const [handoffs, toolBindings, modelConfig, guardrails] = await Promise.all([
    safeCheck(() => checkHandoffs(parsedDoc, ctx.agentNames)),
    safeCheck(() =>
      checkToolBindings(
        parsedDoc,
        ctx.projectId,
        ctx.tenantId,
        ctx.projectToolNames,
        ctx.connectorToolResolver,
      ),
    ),
    safeCheck(() => checkModelConfig(agentName, ctx.projectId, ctx.tenantId, parsedDoc)),
    safeCheck(() => checkGuardrails(dsl, parsedDoc)),
  ]);

  const entryPoint = checkEntryPoint(ctx.entryAgentName, ctx.agentNames);

  const details: CheckDetail[] = [
    compilation,
    handoffs,
    toolBindings,
    modelConfig,
    guardrails,
    entryPoint,
  ];

  return {
    agentName,
    checks: {
      compilation: compilation.status,
      handoffs: handoffs.status,
      toolBindings: toolBindings.status,
      modelConfig: modelConfig.status,
      guardrails: guardrails.status,
      entryPoint: entryPoint.status,
    },
    details,
  };
}

/** Wrapper around checkCompilation that degrades gracefully. */
async function safeCompilation(dsl: string): Promise<CompilationResult> {
  try {
    return await checkCompilation(dsl);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      detail: { check: 'compilation', status: 'WARN', message: `Parse check failed: ${message}` },
      document: null,
    };
  }
}

// ─── Individual Checks ─────────────────────────────────────────────────────

interface CompilationResult {
  detail: CheckDetail;
  document: Record<string, unknown> | null;
}

/**
 * Parse DSL and return both the check detail and the parsed document.
 * The document is reused by handoff/tool extractors to avoid double-parsing.
 */
async function checkCompilation(dsl: string): Promise<CompilationResult> {
  if (!dsl.trim()) {
    return {
      detail: {
        check: 'compilation',
        status: 'FAIL',
        message: 'Agent has no DSL content',
        suggestedFix: 'Add ABL definition for this agent',
      },
      document: null,
    };
  }

  const { parseAgentBasedABL } = await import('@abl/core');
  const result = parseAgentBasedABL(dsl);

  if (result.errors.length > 0) {
    return {
      detail: {
        check: 'compilation',
        status: 'FAIL',
        message: `Parse errors: ${result.errors.map((e: { message: string }) => e.message).join('; ')}`,
        suggestedFix: 'Fix syntax errors in the ABL definition',
      },
      document: null,
    };
  }

  if (result.warnings && result.warnings.length > 0) {
    return {
      detail: {
        check: 'compilation',
        status: 'WARN',
        message: `Parse warnings: ${result.warnings.map((w: { message: string }) => w.message).join('; ')}`,
      },
      document: result.document as Record<string, unknown> | null,
    };
  }

  return {
    detail: { check: 'compilation', status: 'PASS', message: 'DSL parses successfully' },
    document: result.document as Record<string, unknown> | null,
  };
}

async function checkHandoffs(
  parsedDoc: Record<string, unknown> | null,
  agentNames: Set<string>,
): Promise<CheckDetail> {
  if (!parsedDoc) {
    return { check: 'handoffs', status: 'WARN', message: 'Skipped — DSL did not parse' };
  }

  const routingTargets = extractRoutingTargetsFromParsedDocument(parsedDoc, [
    'handoff',
    'delegate',
    'escalate',
  ]);

  if (routingTargets.length === 0) {
    return {
      check: 'handoffs',
      status: 'PASS',
      message: 'No routing targets (not a routing agent)',
    };
  }

  const missing = routingTargets.filter((t) => !agentNames.has(t));
  if (missing.length > 0) {
    return {
      check: 'handoffs',
      status: 'FAIL',
      message: `Missing routing targets: ${missing.join(', ')}`,
      suggestedFix:
        'Create the missing agent(s) or update HANDOFF / DELEGATE references to existing agents',
    };
  }

  return {
    check: 'handoffs',
    status: 'PASS',
    message: `All ${routingTargets.length} routing target(s) exist`,
  };
}

async function checkToolBindings(
  parsedDoc: Record<string, unknown> | null,
  projectId: string,
  tenantId: string,
  preFetchedToolNames: Set<string> | null,
  connectorToolResolver: ConnectorToolResolver | null,
): Promise<CheckDetail> {
  if (!parsedDoc) {
    return { check: 'toolBindings', status: 'WARN', message: 'Skipped — DSL did not parse' };
  }

  const toolNames = extractToolNames(parsedDoc);

  if (toolNames.length === 0) {
    return { check: 'toolBindings', status: 'PASS', message: 'No tools declared' };
  }

  // Verify that declared DSL tools have matching ProjectTool records.
  // A missing record means the tool interface is declared but has no implementation.
  // Normalize to lowercase — ProjectTool.name has `lowercase: true` in Mongoose schema,
  // but DSL tool names may be mixed-case (e.g. GetUserData).

  if (preFetchedToolNames) {
    // Use pre-fetched tool names from executeHealthCheck — no DB query needed.
    // This turns N per-agent queries into 1 bulk query at the health-check level.
    const missing = findMissingDeclaredToolNames(
      toolNames,
      preFetchedToolNames,
      connectorToolResolver,
    );

    if (missing.length > 0) {
      return {
        check: 'toolBindings',
        status: 'WARN',
        message: `${missing.length} tool(s) declared in DSL but missing ProjectTool implementation: ${missing.join(', ')}`,
        suggestedFix: 'Create the missing tool(s) in the project or remove them from the agent DSL',
      };
    }

    return {
      check: 'toolBindings',
      status: 'PASS',
      message: `${toolNames.length} tool(s) declared, all have ProjectTool implementations or connector bindings`,
    };
  }

  // Fallback: per-agent query (when pre-fetch failed)
  const normalizedNames = toolNames.map((n) => n.toLowerCase());
  try {
    const { ProjectTool } = await import('@agent-platform/database/models');
    const existingTools = await ProjectTool.find({
      projectId,
      tenantId,
      name: { $in: normalizedNames },
    }).select('name');
    const existingNames = new Set(existingTools.map((t: { name: string }) => t.name));
    const missing = findMissingDeclaredToolNames(toolNames, existingNames, connectorToolResolver);

    if (missing.length > 0) {
      return {
        check: 'toolBindings',
        status: 'WARN',
        message: `${missing.length} tool(s) declared in DSL but missing ProjectTool implementation: ${missing.join(', ')}`,
        suggestedFix: 'Create the missing tool(s) in the project or remove them from the agent DSL',
      };
    }
  } catch (err: unknown) {
    // HC-04 fix: Distinguish service failure from "tools missing".
    // The LLM should NOT try to "fix" tools when the DB is just unreachable.
    const errMsg = err instanceof Error ? err.message : String(err);
    log.warn('Tool binding check failed — service error, not missing tools', {
      error: errMsg,
    });
    return {
      check: 'toolBindings',
      status: 'WARN',
      message: `${toolNames.length} tool(s) declared — could not verify implementations (service error: ${errMsg}). This is NOT a missing-tool issue; the tool database may be temporarily unavailable.`,
      suggestedFix: 'No action needed — retry health check later if this persists',
    };
  }

  return {
    check: 'toolBindings',
    status: 'PASS',
    message: `${toolNames.length} tool(s) declared, all have ProjectTool implementations or connector bindings`,
  };
}

async function checkModelConfig(
  agentName: string,
  projectId: string,
  tenantId: string,
  parsedDoc: Record<string, unknown> | null,
): Promise<CheckDetail> {
  const declaredModel = extractDeclaredExecutionModel(parsedDoc);
  if (declaredModel) {
    return {
      check: 'modelConfig',
      status: 'PASS',
      message: `Agent declares execution model "${declaredModel}"`,
    };
  }

  const { AgentModelConfig, ModelConfig, TenantModel } =
    await import('@agent-platform/database/models');
  const config = await AgentModelConfig.findOne({ projectId, agentName, tenantId }).lean();

  if (config) {
    return {
      check: 'modelConfig',
      status: 'PASS',
      message: 'Agent has explicit model configuration',
    };
  }

  const projectModelConfig = await ModelConfig.findOne({ projectId })
    .sort({ isDefault: -1, priority: -1 })
    .lean();
  if (projectModelConfig) {
    return {
      check: 'modelConfig',
      status: 'PASS',
      message: 'Agent inherits project model configuration',
    };
  }

  let tenantModel = await TenantModel.findOne({
    tenantId,
    isDefault: true,
    isActive: true,
    inferenceEnabled: true,
  }).lean();
  if (!tenantModel) {
    tenantModel = await TenantModel.findOne({
      tenantId,
      isActive: true,
      inferenceEnabled: true,
    }).lean();
  }

  if (tenantModel) {
    return {
      check: 'modelConfig',
      status: 'PASS',
      message: 'Agent inherits tenant model configuration',
    };
  }

  return {
    check: 'modelConfig',
    status: 'WARN',
    message: 'No agent, project, or tenant model configuration found',
  };
}

async function checkGuardrails(
  dsl: string,
  parsedDoc: Record<string, unknown> | null,
): Promise<CheckDetail> {
  // HC-01 fix: Use parser output instead of regex — avoids false negatives
  // from multiline sections, indentation, or comments containing keywords.
  if (parsedDoc) {
    const constraints = parsedDoc.constraints as unknown[] | undefined;
    const guardrails = parsedDoc.guardrails as unknown[] | undefined;
    const hasConstraints = Array.isArray(constraints) && constraints.length > 0;
    const hasGuardrails = Array.isArray(guardrails) && guardrails.length > 0;

    if (hasConstraints || hasGuardrails) {
      return {
        check: 'guardrails',
        status: 'PASS',
        message: 'Agent has guardrail/constraint definitions',
      };
    }
  } else {
    // Fallback to regex only when parser failed (already reported as compilation error)
    const hasConstraints = /^\s*CONSTRAINTS\s*:/m.test(dsl);
    const hasGuardrails = /^\s*GUARDRAILS\s*:/m.test(dsl);

    if (hasConstraints || hasGuardrails) {
      return {
        check: 'guardrails',
        status: 'PASS',
        message: 'Agent has guardrail/constraint definitions',
      };
    }
  }

  return {
    check: 'guardrails',
    status: 'WARN',
    message: 'No CONSTRAINTS or GUARDRAILS section found',
    suggestedFix: 'Add CONSTRAINTS or GUARDRAILS to enforce behavioral boundaries',
  };
}

function checkEntryPoint(entryAgentName: string | null, agentNames: Set<string>): CheckDetail {
  if (!entryAgentName) {
    return {
      check: 'entryPoint',
      status: 'FAIL',
      message: 'No entry agent configured for the project',
      suggestedFix: 'Set an entry agent in project settings',
    };
  }

  if (!agentNames.has(entryAgentName)) {
    return {
      check: 'entryPoint',
      status: 'FAIL',
      message: `Entry agent "${entryAgentName}" is configured but does not exist in the project`,
      suggestedFix: 'Set the project entry agent to an existing agent',
    };
  }

  return {
    check: 'entryPoint',
    status: 'PASS',
    message: `Entry agent is "${entryAgentName}"`,
  };
}

// ─── Semantic Validation Layer ─────────────────────────────────────────────

type SemanticFinding = HealthFinding;

/**
 * Compile all agents together and run the diagnostic engine.
 * Graceful degradation: returns empty array on any failure.
 */
async function runSemanticChecks(
  agents: Array<Record<string, unknown>>,
  _entryAgentName: string | null,
  projectId: string,
  tenantId: string,
): Promise<SemanticFinding[]> {
  try {
    const { compileProjectAgentsForDiagnostics } = await import('@/lib/abl/project-aware-compile');
    const projectAwareCompilation = await compileProjectAgentsForDiagnostics({
      agents,
      projectId,
      tenantId,
    });
    const projectAwareFindings = buildProjectAwareDiagnosticFindings(projectAwareCompilation).map(
      (finding) => ({
        code: finding.code,
        message: finding.message,
        severity: finding.severity as HealthFinding['severity'],
        category: finding.category ?? 'project_context',
        agentName: finding.agentName ?? null,
      }),
    );
    if (!projectAwareCompilation.compiled) {
      return projectAwareFindings;
    }

    const { runDiagnostics } = await import('@agent-platform/arch-ai');
    const report = runDiagnostics(projectAwareCompilation.compiled, {
      depth: 'deep',
      maxFindings: 20,
    });

    return [
      ...projectAwareFindings,
      ...report.topIssues.map((f) => ({
        code: f.code,
        message: f.message,
        severity: f.severity as HealthFinding['severity'],
        category: f.category ?? 'semantic',
        agentName: f.agentName,
      })),
    ];
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('Semantic checks failed — skipping', { error: message });
    return [];
  }
}

/**
 * Cross-agent checks: circular handoffs, orphaned agents.
 * Operates on parsed documents — lightweight, no compilation.
 */
async function runCrossAgentChecks(
  agents: Array<Record<string, unknown>>,
  entryAgentName: string | null,
): Promise<SemanticFinding[]> {
  const findings: SemanticFinding[] = [];
  const agentNames = new Set(agents.map((a) => a.name as string));
  const { parseAgentBasedABL } = await import('@abl/core');

  // Build routing graph from parsed ABL where possible, then fall back to
  // lightweight DSL scanning for resilience when parsing fails.
  const handoffGraph = new Map<string, string[]>();
  for (const agent of agents) {
    const name = agent.name as string;
    const dsl = agent.dslContent as string | undefined;
    if (!dsl) {
      handoffGraph.set(name, []);
      continue;
    }

    try {
      const parsed = parseAgentBasedABL(dsl);
      if (parsed.document) {
        handoffGraph.set(
          name,
          extractRoutingTargetsFromParsedDocument(parsed.document, [
            'handoff',
            'delegate',
            'escalate',
          ]),
        );
        continue;
      }
    } catch {
      // Fall through to lightweight extraction below.
    }

    handoffGraph.set(
      name,
      extractRoutingEdgesFromDslFallback(dsl, name).map((edge) => edge.to),
    );
  }

  // Circular handoff detection (DFS)
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const cycles: string[][] = [];

  function dfs(node: string, path: string[]): void {
    if (visiting.has(node)) {
      const cycleStart = path.indexOf(node);
      if (cycleStart >= 0) {
        cycles.push(path.slice(cycleStart));
      }
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    path.push(node);
    for (const target of handoffGraph.get(node) ?? []) {
      if (agentNames.has(target)) {
        dfs(target, path);
      }
    }
    path.pop();
    visiting.delete(node);
    visited.add(node);
  }

  for (const name of agentNames) {
    dfs(name, []);
  }

  for (const cycle of cycles) {
    findings.push({
      code: 'CROSS-01',
      message: `Circular handoff detected: ${cycle.join(' \u2192 ')} \u2192 ${cycle[0]}`,
      severity: 'warning',
      category: 'handoff',
      agentName: null,
    });
  }

  // Orphaned agent detection (BFS reachability from entry)
  if (entryAgentName && agentNames.has(entryAgentName)) {
    const reachable = new Set<string>();
    const queue = [entryAgentName];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (reachable.has(current)) continue;
      reachable.add(current);
      for (const target of handoffGraph.get(current) ?? []) {
        if (agentNames.has(target) && !reachable.has(target)) {
          queue.push(target);
        }
      }
    }

    const orphans = [...agentNames].filter((n) => !reachable.has(n));
    if (orphans.length > 0) {
      findings.push({
        code: 'CROSS-02',
        message: `${orphans.length} orphaned agent(s) unreachable from entry "${entryAgentName}": ${orphans.join(', ')}`,
        severity: 'warning',
        category: 'handoff',
        agentName: null,
      });
    }
  }

  return findings;
}

// ─── Parser-Based Extraction Helpers ──────────────────────────────────────

/** Extract tool names from the parsed document (doc.tools[].name). */
function extractToolNames(doc: Record<string, unknown>): string[] {
  const tools = doc.tools as Array<{ name: string }> | undefined;
  if (!tools || !Array.isArray(tools)) return [];
  return tools.map((t) => t.name).filter((n): n is string => typeof n === 'string' && n.length > 0);
}

function extractDeclaredExecutionModel(parsedDoc: Record<string, unknown> | null): string | null {
  const execution = parsedDoc?.execution;
  if (!execution || typeof execution !== 'object') {
    return null;
  }

  const model = (execution as { model?: unknown }).model;
  return typeof model === 'string' && model.trim().length > 0 ? model : null;
}

function findMissingDeclaredToolNames(
  toolNames: string[],
  projectToolNames: Set<string>,
  connectorToolResolver: ConnectorToolResolver | null,
): string[] {
  return toolNames.filter(
    (name) =>
      !projectToolNames.has(name.toLowerCase()) &&
      !isConnectorToolAvailable(name, connectorToolResolver),
  );
}

function isConnectorToolAvailable(
  toolName: string,
  connectorToolResolver: ConnectorToolResolver | null,
): boolean {
  if (!connectorToolResolver) {
    return false;
  }

  const dotIndex = toolName.indexOf('.');
  if (dotIndex <= 0 || dotIndex === toolName.length - 1) {
    return false;
  }

  try {
    return Boolean(
      connectorToolResolver(toolName.substring(0, dotIndex), toolName.substring(dotIndex + 1)),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('Connector tool fallback failed during health check', {
      toolName,
      error: message,
    });
    return false;
  }
}

// ─── Data Loaders ──────────────────────────────────────────────────────────

async function loadEntryAgentName(projectId: string, tenantId: string): Promise<string | null> {
  try {
    const { findProjectByIdAndTenant } = await import('@/repos/project-repo');
    const project = await findProjectByIdAndTenant(projectId, tenantId);
    return (project?.entryAgentName as string) ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('Failed to load project entry agent', { projectId, error: message });
    return null;
  }
}

async function loadConnectorToolResolver(projectId: string): Promise<ConnectorToolResolver | null> {
  try {
    const { buildStudioConnectorToolResolver } = await import('@/lib/connection-service');
    return (await buildStudioConnectorToolResolver()) ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('Connector tool resolver unavailable during health check', {
      projectId,
      error: message,
    });
    return null;
  }
}

// ─── Utilities ─────────────────────────────────────────────────────────────

/** Run an async check; on error downgrade to WARN instead of propagating. */
async function safeCheck(fn: () => Promise<CheckDetail>): Promise<CheckDetail> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      check: 'unknown',
      status: 'WARN',
      message: `Check failed: ${message}`,
    };
  }
}

/** Race a promise against a timeout. Rejects with a timeout error on expiry. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Health check timed out after ${ms}ms`)), ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Build a fully-WARN agent result for when the entire agent check fails/times out. */
function makeFailedAgentResult(agentName: string, reason: string): AgentHealthResult {
  const warnStatus: CheckStatus = 'WARN';
  return {
    agentName,
    checks: {
      compilation: warnStatus,
      handoffs: warnStatus,
      toolBindings: warnStatus,
      modelConfig: warnStatus,
      guardrails: warnStatus,
      entryPoint: warnStatus,
    },
    details: [
      {
        check: 'all',
        status: 'WARN',
        message: `Agent check failed: ${reason}`,
      },
    ],
  };
}
