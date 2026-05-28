import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { extractToolsFromFiles, inferToolType } from '../import/tool-extractor.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────

const TWO_HTTP_TOOLS = `TOOLS:
  base_url: "https://api.example.com"
  auth: bearer
  headers:
    X-Shared: "shared"

  get_user(user_id: string) -> object
    type: http
    description: "Fetch user by ID"
    endpoint: "/users/{user_id}"
    method: GET
    headers:
      X-Tool: "get"

  create_user(name: string, email: string) -> object
    type: http
    description: "Create a new user"
    endpoint: "/users"
    method: POST
`;

const SANDBOX_TOOL = `TOOLS:
  calculate(expression: string) -> string
    type: sandbox
    description: "Evaluate a math expression"
    runtime: javascript
    code: |
      return eval(expression);
`;

const MCP_TOOL = `TOOLS:
  search_docs(query: string) -> object
    type: mcp
    description: "Search documents"
    server: "docs-server"
    tool: "search"
`;

const WORKFLOW_TOOL = `TOOLS:
  run_onboarding(account_id: string) -> object
    type: workflow
    description: "Run onboarding workflow"
    workflow_id: "wf_onboarding"
    trigger_id: "trg_manual"
`;

const OPTIONAL_RETURN_TOOL = `TOOLS:
  lookup_profile(user_id: string)
    type: http
    description: "Lookup a profile"
    endpoint: "https://api.example.com/profiles/{user_id}"
    method: GET
`;

const NO_TYPE_WITH_HTTP_BINDING = `TOOLS:
  lookup(id: string) -> object
    description: "Lookup by id"
    endpoint: "/lookup/{id}"
    method: GET
`;

const NO_TYPE_NO_BINDING = `TOOLS:
  mystery(input: string) -> string
    description: "A mystery tool"
`;

const INVALID_DSL = `TOOLS:
  broken_tool( -> object
    type: http
`;

