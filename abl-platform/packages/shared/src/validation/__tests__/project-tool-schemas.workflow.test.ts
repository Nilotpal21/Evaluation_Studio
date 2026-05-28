import { describe, it, expect } from 'vitest';
import { CreateProjectToolSchema, CreateWorkflowToolSchema } from '../project-tool-schemas.js';

describe('CreateWorkflowToolSchema', () => {
  const validPayload = {
    name: 'run_approval',
    description: 'Trigger an approval workflow',
    toolType: 'workflow' as const,
    workflowId: 'wf_abc123',
    triggerId: 'tr_xyz789',
    mode: 'sync' as const,
    timeoutMs: 30000,
    paramMapping: { order_id: '$.payload.orderId' },
  };

  it('accepts a valid workflow tool payload', () => {
    const result = CreateWorkflowToolSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.toolType).toBe('workflow');
      expect(result.data.workflowId).toBe('wf_abc123');
      expect(result.data.triggerId).toBe('tr_xyz789');
      expect(result.data.mode).toBe('sync');
      expect(result.data.timeoutMs).toBe(30000);
      expect(result.data.paramMapping).toEqual({ order_id: '$.payload.orderId' });
    }
  });

  it('defaults mode to sync when not provided', () => {
    const { mode: _, ...withoutMode } = validPayload;
    const result = CreateWorkflowToolSchema.safeParse(withoutMode);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe('sync');
    }
  });

  it('rejects missing workflowId', () => {
    const { workflowId: _, ...without } = validPayload;
    const result = CreateWorkflowToolSchema.safeParse(without);
    expect(result.success).toBe(false);
  });

  it('rejects missing triggerId', () => {
    const { triggerId: _, ...without } = validPayload;
    const result = CreateWorkflowToolSchema.safeParse(without);
    expect(result.success).toBe(false);
  });

  it('rejects empty workflowId', () => {
    const result = CreateWorkflowToolSchema.safeParse({
      ...validPayload,
      workflowId: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty triggerId', () => {
    const result = CreateWorkflowToolSchema.safeParse({
      ...validPayload,
      triggerId: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects timeoutMs below 1000', () => {
    const result = CreateWorkflowToolSchema.safeParse({
      ...validPayload,
      timeoutMs: 500,
    });
    expect(result.success).toBe(false);
  });

  it('rejects timeoutMs above 600000', () => {
    const result = CreateWorkflowToolSchema.safeParse({
      ...validPayload,
      timeoutMs: 700_000,
    });
    expect(result.success).toBe(false);
  });
});

describe('CreateProjectToolSchema — workflow discriminant', () => {
  it('accepts workflow payload through the discriminated union', () => {
    const result = CreateProjectToolSchema.safeParse({
      name: 'run_approval',
      description: 'Trigger an approval workflow',
      toolType: 'workflow',
      workflowId: 'wf_abc123',
      triggerId: 'tr_xyz789',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.toolType).toBe('workflow');
    }
  });

  it('rejects workflow payload with missing required fields through union', () => {
    const result = CreateProjectToolSchema.safeParse({
      name: 'run_approval',
      description: 'Trigger an approval workflow',
      toolType: 'workflow',
      // missing workflowId and triggerId
    });
    expect(result.success).toBe(false);
  });
});
