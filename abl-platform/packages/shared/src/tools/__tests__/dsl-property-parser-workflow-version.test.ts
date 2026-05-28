/**
 * DSL round-trip test — workflow_version property.
 *
 * Verifies:
 * - `workflow_version: "v0.1.0"` DSL prop → `WorkflowBindingLocal.workflowVersion === 'v0.1.0'`
 * - Missing `workflow_version` key → `WorkflowBindingLocal.workflowVersion === undefined`
 * - Empty string → `workflowVersion` key absent from returned object
 *
 * No mocks — exercises the pure `buildWorkflowBindingFromProps()` function directly.
 */

import { describe, it, expect } from 'vitest';
import {
  buildHttpBindingFromProps,
  buildSandboxBindingFromProps,
  buildWorkflowBindingFromProps,
} from '../dsl-property-parser.js';

describe('buildWorkflowBindingFromProps — workflow_version DSL round-trip', () => {
  const baseProps = {
    workflow_id: 'wf-123',
    trigger_id: 'tr-456',
    mode: 'sync',
  };

  it('parses workflow_version: "v0.1.0" into workflowVersion', () => {
    const result = buildWorkflowBindingFromProps({
      ...baseProps,
      workflow_version: 'v0.1.0',
    });

    expect(result.workflowVersion).toBe('v0.1.0');
    expect(result.workflowId).toBe('wf-123');
    expect(result.triggerId).toBe('tr-456');
    expect(result.mode).toBe('sync');
  });

  it('returns undefined workflowVersion when key is missing', () => {
    const result = buildWorkflowBindingFromProps(baseProps);

    expect(result.workflowVersion).toBeUndefined();
    // workflowVersion key should not be present at all
    expect('workflowVersion' in result).toBe(false);
  });

  it('treats empty string as absent — no workflowVersion key', () => {
    const result = buildWorkflowBindingFromProps({
      ...baseProps,
      workflow_version: '',
    });

    expect(result.workflowVersion).toBeUndefined();
    expect('workflowVersion' in result).toBe(false);
  });

  it('trims whitespace from workflow_version', () => {
    const result = buildWorkflowBindingFromProps({
      ...baseProps,
      workflow_version: '  v0.2.0  ',
    });

    expect(result.workflowVersion).toBe('v0.2.0');
  });

  it('treats whitespace-only string as absent', () => {
    const result = buildWorkflowBindingFromProps({
      ...baseProps,
      workflow_version: '   ',
    });

    expect(result.workflowVersion).toBeUndefined();
    expect('workflowVersion' in result).toBe(false);
  });

  it('preserves exact config placeholders in numeric workflow timeout fields', () => {
    const result = buildWorkflowBindingFromProps({
      ...baseProps,
      timeout_ms: '{{config.WORKFLOW_TIMEOUT_MS}}',
    });

    expect(result.timeoutMs).toBe('{{config.WORKFLOW_TIMEOUT_MS}}');
  });

  it('preserves exact config placeholders in numeric HTTP and sandbox fields', () => {
    const http = buildHttpBindingFromProps({
      endpoint: 'https://example.com',
      method: 'GET',
      timeout: '{{config.HTTP_TIMEOUT_MS}}',
    });
    const sandbox = buildSandboxBindingFromProps(
      {
        runtime: 'javascript',
        timeout: '{{config.SANDBOX_TIMEOUT_MS}}',
        memory_mb: '{{config.SANDBOX_MEMORY_MB}}',
      },
      'code: |\n  return true;',
    );

    expect(http.timeout_ms).toBe('{{config.HTTP_TIMEOUT_MS}}');
    expect(sandbox.timeout_ms).toBe('{{config.SANDBOX_TIMEOUT_MS}}');
    expect(sandbox.memory_mb).toBe('{{config.SANDBOX_MEMORY_MB}}');
  });
});
