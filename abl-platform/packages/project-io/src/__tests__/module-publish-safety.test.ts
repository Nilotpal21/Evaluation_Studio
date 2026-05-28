import { describe, it, expect, vi } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  validatePublishSafety,
  type SafetyAgentInput,
  type SafetyToolInput,
} from '../module-release/module-publish-safety.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

function httpTool(name: string, dslContent: string): SafetyToolInput {
  return { name, toolType: 'http', dslContent };
}

function searchAiTool(name: string, dslContent: string): SafetyToolInput {
  return { name, toolType: 'searchai', dslContent };
}

function genericTool(name: string, dslContent: string): SafetyToolInput {
  return { name, toolType: 'generic', dslContent };
}

function agent(name: string, dslContent: string): SafetyAgentInput {
  return { name, dslContent };
}

// ─── Tier 1 — Structural checks (HTTP tools) ─────────────────────────────

describe('Tier 1 — Structural validation', () => {
  it('flags HTTP tool with hardcoded Authorization header', () => {
    const tool = httpTool('my-api', 'Authorization: my-secret-token-value-here');
    const result = validatePublishSafety([], [tool]);

    expect(result.safe).toBe(false);
    const blocking = result.issues.filter((i) => i.severity === 'blocking');
    expect(blocking.length).toBeGreaterThanOrEqual(1);
    expect(blocking.some((i) => i.code === 'LITERAL_AUTH_HEADER')).toBe(true);
  });

  it('passes HTTP tool with auth_profile_ref', () => {
    const tool = httpTool('my-api', 'AUTH: auth_profile_ref my-profile');
    const result = validatePublishSafety([], [tool]);

    const authIssues = result.issues.filter(
      (i) => i.code === 'LITERAL_AUTH_VALUE' || i.code === 'LITERAL_AUTH_HEADER',
    );
    expect(authIssues).toHaveLength(0);
  });

  it('passes HTTP tool with {{env.TOKEN}} template in header', () => {
    const tool = httpTool('my-api', 'Authorization: {{env.TOKEN}}');
    const result = validatePublishSafety([], [tool]);

    const authIssues = result.issues.filter(
      (i) => i.code === 'LITERAL_AUTH_VALUE' || i.code === 'LITERAL_AUTH_HEADER',
    );
    expect(authIssues).toHaveLength(0);
  });

  it('passes HTTP tool with {{config.TOKEN}} template in AUTH directive', () => {
    const tool = httpTool('my-api', 'AUTH: {{config.MY_AUTH_TOKEN}}');
    const result = validatePublishSafety([], [tool]);

    const authIssues = result.issues.filter((i) => i.code === 'LITERAL_AUTH_VALUE');
    expect(authIssues).toHaveLength(0);
  });

  it('flags X-Api-Key header with hardcoded value', () => {
    const tool = httpTool('my-api', 'X-Api-Key: abcdefgh12345678');
    const result = validatePublishSafety([], [tool]);

    expect(result.safe).toBe(false);
    expect(result.issues.some((i) => i.code === 'LITERAL_AUTH_HEADER')).toBe(true);
  });

  it('flags AUTH directive with inline token', () => {
    const tool = httpTool('my-api', 'AUTH: some-inline-literal-token');
    const result = validatePublishSafety([], [tool]);

    expect(result.safe).toBe(false);
    expect(result.issues.some((i) => i.code === 'LITERAL_AUTH_VALUE')).toBe(true);
  });
});

// ─── Tier 2 — Pattern-based validation ───────────────────────────────────

