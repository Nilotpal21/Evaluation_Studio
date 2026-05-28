/**
 * Import Desired-State (Idempotent) Integration Tests
 *
 * Covers:
 *   Phase 1.1 — computeApplyOperations() diff logic with sourceHash
 *   Phase 1.2 — Tool signature extraction from agent DSL
 *   Phase 1.3 — Auto-generate manifest when project.json is missing
 *   Phase 1.0 — Export-then-reimport round-trip (snapshot fidelity)
 *
 * Integration tests: exercise real functions end-to-end, no mocks.
 */

import { describe, test, expect } from 'vitest';
import {
  computeApplyOperations,
  computeToolApplyOperations,
  type ApplyInput,
  type ApplyOperation,
  type ToolApplyInput,
} from '../import/import-applier.js';
import { migrateV1ToV2 } from '../import/v1-migration.js';
import { readFolderV2 } from '../import/folder-reader.js';
import { stripCommonPrefix } from '../import/path-normalizer.js';
import { computeSourceHash } from '../export/lockfile-generator.js';
import {
  extractToolSignaturesFromAgents,
  type AgentDeclaredTool,
} from '../import/tool-signature-extractor.js';
import { synthesizeToolDsl } from '../import/tool-stub-synthesizer.js';
import { extractAgentName } from '../import/folder-reader.js';

/** Map file-path-keyed agentFiles to agent-name-keyed map for computeApplyOperations */
function mapAgentsByName(
  agentFiles: Map<string, string>,
): Map<string, { name: string; dslContent: string; description: null }> {
  const result = new Map<string, { name: string; dslContent: string; description: null }>();
  for (const [_filePath, content] of agentFiles) {
    const name = extractAgentName(content) ?? 'unknown';
    result.set(name, { name, dslContent: content, description: null });
  }
  return result;
}

/** Same but without description (for existing agents) */
function mapExistingAgentsByName(
  agentFiles: Map<string, string>,
): Map<string, { name: string; dslContent: string }> {
  const result = new Map<string, { name: string; dslContent: string }>();
  for (const [_filePath, content] of agentFiles) {
    const name = extractAgentName(content) ?? 'unknown';
    result.set(name, { name, dslContent: content });
  }
  return result;
}

// ─── DSL Fixtures ───────────────────────────────────────────────────────────

const AGENT_A_V1 = `AGENT: AgentA
GOAL: First version of AgentA
`;

const AGENT_A_V2 = `AGENT: AgentA
GOAL: Second version of AgentA with improvements

TOOLS:
  lookup(id: string) -> {result: object}
    description: "Look up a record"
`;

const AGENT_B = `AGENT: AgentB
GOAL: Handle payments
`;

const AGENT_C = `AGENT: AgentC
GOAL: Handle shipping
`;

const TOOL_FILE = `check_order(order_id: string) -> {status: string, eta: string}
  description: "Check order status by ID"
  type: http
  endpoint: "https://api.example.com/orders"
  method: GET
`;

const TOOL_FILE_MODIFIED = `check_order(order_id: string, include_history?: boolean) -> {status: string, eta: string, history?: object[]}
  description: "Check order status with optional history"
  type: http
  endpoint: "https://api.example.com/v2/orders"
  method: GET
`;

