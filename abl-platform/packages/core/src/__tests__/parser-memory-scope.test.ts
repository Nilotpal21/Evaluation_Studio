/**
 * Parser Tests: Memory SCOPE and Tool CONTEXT_ACCESS
 *
 * Tests that the parser correctly handles:
 * - SCOPE: user | project on persistent memory paths
 * - ACCESS: read | write | readwrite on persistent memory paths
 * - DESCRIPTION: on persistent memory paths
 * - CONTEXT_ACCESS: READ/WRITE on tool definitions
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '../parser/agent-based-parser.js';

describe('Parser: Persistent Memory SCOPE', () => {
  test('parses SCOPE: user on persistent memory', () => {
    const dsl = `
AGENT: ScopedAgent
GOAL: "Test scope parsing"

MEMORY:
  PERSISTENT:
    - PATH: user.preferences
      SCOPE: user
      TYPE: object
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const doc = result.document!;
    expect(doc.memory.persistent).toHaveLength(1);
    expect(doc.memory.persistent[0].path).toBe('user.preferences');
    expect(doc.memory.persistent[0].scope).toBe('user');
    expect(doc.memory.persistent[0].type).toBe('object');
  });

  test('parses SCOPE: project on persistent memory', () => {
    const dsl = `
AGENT: SharedAgent
GOAL: "Test project scope"

MEMORY:
  PERSISTENT:
    - PATH: global_promotions
      SCOPE: project
      ACCESS: read
      TYPE: array
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const doc = result.document!;
    expect(doc.memory.persistent).toHaveLength(1);
    expect(doc.memory.persistent[0].path).toBe('global_promotions');
    expect(doc.memory.persistent[0].scope).toBe('project');
    expect(doc.memory.persistent[0].access).toBe('read');
    expect(doc.memory.persistent[0].type).toBe('array');
  });

  test('parses SCOPE: execution_tree on persistent memory', () => {
    const dsl = `
AGENT: WorkflowAgent
GOAL: "Test execution tree scope"

MEMORY:
  PERSISTENT:
    - PATH: workflow.auth_token
      SCOPE: execution_tree
      ACCESS: readwrite
      TYPE: string
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const doc = result.document!;
    expect(doc.memory.persistent).toHaveLength(1);
    expect(doc.memory.persistent[0].path).toBe('workflow.auth_token');
    expect(doc.memory.persistent[0].scope).toBe('execution_tree');
    expect(doc.memory.persistent[0].access).toBe('readwrite');
    expect(doc.memory.persistent[0].type).toBe('string');
  });

  test('parses multiple persistent paths with mixed scopes', () => {
    const dsl = `
AGENT: MixedScopeAgent
GOAL: "Test mixed scopes"

MEMORY:
  PERSISTENT:
    - PATH: user.preferences
      SCOPE: user
      ACCESS: readwrite
      TYPE: object
    - PATH: global_promotions
      SCOPE: project
      ACCESS: read
      TYPE: array
    - PATH: business_hours
      SCOPE: project
      ACCESS: readwrite
      TYPE: object
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const doc = result.document!;
    expect(doc.memory.persistent).toHaveLength(3);

    expect(doc.memory.persistent[0].scope).toBe('user');
    expect(doc.memory.persistent[0].access).toBe('readwrite');

    expect(doc.memory.persistent[1].scope).toBe('project');
    expect(doc.memory.persistent[1].access).toBe('read');

    expect(doc.memory.persistent[2].scope).toBe('project');
    expect(doc.memory.persistent[2].access).toBe('readwrite');
  });

  test('scope defaults to undefined when not specified (backward compat)', () => {
    const dsl = `
AGENT: LegacyAgent
GOAL: "Test default scope"

MEMORY:
  PERSISTENT:
    - PATH: user.preferred_chains
      TYPE: string
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const doc = result.document!;
    expect(doc.memory.persistent[0].scope).toBeUndefined();
    expect(doc.memory.persistent[0].path).toBe('user.preferred_chains');
  });

  test('parses SCOPE case-insensitively', () => {
    const dsl = `
AGENT: CaseAgent
GOAL: "Test case insensitivity"

MEMORY:
  PERSISTENT:
    - PATH: config
      scope: PROJECT
      TYPE: object
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const doc = result.document!;
    expect(doc.memory.persistent[0].scope).toBe('project');
  });

  test('parses DESCRIPTION on persistent memory', () => {
    const dsl = `
AGENT: DescAgent
GOAL: "Test description"

MEMORY:
  PERSISTENT:
    - PATH: user.loyalty_tier
      TYPE: string
      DESCRIPTION: "User loyalty program tier"
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const doc = result.document!;
    expect(doc.memory.persistent[0].description).toBe('User loyalty program tier');
  });

  test('ignores invalid scope values', () => {
    const dsl = `
AGENT: InvalidAgent
GOAL: "Test invalid scope"

MEMORY:
  PERSISTENT:
    - PATH: test_path
      SCOPE: invalid_scope
      TYPE: string
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const doc = result.document!;
    // Invalid scope is silently ignored — scope stays undefined
    expect(doc.memory.persistent[0].scope).toBeUndefined();
  });
});

describe('Parser: Tool CONTEXT_ACCESS', () => {
  test('parses CONTEXT_ACCESS with READ and WRITE', () => {
    const dsl = `
AGENT: ContextAgent
GOAL: "Test context access"

TOOLS:
  check_inventory(item_id: string) -> object
    CONTEXT_ACCESS:
      READ: [user_location, preferred_currency, loyalty_tier]
      WRITE: [last_inventory_check]
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const doc = result.document!;
    expect(doc.tools).toHaveLength(1);

    const tool = doc.tools[0];
    expect(tool.name).toBe('check_inventory');
    expect(tool.contextAccess).toBeDefined();
    expect(tool.contextAccess!.read).toEqual([
      'user_location',
      'preferred_currency',
      'loyalty_tier',
    ]);
    expect(tool.contextAccess!.write).toEqual(['last_inventory_check']);
  });

  test('parses CONTEXT_ACCESS with READ only', () => {
    const dsl = `
AGENT: ReadOnlyCtx
GOAL: "Test read only context"

TOOLS:
  get_weather(city: string) -> object
    CONTEXT_ACCESS:
      READ: [user_location]
      WRITE: []
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const doc = result.document!;
    const tool = doc.tools[0];
    expect(tool.contextAccess!.read).toEqual(['user_location']);
    expect(tool.contextAccess!.write).toEqual([]);
  });

  test('parses CONTEXT_ACCESS with WRITE only', () => {
    const dsl = `
AGENT: WriteOnlyCtx
GOAL: "Test write only context"

TOOLS:
  update_status(status: string) -> object
    CONTEXT_ACCESS:
      READ: []
      WRITE: [booking_status, last_updated]
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const doc = result.document!;
    const tool = doc.tools[0];
    expect(tool.contextAccess!.read).toEqual([]);
    expect(tool.contextAccess!.write).toEqual(['booking_status', 'last_updated']);
  });

  test('tools without CONTEXT_ACCESS have undefined contextAccess', () => {
    const dsl = `
AGENT: NoCtxAgent
GOAL: "Test no context"

TOOLS:
  simple_tool(input: string) -> string
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const doc = result.document!;
    expect(doc.tools[0].contextAccess).toBeUndefined();
  });

  test('parses CONTEXT_ACCESS alongside other tool properties', () => {
    const dsl = `
AGENT: MultiPropAgent
GOAL: "Test multiple properties"

TOOLS:
  api_call(query: string) -> object
    DESCRIPTION: "Call an external API"
    STORE_RESULT: true
    CONTEXT_ACCESS:
      READ: [api_token, user_id]
      WRITE: [last_api_call]
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const doc = result.document!;
    const tool = doc.tools[0];
    expect(tool.description).toBe('Call an external API');
    expect(tool.storeResult).toBe(true);
    expect(tool.contextAccess!.read).toEqual(['api_token', 'user_id']);
    expect(tool.contextAccess!.write).toEqual(['last_api_call']);
  });
});
