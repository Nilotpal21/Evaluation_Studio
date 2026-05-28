import { createLogger } from '@abl/compiler/platform';
import {
  getProjectAgentExportReadinessIssues,
  getProjectExportReadinessIssues,
  hasBlockingProjectAgentDraftReadinessStatus,
  type ProjectAgentExportReadinessDiagnostic,
  type ProjectAgentExportReadinessRecord,
  type ProjectExportReadinessIssue,
} from '@agent-platform/project-io';
import { backfillMissingRuntimeProjectAgentDraftMetadata } from './project-agent-draft-metadata.js';

const log = createLogger('project-agent-dsl-readiness');

export interface ProjectAgentDslDiagnostic {
  severity?: string | null;
  message?: string | null;
  source?: string | null;
}

export interface ProjectAgentDslReadinessRecord {
  name?: string | null;
  dslContent?: string | null;
  dslValidationStatus?: string | null;
  dslDiagnostics?: readonly ProjectAgentDslDiagnostic[] | null;
}

export interface BlockedProjectAgentDsl {
  name: string;
  diagnosticCount: number;
}

export interface ProjectAgentDslReadiness<T extends ProjectAgentDslReadinessRecord> {
  executableAgents: T[];
  blockedAgents: BlockedProjectAgentDsl[];
  hasBlockingErrors: boolean;
}

export interface ProjectExecutionReadinessInput<T extends ProjectAgentDslReadinessRecord> {
  agents: readonly T[];
  tenantId: string;
  projectId: string;
  runtimeConfig?: Record<string, unknown> | null;
  llmConfig?: Record<string, unknown> | null;
  lazyBackfill?: boolean;
}

export interface ProjectExecutionReadiness<
  T extends ProjectAgentDslReadinessRecord,
> extends ProjectAgentDslReadiness<T> {
  issues: ProjectExportReadinessIssue[];
}

const DSL_VALIDATION_ERROR_STATUS = 'error';
function hasDslContent(agent: ProjectAgentDslReadinessRecord): boolean {
  return typeof agent.dslContent === 'string' && agent.dslContent.trim().length > 0;
}

function normalizeDiagnostic(
  diagnostic: ProjectAgentDslDiagnostic,
): ProjectAgentExportReadinessDiagnostic {
  return {
    severity: diagnostic.severity === 'warning' ? 'warning' : 'error',
    message: diagnostic.message ?? 'Project agent draft validation failed.',
    source: diagnostic.source,
  };
}

function toExportReadinessRecord(
  agent: ProjectAgentDslReadinessRecord,
): ProjectAgentExportReadinessRecord {
  return {
    name: agent.name,
    dslContent: agent.dslContent,
    dslValidationStatus: agent.dslValidationStatus,
    dslDiagnostics: agent.dslDiagnostics?.map(normalizeDiagnostic),
  };
}

function isBlockedAgent(agent: ProjectAgentDslReadinessRecord): boolean {
  return hasBlockingProjectAgentDraftReadinessStatus(toExportReadinessRecord(agent));
}

function toExportReadinessRecords<T extends ProjectAgentDslReadinessRecord>(
  agents: readonly T[],
): ProjectAgentExportReadinessRecord[] {
  return agents.map(toExportReadinessRecord);
}

export function evaluateProjectAgentDslReadiness<T extends ProjectAgentDslReadinessRecord>(
  agents: readonly T[],
): ProjectAgentDslReadiness<T> {
  const blockedAgents = agents.filter(isBlockedAgent).map((agent) => ({
    name: agent.name || 'unknown_agent',
    diagnosticCount:
      agent.dslValidationStatus === DSL_VALIDATION_ERROR_STATUS
        ? (agent.dslDiagnostics?.length ?? 0)
        : 1,
  }));

  return {
    blockedAgents,
    hasBlockingErrors: blockedAgents.length > 0,
    executableAgents:
      blockedAgents.length > 0 ? [] : agents.filter((agent): agent is T => hasDslContent(agent)),
  };
}

export async function evaluateProjectExecutionReadiness<T extends ProjectAgentDslReadinessRecord>({
  agents,
  tenantId,
  projectId,
  runtimeConfig,
  llmConfig,
  lazyBackfill,
}: ProjectExecutionReadinessInput<T>): Promise<ProjectExecutionReadiness<T>> {
  let effectiveAgents = agents;
  if (lazyBackfill) {
    try {
      const backfill = await backfillMissingRuntimeProjectAgentDraftMetadata({
        agents,
        tenantId,
        projectId,
      });
      effectiveAgents = backfill.agents;
      if (backfill.backfilledAgentNames.length > 0) {
        log.info('Lazy backfilled project agent draft validation metadata', {
          tenantId,
          projectId,
          agentNames: backfill.backfilledAgentNames,
        });
      }
    } catch (error) {
      log.warn('Failed to lazy backfill project agent draft validation metadata', {
        tenantId,
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const exportReadinessAgents = toExportReadinessRecords(effectiveAgents);
  const issues = await getProjectExportReadinessIssues({
    agents: exportReadinessAgents,
    tenantId,
    projectId,
    runtimeConfig,
    llmConfig,
  });
  const agentIssues = getProjectAgentExportReadinessIssues(exportReadinessAgents);
  const blockedAgents = agentIssues.map((issue) => {
    const agent = effectiveAgents.find(
      (candidate) => (candidate.name || '<unnamed>') === issue.agentName,
    );
    return {
      name: issue.agentName,
      diagnosticCount:
        agent?.dslValidationStatus === DSL_VALIDATION_ERROR_STATUS
          ? (agent.dslDiagnostics?.length ?? 0)
          : Math.max(issue.diagnostics.length, 1),
    };
  });
  const hasBlockingErrors = issues.length > 0;

  return {
    issues,
    blockedAgents,
    hasBlockingErrors,
    executableAgents: hasBlockingErrors
      ? []
      : effectiveAgents.filter((agent): agent is T => hasDslContent(agent)),
  };
}

export function buildProjectDslReadinessError(): string {
  return 'Project DSL has validation errors. Fix the draft or runtime config before starting a runtime session.';
}
