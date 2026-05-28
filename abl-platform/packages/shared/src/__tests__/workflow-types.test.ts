import { describe, it, expect } from 'vitest';
import {
  resolveExpression,
  generateNodeName,
  getOutputHandles,
  NODE_CATEGORY_MAP,
  NODE_COLOR_MAP,
  NODE_DISPLAY_NAMES,
  STUB_NODE_TYPES,
  NODE_NAME_PATTERN,
  type WorkflowContext,
  type WorkflowNode,
  type NodeType,
} from '../types/workflow-types.js';
import {
  NodeTypeSchema,
  WorkflowNodeSchema,
  WorkflowEdgeSchema,
  WorkflowDefinitionSchema,
  WorkflowExecutionInputSchema,
  StartNodeConfigSchema,
  TextToTextNodeConfigSchema,
  ApiNodeConfigSchema,
  FunctionNodeConfigSchema,
  ConditionNodeConfigSchema,
  LoopNodeConfigSchema,
  HumanNodeConfigSchema,
  DelayNodeConfigSchema,
  AgenticAppNodeConfigSchema,
  ToolNodeConfigSchema,
  NodeExecutionSchema,
  NODE_CONFIG_SCHEMAS,
} from '../types/workflow-schemas.js';

// ─── resolveExpression ─────────────────────────────────────────────────

describe('resolveExpression', () => {
  const ctx: WorkflowContext = {
    input: { orderId: 'ORD-123', amount: 99.5 },
    steps: {
      'fetch-order': {
        output: { total: 250, currency: 'USD' },
      },
    },
    env: { apiKey: 'sk-test' },
  };

  it('resolves input path', () => {
    expect(resolveExpression('{{input.orderId}}', ctx)).toBe('ORD-123');
  });

  it('resolves nested step output path', () => {
    expect(resolveExpression('{{steps.fetch-order.output.total}}', ctx)).toBe(250);
  });

  it('resolves env path', () => {
    expect(resolveExpression('{{env.apiKey}}', ctx)).toBe('sk-test');
  });

  it('resolves with context. prefix', () => {
    expect(resolveExpression('{{context.input.orderId}}', ctx)).toBe('ORD-123');
  });

  it('returns plain string if no template markers', () => {
    expect(resolveExpression('hello world', ctx)).toBe('hello world');
  });

  it('returns undefined for missing path', () => {
    expect(resolveExpression('{{input.nonexistent}}', ctx)).toBeUndefined();
  });

  it('returns undefined for deep missing path', () => {
    expect(resolveExpression('{{steps.missing-step.output.value}}', ctx)).toBeUndefined();
  });

  it('handles numeric values', () => {
    expect(resolveExpression('{{input.amount}}', ctx)).toBe(99.5);
  });

  it('interpolates multiple expressions in a string', () => {
    expect(resolveExpression('Order {{input.orderId}} is {{input.amount}}', ctx)).toBe(
      'Order ORD-123 is 99.5',
    );
  });
});

// ─── WorkflowNode type ─────────────────────────────────────────────────

describe('WorkflowNode type', () => {
  it('accepts valid node shape', () => {
    const node: WorkflowNode = {
      id: 'n1',
      nodeType: 'api',
      name: 'FetchOrder',
      position: { x: 100, y: 200 },
      config: { method: 'GET', url: 'https://example.com' },
    };
    expect(node.nodeType).toBe('api');
  });
});

// ─── Node constants ─────────────────────────────────────────────────────

describe('Node constants', () => {
  it('STUB_NODE_TYPES contains expected stubs', () => {
    expect(STUB_NODE_TYPES).toEqual([
      'browser',
      'doc_search',
      'doc_intelligence',
      'text_to_image',
      'audio_to_text',
      'image_to_text',
      'agentic_app',
    ]);
  });

  it('NODE_CATEGORY_MAP covers all 22 node types', () => {
    expect(Object.keys(NODE_CATEGORY_MAP)).toHaveLength(22);
  });

  it('NODE_COLOR_MAP covers all 22 node types', () => {
    expect(Object.keys(NODE_COLOR_MAP)).toHaveLength(22);
  });

  it('NODE_DISPLAY_NAMES covers all 22 node types', () => {
    expect(Object.keys(NODE_DISPLAY_NAMES)).toHaveLength(22);
  });

  it('NODE_NAME_PATTERN matches valid names', () => {
    expect(NODE_NAME_PATTERN.test('FetchOrder0001')).toBe(true);
    expect(NODE_NAME_PATTERN.test('with space')).toBe(false);
  });
});

