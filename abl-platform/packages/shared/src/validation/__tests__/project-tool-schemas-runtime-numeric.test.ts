import { describe, expect, it } from 'vitest';
import {
  CreateHttpToolSchema,
  CreateSandboxToolSchema,
  CreateWorkflowToolSchema,
} from '../project-tool-schemas.js';

describe('project tool schemas runtime numeric config placeholders', () => {
  it('accepts HTTP numeric fields backed by exact config placeholders', () => {
    const result = CreateHttpToolSchema.safeParse({
      name: 'configured_api',
      description: 'Configured API',
      toolType: 'http',
      endpoint: 'https://api.example.com',
      method: 'GET',
      auth: 'none',
      timeout: '{{config.HTTP_TIMEOUT_MS}}',
      retry: '{{config.HTTP_RETRY_COUNT}}',
      retryDelay: '{{config.HTTP_RETRY_DELAY_MS}}',
      rateLimit: '{{config.HTTP_RATE_LIMIT}}',
      circuitBreaker: {
        threshold: '{{config.HTTP_CB_THRESHOLD}}',
        resetMs: '{{config.HTTP_CB_RESET_MS}}',
      },
    });

    expect(result.success).toBe(true);
  });

  it('accepts sandbox numeric fields backed by exact config placeholders', () => {
    const result = CreateSandboxToolSchema.safeParse({
      name: 'configured_sandbox',
      description: 'Configured sandbox',
      toolType: 'sandbox',
      runtime: 'python',
      code: 'print("hello")',
      memoryMb: '{{config.SANDBOX_MEMORY_MB}}',
      timeout: '{{config.SANDBOX_TIMEOUT_MS}}',
    });

    expect(result.success).toBe(true);
  });

  it('accepts workflow timeout backed by an exact config placeholder', () => {
    const result = CreateWorkflowToolSchema.safeParse({
      name: 'configured_workflow',
      description: 'Configured workflow',
      toolType: 'workflow',
      workflowId: 'wf-1',
      triggerId: 'tr-1',
      timeoutMs: '{{config.WORKFLOW_TIMEOUT_MS}}',
    });

    expect(result.success).toBe(true);
  });

  it('rejects non-exact config expressions for numeric fields', () => {
    const result = CreateHttpToolSchema.safeParse({
      name: 'configured_api',
      description: 'Configured API',
      toolType: 'http',
      endpoint: 'https://api.example.com',
      method: 'GET',
      auth: 'none',
      timeout: 'prefix-{{config.HTTP_TIMEOUT_MS}}',
    });

    expect(result.success).toBe(false);
  });
});