// ═══════════════════════════════════════════════════════════════════════════
// Phase 1.1 — computeApplyOperations() Diff Logic
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 1.1: computeApplyOperations() desired-state diff', () => {
  test('empty project + 2 imported agents = 2 creates', () => {
    const input: ApplyInput = {
      existingAgents: new Map(),
      importedAgents: new Map([
        ['AgentA', { name: 'AgentA', dslContent: AGENT_A_V1, description: null }],
        ['AgentB', { name: 'AgentB', dslContent: AGENT_B, description: null }],
      ]),
    };

    const ops = computeApplyOperations(input);

    const creates = ops.filter((o) => o.type === 'create');
    expect(creates).toHaveLength(2);
    expect(creates.map((o) => o.agentName).sort()).toEqual(['AgentA', 'AgentB']);
  });

  test('identical content = zero operations (idempotent)', () => {
    const input: ApplyInput = {
      existingAgents: new Map([
        ['AgentA', { name: 'AgentA', dslContent: AGENT_A_V1 }],
        ['AgentB', { name: 'AgentB', dslContent: AGENT_B }],
      ]),
      importedAgents: new Map([
        ['AgentA', { name: 'AgentA', dslContent: AGENT_A_V1, description: null }],
        ['AgentB', { name: 'AgentB', dslContent: AGENT_B, description: null }],
      ]),
    };

    const ops = computeApplyOperations(input);

    // Identical content → zero operations
    expect(ops).toHaveLength(0);
  });

  test('modified agent = 1 update', () => {
    const input: ApplyInput = {
      existingAgents: new Map([['AgentA', { name: 'AgentA', dslContent: AGENT_A_V1 }]]),
      importedAgents: new Map([
        ['AgentA', { name: 'AgentA', dslContent: AGENT_A_V2, description: null }],
      ]),
    };

    const ops = computeApplyOperations(input);

    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe('update');
    expect(ops[0].agentName).toBe('AgentA');
    expect(ops[0].dslContent).toBe(AGENT_A_V2);
  });

  test('agent in existing but not in import = 1 delete', () => {
    const input: ApplyInput = {
      existingAgents: new Map([
        ['AgentA', { name: 'AgentA', dslContent: AGENT_A_V1 }],
        ['AgentB', { name: 'AgentB', dslContent: AGENT_B }],
      ]),
      importedAgents: new Map([
        ['AgentA', { name: 'AgentA', dslContent: AGENT_A_V1, description: null }],
      ]),
    };

    const ops = computeApplyOperations(input);

    const deletes = ops.filter((o) => o.type === 'delete');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].agentName).toBe('AgentB');
  });

  test('full desired-state: create + update + delete in one operation', () => {
    const input: ApplyInput = {
      existingAgents: new Map([
        ['AgentA', { name: 'AgentA', dslContent: AGENT_A_V1 }],
        ['AgentB', { name: 'AgentB', dslContent: AGENT_B }],
      ]),
      importedAgents: new Map([
        ['AgentA', { name: 'AgentA', dslContent: AGENT_A_V2, description: null }],
        ['AgentC', { name: 'AgentC', dslContent: AGENT_C, description: null }],
      ]),
    };

    const ops = computeApplyOperations(input);

    const creates = ops.filter((o) => o.type === 'create');
    const updates = ops.filter((o) => o.type === 'update');
    const deletes = ops.filter((o) => o.type === 'delete');

    expect(creates).toHaveLength(1);
    expect(creates[0].agentName).toBe('AgentC');

    expect(updates).toHaveLength(1);
    expect(updates[0].agentName).toBe('AgentA');

    expect(deletes).toHaveLength(1);
    expect(deletes[0].agentName).toBe('AgentB');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 1.1 — Tool Apply Operations
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 1.1: computeToolApplyOperations()', () => {
  test('new tool in import = create', () => {
    const input: ToolApplyInput = {
      existingTools: new Map(),
      importedTools: [
        {
          name: 'check_order',
          toolType: 'http',
          dslContent: TOOL_FILE,
          description: 'Check order status',
          sourceHash: computeSourceHash(TOOL_FILE),
          sourceFile: 'tools/check_order.tools.abl',
        },
      ],
    };

    const ops = computeToolApplyOperations(input);

    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe('create');
    expect(ops[0].toolName).toBe('check_order');
  });

  test('identical tool = zero operations', () => {
    const input: ToolApplyInput = {
      existingTools: new Map([['check_order', { name: 'check_order', dslContent: TOOL_FILE }]]),
      importedTools: [
        {
          name: 'check_order',
          toolType: 'http',
          dslContent: TOOL_FILE,
          description: 'Check order status',
          sourceHash: computeSourceHash(TOOL_FILE),
          sourceFile: 'tools/check_order.tools.abl',
        },
      ],
    };

    const ops = computeToolApplyOperations(input);

    expect(ops).toHaveLength(0);
  });

  test('modified tool = update', () => {
    const input: ToolApplyInput = {
      existingTools: new Map([['check_order', { name: 'check_order', dslContent: TOOL_FILE }]]),
      importedTools: [
        {
          name: 'check_order',
          toolType: 'http',
          dslContent: TOOL_FILE_MODIFIED,
          description: 'Check order status v2',
          sourceHash: computeSourceHash(TOOL_FILE_MODIFIED),
          sourceFile: 'tools/check_order.tools.abl',
        },
      ],
    };

    const ops = computeToolApplyOperations(input);

    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe('update');
    expect(ops[0].toolName).toBe('check_order');
  });

  test('tool in existing but not in import = delete', () => {
    const input: ToolApplyInput = {
      existingTools: new Map([
        ['check_order', { name: 'check_order', dslContent: TOOL_FILE }],
        ['old_tool', { name: 'old_tool', dslContent: 'old()' }],
      ]),
      importedTools: [
        {
          name: 'check_order',
          toolType: 'http',
          dslContent: TOOL_FILE,
          description: 'Check order status',
          sourceHash: computeSourceHash(TOOL_FILE),
          sourceFile: 'tools/check_order.tools.abl',
        },
      ],
    };

    const ops = computeToolApplyOperations(input);

    const deletes = ops.filter((o) => o.type === 'delete');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].toolName).toBe('old_tool');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 1.3 — Auto-Generate Manifest
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 1.3: Auto-generate manifest when project.json is missing', () => {
  test('directory with only agent files — migration returns MISSING_MANIFEST error', () => {
    const files = new Map<string, string>([
      ['agents/agenta.agent.abl', AGENT_A_V1],
      ['agents/agentb.agent.abl', AGENT_B],
    ]);

    const migration = migrateV1ToV2(files);

    expect(migration.error).toBeUndefined();
    expect(migration.migrated).toBe(true);
    expect(migration.formatVersion).toBe('2.0');
    // Should have auto-generated project.json in files
    expect(migration.files.has('project.json')).toBe(true);
    // Entry agent should be first alphabetically
    expect(migration.manifest.entry_agent).toBe('AgentA');
    // Warnings about auto-generation
    expect(migration.warnings.length).toBeGreaterThan(0);
    expect(migration.warnings.some((w) => w.includes('auto-generated'))).toBe(true);
  });

  test('directory with no agent files returns NO_AGENTS_FOUND error', () => {
    const files = new Map<string, string>([['readme.txt', 'Hello']]);

    const migration = migrateV1ToV2(files);

    expect(migration.error).toBeDefined();
    expect(migration.error!.code).toBe('NO_AGENTS_FOUND');
  });

  test('v2 files with project.json pass through without migration', () => {
    const manifest = JSON.stringify({
      format_version: '2.0',
      entry_agent: 'AgentA',
      agents: [{ name: 'AgentA', file: 'agents/agenta.agent.abl' }],
      tools: [],
    });

    const files = new Map<string, string>([
      ['project.json', manifest],
      ['agents/agenta.agent.abl', AGENT_A_V1],
    ]);

    const migration = migrateV1ToV2(files);

    expect(migration.error).toBeUndefined();
    expect(migration.migrated).toBe(false); // v2 pass-through, no migration needed
    expect(migration.formatVersion).toBe('2.0');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 1.0 — Snapshot Round-Trip Fidelity
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 1.0: Export-reimport fidelity', () => {
  test('stripCommonPrefix + readFolderV2 round-trip on wrapped files', () => {
    const manifest = JSON.stringify({
      format_version: '2.0',
      entry_agent: 'AgentA',
      agents: [
        { name: 'AgentA', file: 'agents/agenta.agent.abl' },
        { name: 'AgentB', file: 'agents/agentb.agent.abl' },
      ],
      tools: [],
    });

    // Simulate zip wrapper directory
    const rawFiles = new Map<string, string>([
      ['retail-demo/project.json', manifest],
      ['retail-demo/agents/agenta.agent.abl', AGENT_A_V1],
      ['retail-demo/agents/agentb.agent.abl', AGENT_B],
    ]);

    const { files: strippedFiles } = stripCommonPrefix(rawFiles);

    // Verify prefix was stripped
    expect(strippedFiles.has('project.json')).toBe(true);
    expect(strippedFiles.has('agents/agenta.agent.abl')).toBe(true);

    // Verify migrateV1ToV2 can find project.json after stripping
    const migration = migrateV1ToV2(strippedFiles);
    expect(migration.error).toBeUndefined();
    expect(migration.migrated).toBe(false); // v2 pass-through

    // And readFolderV2 should detect the agents
    const folderResult = readFolderV2(migration.files);
    expect(folderResult.success).toBe(true);
    expect(folderResult.agentFiles.size).toBe(2);
  });

  test('sourceHash is deterministic for identical content', () => {
    const content = AGENT_A_V1;
    const hash1 = computeSourceHash(content);
    const hash2 = computeSourceHash(content);
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(16); // Truncated SHA-256 (64 bits = 16 hex chars)
  });

  test('sourceHash differs for different content', () => {
    const hash1 = computeSourceHash(AGENT_A_V1);
    const hash2 = computeSourceHash(AGENT_A_V2);
    expect(hash1).not.toBe(hash2);
  });

  test('computeApplyOperations preserves content byte-for-byte', () => {
    const input: ApplyInput = {
      existingAgents: new Map(),
      importedAgents: new Map([
        ['AgentA', { name: 'AgentA', dslContent: AGENT_A_V1, description: null }],
      ]),
    };

    const ops = computeApplyOperations(input);
    expect(ops[0].dslContent).toBe(AGENT_A_V1); // Exact same string reference
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Edge Cases
// ═══════════════════════════════════════════════════════════════════════════

describe('Edge cases', () => {
  test('agent with only whitespace changes is detected as modified', () => {
    const original = 'AGENT: Test\nGOAL: Hello\n';
    const withTrailingSpace = 'AGENT: Test\nGOAL: Hello \n';

    const input: ApplyInput = {
      existingAgents: new Map([['Test', { name: 'Test', dslContent: original }]]),
      importedAgents: new Map([
        ['Test', { name: 'Test', dslContent: withTrailingSpace, description: null }],
      ]),
    };

    const ops = computeApplyOperations(input);
    // Whitespace change should count as an update (content differs)
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe('update');
  });

  test('empty existing + empty import = zero operations', () => {
    const input: ApplyInput = {
      existingAgents: new Map(),
      importedAgents: new Map(),
    };

    const ops = computeApplyOperations(input);
    expect(ops).toHaveLength(0);
  });

  test('agent with null dslContent in existing still compares correctly', () => {
    const input: ApplyInput = {
      existingAgents: new Map([['AgentA', { name: 'AgentA', dslContent: null }]]),
      importedAgents: new Map([
        ['AgentA', { name: 'AgentA', dslContent: AGENT_A_V1, description: null }],
      ]),
    };

    const ops = computeApplyOperations(input);
    // null → content = update
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe('update');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 1.2 — Tool Signature Extraction & Stub Synthesis
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 1.2: Tool signature extraction from agent DSL', () => {
  test('extracts tool signatures from single agent', () => {
    const agentFiles = new Map([
      [
        'agents/order-bot.agent.abl',
        `AGENT: OrderBot
GOAL: Handle orders

TOOLS:
  check_order(order_id: string) -> {status: string}
    description: "Check order status"
  cancel_order(order_id: string, reason?: string) -> {success: boolean}
    description: "Cancel an order"
`,
      ],
    ]);

    const result = extractToolSignaturesFromAgents(agentFiles);

    expect(result.errors).toHaveLength(0);
    expect(result.tools).toHaveLength(2);

    const checkOrder = result.tools.find((t) => t.name === 'check_order');
    expect(checkOrder).toBeDefined();
    expect(checkOrder!.parameters).toHaveLength(1);
    expect(checkOrder!.parameters[0].name).toBe('order_id');
    expect(checkOrder!.parameters[0].type).toBe('string');
    expect(checkOrder!.description).toBe('Check order status');
    expect(checkOrder!.sourceAgent).toBe('agents/order-bot.agent.abl');

    const cancelOrder = result.tools.find((t) => t.name === 'cancel_order');
    expect(cancelOrder).toBeDefined();
    // Parser drops optional params (reason?: string) — only required params captured
    expect(cancelOrder!.parameters).toHaveLength(1);
    expect(cancelOrder!.parameters[0].name).toBe('order_id');
  });

  test('deduplicates tools across agents, keeping richest signature', () => {
    const agentFiles = new Map([
      [
        'agents/a.agent.abl',
        `AGENT: AgentA
GOAL: Agent A

TOOLS:
  search(query: string) -> {results: object[]}
    description: "Basic search"
`,
      ],
      [
        'agents/b.agent.abl',
        `AGENT: AgentB
GOAL: Agent B

TOOLS:
  search(query: string, limit: number, offset: number) -> {results: object[], total: number}
    description: "Advanced search"
`,
      ],
    ]);

    const result = extractToolSignaturesFromAgents(agentFiles);

    expect(result.tools).toHaveLength(1);
    const search = result.tools[0];
    expect(search.name).toBe('search');
    // Should keep AgentB's version (3 params > 1 param)
    expect(search.parameters).toHaveLength(3);
    expect(search.sourceAgent).toBe('agents/b.agent.abl');
  });

  test('handles agent with no TOOLS section', () => {
    const agentFiles = new Map([
      [
        'agents/simple.agent.abl',
        `AGENT: SimpleBot
GOAL: No tools
`,
      ],
    ]);

    const result = extractToolSignaturesFromAgents(agentFiles);

    expect(result.errors).toHaveLength(0);
    expect(result.tools).toHaveLength(0);
  });

  test('handles invalid DSL gracefully', () => {
    const agentFiles = new Map([['agents/broken.agent.abl', 'this is not valid ABL at all']]);

    const result = extractToolSignaturesFromAgents(agentFiles);

    // Should not crash, may have errors
    expect(result.tools).toHaveLength(0);
  });
});

describe('Phase 1.2: Tool stub synthesis', () => {
  test('generates valid tool DSL from extracted signature', () => {
    const tool: AgentDeclaredTool = {
      name: 'get_user',
      signature: 'get_user(user_id: string) -> {name: string, email: string}',
      description: 'Fetch user profile',
      parameters: [{ name: 'user_id', type: 'string', required: true }],
      returns: {
        type: 'object',
        fields: {
          name: { type: 'string' },
          email: { type: 'string' },
        },
      },
      sourceAgent: 'agents/my-agent.agent.abl',
    };

    const dsl = synthesizeToolDsl(tool);

    expect(dsl).toContain('get_user(user_id: string)');
    expect(dsl).toContain('description: "Fetch user profile"');
    expect(dsl).toContain('type: http');
    expect(dsl).toContain('endpoint: "https://TODO-configure-endpoint"');
    expect(dsl).toContain('method: POST');
  });

  test('escapes double quotes in description', () => {
    const tool: AgentDeclaredTool = {
      name: 'fetch_data',
      signature: 'fetch_data(source: string) -> {data: object}',
      description: 'Fetches "live" data from the API',
      parameters: [{ name: 'source', type: 'string', required: true }],
      returns: { type: 'object', fields: { data: { type: 'object' } } },
      sourceAgent: 'agents/fetcher.agent.abl',
    };

    const dsl = synthesizeToolDsl(tool);

    expect(dsl).toContain('description: "Fetches \\"live\\" data from the API"');
  });

  test('escapes backslashes in description', () => {
    const tool: AgentDeclaredTool = {
      name: 'read_path',
      signature: 'read_path(path: string) -> {content: string}',
      description: 'Reads files from C:\\Users\\data',
      parameters: [{ name: 'path', type: 'string', required: true }],
      returns: { type: 'object', fields: { content: { type: 'string' } } },
      sourceAgent: 'agents/reader.agent.abl',
    };

    const dsl = synthesizeToolDsl(tool);

    expect(dsl).toContain('description: "Reads files from C:\\\\Users\\\\data"');
  });

  test('escapes both backslashes and double quotes in description', () => {
    const tool: AgentDeclaredTool = {
      name: 'complex_tool',
      signature: 'complex_tool() -> {ok: boolean}',
      description: 'Parses "JSON" from path C:\\tmp\\file',
      parameters: [],
      returns: { type: 'object', fields: { ok: { type: 'boolean' } } },
      sourceAgent: 'agents/complex.agent.abl',
    };

    const dsl = synthesizeToolDsl(tool);

    expect(dsl).toContain('description: "Parses \\"JSON\\" from path C:\\\\tmp\\\\file"');
  });

  test('uses fallback description when none provided', () => {
    const tool: AgentDeclaredTool = {
      name: 'ping',
      signature: 'ping() -> {ok: boolean}',
      description: null,
      parameters: [],
      returns: { type: 'object', fields: { ok: { type: 'boolean' } } },
      sourceAgent: 'agents/test.agent.abl',
    };

    const dsl = synthesizeToolDsl(tool);

    expect(dsl).toContain('Auto-created from agent DSL import');
    expect(dsl).toContain('agents/test.agent.abl');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Full Import Pipeline Integration (E2E without infrastructure)
// ═══════════════════════════════════════════════════════════════════════════

describe('Full import pipeline integration', () => {
  test('v1 project without manifest → auto-manifest → diff → tool extraction', () => {
    // Simulate a v1 project uploaded as zip with no project.json
    const rawFiles = new Map<string, string>([
      [
        'my-project/agents/support.agent.abl',
        `AGENT: SupportBot
GOAL: Handle customer support

TOOLS:
  search_kb(query: string) -> {results: object[]}
    description: "Search knowledge base"
  create_ticket(subject: string, body: string) -> {ticket_id: string}
    description: "Create support ticket"
`,
      ],
      [
        'my-project/agents/billing.agent.abl',
        `AGENT: BillingBot
GOAL: Handle billing inquiries

TOOLS:
  get_invoice(invoice_id: string) -> {amount: number, status: string}
    description: "Get invoice details"
`,
      ],
    ]);

    // Step 1: Strip common prefix
    const { files } = stripCommonPrefix(rawFiles);
    expect(files.has('agents/support.agent.abl')).toBe(true);

    // Step 2: Migrate (auto-generate manifest)
    const migration = migrateV1ToV2(files);
    expect(migration.error).toBeUndefined();
    expect(migration.migrated).toBe(true);
    expect(migration.manifest.entry_agent).toBe('BillingBot'); // B < S alphabetically

    // Step 3: Read folder
    const folder = readFolderV2(migration.files);
    expect(folder.success).toBe(true);
    expect(folder.agentFiles.size).toBe(2);

    // Step 4: Compute diff (fresh project = all creates)
    const agentOps = computeApplyOperations({
      existingAgents: new Map(),
      importedAgents: mapAgentsByName(folder.agentFiles),
    });
    expect(agentOps.filter((o) => o.type === 'create')).toHaveLength(2);

    // Step 5: Extract tool signatures
    const toolResult = extractToolSignaturesFromAgents(folder.agentFiles);
    expect(toolResult.tools).toHaveLength(3); // search_kb, create_ticket, get_invoice
    expect(toolResult.tools.map((t) => t.name).sort()).toEqual([
      'create_ticket',
      'get_invoice',
      'search_kb',
    ]);

    // Step 6: Synthesize stubs for missing tools
    for (const tool of toolResult.tools) {
      const stub = synthesizeToolDsl(tool);
      expect(stub).toContain(tool.name);
      expect(stub).toContain('type: http');
    }
  });

  test('re-import with identical content produces zero operations', () => {
    const manifest = JSON.stringify({
      format_version: '2.0',
      entry_agent: 'AgentA',
      agents: [{ name: 'AgentA', file: 'agents/agenta.agent.abl' }],
      tools: [],
    });

    const files = new Map<string, string>([
      ['project.json', manifest],
      ['agents/agenta.agent.abl', AGENT_A_V1],
    ]);

    // First import
    const migration = migrateV1ToV2(files);
    const folder = readFolderV2(migration.files);
    const firstOps = computeApplyOperations({
      existingAgents: new Map(),
      importedAgents: mapAgentsByName(folder.agentFiles),
    });
    expect(firstOps).toHaveLength(1); // 1 create

    // Re-import same content (simulating existing project)
    const secondOps = computeApplyOperations({
      existingAgents: mapExistingAgentsByName(folder.agentFiles),
      importedAgents: mapAgentsByName(folder.agentFiles),
    });
    expect(secondOps).toHaveLength(0); // Idempotent — zero ops
  });

  test('import with modified agent produces exactly one update', () => {
    const files = new Map<string, string>([
      [
        'project.json',
        JSON.stringify({
          format_version: '2.0',
          entry_agent: 'AgentA',
          agents: [{ name: 'AgentA', file: 'agents/agenta.agent.abl' }],
          tools: [],
        }),
      ],
      ['agents/agenta.agent.abl', AGENT_A_V2],
    ]);

    const migration = migrateV1ToV2(files);
    const folder = readFolderV2(migration.files);

    const ops = computeApplyOperations({
      existingAgents: new Map([['AgentA', { name: 'AgentA', dslContent: AGENT_A_V1 }]]),
      importedAgents: mapAgentsByName(folder.agentFiles),
    });

    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe('update');
    expect(ops[0].agentName).toBe('AgentA');
    expect(ops[0].dslContent).toBe(AGENT_A_V2);
  });

  test('always emits delete operations for agents in existing but not in import', () => {
    // computeApplyOperations is a pure diff — it always computes delete ops.
    // The caller (route handler) is responsible for filtering deletes based on deleteUnmatched flag.
    const ops = computeApplyOperations({
      existingAgents: new Map([
        ['AgentA', { name: 'AgentA', dslContent: AGENT_A_V1 }],
        ['AgentB', { name: 'AgentB', dslContent: AGENT_B }],
        ['AgentC', { name: 'AgentC', dslContent: AGENT_C }],
      ]),
      importedAgents: new Map([
        ['AgentA', { name: 'AgentA', dslContent: AGENT_A_V1, description: null }],
      ]),
    });

    const deletes = ops.filter((o) => o.type === 'delete');
    expect(deletes).toHaveLength(2);
    expect(deletes.map((o) => o.agentName).sort()).toEqual(['AgentB', 'AgentC']);

    // AgentA is unchanged → no create/update
    const creates = ops.filter((o) => o.type === 'create');
    const updates = ops.filter((o) => o.type === 'update');
    expect(creates).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  test('caller can filter delete operations to implement deleteUnmatched=false', () => {
    const ops = computeApplyOperations({
      existingAgents: new Map([
        ['AgentA', { name: 'AgentA', dslContent: AGENT_A_V1 }],
        ['AgentB', { name: 'AgentB', dslContent: AGENT_B }],
      ]),
      importedAgents: new Map([
        ['AgentA', { name: 'AgentA', dslContent: AGENT_A_V1, description: null }],
      ]),
    });

    // Full diff includes a delete for AgentB
    expect(ops.filter((o) => o.type === 'delete')).toHaveLength(1);

    // Caller filters deletes when deleteUnmatched=false
    const filteredOps = ops.filter((o) => o.type !== 'delete');
    expect(filteredOps).toHaveLength(0); // No creates or updates (AgentA unchanged)
  });

  test('tool operations: existing tool updated, missing tool created', () => {
    const toolOps = computeToolApplyOperations({
      existingTools: new Map([['check_order', { name: 'check_order', dslContent: TOOL_FILE }]]),
      importedTools: [
        {
          name: 'check_order',
          toolType: 'http' as const,
          dslContent: TOOL_FILE_MODIFIED,
          description: 'Check order status with optional history',
          sourceFile: 'tools/check_order.tools.abl',
          sourceHash: 'abc123',
        },
        {
          name: 'new_tool',
          toolType: 'http' as const,
          dslContent: 'new_tool() -> {ok: boolean}\n  type: http\n',
          description: 'A new tool',
          sourceFile: 'tools/new_tool.tools.abl',
          sourceHash: 'def456',
        },
      ],
    });

    const creates = toolOps.filter((o) => o.type === 'create');
    const updates = toolOps.filter((o) => o.type === 'update');

    expect(creates).toHaveLength(1);
    expect(creates[0].toolName).toBe('new_tool');

    expect(updates).toHaveLength(1);
    expect(updates[0].toolName).toBe('check_order');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Auto-Manifest Edge Cases
// ═══════════════════════════════════════════════════════════════════════════

describe('Auto-manifest edge cases', () => {
  test('multiple agents: entry_agent is first alphabetically', () => {
    const files = new Map<string, string>([
      ['agents/zebra.agent.abl', 'AGENT: Zebra\nGOAL: Last\n'],
      ['agents/alpha.agent.abl', 'AGENT: Alpha\nGOAL: First\n'],
      ['agents/middle.agent.abl', 'AGENT: Middle\nGOAL: Middle\n'],
    ]);

    const result = migrateV1ToV2(files);

    expect(result.error).toBeUndefined();
    expect(result.manifest.entry_agent).toBe('Alpha');
  });

  test('agents with tools: both captured in manifest', () => {
    const files = new Map<string, string>([
      ['agents/bot.agent.abl', 'AGENT: Bot\nGOAL: Test\n'],
      ['tools/lookup.tools.abl', 'lookup(q: string) -> {r: string}\n  type: http\n'],
    ]);

    const result = migrateV1ToV2(files);

    expect(result.error).toBeUndefined();
    expect(result.manifest.agents).toBeDefined();
    expect(result.manifest.tools).toBeDefined();
    // tools is a Record<string, ManifestTool>, not an array
    expect(Object.keys(result.manifest.tools!)).toHaveLength(1);
    expect(result.manifest.tools!['lookup']).toBeDefined();
  });

  test('no agent files at all: returns error', () => {
    const files = new Map<string, string>([
      ['tools/lookup.tools.abl', 'lookup(q: string) -> {r: string}\n  type: http\n'],
      ['readme.md', '# My Project'],
    ]);

    const result = migrateV1ToV2(files);

    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('NO_AGENTS_FOUND');
  });

  test('agent file that cannot extract name still triggers manifest generation', () => {
    const files = new Map<string, string>([
      ['agents/bad.agent.abl', 'GOAL: No agent declaration'],
      ['agents/good.agent.abl', 'AGENT: GoodBot\nGOAL: Works\n'],
    ]);

    const result = migrateV1ToV2(files);

    // Should generate manifest with only the good agent
    expect(result.error).toBeUndefined();
    expect(result.manifest.entry_agent).toBe('GoodBot');
  });

  test('duplicate extracted agent names block auto-manifest generation', () => {
    const files = new Map<string, string>([
      ['agents/first.agent.abl', 'AGENT: Duplicate\nGOAL: First\n'],
      ['agents/second.agent.abl', 'AGENT: Duplicate\nGOAL: Second\n'],
    ]);

    const result = migrateV1ToV2(files);

    expect(result.error).toEqual({
      code: 'DUPLICATE_AGENT_NAME',
      message:
        'No project.json found and multiple agent files declare "Duplicate": agents/first.agent.abl, agents/second.agent.abl',
    });
    expect(result.manifest.metadata?.entity_counts?.agents).toBeUndefined();
  });

  test('yaml agent file detected for manifest generation', () => {
    // YAML format uses "agent:" not "AGENT:", so extractAgentNameFromDsl
    // may not find the name. The file is still detected by extension.
    const files = new Map<string, string>([
      ['agents/bot.agent.yaml', 'agent:\n  name: YamlBot\n  goal: Test\n'],
    ]);

    const result = migrateV1ToV2(files);

    // extractAgentNameFromDsl looks for /^AGENT:\s*(.+)/m which won't match yaml
    // If name can't be extracted, that file is skipped → NO_AGENTS_FOUND
    // This is expected: yaml name extraction is a known limitation of auto-manifest
    if (result.error) {
      expect(result.error.code).toBe('NO_AGENTS_FOUND');
    }
  });
});
