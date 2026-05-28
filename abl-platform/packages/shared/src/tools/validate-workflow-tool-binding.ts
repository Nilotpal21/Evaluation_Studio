/**
 * Async DB Cross-Check for Workflow Tool Bindings
 *
 * Validates that a workflow tool binding references a real workflow with an
 * active webhook trigger in the version-first model.
 *
 * Activation gate (post version-first migration):
 *   - workflow container `status` is vestigial — the engine's execute path does
 *     NOT read it (see apps/workflow-engine/src/routes/workflow-executions.ts)
 *   - The authoritative activation lives on the TriggerRegistration
 *     (`triggerType: 'webhook'`, `status: 'active'`) and its owning
 *     WorkflowVersion (`state` must not be `'inactive'`)
 *
 * Legacy fallback (when triggerRegistrationsRepo is not provided) preserves
 * the old behavior: embedded `workflow.triggers[]` + `workflow.status === 'active'`.
 */

// ─── Types ───────────────────────────────────────────────────────────────

export type WorkflowValidationErrorCode =
  | 'WORKFLOW_NOT_FOUND'
  | 'WORKFLOW_INACTIVE'
  | 'TRIGGER_INACTIVE'
  | 'INVALID_TOOL_BINDING';

export interface WorkflowValidationSuccess {
  valid: true;
}

export interface WorkflowValidationFailure {
  valid: false;
  error: {
    code: WorkflowValidationErrorCode;
    message: string;
  };
}

export type WorkflowValidationResult = WorkflowValidationSuccess | WorkflowValidationFailure;

/** Minimal trigger shape expected on the workflow document. */
export interface WorkflowTriggerDoc {
  id: string;
  type: string;
  auth?: { type?: string };
}

/** Minimal workflow document shape for validation. */
export interface WorkflowDoc {
  _id: string;
  status: string;
  deleted?: boolean;
  triggers?: WorkflowTriggerDoc[];
}

/** Minimal workflow version document shape for validation. */
export interface WorkflowVersionDoc {
  _id: string;
  workflowId: string;
  version?: string;
  deleted?: boolean;
  state?: 'active' | 'inactive';
}

/** Minimal trigger-registration document shape for validation. */
export interface TriggerRegistrationDoc {
  _id: string;
  workflowId: string;
  workflowVersionId?: string;
  triggerType: 'webhook' | 'cron' | 'event';
  status: 'active' | 'paused' | 'error' | 'deleted' | 'inactive';
  config?: Record<string, unknown>;
  authProfileId?: string | null;
}

/** Repository interface — accepts any object with a compatible findOne. */
export interface WorkflowsRepo {
  findOne(filter: Record<string, unknown>): Promise<WorkflowDoc | null>;
}

/** Repository interface for workflow versions. */
export interface WorkflowVersionsRepo {
  findOne(filter: Record<string, unknown>): Promise<WorkflowVersionDoc | null>;
}

/** Repository interface for trigger registrations (canonical). */
export interface TriggerRegistrationsRepo {
  findOne(filter: Record<string, unknown>): Promise<TriggerRegistrationDoc | null>;
}

export interface ValidateWorkflowBindingContext {
  tenantId: string;
  projectId: string;
  workflowsRepo: WorkflowsRepo;
  allowConfigPlaceholders?: boolean;
  /** Optional — when provided, enables version-aware validation. */
  workflowVersionsRepo?: WorkflowVersionsRepo;
  /**
   * Optional — when provided, the TriggerRegistration collection becomes the
   * authoritative source for trigger lookup instead of the denormalized
   * `workflow.triggers[]` array. Required for version-first validation.
   */
  triggerRegistrationsRepo?: TriggerRegistrationsRepo;
}

// ─── Validator ───────────────────────────────────────────────────────────

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readTriggerRegistrationAuthType(trigger: TriggerRegistrationDoc): string | undefined {
  const config = trigger.config;
  if (!isPlainRecord(config)) {
    return undefined;
  }

  const auth = config.auth;
  if (!isPlainRecord(auth)) {
    return undefined;
  }

  const authType = auth.type;
  return typeof authType === 'string' ? authType : undefined;
}

interface WorkflowToolBinding {
  workflowId: string;
  triggerId: string;
  workflowVersionId?: string;
  workflowVersion?: string;
}

const CONFIG_TEMPLATE_RE = /\{\{config\.[A-Za-z_][A-Za-z0-9_]*\}\}/;

