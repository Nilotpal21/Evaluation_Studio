import { describe, expect, it } from 'vitest';
import { validateToolDsl } from '../project-tool-validator.js';

const context = {
  tenantId: 'tenant-1',
  projectId: 'project-1',
};

describe('validateToolDsl runtime numeric placeholders', () => {
  it('accepts config-backed numeric fields that runtime DSL parsing can resolve later', () => {
    const httpResult = validateToolDsl(
      [
        'lookup_customer(id: string) -> object',
        '  type: http',
        '  endpoint: "https://api.example.com/customers/{{input.id}}"',
        '  method: GET',
        '  timeout: "{{config.HTTP_TIMEOUT_MS}}"',
        '  retry: "{{config.HTTP_RETRY_COUNT}}"',
      ].join('\n'),
      context,
    );
    const sandboxResult = validateToolDsl(
      [
        'run_transform(payload: object) -> object',
        '  type: sandbox',
        '  runtime: javascript',
        '  memory_mb: "{{config.SANDBOX_MEMORY_MB}}"',
        '  code: |',
        '    return payload;',
      ].join('\n'),
      context,
    );
    const workflowResult = validateToolDsl(
      [
        'run_approval(order_id: string) -> object',
        '  type: workflow',
        '  workflow_id: "{{config.APPROVAL_WORKFLOW_ID}}"',
        '  trigger_id: "{{config.APPROVAL_TRIGGER_ID}}"',
        '  timeout_ms: "{{config.WORKFLOW_TIMEOUT_MS}}"',
      ].join('\n'),
      context,
    );

    expect(httpResult.errors).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'E737' }),
        expect.objectContaining({ code: 'E738' }),
      ]),
    );
    expect(sandboxResult.errors).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'E745' })]),
    );
    expect(workflowResult.errors).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'WORKFLOW_INVALID_TIMEOUT' })]),
    );
    expect(httpResult.valid).toBe(true);
    expect(sandboxResult.valid).toBe(true);
    expect(workflowResult.valid).toBe(true);
  });
});