describe('Tier 2 — Pattern-based validation', () => {
  it('flags PEM private key block', () => {
    const dsl = `
AGENT: my-agent
-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA...
-----END RSA PRIVATE KEY-----
`;
    const result = validatePublishSafety([agent('my-agent', dsl)], []);

    expect(result.safe).toBe(false);
    expect(result.issues.some((i) => i.code === 'PEM_PRIVATE_KEY')).toBe(true);
  });

  it('flags sk- prefix token', () => {
    const dsl = 'Use key sk-abcdefghijklmnopqrstuvwxyz1234';
    const result = validatePublishSafety([agent('my-agent', dsl)], []);

    expect(result.safe).toBe(false);
    expect(result.issues.some((i) => i.code === 'SECRET_PREFIX')).toBe(true);
  });

  it('flags Bearer token', () => {
    const dsl = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJ0ZXN0IjoiMSJ9';
    const result = validatePublishSafety([], [genericTool('my-tool', dsl)]);

    expect(result.safe).toBe(false);
    expect(result.issues.some((i) => i.code === 'SECRET_PREFIX')).toBe(true);
  });

  it('does not flag {{env.TOKEN}} template as a secret', () => {
    const dsl = 'Use {{env.TOKEN}} for auth';
    const result = validatePublishSafety([agent('my-agent', dsl)], []);

    const secretIssues = result.issues.filter(
      (i) =>
        i.code === 'SECRET_PREFIX' || i.code === 'PEM_PRIVATE_KEY' || i.code === 'URL_EMBEDDED_KEY',
    );
    expect(secretIssues).toHaveLength(0);
  });

  it('does not flag short base64 strings', () => {
    const dsl = 'key: abc123def456'; // short, not 20+ chars
    const result = validatePublishSafety([agent('my-agent', dsl)], []);

    const b64Issues = result.issues.filter((i) => i.code === 'BASE64_SECRET');
    expect(b64Issues).toHaveLength(0);
  });

  it('emits warning for long base64 string that looks like a secret', () => {
    // Construct a valid base64 string >20 chars that decodes to mostly printable ASCII
    const plaintext = 'this-is-a-secret-value-that-is-long-enough';
    const encoded = Buffer.from(plaintext).toString('base64');
    const dsl = `secret: ${encoded}`;

    const result = validatePublishSafety([agent('my-agent', dsl)], []);

    const b64Issues = result.issues.filter((i) => i.code === 'BASE64_SECRET');
    expect(b64Issues.length).toBeGreaterThanOrEqual(1);
    expect(b64Issues[0].severity).toBe('warning');
  });
});

// ─── Non-portable warnings ───────────────────────────────────────────────

describe('Non-portable warnings', () => {
  it('warns about SearchAI tool with indexId', () => {
    const tool = searchAiTool('search-tool', 'indexId: abc123def456789012345678');
    const result = validatePublishSafety([], [tool]);

    expect(result.issues.some((i) => i.code === 'SEARCHAI_INDEX_BINDING')).toBe(true);
    expect(result.issues.find((i) => i.code === 'SEARCHAI_INDEX_BINDING')!.severity).toBe(
      'warning',
    );
    // Warnings alone should not block
    const blocking = result.issues.filter((i) => i.severity === 'blocking');
    if (blocking.length === 0) {
      expect(result.safe).toBe(true);
    }
  });

  it('warns about tool with workflowId', () => {
    const tool = genericTool('flow-tool', 'workflowId: abc123def456789012345678');
    const result = validatePublishSafety([], [tool]);

    expect(result.issues.some((i) => i.code === 'WORKFLOW_ID_BINDING')).toBe(true);
    expect(result.issues.find((i) => i.code === 'WORKFLOW_ID_BINDING')!.severity).toBe('warning');
  });

  it('warns about DSL-native snake_case SearchAI and workflow bindings', () => {
    const searchTool = searchAiTool(
      'search-tool',
      ['search_docs(query: string) -> object', '  type: searchai', '  index_id: idx_abc_123'].join(
        '\n',
      ),
    );
    const workflowTool = genericTool(
      'flow-tool',
      [
        'run_flow(payload: object) -> object',
        '  type: workflow',
        '  workflow_id: wf_abc_123',
        '  trigger_id: tr_abc_123',
      ].join('\n'),
    );

    const result = validatePublishSafety([], [searchTool, workflowTool]);

    expect(result.issues.some((i) => i.code === 'SEARCHAI_INDEX_BINDING')).toBe(true);
    expect(result.issues.some((i) => i.code === 'WORKFLOW_ID_BINDING')).toBe(true);
  });

  it('blocks config placeholders in SearchAI identity bindings because imports persist live tools', () => {
    const tool = searchAiTool(
      'search-tool',
      [
        'search_docs(query: string) -> object',
        '  type: searchai',
        '  index_id: {{config.SEARCH_INDEX_ID}}',
        '  tenant_id: {{config.TENANT_ID}}',
      ].join('\n'),
    );

    const result = validatePublishSafety([], [tool]);

    expect(result.safe).toBe(false);
    expect(result.issues.some((i) => i.code === 'SEARCHAI_CONFIG_PLACEHOLDER_BINDING')).toBe(true);
    expect(
      result.issues.find((i) => i.code === 'SEARCHAI_CONFIG_PLACEHOLDER_BINDING')!.severity,
    ).toBe('blocking');
  });

  it('blocks config placeholders in workflow identity bindings because runtime cannot execute them literally', () => {
    const tool = genericTool(
      'flow-tool',
      [
        'run_flow(payload: object) -> object',
        '  type: workflow',
        '  workflow_id: {{config.WORKFLOW_ID}}',
        '  trigger_id: {{config.TRIGGER_ID}}',
      ].join('\n'),
    );

    const result = validatePublishSafety([], [tool]);

    expect(result.safe).toBe(false);
    expect(result.issues.some((i) => i.code === 'WORKFLOW_CONFIG_PLACEHOLDER_BINDING')).toBe(true);
    expect(
      result.issues.find((i) => i.code === 'WORKFLOW_CONFIG_PLACEHOLDER_BINDING')!.severity,
    ).toBe('blocking');
  });
});