function hasConfigTemplate(value: string | undefined): boolean {
  return typeof value === 'string' && CONFIG_TEMPLATE_RE.test(value);
}

function hasConfigBackedWorkflowIdentity(binding: WorkflowToolBinding): boolean {
  return (
    hasConfigTemplate(binding.workflowId) ||
    hasConfigTemplate(binding.workflowVersionId) ||
    hasConfigTemplate(binding.workflowVersion) ||
    hasConfigTemplate(binding.triggerId)
  );
}

function selectedWorkflowVersionLabel(binding: WorkflowToolBinding): string | undefined {
  return binding.workflowVersionId ?? binding.workflowVersion;
}

async function findSelectedWorkflowVersion(
  binding: WorkflowToolBinding,
  ctx: Pick<ValidateWorkflowBindingContext, 'tenantId' | 'projectId' | 'workflowVersionsRepo'>,
): Promise<WorkflowVersionDoc | null> {
  const { tenantId, projectId, workflowVersionsRepo } = ctx;
  if (!workflowVersionsRepo) {
    return null;
  }

  if (binding.workflowVersionId) {
    return workflowVersionsRepo.findOne({
      _id: binding.workflowVersionId,
      workflowId: binding.workflowId,
      tenantId,
      projectId,
    });
  }

  if (binding.workflowVersion) {
    return workflowVersionsRepo.findOne({
      workflowId: binding.workflowId,
      version: binding.workflowVersion,
      tenantId,
      projectId,
      deleted: { $ne: true },
    });
  }

  return null;
}

/**
 * Async DB cross-check for a workflow tool binding.
 *
 * Verifies:
 * (a) workflow exists in same tenant+project
 * (b) workflow status is 'active'
 * (c) trigger with matching ID exists
 * (d) trigger type is 'webhook'
 * (e) webhook trigger does not use user_level auth
 */