// ─── getOutputHandles ───────────────────────────────────────────────────

describe('getOutputHandles', () => {
  it('start returns on_success', () => {
    expect(getOutputHandles('start')).toEqual(['on_success']);
  });

  it('end returns empty', () => {
    expect(getOutputHandles('end')).toEqual([]);
  });

  it('human returns approval handles without on_failure by default', () => {
    expect(getOutputHandles('human')).toEqual(['on_approve', 'on_reject']);
  });

  it('human returns on_failure when onFailureEnabled', () => {
    expect(getOutputHandles('human', { onFailureEnabled: true })).toEqual([
      'on_approve',
      'on_reject',
      'on_failure',
    ]);
  });

  it('condition returns dynamic handles plus else', () => {
    const config = { conditions: [{ id: 'if_0', label: 'If' }] };
    expect(getOutputHandles('condition', config)).toEqual(['if_0', 'else']);
  });

  it('loop returns on_complete, on_failure', () => {
    expect(getOutputHandles('loop')).toEqual(['on_complete', 'on_failure']);
  });

  it('loop_start returns loop_body', () => {
    expect(getOutputHandles('loop_start')).toEqual(['loop_body']);
  });

  it('default node returns on_success only', () => {
    expect(getOutputHandles('api')).toEqual(['on_success']);
  });

  it('default node returns on_success and on_failure when onFailureEnabled', () => {
    expect(getOutputHandles('api', { onFailureEnabled: true })).toEqual([
      'on_success',
      'on_failure',
    ]);
  });
});

// ─── generateNodeName ───────────────────────────────────────────────────

describe('generateNodeName', () => {
  it('start always returns Start', () => {
    expect(generateNodeName('start', [])).toBe('Start');
  });

  it('generates sequential names', () => {
    expect(generateNodeName('api', [])).toBe('API0001');
    expect(generateNodeName('api', ['API0001'])).toBe('API0002');
  });

  it('strips non-alphanumeric from display name', () => {
    expect(generateNodeName('text_to_text', [])).toBe('TexttoText0001');
  });
});

// ─── Zod Schemas ───────────────────────────────────────────────────────

describe('NodeTypeSchema', () => {
  it('accepts valid node types', () => {
    expect(NodeTypeSchema.parse('start')).toBe('start');
    expect(NodeTypeSchema.parse('text_to_text')).toBe('text_to_text');
    expect(NodeTypeSchema.parse('agentic_app')).toBe('agentic_app');
  });

  it('rejects invalid node type', () => {
    expect(() => NodeTypeSchema.parse('invalid')).toThrow();
  });
});

describe('WorkflowNodeSchema', () => {
  it('validates a node', () => {
    const result = WorkflowNodeSchema.parse({
      id: 'n1',
      nodeType: 'api',
      name: 'FetchOrder',
      position: { x: 100, y: 200 },
    });
    expect(result.nodeType).toBe('api');
    expect(result.config).toEqual({});
  });

  it('rejects missing id', () => {
    expect(() =>
      WorkflowNodeSchema.parse({
        nodeType: 'api',
        name: 'Test',
        position: { x: 0, y: 0 },
      }),
    ).toThrow();
  });
});

describe('WorkflowEdgeSchema', () => {
  it('validates an edge', () => {
    const result = WorkflowEdgeSchema.parse({
      id: 'e1',
      source: 'n1',
      sourceHandle: 'on_success',
      target: 'n2',
    });
    expect(result.source).toBe('n1');
  });
});

