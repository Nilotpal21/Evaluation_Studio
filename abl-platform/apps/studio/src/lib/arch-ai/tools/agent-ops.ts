import { createLogger } from '@abl/compiler/platform/logger.js';
import {
  checkArchMutationAllowed,
  checkToolPermission,
  isDangerousAction,
  type ToolPermissionContext,
} from '../guards';

const log = createLogger('arch-ai:agent-ops');

interface ProposedChangeInput {
  construct: string;
  before: string | null;
  after: string | null;
  rationale: string;
}

interface AgentOpsInput {
  action: 'read' | 'list' | 'create' | 'modify' | 'compile' | 'delete' | 'propose_modification';
  agentName?: string;
  content?: string;
  edits?: Array<{ section: string; content: string | null }>;
  dryRun?: boolean;
  confirmed?: boolean;
  /** For propose_modification: LLM-generated structured changes */
  changes?: ProposedChangeInput[];
}

interface AgentOpsResult {
  success?: boolean;
  data?: unknown;
  error?: { code: string; message: string };
  needsConfirmation?: boolean;
  warning?: string;
}

export async function executeAgentOps(
  input: AgentOpsInput,
  ctx: ToolPermissionContext,
): Promise<AgentOpsResult> {
  const { action, agentName } = input;
  const { projectId, user } = ctx;
  const tenantId = user.tenantId;

  const perm = await checkToolPermission('agent_ops', action, ctx);
  if (!perm.allowed) {
    return {
      success: false,
      error: { code: perm.code ?? 'FORBIDDEN', message: perm.error ?? 'Permission denied' },
    };
  }

  if (isDangerousAction('agent_ops', action) && !input.confirmed) {
    return {
      needsConfirmation: true,
      warning: `Permanently delete agent "${agentName}"?`,
    };
  }

  const mutationCheck = checkArchMutationAllowed(
    {
      sourceTool: 'agent_ops',
      sourceAction: action,
      targetKind: 'agent_dsl',
      operation:
        action === 'create' || action === 'modify' || action === 'delete' ? action : 'modify',
      agentName,
    },
    ctx,
  );
  if (!mutationCheck.allowed) {
    return {
      success: false,
      error: mutationCheck.error,
    };
  }

  const canonicalModeError = await rejectRawAgentMutationInCanonicalMode(
    action,
    projectId,
    tenantId,
  );
  if (canonicalModeError) {
    return canonicalModeError;
  }

  switch (action) {
    case 'read':
    case 'compile':
    case 'delete':
      if (!agentName) {
        return {
          success: false,
          error: { code: 'MISSING_PARAM', message: 'agentName is required' },
        };
      }
      if (action === 'read') return readAgent(projectId, agentName, tenantId);
      if (action === 'compile') return compileAgent(projectId, agentName, tenantId);
      return deleteAgent(projectId, agentName, user);
    case 'list':
      return listAgents(projectId, tenantId);
    case 'create':
      if (!agentName || !input.content) {
        return {
          success: false,
          error: { code: 'MISSING_PARAM', message: 'agentName and content are required' },
        };
      }
      return createAgent(projectId, agentName, input.content, tenantId);
    case 'modify':
      if (!agentName) {
        return {
          success: false,
          error: { code: 'MISSING_PARAM', message: 'agentName is required' },
        };
      }
      return modifyAgent(projectId, agentName, input, tenantId);
    case 'propose_modification':
      if (!agentName) {
        return {
          success: false,
          error: { code: 'MISSING_PARAM', message: 'agentName is required' },
        };
      }
      return proposeModification(projectId, agentName, input, tenantId);
    default:
      return {
        success: false,
        error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` },
      };
  }
}

async function rejectRawAgentMutationInCanonicalMode(
  action: AgentOpsInput['action'],
  projectId: string,
  tenantId: string,
): Promise<AgentOpsResult | null> {
  if (!['create', 'modify', 'delete', 'propose_modification'].includes(action)) {
    return null;
  }

  const { Project } = await import('@agent-platform/database/models');
  const project = await Project.findOne({ _id: projectId, tenantId }, { archConfig: 1 }).lean();
  const archConfig = project?.archConfig as
    | { canonicalBlueprintMode?: boolean; manualDriftEnabledAt?: Date | null }
    | undefined;

  if (archConfig?.canonicalBlueprintMode !== true) {
    return null;
  }

  return {
    success: false,
    error: {
      code: 'CANONICAL_BLUEPRINT_MODE',
      message:
        'This project is in canonical-blueprint mode. Use propose_blueprint_edit, or explicitly enable manual-drift mode before raw DSL edits.',
    },
  };
}

async function readAgent(
  projectId: string,
  agentName: string,
  tenantId: string,
): Promise<AgentOpsResult> {
  const { findProjectAgent } = await import('@/repos/project-repo');
  const agent = await findProjectAgent(projectId, agentName, tenantId);

  if (!agent) {
    return {
      success: false,
      error: { code: 'NOT_FOUND', message: `Agent "${agentName}" not found in project` },
    };
  }

  return {
    success: true,
    data: {
      name: agent.name,
      description: agent.description ?? null,
      ablContent: agent.dslContent ?? null,
    },
  };
}

async function listAgents(projectId: string, tenantId: string): Promise<AgentOpsResult> {
  const { getProjectAgents } = await import('@/services/project-service');
  const agents = await getProjectAgents(projectId, tenantId);

  return {
    success: true,
    data: {
      count: agents.length,
      agents: agents.map((a: Record<string, unknown>) => ({
        name: a.name,
        description: a.description ?? null,
        hasDsl: Boolean(a.dslContent),
      })),
    },
  };
}

async function createAgent(
  projectId: string,
  agentName: string,
  content: string,
  tenantId: string,
): Promise<AgentOpsResult> {
  // Full compile validation — catches handoff target errors and cross-references,
  // not just syntax. Tool binding is resolved at runtime, not compile time,
  // so unbound tools produce warnings, not blocking errors.
  const validationError = await validateDsl(content);
  if (validationError) return validationError;

  const { findProjectAgent } = await import('@/repos/project-repo');
  const { addAgentToProject } = await import('@/services/project-service');
  const existing = await findProjectAgent(projectId, agentName, tenantId);
  if (existing) {
    return {
      success: false,
      error: { code: 'ALREADY_EXISTS', message: `Agent "${agentName}" already exists` },
    };
  }

  await addAgentToProject({
    name: agentName,
    projectId,
    tenantId,
    dslContent: content,
    description: `Agent created by Arch AI`,
  });

  log.info('Agent created', { projectId, agentName, tenantId });
  return { success: true, data: { created: true, name: agentName } };
}

async function modifyAgent(
  projectId: string,
  agentName: string,
  input: AgentOpsInput,
  tenantId: string,
): Promise<AgentOpsResult> {
  const { edits, content, dryRun = true } = input;

  if (!edits && !content) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'Provide content or edits' },
    };
  }

  // Full replace path
  if (content) {
    return fullReplace(projectId, agentName, content, dryRun, tenantId);
  }

  // Section edits path
  return sectionModify(projectId, agentName, edits!, dryRun, tenantId);
}

async function fullReplace(
  projectId: string,
  agentName: string,
  content: string,
  dryRun: boolean,
  tenantId: string,
): Promise<AgentOpsResult> {
  const validationError = await validateDsl(content);
  if (validationError) return validationError;

  if (dryRun) {
    return {
      success: true,
      data: { applied: false, reason: 'dry_run', modifiedDsl: content },
    };
  }

  const { findProjectAgent, updateProjectAgent } = await import('@/repos/project-repo');
  const agent = await findProjectAgent(projectId, agentName, tenantId);
  if (!agent) {
    return {
      success: false,
      error: { code: 'NOT_FOUND', message: `Agent "${agentName}" not found` },
    };
  }

  await updateProjectAgent(agent.id, { dslContent: content }, tenantId);
  log.info('Agent full-replaced', { projectId, agentName });
  return { success: true, data: { applied: true } };
}

async function sectionModify(
  projectId: string,
  agentName: string,
  edits: Array<{ section: string; content: string | null }>,
  dryRun: boolean,
  tenantId: string,
): Promise<AgentOpsResult> {
  const { findProjectAgent, updateProjectAgent } = await import('@/repos/project-repo');
  const agent = await findProjectAgent(projectId, agentName, tenantId);

  if (!agent) {
    return {
      success: false,
      error: { code: 'NOT_FOUND', message: `Agent "${agentName}" not found` },
    };
  }

  const originalDsl = agent.dslContent as string | null;
  if (!originalDsl) {
    return {
      success: false,
      error: { code: 'NO_DSL', message: `Agent "${agentName}" has no DSL content` },
    };
  }

  const { spliceSections, diffABL } = await import('@agent-platform/project-io');
  const modifiedDsl = spliceSections(originalDsl, edits);
  const diff = diffABL(originalDsl, modifiedDsl);

  const validationError = await validateDsl(modifiedDsl);
  if (validationError) {
    return {
      success: true,
      data: { ...((validationError.data as object) ?? {}), diff },
    };
  }

  if (dryRun) {
    return {
      success: true,
      data: { applied: false, reason: 'dry_run', diff, modifiedDsl },
    };
  }

  await updateProjectAgent(agent.id, { dslContent: modifiedDsl }, tenantId);
  log.info('Agent section-modified', {
    projectId,
    agentName,
    sections: edits.map((e) => e.section),
  });
  return { success: true, data: { applied: true, diff } };
}

async function compileAgent(
  projectId: string,
  agentName: string,
  tenantId: string,
): Promise<AgentOpsResult> {
  const { findProjectAgent } = await import('@/repos/project-repo');
  const agent = await findProjectAgent(projectId, agentName, tenantId);

  if (!agent) {
    return {
      success: false,
      error: { code: 'NOT_FOUND', message: `Agent "${agentName}" not found` },
    };
  }

  if (!agent.dslContent) {
    return {
      success: false,
      error: { code: 'NO_DSL', message: `Agent "${agentName}" has no DSL content` },
    };
  }

  const { parseAgentBasedABL } = await import('@abl/core');
  const parseResult = parseAgentBasedABL(agent.dslContent);

  if (parseResult.errors.length > 0) {
    return {
      success: true,
      data: {
        valid: false,
        stage: 'parse',
        errors: parseResult.errors.map((e: { line: number; message: string }) => ({
          line: e.line,
          message: e.message,
        })),
      },
    };
  }

  if (!parseResult.document) {
    return {
      success: true,
      data: { valid: false, stage: 'parse', errors: [{ message: 'Parser returned no document' }] },
    };
  }

  const { compileABLtoIR } = await import('@abl/compiler');
  const compileResult = compileABLtoIR([parseResult.document]);

  if ((compileResult.compilation_errors?.length ?? 0) > 0) {
    return {
      success: true,
      data: {
        valid: false,
        stage: 'compile',
        errors: (compileResult.compilation_errors ?? []).map((e: { message: string }) => ({
          message: e.message,
        })),
      },
    };
  }

  return {
    success: true,
    data: {
      valid: true,
      agents: Object.keys(compileResult.agents),
      warnings: (parseResult.warnings ?? []).map((w: { line: number; message: string }) => ({
        line: w.line,
        message: w.message,
      })),
    },
  };
}

async function deleteAgent(
  projectId: string,
  agentName: string,
  user: ToolPermissionContext['user'],
): Promise<AgentOpsResult> {
  const tenantId = user.tenantId;
  const { findProjectAgent, deleteProjectAgent } = await import('@/repos/project-repo');
  const agent = await findProjectAgent(projectId, agentName, tenantId);

  if (!agent) {
    return {
      success: false,
      error: { code: 'NOT_FOUND', message: `Agent "${agentName}" not found` },
    };
  }

  await deleteProjectAgent(agent.id, tenantId);
  try {
    const { sessionService } = await import('@/lib/arch-ai/message-services');
    await sessionService.archiveAgentEditorSessionsForAgent(
      { tenantId, userId: user.userId },
      projectId,
      agentName,
      'agent_deleted',
    );
  } catch (err: unknown) {
    log.warn('Failed to archive stale agent-editor sessions after agent delete', {
      projectId,
      agentName,
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  log.info('Agent deleted', { projectId, agentName, tenantId });
  return { success: true, data: { deleted: true, name: agentName } };
}

/**
 * Propose a structured modification to an agent.
 * The LLM provides ProposedChange[] as structured tool input.
 * The tool validates each change's `after` field via parse-only check,
 * then returns a typed ModificationProposal for the frontend to render.
 */
async function proposeModification(
  projectId: string,
  agentName: string,
  input: AgentOpsInput,
  tenantId: string,
): Promise<AgentOpsResult> {
  const changes = input.changes;
  if (!changes || changes.length === 0) {
    return {
      success: false,
      error: {
        code: 'MISSING_PARAM',
        message: 'changes array is required for propose_modification',
      },
    };
  }

  // Read current agent to confirm it exists
  const agentResult = await readAgent(projectId, agentName, tenantId);
  if (!agentResult.success) return agentResult;

  // Validate each change's `after` content (parse-only, no compile)
  const validationErrors: Array<{ construct: string; errors: unknown[] }> = [];
  for (const change of changes) {
    if (change.after) {
      // Wrap the section in a minimal agent stub for parse validation
      const stubDsl = `AGENT ${agentName}\n${change.construct}:\n${change.after}`;
      const parseError = await parseDsl(stubDsl);
      if (parseError) {
        validationErrors.push({
          construct: change.construct,
          errors: (parseError.data as { errors?: unknown[] })?.errors ?? [],
        });
      }
    }
  }

  log.info('Propose modification', {
    projectId,
    agentName,
    changeCount: changes.length,
    validationErrors: validationErrors.length,
  });

  return {
    success: true,
    data: {
      proposal: {
        agentName,
        changes: changes.map((c) => ({
          construct: c.construct,
          before: c.before,
          after: c.after,
          rationale: c.rationale,
        })),
        compilationStatus:
          validationErrors.length > 0
            ? {
                success: false,
                errors: validationErrors.map((v) => `${v.construct}: ${JSON.stringify(v.errors)}`),
                warnings: [],
              }
            : undefined,
      },
    },
  };
}

/** Parse-only validation — checks syntax without compiling (no tool binding checks). */
async function parseDsl(dsl: string): Promise<AgentOpsResult | null> {
  const { parseAgentBasedABL } = await import('@abl/core');
  const parseResult = parseAgentBasedABL(dsl);

  if (parseResult.errors.length > 0) {
    return {
      success: true,
      data: {
        applied: false,
        reason: 'validation_failed',
        errors: parseResult.errors.map((e: { line: number; message: string }) => ({
          line: e.line,
          message: e.message,
        })),
      },
    };
  }

  return null;
}

/** Full validation — parse + compile (checks tool bindings, agent references). */
async function validateDsl(dsl: string): Promise<AgentOpsResult | null> {
  const { parseAgentBasedABL } = await import('@abl/core');
  const parseResult = parseAgentBasedABL(dsl);

  if (parseResult.errors.length > 0) {
    return {
      success: true,
      data: {
        applied: false,
        reason: 'validation_failed',
        errors: parseResult.errors.map((e: { line: number; message: string }) => ({
          line: e.line,
          message: e.message,
        })),
      },
    };
  }

  if (parseResult.document) {
    const { compileABLtoIR } = await import('@abl/compiler');
    const compileResult = compileABLtoIR([parseResult.document]);
    if ((compileResult.compilation_errors?.length ?? 0) > 0) {
      return {
        success: true,
        data: {
          applied: false,
          reason: 'validation_failed',
          errors: (compileResult.compilation_errors ?? []).map((e: { message: string }) => ({
            message: e.message,
          })),
        },
      };
    }
  }

  return null;
}
