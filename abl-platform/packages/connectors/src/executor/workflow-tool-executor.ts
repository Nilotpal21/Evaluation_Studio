/**
 * WorkflowToolExecutor
 *
 * Enables agents to invoke workflows as tools during conversation.
 * Supports sync mode (wait for result) and async mode (return immediately).
 *
 * Uses a generic WorkflowClient interface so we can swap between
 * Restate SDK, HTTP, or mock implementations.
 */

import { randomUUID } from 'crypto';

/** Binding configuration from IR (matches WorkflowBindingIR in schema.ts) */
export interface WorkflowBinding {
  workflowId: string;
  mode: 'sync' | 'async';
  paramMapping: Record<string, string>;
  timeoutMs?: number;
}

/** Result of a workflow execution */
export interface WorkflowResult {
  executionId: string;
  status: 'completed' | 'failed' | 'submitted';
  output?: unknown;
  error?: string;
}

/** Generic workflow client interface — abstracts over Restate, HTTP, etc. */
export interface WorkflowClient {
  submit(input: WorkflowSubmitInput): Promise<WorkflowHandle>;
}

export interface WorkflowSubmitInput {
  workflowId: string;
  executionId: string;
  tenantId?: string;
  projectId?: string;
  triggerType: string;
  triggerPayload: Record<string, unknown>;
}

export interface WorkflowHandle {
  /** Wait for workflow completion and return result */
  result(opts?: { timeout?: number }): Promise<{
    status: 'completed' | 'failed';
    context?: { steps?: Record<string, { output?: unknown }> };
    error?: string;
  }>;
}

export interface WorkflowToolExecutorContext {
  tenantId: string;
  projectId: string;
}

export class WorkflowToolExecutor {
  private bindings = new Map<string, WorkflowBinding>();

  constructor(
    private readonly client: WorkflowClient,
    private readonly sessionContext: WorkflowToolExecutorContext,
  ) {}

  registerBinding(toolName: string, binding: WorkflowBinding): void {
    this.bindings.set(toolName, binding);
  }

  async execute(
    toolName: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<WorkflowResult> {
    const binding = this.bindings.get(toolName);
    if (!binding) {
      throw new Error(`No workflow binding registered for tool: ${toolName}`);
    }

    const executionId = randomUUID();

    // Map agent tool params → workflow trigger payload
    const triggerPayload: Record<string, unknown> = {};
    for (const [toolParam, workflowField] of Object.entries(binding.paramMapping)) {
      triggerPayload[workflowField] = params[toolParam];
    }

    const handle = await this.client.submit({
      workflowId: binding.workflowId,
      executionId,
      tenantId: this.sessionContext.tenantId,
      projectId: this.sessionContext.projectId,
      triggerType: 'agent',
      triggerPayload,
    });

    if (binding.mode === 'sync') {
      const result = await handle.result({
        timeout: binding.timeoutMs ?? timeoutMs,
      });
      return {
        executionId,
        status: result.status,
        output: result.context?.steps,
        error: result.error,
      };
    }

    // Async mode — return immediately
    return {
      executionId,
      status: 'submitted',
    };
  }
}
