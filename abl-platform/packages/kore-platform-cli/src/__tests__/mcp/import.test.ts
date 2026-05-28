/**
 * Import Module Tests
 *
 * Tests for format detection, import analysis, and entity mapping.
 */

import { describe, test, expect } from 'vitest';
import { detectFormat, analyzeImport } from '../../mcp/import/analyzer.js';
import { toAgentName, toToolName, extractBrief } from '../../mcp/import/mapping.js';

// =============================================================================
// FORMAT DETECTION
// =============================================================================

describe('detectFormat', () => {
  describe('Agent Platform v12 detection', () => {
    test('detects agent-platform with orchestrationPrompt', () => {
      const json = {
        app: { orchestrationPrompt: { custom: 'route to agents' } },
        MCPServers: [],
        agents: [],
      };

      expect(detectFormat(json)).toBe('agent-platform');
    });

    test('detects agent-platform without orchestrationPrompt but with MCPServers', () => {
      const json = {
        app: {},
        MCPServers: [{ name: 'server1', tools: [] }],
        agents: [{ name: 'Agent1' }],
      };

      expect(detectFormat(json)).toBe('agent-platform');
    });

    test('detects agent-platform with full export structure', () => {
      const json = {
        app: {
          orchestrationPrompt: { custom: 'multi-agent routing' },
          memoryStores: [],
        },
        MCPServers: [
          { name: 'ToolServer', tools: [{ name: 'search', description: 'Search tool' }] },
        ],
        agents: [
          { name: 'SalesAgent', subType: 'support' },
          { name: 'TechAgent', subType: 'technical' },
        ],
      };

      expect(detectFormat(json)).toBe('agent-platform');
    });
  });

  describe('XO11 detection', () => {
    test('detects xo11 with dialogFlows', () => {
      const json = {
        dialogFlows: [{ name: 'MainFlow', nodes: [] }],
      };

      expect(detectFormat(json)).toBe('xo11');
    });

    test('detects xo11 with dialogTasks', () => {
      const json = {
        dialogTasks: [{ name: 'Task1', nodes: [] }],
      };

      expect(detectFormat(json)).toBe('xo11');
    });

    test('detects xo11 with full export structure', () => {
      const json = {
        dialogFlows: [
          {
            name: 'BookingFlow',
            intent: 'book_appointment',
            nodes: [
              { name: 'welcome', type: 'message', message: 'Hello!' },
              { name: 'getDate', type: 'entity', prompt: 'When?' },
            ],
          },
        ],
        entityNodes: [{ name: 'date', type: 'date' }],
        webhookNodes: [{ name: 'api_call', url: 'https://api.example.com' }],
      };

      expect(detectFormat(json)).toBe('xo11');
    });
  });

  describe('unknown format detection', () => {
    test('returns unknown for null', () => {
      expect(detectFormat(null)).toBe('unknown');
    });

    test('returns unknown for undefined', () => {
      expect(detectFormat(undefined)).toBe('unknown');
    });

    test('returns unknown for empty object', () => {
      expect(detectFormat({})).toBe('unknown');
    });

    test('returns unknown for non-object', () => {
      expect(detectFormat('string')).toBe('unknown');
      expect(detectFormat(123)).toBe('unknown');
      expect(detectFormat([])).toBe('unknown');
    });

    test('returns unknown for unrecognized structure', () => {
      const json = {
        someOtherFormat: true,
        data: [],
      };

      expect(detectFormat(json)).toBe('unknown');
    });
  });
});

// =============================================================================
// IMPORT ANALYSIS - AGENT PLATFORM
// =============================================================================

