/**
 * Compiler Tests: Memory Scope + Tool Context Access
 *
 * Tests that:
 * - PersistentMemory IR includes scope field
 * - ToolContextAccess compiles from AST to IR
 * - validateContextAccessDeclarations warns on undeclared vars
 * - Full DSL → IR compilation preserves scope and context_access
 */

import { describe, test, expect } from 'vitest';
import type {
  PersistentMemory,
  ToolContextAccess,
  AgentIR,
  CompilationOutput,
} from '../platform/ir/schema.js';
import { validateContextAccessDeclarations, compileABLtoIR } from '../platform/ir/compiler.js';
import { parseAgentBasedABL } from '@abl/core';

/** Parse DSL string and compile to IR in one step */
function compileDSL(dsl: string): CompilationOutput {
  const parseResult = parseAgentBasedABL(dsl);
  if (parseResult.errors.length > 0) {
    throw new Error(`Parse errors: ${parseResult.errors.map((e) => e.message).join(', ')}`);
  }
  return compileABLtoIR([parseResult.document!]);
}

// ---------------------------------------------------------------------------
// IR type tests
// ---------------------------------------------------------------------------

describe('PersistentMemory IR with scope', () => {
  test('user scope creates valid object', () => {
    const mem: PersistentMemory = {
      path: 'user.preferences',
      scope: 'user',
      access: 'readwrite',
      type: 'object',
    };

    expect(mem.scope).toBe('user');
    expect(mem.access).toBe('readwrite');
  });

  test('project scope creates valid object', () => {
    const mem: PersistentMemory = {
      path: 'global_promotions',
      scope: 'project',
      access: 'read',
      type: 'array',
    };

    expect(mem.scope).toBe('project');
    expect(mem.access).toBe('read');
  });
});

