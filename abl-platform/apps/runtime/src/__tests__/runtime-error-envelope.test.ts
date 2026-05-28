import { describe, expect, it } from 'vitest';
import { AppError, ErrorCodes, ToolExecutionError } from '@agent-platform/shared-kernel';
import { classifyLlmError } from '../services/llm/classify-llm-error.js';
import { buildRuntimeErrorEnvelope } from '../services/execution/runtime-error-envelope.js';

describe('buildRuntimeErrorEnvelope', () => {
  it('turns known LLM diagnostics into a trace-linked sanitized envelope', () => {
    const classified = classifyLlmError(
      new Error(
        "Item 'fc_123' of type 'function_call' was provided without its required 'reasoning' item: 'rs_456'.",
      ),
    );

    const envelope = buildRuntimeErrorEnvelope(classified, {
      traceId: 'trace-1',
      agentName: 'SupportAgent',
    });

    expect(envelope).toEqual({
      code: 'OPENAI_RESPONSES_REASONING_ITEM_MISSING',
      category: 'llm',
      severity: 'error',
      customer_message: "I'm having trouble completing that request. Please try again.",
      operator_hint:
        'OpenAI Responses rejected a function_call item because its required reasoning item was missing from replayed history.',
      trace_id: 'trace-1',
      agent_name: 'SupportAgent',
      recommended_action:
        'Verify Responses history uses previous_response_id or preserves reasoning items adjacent to function_call items.',
    });
    expect(JSON.stringify(envelope)).not.toContain('fc_123');
    expect(JSON.stringify(envelope)).not.toContain('rs_456');
    expect(envelope?.customer_message).not.toMatch(/\b(AI|model|provider|tool)\b/i);
    expect(envelope).not.toHaveProperty('provider');
  });

  it('sanitizes credential and tenant internals from configuration envelopes', () => {
    const envelope = buildRuntimeErrorEnvelope(
      new AppError(
        "No credential found for provider 'openai' in tenant 'tenant-dev'. Configure model 'gpt-4.1-internal-preview'.",
        { ...ErrorCodes.CREDENTIAL_NOT_FOUND },
      ),
      { traceId: 'trace-credentials' },
    );

    expect(envelope).toMatchObject({
      code: 'LLM_CREDENTIAL_MISSING',
      category: 'llm',
      severity: 'error',
      customer_message:
        'This workspace is not fully configured for that request. Please contact support.',
      operator_hint:
        'Model credential lookup failed or credentials are invalid. Check workspace model credentials and project model configuration.',
      trace_id: 'trace-credentials',
    });
    expect(JSON.stringify(envelope)).not.toContain('tenant-dev');
    expect(JSON.stringify(envelope)).not.toContain('openai');
    expect(JSON.stringify(envelope)).not.toContain('gpt-4.1-internal-preview');
    expect(envelope?.customer_message).not.toMatch(/\b(AI|model|provider|credential)\b/i);
  });

  it('classifies tool timeout and schema failures without raw tool error text', () => {
    const timeoutEnvelope = buildRuntimeErrorEnvelope(
      new ToolExecutionError({
        code: 'TOOL_TIMEOUT',
        message: 'Timeout calling https://internal.example.test/orders',
        toolName: 'lookup_order',
        retryable: true,
      }),
      { traceId: 'trace-tool', agentName: 'OrderAgent' },
    );

    expect(timeoutEnvelope).toMatchObject({
      code: 'TOOL_TIMEOUT',
      category: 'tool',
      severity: 'error',
      customer_message: "I'm still waiting on a required service. Please try again.",
      operator_hint:
        'Tool execution timed out. Check tool latency, timeout settings, and downstream availability.',
      trace_id: 'trace-tool',
      agent_name: 'OrderAgent',
      tool_name: 'lookup_order',
    });
    expect(JSON.stringify(timeoutEnvelope)).not.toContain('internal.example.test');
    expect(timeoutEnvelope?.customer_message).not.toMatch(/\b(tool|internal)\b/i);

    const schemaEnvelope = buildRuntimeErrorEnvelope(
      new ToolExecutionError({
        code: 'TOOL_RESPONSE_PARSE_FAILED',
        message: 'Unexpected response field secret_debug_payload',
        toolName: 'lookup_order',
      }),
    );

    expect(schemaEnvelope?.code).toBe('TOOL_SCHEMA_MISMATCH');
    expect(schemaEnvelope?.operator_hint).toContain('expected contract');
    expect(JSON.stringify(schemaEnvelope)).not.toContain('secret_debug_payload');
  });
});