export async function validateWorkflowToolBinding(
  binding: WorkflowToolBinding,
  ctx: ValidateWorkflowBindingContext,
): Promise<WorkflowValidationResult> {
  const { tenantId, projectId, workflowsRepo, workflowVersionsRepo, triggerRegistrationsRepo } =
    ctx;

  if (hasConfigBackedWorkflowIdentity(binding)) {
    if (!ctx.allowConfigPlaceholders) {
      return {
        valid: false,
        error: {
          code: 'INVALID_TOOL_BINDING',
          message: 'Workflow tool identity fields cannot use config placeholders',
        },
      };
    }
    return { valid: true };
  }

  // (a) Workflow must exist in same tenant + project — cross-scope returns 404
  const workflow = await workflowsRepo.findOne({
    _id: binding.workflowId,
    tenantId,
    projectId,
  });

  if (!workflow) {
    return {
      valid: false,
      error: { code: 'WORKFLOW_NOT_FOUND', message: 'Workflow not found' },
    };
  }

  // (a2) Workflow must not be deleted
  if (workflow.deleted) {
    return {
      valid: false,
      error: { code: 'WORKFLOW_NOT_FOUND', message: 'Workflow not found' },
    };
  }

  let selectedVersion: WorkflowVersionDoc | null = null;
  if ((binding.workflowVersionId || binding.workflowVersion) && workflowVersionsRepo) {
    selectedVersion = await findSelectedWorkflowVersion(binding, {
      tenantId,
      projectId,
      workflowVersionsRepo,
    });
    if (!selectedVersion || selectedVersion.deleted) {
      return {
        valid: false,
        error: {
          code: 'INVALID_TOOL_BINDING',
          message: `Workflow version '${selectedWorkflowVersionLabel(binding)}' not found`,
        },
      };
    }
    if (selectedVersion.state === 'inactive') {
      return {
        valid: false,
        error: {
          code: 'WORKFLOW_INACTIVE',
          message: 'Selected workflow version is inactive',
        },
      };
    }
  }

  // ─── Version-first path (preferred) ──────────────────────────────────────
  // When the canonical TriggerRegistration repo is available, use it as the
  // source of truth. `workflow.status` is vestigial in this model — the
  // execute endpoint does not read it; only the trigger's status and its
  // owning version's state control invocation.
  if (triggerRegistrationsRepo) {
    const trigger = await triggerRegistrationsRepo.findOne({
      _id: binding.triggerId,
      tenantId,
      projectId,
      workflowId: binding.workflowId,
    });

    if (!trigger) {
      return {
        valid: false,
        error: {
          code: 'INVALID_TOOL_BINDING',
          message: `Trigger '${binding.triggerId}' not found in workflow`,
        },
      };
    }

    if (trigger.triggerType !== 'webhook') {
      return {
        valid: false,
        error: {
          code: 'INVALID_TOOL_BINDING',
          message: `Only webhook triggers can be bound as tools; trigger type is '${trigger.triggerType}'`,
        },
      };
    }

    if (trigger.status !== 'active') {
      return {
        valid: false,
        error: {
          code: 'TRIGGER_INACTIVE',
          message: `Webhook trigger is not active (current status: ${trigger.status})`,
        },
      };
    }

    if (readTriggerRegistrationAuthType(trigger) === 'user_level') {
      return {
        valid: false,
        error: {
          code: 'INVALID_TOOL_BINDING',
          message: 'Webhook triggers with user_level auth cannot be bound as tools',
        },
      };
    }

    if (
      binding.workflowVersionId &&
      trigger.workflowVersionId &&
      trigger.workflowVersionId !== binding.workflowVersionId
    ) {
      return {
        valid: false,
        error: {
          code: 'INVALID_TOOL_BINDING',
          message: 'Selected workflow version does not match the trigger binding',
        },
      };
    }

    if (
      selectedVersion &&
      trigger.workflowVersionId &&
      trigger.workflowVersionId !== selectedVersion._id
    ) {
      return {
        valid: false,
        error: {
          code: 'INVALID_TOOL_BINDING',
          message: 'Selected workflow version does not match the trigger binding',
        },
      };
    }

    // If the trigger pins to a specific version, that version must not be
    // missing, deleted, or inactive — matches the trigger-engine guard (see
    // apps/workflow-engine/src/services/trigger-engine.ts).
    if (trigger.workflowVersionId && workflowVersionsRepo) {
      const version =
        selectedVersion && selectedVersion._id === trigger.workflowVersionId
          ? selectedVersion
          : await workflowVersionsRepo.findOne({
              _id: trigger.workflowVersionId,
              tenantId,
              projectId,
            });
      if (!version || version.deleted) {
        return {
          valid: false,
          error: {
            code: 'INVALID_TOOL_BINDING',
            message: 'Workflow version bound to this trigger was not found',
          },
        };
      }
      if (version && version.state === 'inactive') {
        return {
          valid: false,
          error: {
            code: 'WORKFLOW_INACTIVE',
            message: 'Workflow version bound to this trigger is inactive',
          },
        };
      }
    }

    return { valid: true };
  }

  // ─── Legacy path (backward-compatible) ───────────────────────────────────
  // Preserved for call-sites that have not yet been updated to pass the
  // TriggerRegistration repo. Uses embedded workflow.triggers[] + container
  // status — will reject draft workflows even when a valid webhook exists.
  let isActive = false;

  if (selectedVersion) {
    isActive = selectedVersion.state !== 'inactive';
  } else if (workflowVersionsRepo) {
    const activeVersion = await workflowVersionsRepo.findOne({
      workflowId: binding.workflowId,
      tenantId,
      projectId,
      state: 'active',
    });
    if (activeVersion) {
      isActive = true;
    }
  }

  if (!isActive && workflow.status === 'active') {
    isActive = true;
  }

  if (!isActive) {
    return {
      valid: false,
      error: {
        code: 'WORKFLOW_INACTIVE',
        message: `Workflow is not active (current status: ${workflow.status})`,
      },
    };
  }

  const triggers = workflow.triggers ?? [];
  const trigger = triggers.find((t) => t.id === binding.triggerId);

  if (!trigger) {
    return {
      valid: false,
      error: {
        code: 'INVALID_TOOL_BINDING',
        message: `Trigger '${binding.triggerId}' not found in workflow`,
      },
    };
  }

  if (trigger.type !== 'webhook') {
    return {
      valid: false,
      error: {
        code: 'INVALID_TOOL_BINDING',
        message: `Only webhook triggers can be bound as tools; trigger type is '${trigger.type}'`,
      },
    };
  }

  if (trigger.auth?.type === 'user_level') {
    return {
      valid: false,
      error: {
        code: 'INVALID_TOOL_BINDING',
        message: 'Webhook triggers with user_level auth cannot be bound as tools',
      },
    };
  }

  return { valid: true };
}