function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('extractToolsFromFiles', () => {
  it('extracts multiple HTTP tools from a single file', () => {
    const files = new Map([['tools/api.tools.abl', TWO_HTTP_TOOLS]]);
    const result = extractToolsFromFiles(files);

    expect(result.errors).toHaveLength(0);
    expect(result.tools).toHaveLength(2);

    const [first, second] = result.tools;
    expect(first.name).toBe('get_user');
    expect(first.toolType).toBe('http');
    expect(first.description).toBe('Fetch user by ID');
    expect(first.sourceFile).toBe('tools/api.tools.abl');

    expect(second.name).toBe('create_user');
    expect(second.toolType).toBe('http');
    expect(second.description).toBe('Create a new user');
  });

  it('detects sandbox tool type', () => {
    const files = new Map([['tools/calc.tools.abl', SANDBOX_TOOL]]);
    const result = extractToolsFromFiles(files);

    expect(result.errors).toHaveLength(0);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].toolType).toBe('sandbox');
    expect(result.tools[0].name).toBe('calculate');
  });

  it('returns empty result for empty files map', () => {
    const result = extractToolsFromFiles(new Map());

    expect(result.tools).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('handles parse errors gracefully and continues with other files', () => {
    const files = new Map([
      ['tools/bad.tools.abl', INVALID_DSL],
      ['tools/good.tools.abl', SANDBOX_TOOL],
    ]);
    const result = extractToolsFromFiles(files);

    // Bad file produces errors but good file still extracts
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.sourceFile === 'tools/bad.tools.abl')).toBe(true);

    // Good file still extracted
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('calculate');
  });

  it('warns when legacy single-tool DSL is normalized for import', () => {
    const files = new Map([
      [
        'tools/weather.tools.abl',
        `lookup(city: string) -> object
  type: http
  description: "Lookup weather"
  endpoint: "/weather/{city}"
  method: GET`,
      ],
    ]);

    const result = extractToolsFromFiles(files);

    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.code).toBe('W_LEGACY_TOOL_FILE_NORMALIZED');
    expect(result.tools[0]?.name).toBe('lookup');
  });

  it('keeps canonical tool files with leading comments intact', () => {
    const files = new Map([
      [
        'tools/commented.tools.abl',
        `# Shared tool defaults

TOOLS:
  lookup(city: string) -> object
    type: http
    description: "Lookup weather"
    endpoint: "/weather/{city}"
    method: GET`,
      ],
    ]);

    const result = extractToolsFromFiles(files);

    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(result.tools[0]?.name).toBe('lookup');
  });

  it('stores per-tool DSL (starting with signature) as dslContent', () => {
    const files = new Map([['tools/calc.tools.abl', SANDBOX_TOOL]]);
    const result = extractToolsFromFiles(files);

    // dslContent should start with the signature line, not "TOOLS:"
    expect(result.tools[0].dslContent).toMatch(/^calculate\(/);
    expect(result.tools[0].dslContent).not.toContain('TOOLS:');
    // Should contain the tool properties
    expect(result.tools[0].dslContent).toContain('type: sandbox');
    expect(result.tools[0].dslContent).toContain('code: |');
  });

  it('extracts separate dslContent for each tool in multi-tool file', () => {
    const files = new Map([['tools/api.tools.abl', TWO_HTTP_TOOLS]]);
    const result = extractToolsFromFiles(files);

    expect(result.tools).toHaveLength(2);
    // First tool DSL starts with its own signature
    expect(result.tools[0].dslContent).toMatch(/^get_user\(/);
    expect(result.tools[0].dslContent).toContain(
      'endpoint: "https://api.example.com/users/{user_id}"',
    );
    expect(result.tools[0].dslContent).not.toContain('create_user');
    // Second tool DSL starts with its own signature
    expect(result.tools[1].dslContent).toMatch(/^create_user\(/);
    expect(result.tools[1].dslContent).toContain('endpoint: "https://api.example.com/users"');
    expect(result.tools[1].dslContent).not.toContain('get_user');
  });

  it('materializes file-level HTTP defaults into standalone stored DSL before hashing', () => {
    const files = new Map([['tools/api.tools.abl', TWO_HTTP_TOOLS]]);
    const result = extractToolsFromFiles(files);

    expect(result.errors).toHaveLength(0);
    const [getUser, createUser] = result.tools;

    expect(getUser.dslContent).not.toContain('base_url');
    expect(getUser.dslContent).toContain('endpoint: "https://api.example.com/users/{user_id}"');
    expect(getUser.dslContent).toContain('auth: bearer');
    expect(getUser.dslContent).toContain('headers:');
    expect(getUser.dslContent).toContain('X-Shared: "shared"');
    expect(getUser.dslContent).toContain('X-Tool: "get"');
    expect(getUser.sourceHash).toBe(hashContent(getUser.dslContent));

    expect(createUser.dslContent).not.toContain('base_url');
    expect(createUser.dslContent).toContain('endpoint: "https://api.example.com/users"');
    expect(createUser.dslContent).toContain('auth: bearer');
    expect(createUser.dslContent).toContain('headers:');
    expect(createUser.dslContent).toContain('X-Shared: "shared"');
    expect(createUser.sourceHash).toBe(hashContent(createUser.dslContent));
  });

  it('computes sourceHash from each extracted tool DSL, not the whole multi-tool file', () => {
    const files = new Map([['tools/api.tools.abl', TWO_HTTP_TOOLS]]);
    const result = extractToolsFromFiles(files);

    expect(result.tools).toHaveLength(2);
    expect(result.tools[0].sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.tools[1].sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.tools[0].sourceHash).not.toBe(result.tools[1].sourceHash);
  });

  it('extracts optional-return tool signatures as standalone DSL content', () => {
    const files = new Map([['tools/profile.tools.abl', OPTIONAL_RETURN_TOOL]]);
    const result = extractToolsFromFiles(files);

    expect(result.errors).toHaveLength(0);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].dslContent.split('\n')[0]).toBe('lookup_profile(user_id: string)');
    expect(result.tools[0].dslContent).toContain('type: http');
    expect(result.tools[0].dslContent).not.toContain('TOOLS:');
  });

  it('produces a 64-character hex sourceHash', () => {
    const files = new Map([['tools/calc.tools.abl', SANDBOX_TOOL]]);
    const result = extractToolsFromFiles(files);

    const hash = result.tools[0].sourceHash;
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).toHaveLength(64);
  });

  it('produces identical hashes for same content in different paths', () => {
    const files = new Map([
      ['tools/a.tools.abl', SANDBOX_TOOL],
      ['tools/b.tools.abl', SANDBOX_TOOL],
    ]);
    const result = extractToolsFromFiles(files);

    expect(result.tools[0].sourceHash).toBe(result.tools[1].sourceHash);
  });
});

describe('inferToolType', () => {
  it('defaults to http when no type and no bindings', () => {
    const files = new Map([['tools/mystery.tools.abl', NO_TYPE_NO_BINDING]]);
    const result = extractToolsFromFiles(files);

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].toolType).toBe('http');
  });

  it('infers mcp from explicit type field', () => {
    const files = new Map([['tools/mcp.tools.abl', MCP_TOOL]]);
    const result = extractToolsFromFiles(files);

    expect(result.tools[0].toolType).toBe('mcp');
  });

  it('infers workflow from explicit type field', () => {
    const files = new Map([['tools/workflow.tools.abl', WORKFLOW_TOOL]]);
    const result = extractToolsFromFiles(files);

    expect(result.errors).toHaveLength(0);
    expect(result.tools[0].toolType).toBe('workflow');
  });

  it('infers http from httpBinding when no explicit type', () => {
    // The parser sets type:'http' when endpoint is present, but this tests
    // the general fallback path if type is somehow missing
    const files = new Map([['tools/lookup.tools.abl', NO_TYPE_WITH_HTTP_BINDING]]);
    const result = extractToolsFromFiles(files);

    expect(result.tools[0].toolType).toBe('http');
  });
});
