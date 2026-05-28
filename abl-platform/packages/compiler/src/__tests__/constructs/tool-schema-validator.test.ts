/**
 * Tests for Tool Schema Validator
 *
 * Validates tool definitions at compile time for completeness and correctness.
 */

import { describe, it, expect } from 'vitest';
import { validateToolDefinitions } from '../../platform/ir/tool-schema-validator.js';
import type { ToolDefinition } from '../../platform/ir/schema.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeHttpTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'test-http-tool',
    description: 'A test HTTP tool',
    parameters: [],
    returns: { type: 'object' },
    hints: {
      cacheable: false,
      latency: 'medium',
      parallelizable: true,
      side_effects: false,
      requires_auth: false,
    },
    tool_type: 'http',
    http_binding: {
      endpoint: 'https://api.example.com/data',
      method: 'GET',
      auth: { type: 'none' },
    },
    ...overrides,
  } as ToolDefinition;
}

function makeMcpTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'test-mcp-tool',
    description: 'A test MCP tool',
    parameters: [],
    returns: { type: 'object' },
    hints: {
      cacheable: false,
      latency: 'medium',
      parallelizable: true,
      side_effects: false,
      requires_auth: false,
    },
    tool_type: 'mcp',
    mcp_binding: {
      server: 'my-server',
      tool: 'my-tool',
    },
    ...overrides,
  } as ToolDefinition;
}

function makeSandboxTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'test-sandbox-tool',
    description: 'A test sandbox tool',
    parameters: [],
    returns: { type: 'object' },
    hints: {
      cacheable: false,
      latency: 'medium',
      parallelizable: true,
      side_effects: false,
      requires_auth: false,
    },
    tool_type: 'sandbox',
    sandbox_binding: {
      runtime: 'javascript',
      code_content: 'function main() {}',
    },
    ...overrides,
  } as ToolDefinition;
}

function makeWorkflowTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'test-workflow-tool',
    description: 'A test workflow tool',
    parameters: [],
    returns: { type: 'object' },
    hints: {
      cacheable: false,
      latency: 'slow',
      parallelizable: false,
      side_effects: true,
      requires_auth: false,
    },
    tool_type: 'workflow',
    workflow_binding: {
      workflowId: 'wf-test-123',
      triggerId: 'trigger-456',
      mode: 'sync',
      paramMapping: {},
    },
    ...overrides,
  } as ToolDefinition;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('validateToolDefinitions', () => {
  describe('valid tools', () => {
    it('passes for well-formed HTTP tool', () => {
      const result = validateToolDefinitions([makeHttpTool()]);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('passes for well-formed MCP tool', () => {
      const result = validateToolDefinitions([makeMcpTool()]);
      expect(result.valid).toBe(true);
    });

    it('passes for well-formed sandbox tool', () => {
      const result = validateToolDefinitions([makeSandboxTool()]);
      expect(result.valid).toBe(true);
    });

    it('passes for empty array', () => {
      const result = validateToolDefinitions([]);
      expect(result.valid).toBe(true);
    });
  });

  describe('required fields', () => {
    it('errors on missing tool name', () => {
      const result = validateToolDefinitions([makeHttpTool({ name: '' })]);
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('name');
    });

    it('warns on missing description', () => {
      const result = validateToolDefinitions([makeHttpTool({ description: '' })]);
      expect(result.valid).toBe(true); // warnings don't fail
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].field).toBe('description');
    });
  });

  describe('duplicate names', () => {
    it('errors on duplicate tool names', () => {
      const result = validateToolDefinitions([
        makeHttpTool({ name: 'same-name' }),
        makeMcpTool({ name: 'same-name' }),
      ]);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes('Duplicate'))).toBe(true);
    });
  });

  describe('HTTP tool validation', () => {
    it('errors on missing endpoint', () => {
      const tool = makeHttpTool();
      tool.http_binding!.endpoint = '';
      const result = validateToolDefinitions([tool]);
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('http_binding.endpoint');
    });

    it('errors on invalid endpoint URL', () => {
      const tool = makeHttpTool();
      tool.http_binding!.endpoint = 'not-a-url';
      const result = validateToolDefinitions([tool]);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('Invalid endpoint URL');
    });

    it('allows template URLs with placeholders', () => {
      const tool = makeHttpTool();
      tool.http_binding!.endpoint = 'https://api.example.com/users/{{userId}}';
      const result = validateToolDefinitions([tool]);
      expect(result.valid).toBe(true);
    });

    it('errors on invalid HTTP method', () => {
      const tool = makeHttpTool();
      (tool.http_binding as any).method = 'FETCH';
      const result = validateToolDefinitions([tool]);
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('http_binding.method');
    });

    it('errors on missing http_binding for http type', () => {
      const tool = makeHttpTool({ http_binding: undefined });
      const result = validateToolDefinitions([tool]);
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('http_binding');
    });

    it('warns on missing auth config', () => {
      const tool = makeHttpTool();
      (tool.http_binding as any).auth = undefined;
      const result = validateToolDefinitions([tool]);
      expect(result.warnings.some((w) => w.field === 'http_binding.auth')).toBe(true);
    });

    it('errors when SOAP protocol is paired with non-POST method', () => {
      const tool = makeHttpTool();
      tool.http_binding!.method = 'GET';
      tool.http_binding!.protocol = 'soap';
      tool.http_binding!.soap_version = '1.1';
      const result = validateToolDefinitions([tool]);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'http_binding.method')).toBe(true);
    });

    it('accepts SOAP protocol with POST method', () => {
      const tool = makeHttpTool();
      tool.http_binding!.method = 'POST';
      tool.http_binding!.protocol = 'soap';
      tool.http_binding!.soap_version = '1.1';
      const result = validateToolDefinitions([tool]);
      expect(result.errors.filter((e) => e.field === 'http_binding.method')).toHaveLength(0);
    });
  });

  describe('MCP tool validation', () => {
    it('errors on missing mcp_binding', () => {
      const tool = makeMcpTool({ mcp_binding: undefined });
      const result = validateToolDefinitions([tool]);
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('mcp_binding');
    });

    it('errors on missing server reference', () => {
      const tool = makeMcpTool();
      tool.mcp_binding!.server = '';
      const result = validateToolDefinitions([tool]);
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('mcp_binding.server');
    });

    it('errors on missing tool name on server', () => {
      const tool = makeMcpTool();
      tool.mcp_binding!.tool = '';
      const result = validateToolDefinitions([tool]);
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('mcp_binding.tool');
    });

    it('errors on SSE transport without URL', () => {
      const tool = makeMcpTool();
      tool.mcp_binding!.server_config = {
        name: 'my-server',
        transport: 'sse',
        // url missing
      } as any;
      const result = validateToolDefinitions([tool]);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('requires a url');
    });

    it('errors on stdio transport without command', () => {
      const tool = makeMcpTool();
      tool.mcp_binding!.server_config = {
        name: 'my-server',
        transport: 'stdio',
        // command missing
      } as any;
      const result = validateToolDefinitions([tool]);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('requires a command');
    });
  });

  describe('sandbox tool validation', () => {
    it('errors on missing sandbox_binding', () => {
      const tool = makeSandboxTool({ sandbox_binding: undefined });
      const result = validateToolDefinitions([tool]);
      expect(result.valid).toBe(false);
    });

    it('errors on invalid runtime', () => {
      const tool = makeSandboxTool();
      (tool.sandbox_binding as any).runtime = 'ruby';
      const result = validateToolDefinitions([tool]);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('ruby');
    });
  });

  describe('parameter validation', () => {
    it('errors on parameter without name', () => {
      const tool = makeHttpTool({
        parameters: [{ name: '', type: 'string', required: true }],
      });
      const result = validateToolDefinitions([tool]);
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('parameters');
    });
  });

  describe('tool type validation', () => {
    it('errors on invalid tool type', () => {
      const tool = makeHttpTool({ tool_type: 'lambda' as any });
      const result = validateToolDefinitions([tool]);
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('tool_type');
    });

    it('lists valid types dynamically in error message', () => {
      const tool = makeHttpTool({ tool_type: 'bogus' as any });
      const result = validateToolDefinitions([tool]);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('workflow');
      expect(result.errors[0].message).toContain('Must be one of:');
    });

    it('accepts connector and searchai tool types', () => {
      // Verify that connector and searchai don't trigger tool_type validation errors
      const types = ['connector', 'searchai'];
      for (const type of types) {
        const tool = makeHttpTool({ tool_type: type as any });
        const result = validateToolDefinitions([tool]);
        const toolTypeError = result.errors.find((e) => e.field === 'tool_type');
        expect(toolTypeError).toBeUndefined();
      }
    });
  });

  describe('workflow tool validation', () => {
    it('passes for well-formed workflow tool', () => {
      const tool = makeWorkflowTool();
      const result = validateToolDefinitions([tool]);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('errors on missing workflow_binding', () => {
      const tool = makeWorkflowTool({ workflow_binding: undefined });
      const result = validateToolDefinitions([tool]);
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('workflow_binding');
      expect(result.errors[0].message).toContain('must have workflow_binding');
    });

    it('errors on missing workflowId', () => {
      const tool = makeWorkflowTool();
      tool.workflow_binding!.workflowId = '';
      const result = validateToolDefinitions([tool]);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'workflow_binding.workflowId')).toBe(true);
    });

    it('errors on missing triggerId', () => {
      const tool = makeWorkflowTool();
      tool.workflow_binding!.triggerId = '';
      const result = validateToolDefinitions([tool]);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'workflow_binding.triggerId')).toBe(true);
    });

    it('errors on both missing workflowId and triggerId', () => {
      const tool = makeWorkflowTool();
      tool.workflow_binding!.workflowId = '';
      tool.workflow_binding!.triggerId = '';
      const result = validateToolDefinitions([tool]);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(2);
    });
  });
});
