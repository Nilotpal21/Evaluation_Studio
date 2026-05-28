import { describe, it, expect } from 'vitest';
import {
  sanitizeStepOutput,
  buildCleanStepContext,
  type BaseStepContext,
} from '../context/step-context-schema.js';

// ── sanitizeStepOutput ────────────────────────────────────────────────────────
// sanitizeStepOutput is a deprecated pass-through. Credential stripping happens
// at the WS publish boundary (PUBLISH_SENSITIVE_STEP_FIELDS / sanitizeSnapshotDoc).

describe('sanitizeStepOutput — connector_action', () => {
  it('passes scalar string through unchanged (regression: was silently dropped as null)', () => {
    const result = sanitizeStepOutput('connector_action', 'Hello from Claude');
    expect(result).toBe('Hello from Claude');
  });

  it('passes scalar number through unchanged', () => {
    expect(sanitizeStepOutput('connector_action', 42)).toBe(42);
  });

  it('passes boolean through unchanged', () => {
    expect(sanitizeStepOutput('connector_action', false)).toBe(false);
  });

  it('passes array through unchanged', () => {
    const arr = [{ id: 1 }, { id: 2 }];
    expect(sanitizeStepOutput('connector_action', arr)).toStrictEqual(arr);
  });

  it('passes null through unchanged', () => {
    expect(sanitizeStepOutput('connector_action', null)).toBeNull();
  });

  it('returns undefined for undefined', () => {
    expect(sanitizeStepOutput('connector_action', undefined)).toBeUndefined();
  });

  it('passes AP httpClient envelope through unchanged — credential stripping is at WS boundary', () => {
    const apEnvelope = {
      status: 200,
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok' },
      body: { id: 'PROJ-1', summary: 'Fix bug' },
    };
    expect(sanitizeStepOutput('connector_action', apEnvelope)).toStrictEqual(apEnvelope);
  });

  it('passes Axios envelope through unchanged', () => {
    const axiosEnvelope = {
      status: 201,
      statusText: 'Created',
      headers: { 'x-request-id': 'abc123' },
      config: { url: 'https://api.example.com', method: 'post' },
      request: {},
      data: { token: 'secret-token', userId: 'u1' },
    };
    expect(sanitizeStepOutput('connector_action', axiosEnvelope)).toStrictEqual(axiosEnvelope);
  });

  it('passes business object with numeric status through unchanged', () => {
    const businessObj = { status: 1, name: 'Active', code: 'ACT' };
    expect(sanitizeStepOutput('connector_action', businessObj)).toStrictEqual(businessObj);
  });

  it('passes plain object with no status field through unchanged', () => {
    const plain = { id: 'abc', name: 'Widget', price: 9.99 };
    expect(sanitizeStepOutput('connector_action', plain)).toStrictEqual(plain);
  });
});

describe('sanitizeStepOutput — non-connector node types', () => {
  it('passes output through unchanged for any node type', () => {
    const httpEnvelope = { status: 200, headers: { 'content-type': 'application/json' }, body: {} };
    expect(sanitizeStepOutput('http', httpEnvelope)).toStrictEqual(httpEnvelope);
    expect(sanitizeStepOutput('function', 'some string')).toBe('some string');
    expect(sanitizeStepOutput('agent_invocation', null)).toBeNull();
  });
});

// ── buildCleanStepContext — connector_action ─────────────────────────────────

describe('buildCleanStepContext — connector_action output', () => {
  const base: BaseStepContext = {
    nodeType: 'connector_action',
    stepId: 'step-1',
    status: 'completed',
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T00:00:01Z',
    durationMs: 1000,
  };

  it('scalar string output (Claude/OpenAI text) survives round-trip through buildCleanStepContext', () => {
    const ctx = buildCleanStepContext('connector_action', base, {
      input: { connector: 'claude', action: 'ask_claude' },
      output: 'The answer is 42.',
    });
    expect(ctx.nodeType).toBe('connector_action');
    if (ctx.nodeType === 'connector_action') {
      expect(ctx.output).toBe('The answer is 42.');
    }
  });

  it('HTTP envelope output is stored as-is — headers preserved (stripping at WS boundary)', () => {
    const envelope = {
      status: 200,
      headers: { 'x-atlassian-token': 'no-check' },
      body: [{ id: '100001', filename: 'report.pdf' }],
    };
    const ctx = buildCleanStepContext('connector_action', base, {
      input: { connector: 'jira-cloud', action: 'add_issue_attachment' },
      output: envelope,
    });
    if (ctx.nodeType === 'connector_action') {
      expect(ctx.output).toStrictEqual(envelope);
    }
  });

  it('undefined output field is omitted from the built context', () => {
    const ctx = buildCleanStepContext('connector_action', base, {});
    if (ctx.nodeType === 'connector_action') {
      expect(ctx.output).toBeUndefined();
    }
  });

  it('null output is stored as null', () => {
    const ctx = buildCleanStepContext('connector_action', base, { output: null });
    if (ctx.nodeType === 'connector_action') {
      expect(ctx.output).toBeNull();
    }
  });
});