describe('analyzeImport - Agent Platform v12', () => {
  test('analyzes basic agent platform export', () => {
    const json = {
      app: {},
      MCPServers: [],
      agents: [{ name: 'TestAgent' }],
    };

    const analysis = analyzeImport(json);

    expect(analysis.format).toBe('agent-platform');
    expect(analysis.summary.agentCount).toBe(1);
    expect(analysis.summary.supervisorDetected).toBe(false);
  });

  test('detects supervisor from orchestrationPrompt', () => {
    const json = {
      app: {
        orchestrationPrompt: { custom: 'route to appropriate agent' },
      },
      MCPServers: [],
      agents: [{ name: 'SalesAgent' }, { name: 'SupportAgent' }],
    };

    const analysis = analyzeImport(json);

    expect(analysis.summary.supervisorDetected).toBe(true);
    expect(analysis.suggestedTopology).toBe('supervisor');
  });

  test('extracts tools from MCPServers', () => {
    const json = {
      app: {},
      MCPServers: [
        {
          name: 'SearchServer',
          tools: [
            { name: 'web_search', description: 'Search the web' },
            { name: 'image_search', description: 'Search images' },
          ],
        },
      ],
      agents: [{ name: 'Agent1' }],
    };

    const analysis = analyzeImport(json);

    expect(analysis.summary.toolCount).toBe(2);
    expect(analysis.rawEntities.tools).toContain('web_search');
    expect(analysis.rawEntities.tools).toContain('image_search');
  });

  test('creates entity mappings', () => {
    const json = {
      app: {},
      MCPServers: [{ name: 'Server1', tools: [{ name: 'my_tool' }] }],
      agents: [{ name: 'MyAgent', subType: 'support' }],
    };

    const analysis = analyzeImport(json);

    // Agent mapping
    const agentMapping = analysis.mappings.find((m) => m.sourceType === 'agent');
    expect(agentMapping).toBeDefined();
    expect(agentMapping!.target).toBe('My_Agent');
    expect(agentMapping!.targetType).toBe('AGENT');

    // Tool mapping
    const toolMapping = analysis.mappings.find((m) => m.sourceType === 'tool');
    expect(toolMapping).toBeDefined();
    expect(toolMapping!.targetType).toBe('TOOL');
  });

  test('maps memory stores', () => {
    const json = {
      app: {
        memoryStores: [{ memoryStoreName: 'user_preferences' }, { name: 'session_data' }],
      },
      MCPServers: [],
      agents: [{ name: 'Agent1' }],
    };

    const analysis = analyzeImport(json);

    const memoryMappings = analysis.mappings.filter((m) => m.targetType === 'MEMORY');
    expect(memoryMappings.length).toBe(2);
  });

  test('includes gap report', () => {
    const json = {
      app: {
        piiConfigs: { enabled: true },
      },
      MCPServers: [],
      agents: [{ name: 'Agent1' }],
    };

    const analysis = analyzeImport(json);

    expect(analysis.gapReport).toBeDefined();
    expect(analysis.gapReport.gaps.length).toBeGreaterThan(0);
  });

  test('suggests single-agent topology for single agent', () => {
    const json = {
      app: {},
      MCPServers: [],
      agents: [{ name: 'OnlyAgent' }],
    };

    const analysis = analyzeImport(json);

    expect(analysis.suggestedTopology).toBe('single-agent');
  });

  test('suggests adaptive-network for multiple agents without supervisor', () => {
    const json = {
      app: {},
      MCPServers: [],
      agents: [{ name: 'Agent1' }, { name: 'Agent2' }],
    };

    const analysis = analyzeImport(json);

    expect(analysis.suggestedTopology).toBe('adaptive-network');
  });
});

// =============================================================================
// IMPORT ANALYSIS - XO11
// =============================================================================

