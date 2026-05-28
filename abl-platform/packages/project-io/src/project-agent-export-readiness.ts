import {
  stripModelPolicyImportMetadata,
  stripRuntimeConfigSaveValidationMetadata,
  validateProjectModelPolicyConfigWrite,
  validateProjectRuntimeConfigWrite,
} from './import/runtime-config-save-validation.js';

export const INVALID_AGENT_DRAFT_EXPORT_CODE = 'INVALID_AGENT_DRAFT';

export interface ProjectAgentExportReadinessDiagnostic {
  severity: 'error' | 'warning';
  message: string;
  source?: string | null;
}

export interface ProjectAgentExportReadinessRecord {
  name?: string | null;
  dslContent?: string | null;
  dslValidationStatus?: string | null;
  dslDiagnostics?: ProjectAgentExportReadinessDiagnostic[] | null;
}

export interface ProjectAgentExportReadinessIssue {
  kind: 'agent_draft';
  agentName: string;
  diagnostics: ProjectAgentExportReadinessDiagnostic[];
}

export interface ProjectRuntimeConfigExportReadinessIssue {
  kind: 'runtime_config';
  diagnostics: ProjectAgentExportReadinessDiagnostic[];
}

export interface ProjectModelPolicyConfigExportReadinessIssue {
  kind: 'model_policy';
  diagnostics: ProjectAgentExportReadinessDiagnostic[];
}

export type ProjectExportReadinessIssue =
  | ProjectAgentExportReadinessIssue
  | ProjectRuntimeConfigExportReadinessIssue
  | ProjectModelPolicyConfigExportReadinessIssue;

export interface ProjectExportReadinessInput {
  agents: readonly ProjectAgentExportReadinessRecord[];
  tenantId: string;
  projectId: string;
  runtimeConfig?: Record<string, unknown> | null;
  llmConfig?: Record<string, unknown> | null;
}

const VALIDATED_DSL_STATUSES = new Set(['valid', 'warning']);
const UNVALIDATED_DRAFT_DIAGNOSTIC: ProjectAgentExportReadinessDiagnostic = {
  severity: 'error',
  message: 'Agent draft has not been validated. Save or revalidate the draft before exporting.',
  source: 'project-agent-export-readiness',
};
function sanitizeRuntimeConfigForValidation(
  runtimeConfig: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!runtimeConfig) {
    return null;
  }

  return stripRuntimeConfigSaveValidationMetadata(runtimeConfig);
}

function sanitizeModelPolicyConfigForValidation(
  modelPolicyConfig: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!modelPolicyConfig) {
    return null;
  }

  return stripModelPolicyImportMetadata(modelPolicyConfig);
}

function hasDslContent(agent: ProjectAgentExportReadinessRecord): boolean {
  return typeof agent.dslContent === 'string' && agent.dslContent.trim().length > 0;
}

export function hasBlockingProjectAgentDraftReadinessStatus(
  agent: ProjectAgentExportReadinessRecord,
): boolean {
  if (!hasDslContent(agent)) {
    return false;
  }
  return (
    agent.dslValidationStatus === 'error' ||
    !VALIDATED_DSL_STATUSES.has(String(agent.dslValidationStatus))
  );
}

function diagnosticsForAgent(
  agent: ProjectAgentExportReadinessRecord,
): ProjectAgentExportReadinessDiagnostic[] {
  if (agent.dslValidationStatus === 'error') {
    return Array.isArray(agent.dslDiagnostics) ? agent.dslDiagnostics : [];
  }
  return [UNVALIDATED_DRAFT_DIAGNOSTIC];
}

export function getProjectAgentExportReadinessIssues(
  agents: readonly ProjectAgentExportReadinessRecord[],
): ProjectAgentExportReadinessIssue[] {
  return agents.filter(hasBlockingProjectAgentDraftReadinessStatus).map((agent) => ({
    kind: 'agent_draft',
    agentName: agent.name?.trim() || '<unnamed>',
    diagnostics: diagnosticsForAgent(agent),
  }));
}

export async function getProjectExportReadinessIssues({
  agents,
  tenantId,
  projectId,
  runtimeConfig,
  llmConfig,
}: ProjectExportReadinessInput): Promise<ProjectExportReadinessIssue[]> {
  const issues: ProjectExportReadinessIssue[] = [...getProjectAgentExportReadinessIssues(agents)];
  const sanitizedRuntimeConfig = sanitizeRuntimeConfigForValidation(runtimeConfig);
  const sanitizedLlmConfig = sanitizeModelPolicyConfigForValidation(llmConfig);

  if (sanitizedRuntimeConfig !== null) {
    const runtimeConfigValidation = await validateProjectRuntimeConfigWrite({
      tenantId,
      projectId,
      data: sanitizedRuntimeConfig,
    });

    if (!runtimeConfigValidation.valid) {
      issues.push({
        kind: 'runtime_config',
        diagnostics: [
          {
            severity: 'error',
            message: runtimeConfigValidation.message,
            source: 'export-runtime-config-readiness',
          },
        ],
      });
    }
  }

  if (sanitizedLlmConfig !== null) {
    const modelPolicyValidation = validateProjectModelPolicyConfigWrite({
      data: sanitizedLlmConfig,
    });

    if (!modelPolicyValidation.valid) {
      issues.push({
        kind: 'model_policy',
        diagnostics: [
          {
            severity: 'error',
            message: modelPolicyValidation.message,
            source: 'export-model-policy-readiness',
          },
        ],
      });
    }
  }

  return issues;
}

export function buildInvalidAgentDraftExportPayload(
  issues: readonly ProjectAgentExportReadinessIssue[],
) {
  return buildInvalidProjectExportPayload(issues);
}

export function buildInvalidProjectExportPayload(issues: readonly ProjectExportReadinessIssue[]) {
  return {
    success: false,
    error: {
      code: INVALID_AGENT_DRAFT_EXPORT_CODE,
      message:
        'Export blocked because the project working copy has validation errors. Fix the draft or runtime config diagnostics before exporting or syncing.',
    },
    issues: [...issues],
  };
}
