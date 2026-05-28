/**
 * Workflow Repository
 *
 * MongoDB data access for Workflow, WorkflowVersion, and WorkflowExecution reads.
 * Used by: routes/deployments.ts, routes/workflows-execute.ts, routes/workflow-execute-handler.ts
 */

import type {
  IWorkflow,
  IWorkflowVersion,
  IWorkflowExecution,
} from '@agent-platform/database/models';

// ─── Types ───────────────────────────────────────────────────────────────

/**
 * Lean document type — `.lean()` returns a plain object with an `_id` field.
 * The model I-interfaces describe document shape but don't include `_id` at
 * the TS level; wrap them in `Lean<T>` so consumers get a typed `_id` without
 * the full Mongoose Document methods.
 */
export type Lean<T> = T & { _id: string };

export type WorkflowDoc = Lean<IWorkflow>;
export type WorkflowVersionDoc = Lean<IWorkflowVersion>;
export type WorkflowExecutionDoc = Lean<IWorkflowExecution>;

// ─── Workflow Find ───────────────────────────────────────────────────────

/**
 * Find a workflow by name within a tenant+project scope.
 * Call site: deployments.ts (deployment validation — workflow-version manifest check).
 * Filter: { projectId, tenantId, name }
 */
export async function findWorkflowByNameAndProject(
  name: string,
  tenantId: string,
  projectId: string,
): Promise<WorkflowDoc | null> {
  const { Workflow } = await import('@agent-platform/database/models');
  return (await Workflow.findOne({ projectId, tenantId, name }).lean()) as WorkflowDoc | null;
}

/**
 * Find a workflow by _id within a tenant scope only. Caller MUST verify project
 * scope via `tenantContext.projectScope[]` after lookup (API-key auth pattern).
 * Call site: workflows-execute.ts (execute + status poll).
 *
 * NOTE: The `deleted` filter varies by call site — execute paths set
 * `includeDeleted: false`; status-poll sets `includeDeleted: true` (intentionally
 * allows polling executions of soft-deleted workflows, see D-4).
 * Filter: { _id, tenantId } + optional `deleted: { $ne: true }`
 */
export async function findWorkflowByIdAndTenant(
  workflowId: string,
  tenantId: string,
  opts?: { includeDeleted?: boolean },
): Promise<WorkflowDoc | null> {
  const { Workflow } = await import('@agent-platform/database/models');
  const filter: Record<string, unknown> = { _id: workflowId, tenantId };
  if (!opts?.includeDeleted) {
    filter.deleted = { $ne: true };
  }
  return (await Workflow.findOne(filter).lean()) as WorkflowDoc | null;
}

// ─── WorkflowVersion Find ────────────────────────────────────────────────

/**
 * Find a workflow version — state-agnostic by default.
 *
 * Extended to support an optional `excludeDeleted` filter so webhook-execute
 * callers can pin an inactive-but-not-deleted version while deployment code
 * paths that need any record (including deleted) retain their current behavior.
 *
 * Call sites:
 *  - `deployments.ts` — version-manifest validation (no opts, accepts all)
 *  - `workflows-execute.ts` — explicit ?version= pin ({ excludeDeleted: true };
 *    matches engine's `deleted: { $ne: true }` filter)
 *
 * Filter: { workflowId, version, tenantId, projectId } + optional `deleted: { $ne: true }`
 */
export async function findWorkflowVersion(
  workflowId: string,
  version: string,
  tenantId: string,
  projectId: string,
  opts?: { excludeDeleted?: boolean },
): Promise<WorkflowVersionDoc | null> {
  const { WorkflowVersion } = await import('@agent-platform/database/models');
  const filter: Record<string, unknown> = { workflowId, version, tenantId, projectId };
  if (opts?.excludeDeleted) {
    filter.deleted = { $ne: true };
  }
  return (await WorkflowVersion.findOne(filter).lean()) as WorkflowVersionDoc | null;
}

/**
 * Find an active, non-deleted workflow version — used when executing.
 * Call site: workflows-execute.ts (execute endpoint with explicit ?version= query).
 * Filter: { workflowId, version, tenantId, projectId, state: 'active', deleted: { $ne: true } }
 */
export async function findActiveWorkflowVersion(
  workflowId: string,
  version: string,
  tenantId: string,
  projectId: string,
): Promise<WorkflowVersionDoc | null> {
  const { WorkflowVersion } = await import('@agent-platform/database/models');
  return (await WorkflowVersion.findOne({
    workflowId,
    version,
    tenantId,
    projectId,
    state: 'active',
    deleted: { $ne: true },
  }).lean()) as WorkflowVersionDoc | null;
}

// ─── WorkflowExecution Find ─────────────────────────────────────────────

/**
 * Find a workflow execution by traceId (= _id), scoped to tenant+project+workflow.
 * Call site: workflows-execute.ts (status endpoint).
 * Filter: { _id: traceId, workflowId, tenantId, projectId }
 */
export async function findWorkflowExecution(
  traceId: string,
  workflowId: string,
  tenantId: string,
  projectId: string,
): Promise<WorkflowExecutionDoc | null> {
  const { WorkflowExecution } = await import('@agent-platform/database/models');
  return (await WorkflowExecution.findOne({
    _id: traceId,
    workflowId,
    tenantId,
    projectId,
  }).lean()) as WorkflowExecutionDoc | null;
}
