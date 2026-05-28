import { describe, it, expect } from 'vitest';
import { validateToolDsl } from '../tools/project-tool-validator.js';

const ctx = { tenantId: 'test-tenant', projectId: 'test-project' };

// =============================================================================
// Phase 5: Trial Compile
// =============================================================================

describe('validateToolDsl — Phase 5 trial compile', () => {
  it('passes for valid HTTP tool DSL', () => {
    const dsl = `charge_card(amount: number) -> object
  type: http
  endpoint: https://api.stripe.com/v1/charges
  method: POST
  auth: bearer`;
    const result = validateToolDsl(dsl, ctx);
    expect(result.errors.filter((e) => e.code === 'E739')).toHaveLength(0);
  });

  it('passes for valid sandbox tool DSL', () => {
    const dsl = `calculate(x: number) -> number
  type: sandbox
  runtime: javascript
  code: |
    function main(x) { return x * 2; }
    return main($x);`;
    const result = validateToolDsl(dsl, ctx);
    expect(result.errors.filter((e) => e.code === 'E739')).toHaveLength(0);
  });

  it('passes for valid MCP tool DSL', () => {
    const dsl = `search(query: string) -> object
  type: mcp
  server: my-mcp-server`;
    const result = validateToolDsl(dsl, ctx);
    expect(result.errors.filter((e) => e.code === 'E739')).toHaveLength(0);
  });
});

// =============================================================================
// Full pipeline — regression tests
// =============================================================================

describe('validateToolDsl — full pipeline', () => {
  it('rejects DSL with missing type', () => {
    const dsl = `my_tool(x: string) -> object
  endpoint: https://api.example.com`;
    const result = validateToolDsl(dsl, ctx);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'E732')).toBe(true);
  });

  it('rejects HTTP tool with missing endpoint', () => {
    const dsl = `my_tool(x: string) -> object
  type: http
  method: GET`;
    const result = validateToolDsl(dsl, ctx);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'E733')).toBe(true);
  });

  it('rejects invalid auth type', () => {
    const dsl = `my_tool() -> object
  type: http
  endpoint: https://api.example.com
  method: GET
  auth: magic`;
    const result = validateToolDsl(dsl, ctx);
    expect(result.errors.some((e) => e.code === 'E735')).toBe(true);
  });

  it('rejects sandbox tool with missing runtime', () => {
    const dsl = `my_tool() -> object
  type: sandbox
  code: |
    return 42;`;
    const result = validateToolDsl(dsl, ctx);
    expect(result.errors.some((e) => e.code === 'E740')).toBe(true);
  });

  it('rejects MCP tool with missing server', () => {
    const dsl = `my_tool() -> object
  type: mcp`;
    const result = validateToolDsl(dsl, ctx);
    expect(result.errors.some((e) => e.code === 'E750')).toBe(true);
  });

  it('warns on missing description', () => {
    const dsl = `my_tool() -> object
  type: http
  endpoint: https://api.example.com
  method: GET`;
    const result = validateToolDsl(dsl, ctx);
    expect(result.warnings.some((w) => w.code === 'W730')).toBe(true);
  });

  it('detects duplicate tool names', () => {
    const dsl = `my_tool() -> object
  type: http
  endpoint: https://api.example.com
  method: GET`;
    const result = validateToolDsl(dsl, { ...ctx, existingNames: ['my_tool'] });
    expect(result.errors.some((e) => e.code === 'E731')).toBe(true);
  });

  it('accepts valid complete HTTP tool DSL', () => {
    const dsl = `charge_card(amount: number, currency?: string) -> {txnId: string}
  description: "Charge a credit card"
  type: http
  endpoint: https://api.stripe.com/v1/charges
  method: POST
  auth: bearer
  timeout: 10000
  retry: 3`;
    const result = validateToolDsl(dsl, ctx);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts HTTP endpoint URLs backed by unresolved env placeholders', () => {
    const dsl = `my_tool() -> object
  description: "A templated HTTP tool"
  type: http
  endpoint: "{{env.TOOL_BASE_URL}}/events"
  method: GET`;
    const result = validateToolDsl(dsl, ctx);
    expect(result.errors.some((e) => e.code === 'E761')).toBe(false);
    expect(result.valid).toBe(true);
  });

  it('still blocks unsafe literal HTTP endpoint prefixes with env placeholders', () => {
    const dsl = `my_tool() -> object
  description: "An unsafe templated HTTP tool"
  type: http
  endpoint: "http://169.254.169.254/{{env.METADATA_PATH}}"
  method: GET`;
    const result = validateToolDsl(dsl, ctx);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'E761',
          field: 'endpoint',
        }),
      ]),
    );
  });

  it('emits traceEmitter on valid tool', () => {
    const dsl = `my_tool() -> object
  description: "A tool"
  type: http
  endpoint: https://api.example.com
  method: GET`;
    const events: unknown[] = [];
    validateToolDsl(dsl, ctx, (event) => events.push(event));
    expect(events).toHaveLength(1);
    expect((events[0] as any).type).toBe('tool.validation.pass');
  });

  it('emits traceEmitter on invalid tool', () => {
    const dsl = `my_tool() -> object
  endpoint: https://api.example.com`;
    const events: unknown[] = [];
    validateToolDsl(dsl, ctx, (event) => events.push(event));
    expect(events).toHaveLength(1);
    expect((events[0] as any).type).toBe('tool.validation.fail');
  });
});

