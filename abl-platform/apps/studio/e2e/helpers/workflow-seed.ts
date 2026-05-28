/**
 * Workflow seeding helpers for UI E2E tests.
 *
 * Thin wrappers around apiPost/apiDelete to create and tear down workflows
 * needed by workflow-tool UI E2E scenarios (UI-E2E-1..4).
 *
 * @e2e-real — No mocks. All calls hit real endpoints via Studio proxy.
 */

import type { Page, APIRequestContext } from '@playwright/test';
import { apiPost, apiDelete } from './api';

export interface SeededWorkflow {
  workflowId: string;
  triggerId: string;
  name: string;
}

export interface SeedWorkflowOptions {
  projectId: string;
  /** Default: 'sync' */
  mode?: 'sync' | 'async';
  /** Default: [{ name: 'topic', type: 'string', required: true }] */
  inputVariables?: Array<{
    name: string;
    type: 'string' | 'number' | 'boolean' | 'json';
    required?: boolean;
    description?: string;
  }>;
  /** Default: auto-generated `wf_ui_${mode}_<6-char suffix>` */
  namePrefix?: string;
  /** Default: 'active'. Use 'archived' to simulate a non-active workflow. */
  status?: 'active' | 'archived';
}

/**
 * Seeds an active workflow with exactly one webhook trigger.
 *
 * Creates via POST /api/projects/:projectId/workflows with embedded trigger
 * and a start node containing inputVariables. Returns the workflowId and triggerId
 * for use in tool creation and assertions.
 */
export async function seedWorkflowWithWebhook(
  ctx: Page | APIRequestContext,
  token: string,
  opts: SeedWorkflowOptions,
): Promise<SeededWorkflow> {
  const suffix = crypto.randomUUID().slice(0, 6);
  const mode = opts.mode ?? 'sync';
  const name = opts.namePrefix ?? `wf_ui_${mode}_${suffix}`;
  const triggerId = `trg_${mode}_${suffix}`;
  const status = opts.status ?? 'active';

  const inputVariables = opts.inputVariables ?? [{ name: 'topic', type: 'string', required: true }];

  const { status: httpStatus, body } = await apiPost(
    ctx,
    `/api/projects/${opts.projectId}/workflows`,
    token,
    {
      name,
      description: `Seeded ${mode} webhook workflow for UI E2E`,
      status,
      nodes: [
        {
          id: 'start-node',
          nodeType: 'start',
          name: 'Start',
          position: { x: 400, y: 50 },
          config: { inputVariables },
        },
        {
          id: 'end-node',
          nodeType: 'end',
          name: 'End',
          position: { x: 400, y: 300 },
          config: {},
        },
      ],
      edges: [
        {
          id: 'edge-start-end',
          source: 'start-node',
          target: 'end-node',
        },
      ],
      triggers: [
        {
          id: triggerId,
          type: 'webhook',
          config: { mode },
          status: 'active',
        },
      ],
    },
  );

  if (httpStatus !== 200 && httpStatus !== 201) {
    throw new Error(`seedWorkflowWithWebhook failed: HTTP ${httpStatus} — ${JSON.stringify(body)}`);
  }

  const workflowId =
    (body as Record<string, unknown>).id ??
    ((body as Record<string, unknown>).workflow as Record<string, unknown>)?.id ??
    '';

  if (!workflowId) {
    throw new Error(
      `seedWorkflowWithWebhook: no workflow id in response — ${JSON.stringify(body)}`,
    );
  }

  return { workflowId: String(workflowId), triggerId, name };
}

/**
 * Seeds an active workflow with exactly one cron trigger (zero webhooks).
 * Used by UI-E2E-2 to test the empty-state when no webhook triggers exist.
 */
export async function seedCronOnlyWorkflow(
  ctx: Page | APIRequestContext,
  token: string,
  opts: Omit<SeedWorkflowOptions, 'mode'>,
): Promise<SeededWorkflow> {
  const suffix = crypto.randomUUID().slice(0, 6);
  const name = opts.namePrefix ?? `wf_cron_only_${suffix}`;
  const triggerId = `trg_cron_${suffix}`;
  const status = opts.status ?? 'active';

  const { status: httpStatus, body } = await apiPost(
    ctx,
    `/api/projects/${opts.projectId}/workflows`,
    token,
    {
      name,
      description: 'Seeded cron-only workflow for UI E2E (no webhook triggers)',
      status,
      nodes: [
        {
          id: 'start-node',
          nodeType: 'start',
          name: 'Start',
          position: { x: 400, y: 50 },
          config: { inputVariables: [] },
        },
        {
          id: 'end-node',
          nodeType: 'end',
          name: 'End',
          position: { x: 400, y: 300 },
          config: {},
        },
      ],
      edges: [
        {
          id: 'edge-start-end',
          source: 'start-node',
          target: 'end-node',
        },
      ],
      triggers: [
        {
          id: triggerId,
          type: 'cron',
          config: { schedule: '0 0 * * *' },
          status: 'active',
        },
      ],
    },
  );

  if (httpStatus !== 200 && httpStatus !== 201) {
    throw new Error(`seedCronOnlyWorkflow failed: HTTP ${httpStatus} — ${JSON.stringify(body)}`);
  }

  const workflowId =
    (body as Record<string, unknown>).id ??
    ((body as Record<string, unknown>).workflow as Record<string, unknown>)?.id ??
    '';

  if (!workflowId) {
    throw new Error(`seedCronOnlyWorkflow: no workflow id in response — ${JSON.stringify(body)}`);
  }

  return { workflowId: String(workflowId), triggerId, name };
}

/**
 * Deletes a seeded workflow by id. Safe to call in `afterAll` — swallows 404.
 */
export async function deleteSeededWorkflow(
  ctx: Page | APIRequestContext,
  token: string,
  projectId: string,
  workflowId: string,
): Promise<void> {
  const { status } = await apiDelete(
    ctx,
    `/api/projects/${projectId}/workflows/${workflowId}`,
    token,
  );
  if (status !== 200 && status !== 204 && status !== 404) {
    console.warn(`[E2E] deleteSeededWorkflow: unexpected HTTP ${status} for ${workflowId}`);
  }
}