describe('analyzeImport - XO11', () => {
  test('analyzes basic XO11 export', () => {
    const json = {
      dialogFlows: [{ name: 'MainFlow', nodes: [] }],
    };

    const analysis = analyzeImport(json);

    expect(analysis.format).toBe('xo11');
    expect(analysis.summary.agentCount).toBe(1);
  });

  test('maps dialog flows to agents', () => {
    const json = {
      dialogFlows: [
        { name: 'BookingFlow', intent: 'book_appointment', nodes: [] },
        { name: 'SupportFlow', intent: 'get_help', nodes: [] },
      ],
    };

    const analysis = analyzeImport(json);

    expect(analysis.rawEntities.agents).toContain('BookingFlow');
    expect(analysis.rawEntities.agents).toContain('SupportFlow');
    expect(analysis.rawEntities.intents).toContain('book_appointment');
  });

  test('maps webhook nodes to tools', () => {
    const json = {
      dialogFlows: [
        {
          name: 'Flow1',
          nodes: [{ name: 'api_call', url: 'https://api.example.com/data' }],
        },
      ],
    };

    const analysis = analyzeImport(json);

    const toolMappings = analysis.mappings.filter((m) => m.targetType === 'TOOL');
    expect(toolMappings.length).toBeGreaterThan(0);
  });

  test('maps script nodes as tools with GAP note', () => {
    const json = {
      dialogFlows: [
        {
          name: 'Flow1',
          nodes: [{ name: 'custom_logic', script: 'return x + 1' }],
        },
      ],
    };

    const analysis = analyzeImport(json);

    const scriptMapping = analysis.mappings.find((m) => m.sourceType === 'scriptNode');
    expect(scriptMapping).toBeDefined();
    expect(scriptMapping!.notes).toContain('GAP');
  });

  test('maps message nodes to flow steps', () => {
    const json = {
      dialogFlows: [
        {
          name: 'Flow1',
          nodes: [{ name: 'welcome_msg', message: 'Hello!' }],
        },
      ],
    };

    const analysis = analyzeImport(json);

    const stepMapping = analysis.mappings.find((m) => m.targetType === 'FLOW_STEP');
    expect(stepMapping).toBeDefined();
  });

  test('maps entity nodes to gather fields', () => {
    const json = {
      dialogFlows: [
        {
          name: 'Flow1',
          nodes: [{ name: 'get_date', prompt: 'When would you like to book?' }],
        },
      ],
    };

    const analysis = analyzeImport(json);

    const gatherMapping = analysis.mappings.find((m) => m.targetType === 'GATHER_FIELD');
    expect(gatherMapping).toBeDefined();
  });

  test('extracts standalone nodes', () => {
    const json = {
      dialogFlows: [],
      entityNodes: [{ name: 'email_entity' }],
      webhookNodes: [{ name: 'send_email' }],
      scriptNodes: [{ name: 'format_data' }],
    };

    const analysis = analyzeImport(json);

    expect(analysis.mappings.some((m) => m.source === 'email_entity')).toBe(true);
    expect(analysis.mappings.some((m) => m.source === 'send_email')).toBe(true);
    expect(analysis.mappings.some((m) => m.source === 'format_data')).toBe(true);
  });

  test('suggests supervisor for multiple flows', () => {
    const json = {
      dialogFlows: [
        { name: 'Flow1', nodes: [] },
        { name: 'Flow2', nodes: [] },
      ],
    };

    const analysis = analyzeImport(json);

    expect(analysis.summary.supervisorDetected).toBe(true);
    expect(analysis.suggestedTopology).toBe('supervisor');
  });

  test('includes gap report', () => {
    const json = {
      dialogFlows: [
        {
          name: 'Flow1',
          nodes: [{ type: 'carousel', items: [] }],
        },
      ],
    };

    const analysis = analyzeImport(json);

    expect(analysis.gapReport).toBeDefined();
    expect(analysis.gapReport.gaps.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// IMPORT ANALYSIS - UNKNOWN FORMAT
// =============================================================================

describe('analyzeImport - unknown format', () => {
  test('throws error for unknown format', () => {
    const json = { unknownField: true };

    expect(() => analyzeImport(json)).toThrow('Unknown import format');
  });

  test('error message lists expected formats', () => {
    const json = { unknownField: true };

    expect(() => analyzeImport(json)).toThrow('Agent Platform v12');
    expect(() => analyzeImport(json)).toThrow('XO11');
  });
});

// =============================================================================
// ENTITY MAPPING UTILITIES
// =============================================================================

describe('toAgentName', () => {
  test('converts camelCase to PascalCase with underscores', () => {
    expect(toAgentName('myAgent')).toBe('My_Agent');
  });

  test('handles existing underscores', () => {
    expect(toAgentName('my_agent')).toBe('My_Agent');
  });

  test('handles PascalCase', () => {
    expect(toAgentName('MyAgent')).toBe('My_Agent');
  });

  test('handles single word', () => {
    expect(toAgentName('agent')).toBe('Agent');
  });

  test('handles spaces', () => {
    expect(toAgentName('sales agent')).toBe('Sales_Agent');
  });

  test('handles special characters', () => {
    expect(toAgentName('my-agent-1')).toMatch(/^[A-Z][a-zA-Z0-9_]*$/);
  });
});

describe('toToolName', () => {
  test('converts to snake_case', () => {
    expect(toToolName('myTool')).toBe('my_tool');
  });

  test('handles PascalCase', () => {
    expect(toToolName('MyToolName')).toBe('my_tool_name');
  });

  test('preserves existing snake_case', () => {
    expect(toToolName('my_tool')).toBe('my_tool');
  });

  test('handles spaces', () => {
    expect(toToolName('my tool')).toBe('my_tool');
  });

  test('handles hyphens', () => {
    expect(toToolName('my-tool')).toBe('my_tool');
  });
});

describe('extractBrief', () => {
  test('extracts first sentence', () => {
    const description = 'This is a tool. It does many things.';
    expect(extractBrief(description)).toBe('This is a tool.');
  });

  test('truncates long descriptions', () => {
    const longDesc = 'A'.repeat(200);
    const brief = extractBrief(longDesc);
    expect(brief.length).toBeLessThanOrEqual(120); // default maxLength is 120
  });

  test('handles single sentence', () => {
    expect(extractBrief('Just one sentence')).toBe('Just one sentence');
  });

  test('handles empty string', () => {
    expect(extractBrief('')).toBe('');
  });
});