// =============================================================================
// Phase 4: Security — plaintext secret detection
// =============================================================================

describe('validateToolDsl — Phase 4 security (plaintext secrets)', () => {
  it('detects OpenAI-style API key in client_secret field', () => {
    const dsl = `my_tool() -> object
  description: "A tool"
  type: http
  endpoint: https://api.example.com
  method: POST
  auth: oauth2_client
  client_secret: sk-1234567890abcdef
  token_url: https://auth.example.com/token`;
    const result = validateToolDsl(dsl, ctx);
    expect(result.errors.some((e) => e.code === 'E760')).toBe(true);
    expect(result.errors.some((e) => e.message.includes('plaintext secret'))).toBe(true);
  });

  it('detects JWT token in bearer field', () => {
    const dsl = `my_tool() -> object
  description: "A tool"
  type: http
  endpoint: https://api.example.com
  method: GET
  bearer: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U`;
    const result = validateToolDsl(dsl, ctx);
    expect(result.errors.some((e) => e.code === 'E760')).toBe(true);
  });

  it('detects GitHub token in client_secret', () => {
    const dsl = `my_tool() -> object
  description: "A tool"
  type: http
  endpoint: https://api.example.com
  method: GET
  client_secret: ghp_abc1234567890def1234567890abcdef12`;
    const result = validateToolDsl(dsl, ctx);
    expect(result.errors.some((e) => e.code === 'E760')).toBe(true);
  });

  it('skips template placeholder values (not flagged as plaintext)', () => {
    const dsl = `my_tool() -> object
  description: "A tool"
  type: http
  endpoint: https://api.example.com
  method: POST
  auth: oauth2_client
  client_secret: "{{secrets.CLIENT_SECRET}}"
  token_url: https://auth.example.com/token`;
    const result = validateToolDsl(dsl, ctx);
    expect(result.errors.filter((e) => e.code === 'E760')).toHaveLength(0);
  });

  it('skips env template values (not flagged as plaintext)', () => {
    const dsl = `my_tool() -> object
  description: "A tool"
  type: http
  endpoint: https://api.example.com
  method: GET
  bearer: "{{env.MY_TOKEN}}"`;
    const result = validateToolDsl(dsl, ctx);
    expect(result.errors.filter((e) => e.code === 'E760')).toHaveLength(0);
  });
});

// =============================================================================
// Phase 5: Trial Compile — catch block (E739)
// =============================================================================

