/**
 * validate_agent tool — runs the diagnostic engine on one or all agents.
 * Tier 1 (structural) + Tier 2 (semantic) + Tier 3 (patterns).
 */

import { createLogger } from '@abl/compiler/platform/logger.js';
import { checkToolPermission, type ToolPermissionContext } from '../guards';
import {
  buildProjectAwareDiagnosticFindings,
  mergeScopedFindingsIntoReport,
  type ScopedDiagnosticFinding,
} from './project-aware-diagnostic-report';

const log = createLogger('arch-ai:validate-agent');

const PER_AGENT_TIMEOUT_MS = 5_000;
const ALL_AGENTS_TIMEOUT_MS = 30_000;

interface ValidateAgentInput {
  agentName: string;
  depth?: 'quick' | 'deep';
}

interface ValidateAgentResult {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

interface DiagnosticReportLike {
  sections?: Array<{ findings?: ScopedDiagnosticFinding[] }>;
  topIssues?: ScopedDiagnosticFinding[];
  summary?: {
    errors?: number;
    warnings?: number;
    infos?: number;
    total?: number;
  };
}

export async function executeValidateAgent(
  input: ValidateAgentInput,
  ctx: ToolPermissionContext,
): Promise<ValidateAgentResult> {
  const perm = await checkToolPermission('health_check', 'run_check', ctx);
  if (!perm.allowed) {
    return {
      success: false,
      error: { code: 'FORBIDDEN', message: perm.error ?? 'Permission denied' },
    };
  }

  const { projectId, user } = ctx;
  const tenantId = user.tenantId;
  const depth = input.depth ?? 'deep';
  const isAll = input.agentName === 'all';
  const timeoutMs = isAll ? ALL_AGENTS_TIMEOUT_MS : PER_AGENT_TIMEOUT_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const validation = runValidation(projectId, tenantId, isAll ? null : input.agentName, depth);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Validation timed out')), timeoutMs);
    });
    const result = await Promise.race([validation, timeout]);
    return { success: true, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Validate agent failed', { projectId, agentName: input.agentName, error: message });
    return { success: false, error: { code: 'VALIDATION_ERROR', message } };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function runValidation(
  projectId: string,
  tenantId: string,
  agentName: string | null,
  depth: 'quick' | 'deep',
) {
  // 1. Load agents from DB
  const { getProjectAgents } = await import('@/services/project-service');
  const agents = await getProjectAgents(projectId, tenantId);

  if (agents.length === 0) {
    return {
      findings: [],
      summary: { errors: 0, warnings: 0, infos: 0, total: 0 },
      note: 'No agents in project',
    };
  }

  // 2. Parse each agent's DSL
  const { compileProjectAgentsForDiagnostics } = await import('@/lib/abl/project-aware-compile');
  const projectAwareCompilation = await compileProjectAgentsForDiagnostics({
    agents,
    projectId,
    tenantId,
  });
  const projectAwareFindings = buildProjectAwareDiagnosticFindings(projectAwareCompilation);
  if (!projectAwareCompilation.compiled) {
    return {
      findings: projectAwareFindings,
      topIssues: projectAwareFindings,
      summary: summarizeStandaloneFindings(projectAwareFindings),
      parseErrors:
        projectAwareCompilation.parseErrors.length > 0
          ? projectAwareCompilation.parseErrors
          : undefined,
      projectAwareWarnings:
        projectAwareCompilation.warnings.length > 0 ? projectAwareCompilation.warnings : undefined,
      agentCount: agents.length,
    };
  }

  // 4. Run diagnostic engine
  const { runDiagnostics } = await import('@agent-platform/arch-ai');
  const report = mergeScopedFindingsIntoReport(
    runDiagnostics(projectAwareCompilation.compiled, {
      depth,
      agentName: agentName ?? undefined,
      maxFindings: 50,
    }),
    projectAwareFindings,
  );
  const scopedFindings = collectReportFindings(report);

  const projectContext =
    agentName && depth === 'deep'
      ? buildRelatedProjectContext(
          agentName,
          scopedFindings,
          collectReportFindings(
            mergeScopedFindingsIntoReport(
              runDiagnostics(projectAwareCompilation.compiled, {
                depth,
                maxFindings: 100,
              }),
              projectAwareFindings,
            ),
          ),
        )
      : undefined;

  return {
    ...report,
    projectContext,
    parseErrors:
      projectAwareCompilation.parseErrors.length > 0
        ? projectAwareCompilation.parseErrors
        : undefined,
    projectAwareWarnings:
      projectAwareCompilation.warnings.length > 0 ? projectAwareCompilation.warnings : undefined,
    agentCount: agents.length,
  };
}

function summarizeStandaloneFindings(findings: readonly ScopedDiagnosticFinding[]): {
  errors: number;
  warnings: number;
  infos: number;
  total: number;
} {
  return {
    errors: findings.filter((finding) => finding.severity === 'error').length,
    warnings: findings.filter((finding) => finding.severity === 'warning').length,
    infos: findings.filter((finding) => finding.severity === 'info').length,
    total: findings.length,
  };
}

function buildRelatedProjectContext(
  agentName: string,
  scopedFindings: ScopedDiagnosticFinding[],
  projectFindings: ScopedDiagnosticFinding[],
): { note: string; relatedFindings: ScopedDiagnosticFinding[] } | undefined {
  const scopedKeys = new Set(scopedFindings.map(diagnosticFindingKey));
  const relatedFindings = projectFindings
    .filter((finding) => !scopedKeys.has(diagnosticFindingKey(finding)))
    .filter((finding) => isFindingRelatedToAgent(finding, agentName))
    .slice(0, 20);

  if (relatedFindings.length === 0) {
    return undefined;
  }

  return {
    note: `Agent-scoped validation also includes these full-project findings because edits to "${agentName}" can affect upstream/downstream contracts.`,
    relatedFindings,
  };
}

function collectReportFindings(report: DiagnosticReportLike): ScopedDiagnosticFinding[] {
  const findings = [
    ...(report.sections ?? []).flatMap((section) => section.findings ?? []),
    ...(report.topIssues ?? []),
  ];
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = diagnosticFindingKey(finding);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function diagnosticFindingKey(finding: ScopedDiagnosticFinding): string {
  return [
    finding.severity,
    finding.code,
    finding.agentName ?? '_project',
    finding.category ?? '_category',
    finding.message,
  ].join('|');
}

function isFindingRelatedToAgent(finding: ScopedDiagnosticFinding, agentName: string): boolean {
  return (
    finding.agentName === agentName ||
    finding.message.includes(`"${agentName}"`) ||
    finding.message.includes(`'${agentName}'`)
  );
}
