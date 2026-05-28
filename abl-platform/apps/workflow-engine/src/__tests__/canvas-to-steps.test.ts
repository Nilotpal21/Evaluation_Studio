import { describe, it, expect } from 'vitest';
import { convertCanvasToSteps } from '../handlers/canvas-to-steps.js';

describe('canvas-to-steps', () => {
  // UT-15: Canvas function node maps to function step type
  it('UT-15: function node maps to function step type (not transform)', () => {
    const nodes = [
      {
        id: 'start-1',
        nodeType: 'start',
        name: 'Start',
        config: {},
      },
      {
        id: 'fn-1',
        nodeType: 'function',
        name: 'Transform Data',
        config: {
          code: 'context.result = 1;',
          timeout: 10,
        },
      },
      {
        id: 'end-1',
        nodeType: 'end',
        name: 'End',
        config: {},
      },
    ];

    const edges = [
      { id: 'e1', source: 'start-1', target: 'fn-1' },
      { id: 'e2', source: 'fn-1', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);

    const fnStep = steps.find((s) => s.id === 'fn-1');
    expect(fnStep).toBeDefined();
    expect(fnStep!.type).toBe('function');
    expect((fnStep as Record<string, unknown>).type).not.toBe('transform');

    const config = (fnStep as Record<string, unknown>).config as Record<string, unknown>;
    expect(config.code).toBe('context.result = 1;');
    expect(config.timeout).toBe(10);
  });

  it('adds runtime end target aliases to edgeMap descriptors', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      { id: 'delay-1', nodeType: 'delay', name: 'Delay', config: { duration: 'PT1S' } },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', sourceHandle: 'on_success', target: 'delay-1' },
      { id: 'e2', source: 'delay-1', sourceHandle: 'on_success', target: 'end-1' },
    ];

    const result = convertCanvasToSteps(nodes as never[], edges as never[], { full: true });

    expect(result.edgeMap['start-1']).toContainEqual({
      edgeId: 'e1',
      sourceHandle: 'on_success',
      target: 'delay-1',
      sourceNodeType: 'start',
      sourceRuntimeId: 'start',
    });
    expect(result.edgeMap['delay-1']).toContainEqual({
      edgeId: 'e2',
      sourceHandle: 'on_success',
      target: 'end-1',
      sourceNodeType: 'delay',
      targetRuntimeId: 'end',
    });
  });

  it('data_entry node maps to human_task step with taskType data_entry', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      {
        id: 'de-1',
        nodeType: 'data_entry',
        name: 'CustomerForm',
        config: {
          fields: [
            { name: 'customer_name', type: 'text', label: 'Customer Name', required: true },
            { name: 'amount', type: 'number', label: 'Amount', required: false },
          ],
          assignTo: 'everyone',
          timeout: { duration: 30, unit: 'minutes' },
          onTimeout: 'terminate',
        },
      },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];

    const edges = [
      { id: 'e1', source: 'start-1', sourceHandle: 'on_success', target: 'de-1' },
      { id: 'e2', source: 'de-1', sourceHandle: 'on_success', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);

    const deStep = steps.find((s) => s.id === 'de-1');
    expect(deStep).toBeDefined();
    expect(deStep!.type).toBe('human_task');
    const ht = deStep as Record<string, unknown>;
    expect(ht.taskType).toBe('data_entry');
    expect(ht.title).toBe('CustomerForm');
    expect(ht.timeout).toBe(30 * 60 * 1000); // 30 minutes in ms
    expect(Array.isArray(ht.fields)).toBe(true);
    expect((ht.fields as unknown[]).length).toBe(2);
  });

  it('data_entry fields default label to name and preserve select options objects', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      {
        id: 'de-2',
        nodeType: 'data_entry',
        name: 'GenderForm',
        config: {
          fields: [
            {
              name: 'gender',
              type: 'select',
              label: '',
              required: true,
              options: [
                { label: 'Male', value: 'm' },
                { label: 'Female', value: 'f' },
              ],
            },
            { name: 'notes', type: 'textarea', required: false },
          ],
          assignTo: 'everyone',
        },
      },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];

    const edges = [
      { id: 'e1', source: 'start-1', sourceHandle: 'on_success', target: 'de-2' },
      { id: 'e2', source: 'de-2', sourceHandle: 'on_success', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const deStep = steps.find((s) => s.id === 'de-2');
    expect(deStep).toBeDefined();

    const fields = (deStep as Record<string, unknown>).fields as Record<string, unknown>[];
    // Empty label defaults to field name
    expect(fields[0].label).toBe('gender');
    // Missing label defaults to field name
    expect(fields[1].label).toBe('notes');
    // Select options objects are preserved (not flattened to strings)
    expect(fields[0].options).toEqual([
      { label: 'Male', value: 'm' },
      { label: 'Female', value: 'f' },
    ]);
    // required is normalized to boolean
    expect(fields[1].required).toBe(false);
  });

  it("data_entry with assignTo: 'specific' resolves assignees list from config.assignees", () => {
    // Covers the 'specific' branch (line ~439-441) including the filter(Boolean)
    // path that drops empty-string entries.
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      {
        id: 'de-3',
        nodeType: 'data_entry',
        name: 'ReviewForm',
        config: {
          fields: [{ name: 'decision', type: 'text', label: 'Decision', required: true }],
          assignTo: 'specific',
          assignees: ['alice@example.com', '', 'bob@example.com'],
        },
      },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', sourceHandle: 'on_success', target: 'de-3' },
      { id: 'e2', source: 'de-3', sourceHandle: 'on_success', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const ht = steps.find((s) => s.id === 'de-3') as Record<string, unknown>;
    expect(ht.assignTo).toEqual(['alice@example.com', 'bob@example.com']);
  });

  it('data_entry with assignTo as an array passes it through unchanged', () => {
    // Covers the `Array.isArray(config.assignTo)` branch (line ~444-445).
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      {
        id: 'de-4',
        nodeType: 'data_entry',
        name: 'TeamForm',
        config: {
          fields: [{ name: 'note', type: 'text', label: 'Note', required: false }],
          assignTo: ['alice', 'bob'],
        },
      },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', sourceHandle: 'on_success', target: 'de-4' },
      { id: 'e2', source: 'de-4', sourceHandle: 'on_success', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const ht = steps.find((s) => s.id === 'de-4') as Record<string, unknown>;
    expect(ht.assignTo).toEqual(['alice', 'bob']);
  });

  it('data_entry with assignTo as a single string wraps it in an array', () => {
    // Covers the `typeof config.assignTo === 'string'` fallback (line ~446-447).
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      {
        id: 'de-5',
        nodeType: 'data_entry',
        name: 'SoloForm',
        config: {
          fields: [{ name: 'note', type: 'text', label: 'Note', required: false }],
          assignTo: 'carol',
        },
      },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', sourceHandle: 'on_success', target: 'de-5' },
      { id: 'e2', source: 'de-5', sourceHandle: 'on_success', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const ht = steps.find((s) => s.id === 'de-5') as Record<string, unknown>;
    expect(ht.assignTo).toEqual(['carol']);
  });

  it('agent_invocation node maps to agent_invocation step with agentId and message', () => {
    // Covers the `case 'agent_invocation'` branch (lines ~479-492).
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      {
        id: 'ai-1',
        nodeType: 'agent',
        name: 'Ask Assistant',
        config: {
          agentId: 'agent-42',
          message: 'Summarize the incoming payload',
          timeout: 5,
        },
      },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', sourceHandle: 'on_success', target: 'ai-1' },
      { id: 'e2', source: 'ai-1', sourceHandle: 'on_success', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const ai = steps.find((s) => s.id === 'ai-1') as Record<string, unknown>;
    expect(ai.type).toBe('agent_invocation');
    expect(ai.agentId).toBe('agent-42');
    expect(ai.message).toBe('Summarize the incoming payload');
    expect(ai.timeout).toBe(5000);
  });

  it('agent_invocation serializes non-string config.input via JSON.stringify', () => {
    // Covers the `typeof config.input === 'string'` ternary false branch —
    // object inputs must be stringified, and the `agentName` fallback path.
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      {
        id: 'ai-2',
        nodeType: 'agent',
        name: 'Ask With Context',
        config: {
          agentName: 'agent-by-name',
          input: { topic: 'weather', detail: 'tomorrow' },
        },
      },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', sourceHandle: 'on_success', target: 'ai-2' },
      { id: 'e2', source: 'ai-2', sourceHandle: 'on_success', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const ai = steps.find((s) => s.id === 'ai-2') as Record<string, unknown>;
    expect(ai.agentId).toBe('agent-by-name');
    expect(ai.message).toBe(JSON.stringify({ topic: 'weather', detail: 'tomorrow' }));
  });

  it('tool_call node maps to tool_call step with toolName and params', () => {
    // Covers the `case 'tool_call'` branch (lines ~494-501).
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      {
        id: 'tc-1',
        nodeType: 'tool',
        name: 'Invoke Tool',
        config: {
          toolName: 'send-email',
          params: { to: 'alice@example.com', subject: 'Hi' },
          timeout: 12,
        },
      },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', sourceHandle: 'on_success', target: 'tc-1' },
      { id: 'e2', source: 'tc-1', sourceHandle: 'on_success', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const tc = steps.find((s) => s.id === 'tc-1') as Record<string, unknown>;
    expect(tc.type).toBe('tool_call');
    expect(tc.toolName).toBe('send-email');
    expect(tc.params).toEqual({ to: 'alice@example.com', subject: 'Hi' });
    expect(tc.timeout).toBe(12000);
    expect(tc.executionMode).toBe('sync');
  });

  it('tool_call node preserves explicit async wait execution mode', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      {
        id: 'tc-wait',
        nodeType: 'tool',
        name: 'Wait For Workflow Tool',
        config: {
          toolName: 'child-workflow',
          params: {},
          executionMode: 'async_wait',
        },
      },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', sourceHandle: 'on_success', target: 'tc-wait' },
      { id: 'e2', source: 'tc-wait', sourceHandle: 'on_success', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const tc = steps.find((s) => s.id === 'tc-wait') as Record<string, unknown>;
    expect(tc.type).toBe('tool_call');
    expect(tc.executionMode).toBe('async_wait');
  });

  it('tool_call falls back to toolId when toolName is missing and defaults params to {}', () => {
    // Covers the `config.toolId` fallback and the `params || {}` default on the
    // tool_call branch.
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      {
        id: 'tc-2',
        nodeType: 'tool',
        name: 'Legacy Tool',
        config: { toolId: 'legacy-tool' },
      },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', sourceHandle: 'on_success', target: 'tc-2' },
      { id: 'e2', source: 'tc-2', sourceHandle: 'on_success', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const tc = steps.find((s) => s.id === 'tc-2') as Record<string, unknown>;
    expect(tc.toolName).toBe('legacy-tool');
    expect(tc.params).toEqual({});
  });

  // ─── http / api nodes ────────────────────────────────────────────────────

  it('api node maps to http step with method, url, headers, body, and timeout', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      {
        id: 'api-1',
        nodeType: 'api',
        name: 'Fetch',
        config: {
          method: 'POST',
          url: 'https://api.example.com/create',
          headers: { 'x-auth': 'abc' },
          body: '{"foo":1}',
          timeout: 5,
        },
      },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'api-1' },
      { id: 'e2', source: 'api-1', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const http = steps.find((s) => s.id === 'api-1') as Record<string, unknown>;
    expect(http.type).toBe('http');
    expect(http.method).toBe('POST');
    expect(http.url).toBe('https://api.example.com/create');
    expect(http.headers).toEqual({ 'x-auth': 'abc' });
    expect(http.body).toBe('{"foo":1}');
    expect(http.timeout).toBe(5000);
  });

  it('api node without method/url config defaults to GET and empty url', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      { id: 'api-2', nodeType: 'api', name: 'Fetch', config: {} },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'api-2' },
      { id: 'e2', source: 'api-2', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const http = steps.find((s) => s.id === 'api-2') as Record<string, unknown>;
    expect(http.method).toBe('GET');
    expect(http.url).toBe('');
  });

  // ─── condition nodes ─────────────────────────────────────────────────────

  it('condition node derives thenSteps from non-else edges and elseSteps from else edges', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      {
        id: 'cond-1',
        nodeType: 'condition',
        name: 'If',
        config: {
          conditions: [{ field: 'trigger.payload.status', operator: '==', value: '"ok"' }],
        },
      },
      { id: 'yes-1', nodeType: 'api', name: 'Yes', config: { url: 'https://y.com' } },
      { id: 'no-1', nodeType: 'api', name: 'No', config: { url: 'https://n.com' } },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'cond-1' },
      { id: 'e2', source: 'cond-1', sourceHandle: 'if_0', target: 'yes-1' },
      { id: 'e3', source: 'cond-1', sourceHandle: 'else', target: 'no-1' },
      { id: 'e4', source: 'yes-1', target: 'end-1' },
      { id: 'e5', source: 'no-1', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const cond = steps.find((s) => s.id === 'cond-1') as Record<string, unknown>;
    expect(cond.type).toBe('condition');
    expect(cond.thenSteps).toEqual(['yes-1']);
    expect(cond.elseSteps).toEqual(['no-1']);
    expect(cond.canvasRouted).toBe(true);
    // field was not already wrapped → engine wraps in {{ }}
    expect(cond.expression).toBe('{{trigger.payload.status}} == "ok"');
  });

  it('condition node leaves already-wrapped field expressions alone', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      {
        id: 'cond-2',
        nodeType: 'condition',
        name: 'If wrapped',
        config: {
          conditions: [{ field: '{{vars.flag}}', operator: '!=', value: 'false' }],
        },
      },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'cond-2' },
      { id: 'e2', source: 'cond-2', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const cond = steps.find((s) => s.id === 'cond-2') as Record<string, unknown>;
    expect(cond.expression).toBe('{{vars.flag}} != false');
  });

  it('condition node defaults expression to "true" when conditions array is empty', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      { id: 'cond-3', nodeType: 'condition', name: 'If', config: { conditions: [] } },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'cond-3' },
      { id: 'e2', source: 'cond-3', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const cond = steps.find((s) => s.id === 'cond-3') as Record<string, unknown>;
    expect(cond.expression).toBe('true');
  });

  // ─── delay nodes ─────────────────────────────────────────────────────────

  it('delay node passes ISO duration string through unchanged', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      { id: 'd-1', nodeType: 'delay', name: 'Wait', config: { duration: 'PT5M' } },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'd-1' },
      { id: 'e2', source: 'd-1', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const d = steps.find((s) => s.id === 'd-1') as Record<string, unknown>;
    expect(d.type).toBe('delay');
    expect(d.duration).toBe('PT5M');
  });

  it('delay node converts durationMs to seconds-based ISO string', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      { id: 'd-2', nodeType: 'delay', name: 'Wait', config: { durationMs: 3500 } },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'd-2' },
      { id: 'e2', source: 'd-2', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const d = steps.find((s) => s.id === 'd-2') as Record<string, unknown>;
    // Math.round(3500 / 1000) = 4
    expect(d.duration).toBe('PT4S');
  });

  it('delay node with no duration config defaults to PT1S', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      { id: 'd-3', nodeType: 'delay', name: 'Wait', config: {} },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'd-3' },
      { id: 'e2', source: 'd-3', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const d = steps.find((s) => s.id === 'd-3') as Record<string, unknown>;
    expect(d.duration).toBe('PT1S');
  });

  // ─── loop node ───────────────────────────────────────────────────────────

  it('loop node maps to loop step with full config attached', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      {
        id: 'lp-1',
        nodeType: 'loop',
        name: 'Each',
        config: { items: '{{trigger.payload.items}}', as: 'item' },
      },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'lp-1' },
      { id: 'e2', source: 'lp-1', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const lp = steps.find((s) => s.id === 'lp-1') as Record<string, unknown>;
    expect(lp.type).toBe('loop');
    expect(lp.config).toEqual({
      items: '{{trigger.payload.items}}',
      as: 'item',
      collection: '{{trigger.payload.items}}',
      itemVariable: 'item',
    });
  });

  // ─── connector_action / integration node ─────────────────────────────────

  it('integration node maps to connector_action with connectorId/actionName primary fields', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      {
        id: 'ia-1',
        nodeType: 'integration',
        name: 'Slack send',
        config: {
          connectorId: 'slack',
          actionName: 'postMessage',
          params: { channel: '#ops', text: 'hi' },
          paramModes: { channel: 'static', text: 'expression' },
          connectionId: 'conn-1',
          timeout: 2,
        },
      },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'ia-1' },
      { id: 'e2', source: 'ia-1', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const ca = steps.find((s) => s.id === 'ia-1') as Record<string, unknown>;
    expect(ca.type).toBe('connector_action');
    expect(ca.connector).toBe('slack');
    expect(ca.action).toBe('postMessage');
    expect(ca.params).toEqual({ channel: '#ops', text: 'hi' });
    expect(ca.paramModes).toEqual({ channel: 'static', text: 'expression' });
    expect(ca.connectionId).toBe('conn-1');
    expect(ca.timeout).toBe(2000);
  });

  it('integration node falls back to connector/action when connectorId/actionName absent', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      {
        id: 'ia-2',
        nodeType: 'integration',
        name: 'Legacy action',
        config: { connector: 'github', action: 'createIssue' },
      },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'ia-2' },
      { id: 'e2', source: 'ia-2', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const ca = steps.find((s) => s.id === 'ia-2') as Record<string, unknown>;
    expect(ca.connector).toBe('github');
    expect(ca.action).toBe('createIssue');
    expect(ca.params).toEqual({});
  });

  // ─── human_task — timeout unit variants ──────────────────────────────────

  it('human_task timeout in seconds is converted to ms', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      {
        id: 'ht-s',
        nodeType: 'human',
        name: 'Sec',
        config: { timeout: { duration: 45, unit: 'seconds' } },
      },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'ht-s' },
      { id: 'e2', source: 'ht-s', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const ht = steps.find((s) => s.id === 'ht-s') as Record<string, unknown>;
    expect(ht.timeout).toBe(45_000);
  });

  it('human_task timeout in hours is converted to ms', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      {
        id: 'ht-h',
        nodeType: 'human',
        name: 'Hours',
        config: { timeout: { duration: 2, unit: 'hours' } },
      },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'ht-h' },
      { id: 'e2', source: 'ht-h', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const ht = steps.find((s) => s.id === 'ht-h') as Record<string, unknown>;
    expect(ht.timeout).toBe(2 * 3_600_000);
  });

  it('human_task timeout in days is converted to ms', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      {
        id: 'ht-d',
        nodeType: 'human',
        name: 'Days',
        config: { timeout: { duration: 3, unit: 'days' } },
      },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'ht-d' },
      { id: 'e2', source: 'ht-d', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const ht = steps.find((s) => s.id === 'ht-d') as Record<string, unknown>;
    expect(ht.timeout).toBe(3 * 86_400_000);
  });

  it('human_task timeout as a raw number passes through unchanged', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      {
        id: 'ht-n',
        nodeType: 'human',
        name: 'Raw ms',
        config: { timeout: 15_000 },
      },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'ht-n' },
      { id: 'e2', source: 'ht-n', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const ht = steps.find((s) => s.id === 'ht-n') as Record<string, unknown>;
    expect(ht.timeout).toBe(15_000);
  });

  it('human_task timeout object with duration=0 produces undefined timeout', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      {
        id: 'ht-0',
        nodeType: 'human',
        name: 'Zero',
        config: { timeout: { duration: 0, unit: 'minutes' } },
      },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'ht-0' },
      { id: 'e2', source: 'ht-0', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const ht = steps.find((s) => s.id === 'ht-0') as Record<string, unknown>;
    expect(ht.timeout).toBeUndefined();
  });

  // ─── human_task — onTimeout mapping ──────────────────────────────────────

  it('human_task onTimeout "terminate" is mapped to "expire"', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      {
        id: 'ht-ot',
        nodeType: 'human',
        name: 'Term',
        config: { onTimeout: 'terminate' },
      },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'ht-ot' },
      { id: 'e2', source: 'ht-ot', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const ht = steps.find((s) => s.id === 'ht-ot') as Record<string, unknown>;
    expect(ht.onTimeout).toBe('expire');
  });

  it('human_task onTimeout "skip" passes through as "skip"', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      { id: 'ht-sk', nodeType: 'human', name: 'Skip', config: { onTimeout: 'skip' } },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'ht-sk' },
      { id: 'e2', source: 'ht-sk', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const ht = steps.find((s) => s.id === 'ht-sk') as Record<string, unknown>;
    expect(ht.onTimeout).toBe('skip');
  });

  it('human_task onTimeout "escalate" passes through unchanged', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      {
        id: 'ht-es',
        nodeType: 'human',
        name: 'Esc',
        config: { onTimeout: 'escalate' },
      },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'ht-es' },
      { id: 'e2', source: 'ht-es', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const ht = steps.find((s) => s.id === 'ht-es') as Record<string, unknown>;
    expect(ht.onTimeout).toBe('escalate');
  });

  // ─── human_task — title / description / taskType fallbacks ───────────────

  it('human_task falls back from title → subject → node.name', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      {
        id: 'ht-fb1',
        nodeType: 'human',
        name: 'FallbackName',
        config: { subject: 'Subject Text' },
      },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'ht-fb1' },
      { id: 'e2', source: 'ht-fb1', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const ht = steps.find((s) => s.id === 'ht-fb1') as Record<string, unknown>;
    // config.subject takes precedence over node.name
    expect(ht.title).toBe('Subject Text');
  });

  it('human_task falls back to node.name when no title or subject is set', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      { id: 'ht-fb2', nodeType: 'human', name: 'FallbackName', config: {} },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'ht-fb2' },
      { id: 'e2', source: 'ht-fb2', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const ht = steps.find((s) => s.id === 'ht-fb2') as Record<string, unknown>;
    expect(ht.title).toBe('FallbackName');
  });

  it('human_task description falls back to config.message when description absent', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      {
        id: 'ht-fb3',
        nodeType: 'human',
        name: 'Msg',
        config: { message: 'Approve this please' },
      },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'ht-fb3' },
      { id: 'e2', source: 'ht-fb3', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const ht = steps.find((s) => s.id === 'ht-fb3') as Record<string, unknown>;
    expect(ht.description).toBe('Approve this please');
  });

  it('human_task description falls back to config.instructions as final option', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      {
        id: 'ht-fb4',
        nodeType: 'human',
        name: 'Inst',
        config: { instructions: 'Please review' },
      },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'ht-fb4' },
      { id: 'e2', source: 'ht-fb4', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const ht = steps.find((s) => s.id === 'ht-fb4') as Record<string, unknown>;
    expect(ht.description).toBe('Please review');
  });

  it('human nodeType defaults taskType to "approval" when config.taskType is absent', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      { id: 'ht-tt1', nodeType: 'human', name: 'Default', config: {} },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'ht-tt1' },
      { id: 'e2', source: 'ht-tt1', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const ht = steps.find((s) => s.id === 'ht-tt1') as Record<string, unknown>;
    expect(ht.taskType).toBe('approval');
  });

  it('human_task taskType from config overrides nodeType-based default', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      {
        id: 'ht-tt2',
        nodeType: 'data_entry',
        name: 'Review',
        config: { taskType: 'review', fields: [] },
      },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'ht-tt2' },
      { id: 'e2', source: 'ht-tt2', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const ht = steps.find((s) => s.id === 'ht-tt2') as Record<string, unknown>;
    expect(ht.taskType).toBe('review');
  });

  it('human_task priority passes through from config', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      {
        id: 'ht-pr',
        nodeType: 'human',
        name: 'Hi',
        config: { priority: 'high' },
      },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'ht-pr' },
      { id: 'e2', source: 'ht-pr', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const ht = steps.find((s) => s.id === 'ht-pr') as Record<string, unknown>;
    expect(ht.priority).toBe('high');
  });

  // ─── agent_invocation ────────────────────────────────────────────────────

  it('agent_invocation with string config.input uses it as message', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      {
        id: 'ai-s',
        nodeType: 'agent',
        name: 'Agent',
        config: { agentId: 'a-1', input: 'tell me a joke' },
      },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'ai-s' },
      { id: 'e2', source: 'ai-s', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const ai = steps.find((s) => s.id === 'ai-s') as Record<string, unknown>;
    expect(ai.message).toBe('tell me a joke');
  });

  it('agent_invocation with no message or input produces an empty string', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      { id: 'ai-e', nodeType: 'agent', name: 'Empty', config: { agentId: 'a-1' } },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'ai-e' },
      { id: 'e2', source: 'ai-e', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const ai = steps.find((s) => s.id === 'ai-e') as Record<string, unknown>;
    expect(ai.message).toBe('');
  });

  // ─── Edge routing: success / failure / reject handles ────────────────────

  it('splits outgoing edges into success, failure, and reject targets based on sourceHandle', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      { id: 'ht-r', nodeType: 'human', name: 'Review', config: {} },
      { id: 'ok-1', nodeType: 'api', name: 'OK', config: { url: 'https://ok' } },
      { id: 'err-1', nodeType: 'api', name: 'Err', config: { url: 'https://err' } },
      { id: 'rej-1', nodeType: 'api', name: 'Rej', config: { url: 'https://rej' } },
      { id: 'to-1', nodeType: 'api', name: 'Timeout', config: { url: 'https://to' } },
      { id: 'dec-1', nodeType: 'api', name: 'Decline', config: { url: 'https://dec' } },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'ht-r' },
      { id: 'e2', source: 'ht-r', sourceHandle: 'on_success', target: 'ok-1' },
      { id: 'e3', source: 'ht-r', sourceHandle: 'on_failure', target: 'err-1' },
      { id: 'e4', source: 'ht-r', sourceHandle: 'on_reject', target: 'rej-1' },
      { id: 'e5', source: 'ht-r', sourceHandle: 'on_timeout', target: 'to-1' },
      { id: 'e6', source: 'ht-r', sourceHandle: 'on_decline', target: 'dec-1' },
      { id: 'e7', source: 'ok-1', target: 'end-1' },
      { id: 'e8', source: 'err-1', target: 'end-1' },
      { id: 'e9', source: 'rej-1', target: 'end-1' },
      { id: 'e10', source: 'to-1', target: 'end-1' },
      { id: 'e11', source: 'dec-1', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const ht = steps.find((s) => s.id === 'ht-r') as Record<string, unknown>;
    expect(ht.onSuccessSteps).toEqual(['ok-1']);
    // on_failure + on_timeout both get grouped into onFailureSteps
    expect(ht.onFailureSteps).toEqual(['err-1', 'to-1']);
    // on_reject + on_decline both get grouped into onRejectSteps
    expect(ht.onRejectSteps).toEqual(['rej-1', 'dec-1']);
  });

  it('keeps onSuccessSteps pointing to end node so handler clears the queue', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      { id: 'api-last', nodeType: 'api', name: 'Last', config: { url: 'https://x' } },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'api-last' },
      { id: 'e2', source: 'api-last', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const api = steps.find((s) => s.id === 'api-last') as Record<string, unknown>;
    // End node ID is kept so the handler skips it gracefully and clears the queue
    expect(api.onSuccessSteps).toEqual(['end-1']);
  });

  it('keeps onFailureSteps/onRejectSteps referencing end nodes for queue clearing', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      { id: 'ht-t', nodeType: 'human', name: 'Review', config: {} },
      { id: 'ok-1', nodeType: 'api', name: 'OK', config: { url: 'https://ok' } },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'ht-t' },
      { id: 'e2', source: 'ht-t', sourceHandle: 'on_success', target: 'ok-1' },
      // failure and reject go straight to end — kept so handler clears queue
      { id: 'e3', source: 'ht-t', sourceHandle: 'on_failure', target: 'end-1' },
      { id: 'e4', source: 'ht-t', sourceHandle: 'on_reject', target: 'end-1' },
      { id: 'e5', source: 'ok-1', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    const ht = steps.find((s) => s.id === 'ht-t') as Record<string, unknown>;
    expect(ht.onSuccessSteps).toEqual(['ok-1']);
    expect(ht.onFailureSteps).toEqual(['end-1']);
    expect(ht.onRejectSteps).toEqual(['end-1']);
  });

  // ─── Edge cases ──────────────────────────────────────────────────────────

  it('returns empty steps when nodes is empty', () => {
    const steps = convertCanvasToSteps([] as never[], [] as never[]);
    expect(steps).toEqual([]);
  });

  it('returns empty steps when there is no start node', () => {
    const nodes = [
      { id: 'api-orphan', nodeType: 'api', name: 'Orphan', config: { url: 'https://x' } },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const steps = convertCanvasToSteps(nodes as never[], [] as never[]);
    expect(steps).toEqual([]);
  });

  it('skips nodes with an unknown nodeType but keeps traversing', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      { id: 'mystery', nodeType: 'unknown_type', name: 'Mystery', config: {} },
      { id: 'api-1', nodeType: 'api', name: 'Fetch', config: { url: 'https://y' } },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'mystery' },
      { id: 'e2', source: 'mystery', target: 'api-1' },
      { id: 'e3', source: 'api-1', target: 'end-1' },
    ];

    const steps = convertCanvasToSteps(nodes as never[], edges as never[]);
    // Unknown node is skipped; the api-1 node is still reached
    expect(steps.find((s) => s.id === 'mystery')).toBeUndefined();
    expect(steps.find((s) => s.id === 'api-1')).toBeDefined();
  });

  // ─── Full conversion result { full: true } ───────────────────────────────

  it('returns CanvasConversionResult with nameToIdMap, outputMappings (array form), and startInputVariables when opts.full is true', () => {
    const nodes = [
      {
        id: 'start-1',
        nodeType: 'start',
        name: 'Begin',
        config: {
          inputVariables: [
            { name: 'orderId', type: 'string', required: true },
            { name: 'amount', type: 'number', required: false },
          ],
        },
      },
      { id: 'api-1', nodeType: 'api', name: 'Fetch', config: { url: 'https://x' } },
      {
        id: 'end-1',
        nodeType: 'end',
        name: 'Finish',
        config: {
          outputMappings: [{ name: 'statusCode', expression: '{{steps.Fetch.output.statusCode}}' }],
        },
      },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'api-1' },
      { id: 'e2', source: 'api-1', target: 'end-1' },
    ];

    const result = convertCanvasToSteps(nodes as never[], edges as never[], { full: true });
    expect(result.steps).toHaveLength(1);
    expect(result.nameToIdMap).toEqual({
      Begin: 'start-1',
      Fetch: 'api-1',
      Finish: 'end-1',
    });
    expect(result.outputMappings).toEqual([
      { name: 'statusCode', expression: '{{steps.Fetch.output.statusCode}}' },
    ]);
    expect(result.startInputVariables).toEqual([
      { name: 'orderId', type: 'string', required: true },
      { name: 'amount', type: 'number', required: false },
    ]);
  });

  it('converts end-node outputMapping object form into an OutputMapping[] and skips empty keys', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      { id: 'api-1', nodeType: 'api', name: 'Fetch', config: { url: 'https://x' } },
      {
        id: 'end-1',
        nodeType: 'end',
        name: 'Finish',
        config: {
          outputMapping: {
            statusCode: '{{steps.Fetch.output.statusCode}}',
            body: '{{steps.Fetch.output.body}}',
            '': '{{ignored}}', // empty key → skipped
          },
        },
      },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'api-1' },
      { id: 'e2', source: 'api-1', target: 'end-1' },
    ];

    const result = convertCanvasToSteps(nodes as never[], edges as never[], { full: true });
    expect(result.outputMappings).toEqual([
      { name: 'statusCode', expression: '{{steps.Fetch.output.statusCode}}' },
      { name: 'body', expression: '{{steps.Fetch.output.body}}' },
    ]);
  });

  it('aggregates output mappings from every top-level end node', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      { id: 'api-1', nodeType: 'api', name: 'FetchCustomer', config: { url: 'https://x' } },
      { id: 'api-2', nodeType: 'api', name: 'FetchOrder', config: { url: 'https://y' } },
      {
        id: 'end-1',
        nodeType: 'end',
        name: 'CustomerEnd',
        config: {
          outputMapping: {
            customer: {
              expression: '{{steps.FetchCustomer.output.body.customer}}',
              type: 'json',
            },
          },
        },
      },
      {
        id: 'end-2',
        nodeType: 'end',
        name: 'OrderEnd',
        config: {
          outputMapping: {
            order: {
              expression: '{{steps.FetchOrder.output.body.order}}',
              type: 'json',
            },
          },
        },
      },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'api-1' },
      { id: 'e2', source: 'start-1', target: 'api-2' },
      { id: 'e3', source: 'api-1', target: 'end-1' },
      { id: 'e4', source: 'api-2', target: 'end-2' },
    ];

    const result = convertCanvasToSteps(nodes as never[], edges as never[], { full: true });

    expect(result.outputMappings).toEqual([
      {
        name: 'customer',
        expression: '{{steps.FetchCustomer.output.body.customer}}',
        type: 'json',
      },
      {
        name: 'order',
        expression: '{{steps.FetchOrder.output.body.order}}',
        type: 'json',
      },
    ]);
    expect(result.outputMappingsByEndNodeId).toEqual({
      'end-1': [
        {
          name: 'customer',
          expression: '{{steps.FetchCustomer.output.body.customer}}',
          type: 'json',
        },
      ],
      'end-2': [
        {
          name: 'order',
          expression: '{{steps.FetchOrder.output.body.order}}',
          type: 'json',
        },
      ],
    });
  });

  it('attaches loop body panel output mappings to the loop step config', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      {
        id: 'loop-1',
        nodeType: 'loop',
        name: 'Loop0001',
        config: {
          collection: '{{context.steps.start.output.items}}',
          itemVariable: 'currentItem',
          bodyOutputMapping: {
            processed: {
              expression: '{{context.steps.API0002.output.body.processed}}',
              type: 'boolean',
              description: 'Whether the item was processed',
            },
          },
        },
      },
      { id: 'loop-start-1', nodeType: 'loop_start', name: 'LoopStart', parentId: 'loop-1' },
      {
        id: 'api-1',
        nodeType: 'api',
        name: 'API0002',
        parentId: 'loop-1',
        config: { url: 'https://x' },
      },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'loop-1' },
      { id: 'e2', source: 'loop-1', target: 'end-1' },
      { id: 'e3', source: 'loop-start-1', sourceHandle: 'loop_body', target: 'api-1' },
    ];

    const result = convertCanvasToSteps(nodes as never[], edges as never[], { full: true });
    const loopStep = result.steps.find((step) => step.id === 'loop-1') as
      | { config?: Record<string, unknown> }
      | undefined;

    expect(loopStep?.config?.body).toEqual(['api-1']);
    expect(loopStep?.config?.bodyOutputMappings).toEqual([
      {
        name: 'processed',
        expression: '{{context.steps.API0002.output.body.processed}}',
        type: 'boolean',
        description: 'Whether the item was processed',
      },
    ]);
    expect(loopStep?.config?.bodyEndStep).toBeUndefined();
    expect(result.outputMappings).toEqual([]);
  });

  it('collects all loop-start branches and computes merge in-degree inside loop body', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      {
        id: 'loop-1',
        nodeType: 'loop',
        name: 'Loop0001',
        config: {
          collection: '{{context.steps.start.output.items}}',
          itemVariable: 'currentItem',
        },
      },
      { id: 'loop-start-1', nodeType: 'loop_start', name: 'LoopStart', parentId: 'loop-1' },
      {
        id: 'delay-2',
        nodeType: 'delay',
        name: 'Delay0002',
        parentId: 'loop-1',
        config: { duration: 5, unit: 'seconds' },
      },
      {
        id: 'delay-3',
        nodeType: 'delay',
        name: 'Delay0003',
        parentId: 'loop-1',
        config: { duration: 5, unit: 'seconds' },
      },
      {
        id: 'api-2',
        nodeType: 'api',
        name: 'API0002',
        parentId: 'loop-1',
        config: { url: 'https://x' },
      },
      {
        id: 'loop-end-1',
        nodeType: 'end',
        name: 'LoopEnd',
        parentId: 'loop-1',
        config: {},
      },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'loop-1' },
      { id: 'e2', source: 'loop-1', target: 'end-1' },
      { id: 'e3', source: 'loop-start-1', sourceHandle: 'loop_body', target: 'delay-2' },
      { id: 'e4', source: 'loop-start-1', sourceHandle: 'loop_body', target: 'delay-3' },
      { id: 'e5', source: 'delay-2', target: 'api-2' },
      { id: 'e6', source: 'delay-3', target: 'api-2' },
      { id: 'e7', source: 'api-2', target: 'loop-end-1' },
    ];

    const result = convertCanvasToSteps(nodes as never[], edges as never[], { full: true });
    const loopStep = result.steps.find((step) => step.id === 'loop-1') as
      | { config?: Record<string, unknown> }
      | undefined;

    expect(loopStep?.config?.body).toEqual(['delay-2', 'delay-3', 'api-2']);
    expect(loopStep?.config?.bodyInDegreeMap).toEqual({
      'delay-2': 0,
      'delay-3': 0,
      'api-2': 2,
    });
    expect(result.edgeMap['loop-start-1']).toEqual([
      {
        edgeId: 'e3',
        sourceHandle: 'loop_body',
        target: 'delay-2',
        sourceNodeType: 'loop_start',
        loopId: 'loop-1',
      },
      {
        edgeId: 'e4',
        sourceHandle: 'loop_body',
        target: 'delay-3',
        sourceNodeType: 'loop_start',
        loopId: 'loop-1',
      },
    ]);
  });

  it('returns empty outputMappings and startInputVariables when end/start configs are absent', () => {
    const nodes = [
      { id: 'start-1', nodeType: 'start', name: 'Start', config: {} },
      { id: 'api-1', nodeType: 'api', name: 'Fetch', config: { url: 'https://x' } },
      { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start-1', target: 'api-1' },
      { id: 'e2', source: 'api-1', target: 'end-1' },
    ];

    const result = convertCanvasToSteps(nodes as never[], edges as never[], { full: true });
    expect(result.outputMappings).toEqual([]);
    expect(result.startInputVariables).toEqual([]);
  });
});