describe('validateToolDsl — Phase 5 trial compile error', () => {
  it('validates searchai tool type', () => {
    const dsl = `search_kb(query: string) -> object
  description: "Search knowledge base"
  type: searchai
  index_id: idx_123
  tenant_id: tenant_456`;
    const result = validateToolDsl(dsl, ctx);
    expect(result.errors.filter((e) => e.code === 'E739')).toHaveLength(0);
  });

  it('rejects searchai tool missing index_id', () => {
    const dsl = `search_kb(query: string) -> object
  description: "Search"
  type: searchai
  tenant_id: tenant_456`;
    const result = validateToolDsl(dsl, ctx);
    expect(result.errors.some((e) => e.code === 'SEARCHAI_MISSING_INDEX_ID')).toBe(true);
  });

  it('rejects searchai tool missing tenant_id', () => {
    const dsl = `search_kb(query: string) -> object
  description: "Search"
  type: searchai
  index_id: idx_123`;
    const result = validateToolDsl(dsl, ctx);
    expect(result.errors.some((e) => e.code === 'SEARCHAI_MISSING_TENANT_ID')).toBe(true);
  });

  it('rejects invalid HTTP method', () => {
    const dsl = `my_tool() -> object
  description: "A tool"
  type: http
  endpoint: https://api.example.com
  method: UNKNOWN`;
    const result = validateToolDsl(dsl, ctx);
    expect(result.errors.some((e) => e.code === 'E734')).toBe(true);
  });

  it('rejects timeout out of range', () => {
    const dsl = `my_tool() -> object
  description: "A tool"
  type: http
  endpoint: https://api.example.com
  method: GET
  timeout: 50`;
    const result = validateToolDsl(dsl, ctx);
    expect(result.errors.some((e) => e.code === 'E737')).toBe(true);
  });

  it('rejects retry out of range', () => {
    const dsl = `my_tool() -> object
  description: "A tool"
  type: http
  endpoint: https://api.example.com
  method: GET
  retry: 20`;
    const result = validateToolDsl(dsl, ctx);
    expect(result.errors.some((e) => e.code === 'E738')).toBe(true);
  });

  it('rejects sandbox with invalid runtime', () => {
    const dsl = `my_tool() -> object
  description: "A tool"
  type: sandbox
  runtime: rust
  code: |
    return 42;`;
    const result = validateToolDsl(dsl, ctx);
    expect(result.errors.some((e) => e.code === 'E741')).toBe(true);
  });

  it('rejects sandbox memory_mb out of range', () => {
    const dsl = `my_tool() -> object
  description: "A tool"
  type: sandbox
  runtime: javascript
  memory_mb: 50
  code: |
    return 42;`;
    const result = validateToolDsl(dsl, ctx);
    expect(result.errors.some((e) => e.code === 'E745')).toBe(true);
  });

  it('rejects invalid tool type', () => {
    const dsl = `my_tool() -> object
  description: "A tool"
  type: grpc`;
    const result = validateToolDsl(dsl, ctx);
    expect(result.errors.some((e) => e.code === 'E732')).toBe(true);
  });

  it('rejects oversized DSL content', () => {
    const dsl = `my_tool() -> object\n  type: http\n  endpoint: ${'x'.repeat(600_000)}`;
    const result = validateToolDsl(dsl, ctx);
    expect(result.valid).toBe(false);
    expect(result.errors[0].code).toBe('E730');
  });

  it('rejects DSL that fails to parse', () => {
    const dsl = `INVALID no signature here`;
    const result = validateToolDsl(dsl, ctx);
    expect(result.valid).toBe(false);
    expect(result.errors[0].code).toBe('E730');
  });

  it('rejects too-long description', () => {
    const dsl = `my_tool() -> object
  description: "${'x'.repeat(2100)}"
  type: http
  endpoint: https://api.example.com
  method: GET`;
    const result = validateToolDsl(dsl, ctx);
    expect(result.errors.some((e) => e.field === 'description')).toBe(true);
  });

  it('rejects HTTP tool with missing method', () => {
    const dsl = `my_tool() -> object
  description: "A tool"
  type: http
  endpoint: https://api.example.com`;
    const result = validateToolDsl(dsl, ctx);
    expect(result.errors.some((e) => e.code === 'E734')).toBe(true);
    expect(result.errors.some((e) => e.message.includes('requires a method'))).toBe(true);
  });

  it('rejects sandbox tool with missing code block', () => {
    const dsl = `my_tool() -> object
  description: "A tool"
  type: sandbox
  runtime: javascript`;
    const result = validateToolDsl(dsl, ctx);
    expect(result.errors.some((e) => e.code === 'E742')).toBe(true);
    expect(result.errors.some((e) => e.message.includes('requires a code block'))).toBe(true);
  });

  it('rejects tool with invalid name format (single char)', () => {
    const dsl = `x() -> object
  description: "Invalid name"
  type: http
  endpoint: https://api.example.com
  method: GET`;
    const result = validateToolDsl(dsl, ctx);
    expect(result.errors.some((e) => e.code === 'E731')).toBe(true);
  });

  it('rejects HTTP tool with SSRF-blocked endpoint', () => {
    const dsl = `my_tool() -> object
  description: "A tool"
  type: http
  endpoint: http://169.254.169.254/latest/meta-data
  method: GET`;
    const result = validateToolDsl(dsl, ctx);
    expect(result.errors.some((e) => e.code === 'E761')).toBe(true);
  });

  it('rejects oauth2_client without token_url', () => {
    const dsl = `my_tool() -> object
  description: "A tool"
  type: http
  endpoint: https://api.example.com
  method: POST
  auth: oauth2_client`;
    const result = validateToolDsl(dsl, ctx);
    expect(result.errors.some((e) => e.code === 'E736')).toBe(true);
  });

  it('allows auth-profile backed oauth2_client without inline token_url', () => {
    const dsl = `my_tool() -> object
  description: "A tool"
  type: http
  endpoint: https://api.example.com
  method: POST
  auth_profile: CCAuth
  auth: oauth2_client`;
    const result = validateToolDsl(dsl, ctx);
    expect(result.errors.some((e) => e.code === 'E736')).toBe(false);
  });
});