// ─── Source-project identifiers ──────────────────────────────────────────

describe('Source-project identifiers', () => {
  it('blocks variableNamespaceIds', () => {
    const dsl = 'variableNamespaceIds: ns-abc-123-def-456';
    const result = validatePublishSafety([agent('my-agent', dsl)], []);

    expect(result.safe).toBe(false);
    expect(result.issues.some((i) => i.code === 'VARIABLE_NAMESPACE_ID')).toBe(true);
    expect(result.issues.find((i) => i.code === 'VARIABLE_NAMESPACE_ID')!.severity).toBe(
      'blocking',
    );
  });

  it('blocks variable_namespace_ids', () => {
    const dsl = 'variable_namespace_ids: ["ns-abc-123-def-456"]';
    const result = validatePublishSafety([agent('my-agent', dsl)], []);

    expect(result.safe).toBe(false);
    expect(result.issues.some((i) => i.code === 'VARIABLE_NAMESPACE_ID')).toBe(true);
  });

  it('warns on raw _id references', () => {
    const dsl = '_id: "aabbccddeeff00112233445566778899"';
    const result = validatePublishSafety([agent('my-agent', dsl)], []);

    expect(result.issues.some((i) => i.code === 'RAW_MONGODB_ID')).toBe(true);
    expect(result.issues.find((i) => i.code === 'RAW_MONGODB_ID')!.severity).toBe('warning');
  });

  it('warns on projectId references', () => {
    const dsl = 'projectId: "aabbccddeeff00112233445566778899"';
    const result = validatePublishSafety([agent('my-agent', dsl)], []);

    expect(result.issues.some((i) => i.code === 'SOURCE_PROJECT_ID')).toBe(true);
    expect(result.issues.find((i) => i.code === 'SOURCE_PROJECT_ID')!.severity).toBe('warning');
  });
});

// ─── Clean cases ─────────────────────────────────────────────────────────

describe('Clean cases', () => {
  it('returns safe with no issues for a normal tool DSL', () => {
    const tool = genericTool(
      'clean-tool',
      `TOOL clean-tool
  TYPE: generic
  DESCRIPTION: A simple tool that does things
  INPUT_SCHEMA:
    type: object
    properties:
      query:
        type: string`,
    );
    const result = validatePublishSafety([], [tool]);

    expect(result.safe).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('returns safe for tool using only template references', () => {
    const tool = httpTool(
      'templated-tool',
      `TOOL templated-tool
  TYPE: http
  URL: {{env.BASE_URL}}/api/data
  AUTH: auth_profile_ref my-profile`,
    );
    const result = validatePublishSafety([], [tool]);

    const blocking = result.issues.filter((i) => i.severity === 'blocking');
    expect(blocking).toHaveLength(0);
    expect(result.safe).toBe(true);
  });

  it('returns safe with empty agents and tools', () => {
    const result = validatePublishSafety([], []);
    expect(result.safe).toBe(true);
    expect(result.issues).toHaveLength(0);
  });
});