describe('Node config schemas', () => {
  it('StartNodeConfigSchema applies defaults', () => {
    const result = StartNodeConfigSchema.parse({});
    expect(result.inputVariables).toEqual([]);
  });

  it('TextToTextNodeConfigSchema applies defaults', () => {
    const result = TextToTextNodeConfigSchema.parse({});
    expect(result.temperature).toBe(0.7);
    expect(result.timeout).toBe(60);
  });

  it('ApiNodeConfigSchema applies defaults', () => {
    const result = ApiNodeConfigSchema.parse({});
    expect(result.method).toBe('GET');
    expect(result.body).toEqual({ type: 'none' });
    expect(result.auth).toEqual({ type: 'none' });
  });

  it('FunctionNodeConfigSchema applies defaults', () => {
    const result = FunctionNodeConfigSchema.parse({});
    expect(result.language).toBe('javascript');
    expect(result.mode).toBe('inline');
    expect(result.timeout).toBe(10);
  });

  it('ConditionNodeConfigSchema applies defaults', () => {
    const result = ConditionNodeConfigSchema.parse({});
    expect(result.conditions).toHaveLength(1);
    expect(result.logic).toBe('and');
  });

  it('LoopNodeConfigSchema applies defaults', () => {
    const result = LoopNodeConfigSchema.parse({});
    expect(result.itemAlias).toBe('currentItem');
    expect(result.maxIterations).toBe(1000);
  });

  it('HumanNodeConfigSchema applies defaults', () => {
    const result = HumanNodeConfigSchema.parse({});
    expect(result.assignTo).toBe('everyone');
    expect(result.onTimeout).toBe('terminate');
  });

  it('DelayNodeConfigSchema applies defaults', () => {
    const result = DelayNodeConfigSchema.parse({});
    expect(result.duration).toBe(5);
    expect(result.unit).toBe('seconds');
  });

  it('AgenticAppNodeConfigSchema applies defaults', () => {
    const result = AgenticAppNodeConfigSchema.parse({});
    expect(result.timeout).toBe(120);
  });

  it('ToolNodeConfigSchema accepts typed param values', () => {
    const result = ToolNodeConfigSchema.parse({
      toolName: 'create_order',
      params: {
        orderId: '{{trigger.payload.orderId}}',
        amount: 99.5,
        expedited: true,
        metadata: { source: 'migration' },
      },
    });
    expect(result.params).toEqual({
      orderId: '{{trigger.payload.orderId}}',
      amount: 99.5,
      expedited: true,
      metadata: { source: 'migration' },
    });
  });

  it('NODE_CONFIG_SCHEMAS has all 20 node types', () => {
    expect(Object.keys(NODE_CONFIG_SCHEMAS)).toHaveLength(20);
  });
});

describe('WorkflowDefinitionSchema', () => {
  it('validates complete workflow definition', () => {
    const result = WorkflowDefinitionSchema.parse({
      name: 'Order Processing',
      nodes: [
        {
          id: 'n1',
          nodeType: 'start',
          name: 'Start',
          position: { x: 0, y: 0 },
        },
        {
          id: 'n2',
          nodeType: 'api',
          name: 'FetchOrder',
          position: { x: 200, y: 0 },
          config: { method: 'GET', url: 'https://api.example.com/orders' },
        },
      ],
      edges: [{ id: 'e1', source: 'n1', sourceHandle: 'on_success', target: 'n2' }],
    });
    expect(result.name).toBe('Order Processing');
    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
    expect(result.status).toBe('draft');
    expect(result.envVars).toEqual({});
  });

  it('rejects empty name', () => {
    expect(() => WorkflowDefinitionSchema.parse({ name: '' })).toThrow();
  });
});

describe('NodeExecutionSchema', () => {
  it('validates node execution', () => {
    const result = NodeExecutionSchema.parse({
      nodeId: 'n1',
      nodeName: 'FetchOrder',
      nodeType: 'api',
      status: 'completed',
      output: { data: 'test' },
      durationMs: 150,
    });
    expect(result.status).toBe('completed');
  });
});

describe('WorkflowExecutionInputSchema', () => {
  it('validates execution input', () => {
    const result = WorkflowExecutionInputSchema.parse({
      workflowId: 'wf-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      input: { orderId: 'ORD-123' },
    });
    expect(result.workflowId).toBe('wf-1');
    expect(result.tenantId).toBe('tenant-1');
    expect(result.projectId).toBe('proj-1');
    expect(result.triggerType).toBe('studio');
  });

  it('accepts all trigger types', () => {
    for (const triggerType of ['webhook', 'cron', 'event', 'studio', 'agent']) {
      const extra = triggerType === 'webhook' ? { webhookMode: 'sync' as const } : {};
      const result = WorkflowExecutionInputSchema.parse({
        workflowId: 'wf-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        triggerType,
        ...extra,
      });
      expect(result.triggerType).toBe(triggerType);
    }
  });
});