describe('ToolContextAccess IR', () => {
  test('creates valid read/write access', () => {
    const ctx: ToolContextAccess = {
      read: ['user_location', 'preferred_currency'],
      write: ['last_check'],
    };

    expect(ctx.read).toHaveLength(2);
    expect(ctx.write).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Validation tests
// ---------------------------------------------------------------------------

/** Minimal AgentIR stub for validation testing */
function makeAgentIR(overrides: Partial<AgentIR> = {}): AgentIR {
  return {
    metadata: { name: 'test_agent', kind: 'agent', description: '', source_hash: '' },
    identity: { goal: '', persona: '', limitations: [] },
    // mode is deprecated — execution style derived from flow presence
    execution: {} as any,
    gather: { fields: [], strategy: 'hybrid' },
    memory: {
      session: [],
      persistent: [],
      remember: [],
      recall: [],
    },
    constraints: { constraints: [], guardrails: [] },
    tools: [],
    coordination: { delegates: [], handoffs: [] },
    ...overrides,
  } as AgentIR;
}

describe('validateContextAccessDeclarations', () => {
  test('no warnings when no tools have context_access', () => {
    const ir = makeAgentIR({
      tools: [
        {
          name: 'simple_tool',
          description: 'A tool',
          parameters: [],
          returns: { type: 'object' },
          hints: {
            cacheable: false,
            latency: 'medium',
            parallelizable: false,
            side_effects: false,
            requires_auth: false,
          },
        },
      ],
    });
    expect(validateContextAccessDeclarations(ir)).toEqual([]);
  });

  test('no warnings when context_access references declared session vars', () => {
    const ir = makeAgentIR({
      memory: {
        session: [{ name: 'user_location' }, { name: 'last_check' }],
        persistent: [],
        remember: [],
        recall: [],
      },
      tools: [
        {
          name: 'check_inventory',
          description: 'Check inventory',
          parameters: [],
          returns: { type: 'object' },
          hints: {
            cacheable: false,
            latency: 'medium',
            parallelizable: false,
            side_effects: false,
            requires_auth: false,
          },
          context_access: { read: ['user_location'], write: ['last_check'] },
        },
      ],
    });
    expect(validateContextAccessDeclarations(ir)).toEqual([]);
  });

  test('no warnings when context_access references declared persistent paths', () => {
    const ir = makeAgentIR({
      memory: {
        session: [],
        persistent: [
          { path: 'user.preferences', scope: 'user', access: 'readwrite' },
          { path: 'global_config', scope: 'project', access: 'read' },
        ],
        remember: [],
        recall: [],
      },
      tools: [
        {
          name: 'load_config',
          description: 'Load config',
          parameters: [],
          returns: { type: 'object' },
          hints: {
            cacheable: false,
            latency: 'medium',
            parallelizable: false,
            side_effects: false,
            requires_auth: false,
          },
          context_access: { read: ['user.preferences', 'global_config'], write: [] },
        },
      ],
    });
    expect(validateContextAccessDeclarations(ir)).toEqual([]);
  });

  test('warns when context_access references undeclared var', () => {
    const ir = makeAgentIR({
      memory: {
        session: [{ name: 'user_location' }],
        persistent: [],
        remember: [],
        recall: [],
      },
      tools: [
        {
          name: 'check_tool',
          description: 'Check',
          parameters: [],
          returns: { type: 'object' },
          hints: {
            cacheable: false,
            latency: 'medium',
            parallelizable: false,
            side_effects: false,
            requires_auth: false,
          },
          context_access: { read: ['user_location', 'undeclared_var'], write: [] },
        },
      ],
    });

    const warnings = validateContextAccessDeclarations(ir);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('undeclared_var');
    expect(warnings[0].message).toContain('check_tool');
    expect(warnings[0].severity).toBe('warning');
  });

  test('warns for each undeclared var across multiple tools', () => {
    const ir = makeAgentIR({
      memory: {
        session: [],
        persistent: [],
        remember: [],
        recall: [],
      },
      tools: [
        {
          name: 'tool_a',
          description: 'A',
          parameters: [],
          returns: { type: 'object' },
          hints: {
            cacheable: false,
            latency: 'medium',
            parallelizable: false,
            side_effects: false,
            requires_auth: false,
          },
          context_access: { read: ['unknown_1'], write: [] },
        },
        {
          name: 'tool_b',
          description: 'B',
          parameters: [],
          returns: { type: 'object' },
          hints: {
            cacheable: false,
            latency: 'medium',
            parallelizable: false,
            side_effects: false,
            requires_auth: false,
          },
          context_access: { read: [], write: ['unknown_2'] },
        },
      ],
    });

    const warnings = validateContextAccessDeclarations(ir);
    expect(warnings).toHaveLength(2);
    expect(warnings[0].message).toContain('unknown_1');
    expect(warnings[1].message).toContain('unknown_2');
  });

  test('no warnings when no memory config', () => {
    const ir = makeAgentIR({ memory: undefined as unknown as AgentIR['memory'] });
    expect(validateContextAccessDeclarations(ir)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Full DSL → IR compilation
// ---------------------------------------------------------------------------

describe('DSL → IR compilation: scope and context_access', () => {
  test('compiles persistent memory SCOPE to IR scope field', () => {
    const dsl = `
AGENT: ScopeCompileAgent
GOAL: "Test scope compilation"

MEMORY:
  PERSISTENT:
    - PATH: user.prefs
      SCOPE: user
      TYPE: object
    - PATH: shared_config
      SCOPE: project
      ACCESS: read
      TYPE: object
`;

    const output = compileDSL(dsl);
    expect(output.compilation_errors ?? []).toHaveLength(0);

    const ir = output.agents['ScopeCompileAgent'];
    expect(ir).toBeDefined();
    expect(ir.memory.persistent).toHaveLength(2);

    expect(ir.memory.persistent[0].path).toBe('user.prefs');
    expect(ir.memory.persistent[0].scope).toBe('user');

    expect(ir.memory.persistent[1].path).toBe('shared_config');
    expect(ir.memory.persistent[1].scope).toBe('project');
  });

  test('persistent memory without SCOPE defaults to user', () => {
    const dsl = `
AGENT: DefaultScopeAgent
GOAL: "Test default scope"

MEMORY:
  PERSISTENT:
    - PATH: user.history
      TYPE: array
`;

    const output = compileDSL(dsl);
    expect(output.compilation_errors ?? []).toHaveLength(0);

    const ir = output.agents['DefaultScopeAgent'];
    expect(ir.memory.persistent[0].scope).toBe('user');
  });

  test('compiles tool CONTEXT_ACCESS to IR context_access', () => {
    const dsl = `
AGENT: CtxCompileAgent
GOAL: "Test context access compilation"

MEMORY:
  SESSION:
    - user_location
    - last_check

TOOLS:
  check_inventory(item_id: string) -> object
    CONTEXT_ACCESS:
      READ: [user_location]
      WRITE: [last_check]
`;

    const output = compileDSL(dsl);
    expect(output.compilation_errors ?? []).toHaveLength(0);

    const ir = output.agents['CtxCompileAgent'];
    const tool = ir.tools.find((t) => t.name === 'check_inventory');
    expect(tool).toBeDefined();
    expect(tool!.context_access).toBeDefined();
    expect(tool!.context_access!.read).toEqual(['user_location']);
    expect(tool!.context_access!.write).toEqual(['last_check']);
  });

  test('tools without CONTEXT_ACCESS have undefined context_access in IR', () => {
    const dsl = `
AGENT: NoCtxAgent
GOAL: "Test no context"

TOOLS:
  simple(input: string) -> string
`;

    const output = compileDSL(dsl);
    expect(output.compilation_errors ?? []).toHaveLength(0);

    const ir = output.agents['NoCtxAgent'];
    const tool = ir.tools.find((t) => t.name === 'simple');
    expect(tool!.context_access).toBeUndefined();
  });
});
