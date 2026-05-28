/**
 * PII Vault Boundary Contract — Unit Tests
 *
 * ABLP-535: Tests for resolveRenderMode('original'), bare-UUID restoration,
 * normalizeToolPIIAccess('original'), and renderForConsumer parity.
 *
 * Pure-function tests — no mocks, no session, no runtime.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  PIIVault,
  resolveRenderMode,
  applyMask,
  type PIIPatternConfig,
} from '@abl/compiler/platform/security/pii-vault.js';
import {
  getToolPIIAccess,
  restorePIITokensForToolExecution,
  type PIIAuditContext,
} from '../services/execution/pii-tool-execution.js';
import type { RuntimeSession } from '../services/execution/types.js';
import { tokenizeStringLeavesDeep } from '../routes/internal-tools.js';

describe('PII Vault Boundary Contract — resolveRenderMode', () => {
  it('returns "original" for consumer "original" (FR-1, FR-2)', () => {
    expect(resolveRenderMode('original', 'ssn')).toBe('original');
  });

  it('returns "redacted" for consumer "tools" — secure default unchanged', () => {
    expect(resolveRenderMode('tools', 'ssn')).toBe('redacted');
  });

  it('returns "masked" for consumer "user" — unchanged', () => {
    expect(resolveRenderMode('user', 'ssn')).toBe('masked');
  });

  it('returns "redacted" for consumer "logs" — unchanged', () => {
    expect(resolveRenderMode('logs', 'ssn')).toBe('redacted');
  });

  it('returns "tokenized" for consumer "llm" — security baseline unchanged', () => {
    expect(resolveRenderMode('llm', 'ssn')).toBe('tokenized');
  });

  it('returns "redacted" for consumer "admin" — unchanged', () => {
    expect(resolveRenderMode('admin', 'ssn')).toBe('redacted');
  });

  it('returns "redacted" for consumer "system" — unchanged', () => {
    expect(resolveRenderMode('system', 'ssn')).toBe('redacted');
  });

  it('returns "redacted" for unknown consumer — fail-closed', () => {
    expect(resolveRenderMode('unknown_consumer', 'ssn')).toBe('redacted');
  });

  it('pattern-level consumerAccess override takes precedence over builtin', () => {
    const configs: PIIPatternConfig[] = [
      {
        patternName: 'ssn',
        defaultRenderMode: 'masked',
        consumerAccess: [{ consumer: 'original', renderMode: 'redacted' }],
      },
    ];
    expect(resolveRenderMode('original', 'ssn', configs)).toBe('redacted');
  });

  it('pattern-level defaultRenderMode wins when no consumer override exists', () => {
    const configs: PIIPatternConfig[] = [
      {
        patternName: 'ssn',
        defaultRenderMode: 'masked',
        consumerAccess: [],
      },
    ];
    // 'original' consumer has no explicit override, falls to defaultRenderMode
    expect(resolveRenderMode('original', 'ssn', configs)).toBe('masked');
  });
});

describe('PII Vault Boundary Contract — renderForConsumer with "original"', () => {
  let vault: PIIVault;

  beforeEach(() => {
    vault = new PIIVault();
  });

  it('returns plaintext for consumer "original" (FR-2)', () => {
    const input = 'My SSN is 123-45-6789';
    const { text: tokenized } = vault.tokenize(input);
    expect(vault.renderForConsumer(tokenized, 'original')).toBe(input);
  });

  it('returns redacted for consumer "tools" — secure default (regression)', () => {
    const input = 'My SSN is 123-45-6789';
    const { text: tokenized } = vault.tokenize(input);
    expect(vault.renderForConsumer(tokenized, 'tools')).toBe('My SSN is [REDACTED_SSN]');
  });

  it('returns masked original for consumer "user" — not masked UUID', () => {
    const input = 'My SSN is 123-45-6789';
    const { text: tokenized } = vault.tokenize(input);
    const userView = vault.renderForConsumer(tokenized, 'user');
    // Should mask the original SSN, not the UUID
    expect(userView).toBe('My SSN is ***-**-****');
    expect(userView).not.toMatch(/[a-f0-9]{8}-[a-f0-9]{4}/);
  });
});

describe('PII Vault Boundary Contract — bare-UUID restoration', () => {
  let vault: PIIVault;

  beforeEach(() => {
    vault = new PIIVault();
  });

  it('restores bare UUID matching a vault entry (FR-4)', () => {
    const input = 'My SSN is 123-45-6789';
    const { tokens } = vault.tokenize(input);
    const tokenId = tokens[0].id;

    // Simulate LLM stripping the {{PII:ssn:...}} wrapper — only the UUID remains
    const bareUUID = tokenId;
    const result = vault.renderForConsumer(bareUUID, 'original');
    expect(result).toBe('123-45-6789');
  });

  it('does not false-positive on UUIDs not in the vault (FR-4)', () => {
    const input = 'My SSN is 123-45-6789';
    vault.tokenize(input);

    // A random UUID that is NOT in the vault
    const randomUUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const result = vault.renderForConsumer(randomUUID, 'original');
    expect(result).toBe(randomUUID);
  });

  it('restores vault UUID and passes through non-vault UUID in mixed text', () => {
    const input = 'My SSN is 123-45-6789';
    const { tokens } = vault.tokenize(input);
    const vaultUUID = tokens[0].id;
    const otherUUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    const mixedText = `ID: ${vaultUUID} and doc: ${otherUUID}`;
    const result = vault.renderForConsumer(mixedText, 'original');
    expect(result).toBe(`ID: 123-45-6789 and doc: ${otherUUID}`);
  });

  it('renders bare UUID per consumer mode (redacted for tools)', () => {
    const input = 'Phone: 555-123-4567';
    const { tokens } = vault.tokenize(input);
    const tokenId = tokens[0].id;

    const result = vault.renderForConsumer(tokenId, 'tools');
    expect(result).toBe('[REDACTED_PHONE]');
  });

  it('renders bare UUID per consumer mode (masked for user)', () => {
    const input = 'My SSN is 123-45-6789';
    const { tokens } = vault.tokenize(input);
    const tokenId = tokens[0].id;

    const result = vault.renderForConsumer(tokenId, 'user');
    expect(result).toBe('***-**-****');
  });

  it('handles empty vault — UUIDs pass through unchanged', () => {
    const emptyVault = new PIIVault();
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const result = emptyVault.renderForConsumer(uuid, 'original');
    expect(result).toBe(uuid);
  });

  it('handles text with both wrapped tokens and bare UUIDs', () => {
    const input = 'SSN: 123-45-6789 and phone: 555-987-6543';
    const { text: tokenized, tokens } = vault.tokenize(input);
    // tokens[0] is ssn, tokens[1] is phone

    // Simulate LLM keeping ssn wrapped but stripping phone wrapper
    const ssnToken = `{{PII:ssn:${tokens[0].id}}}`;
    const phoneId = tokens[1].id;
    const mixedText = `SSN: ${ssnToken} and phone: ${phoneId}`;

    const result = vault.renderForConsumer(mixedText, 'original');
    expect(result).toBe('SSN: 123-45-6789 and phone: 555-987-6543');
  });
});

describe('PII Vault Boundary Contract — normalizeToolPIIAccess', () => {
  // normalizeToolPIIAccess is private, so we test it indirectly through
  // getToolPIIAccess which calls normalizeToolPIIAccess on the tool's pii_access.

  it('accepts "original" as a valid ToolPIIAccess value (FR-3)', () => {
    const session = {
      agentIR: {
        tools: [{ name: 'crm_lookup', pii_access: 'original' }],
      },
    } as unknown as RuntimeSession;

    const result = getToolPIIAccess(session, 'crm_lookup');
    expect(result).toBe('original');
  });

  it('normalizes unknown pii_access values to "tools" (FR-3)', () => {
    const session = {
      agentIR: {
        tools: [{ name: 'bad_tool', pii_access: 'garbage' }],
      },
    } as unknown as RuntimeSession;

    const result = getToolPIIAccess(session, 'bad_tool');
    expect(result).toBe('tools');
  });

  it('normalizes undefined pii_access to "tools" (FR-3)', () => {
    const session = {
      agentIR: {
        tools: [{ name: 'no_pii', pii_access: undefined }],
      },
    } as unknown as RuntimeSession;

    const result = getToolPIIAccess(session, 'no_pii');
    expect(result).toBe('tools');
  });

  it('normalizes null pii_access to "tools" — never to "original" (FR-3)', () => {
    const session = {
      agentIR: {
        tools: [{ name: 'null_pii', pii_access: null }],
      },
    } as unknown as RuntimeSession;

    const result = getToolPIIAccess(session, 'null_pii');
    expect(result).toBe('tools');
  });
});

// ---------------------------------------------------------------------------
// R1: renderForConsumerWithTrace — audit precision
// ---------------------------------------------------------------------------

describe('PII Vault — renderForConsumerWithTrace (R1 audit precision)', () => {
  let vault: PIIVault;

  beforeEach(() => {
    vault = new PIIVault();
  });

  it('returns empty renderedTokens when vault is empty', () => {
    const { text, renderedTokens } = vault.renderForConsumerWithTrace(
      'nothing to see here',
      'original',
    );
    expect(text).toBe('nothing to see here');
    expect(renderedTokens).toEqual([]);
  });

  it('returns empty renderedTokens when text contains no tokens', () => {
    vault.tokenize('SSN: 123-45-6789'); // fills the vault
    const { text, renderedTokens } = vault.renderForConsumerWithTrace('no tokens here', 'original');
    expect(text).toBe('no tokens here');
    expect(renderedTokens).toEqual([]);
  });

  it('returns exactly the one token that was substituted', () => {
    vault.tokenize('SSN: 123-45-6789');
    vault.tokenize('Phone: 555-867-5309');
    vault.tokenize('Email: alice@example.com');

    // Only include the SSN token in the text
    const ssnTokens = vault.listTokens().filter((t) => t.type === 'ssn');
    expect(ssnTokens.length).toBe(1);
    const ssnText = `lookup ${ssnTokens[0].token}`;

    const { text, renderedTokens } = vault.renderForConsumerWithTrace(ssnText, 'original');
    expect(text).toBe('lookup 123-45-6789');
    expect(renderedTokens).toHaveLength(1);
    expect(renderedTokens[0].type).toBe('ssn');
    expect(renderedTokens[0].original).toBe('123-45-6789');
  });

  it('returns all tokens when multiple are substituted', () => {
    const input = 'SSN: 123-45-6789 and Phone: 555-867-5309';
    const { text: tokenized, tokens } = vault.tokenize(input);
    expect(tokens.length).toBeGreaterThanOrEqual(2);

    const { text, renderedTokens } = vault.renderForConsumerWithTrace(tokenized, 'original');
    expect(text).toBe(input);
    expect(renderedTokens.length).toBe(tokens.length);
  });

  it('tracks bare-UUID hits in renderedTokens', () => {
    const input = 'SSN: 123-45-6789';
    const { tokens } = vault.tokenize(input);
    const bareUUID = tokens[0].id;

    const { text, renderedTokens } = vault.renderForConsumerWithTrace(bareUUID, 'original');
    expect(text).toBe('123-45-6789');
    expect(renderedTokens).toHaveLength(1);
    expect(renderedTokens[0].type).toBe('ssn');
  });

  it('does not include non-vault UUIDs in renderedTokens', () => {
    vault.tokenize('SSN: 123-45-6789');
    const nonVaultUUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    const { text, renderedTokens } = vault.renderForConsumerWithTrace(nonVaultUUID, 'original');
    expect(text).toBe(nonVaultUUID);
    expect(renderedTokens).toEqual([]);
  });

  it('renders the same output as renderForConsumer (parity)', () => {
    const input = 'SSN: 123-45-6789 and Email: bob@test.io';
    const { text: tokenized } = vault.tokenize(input);

    const oldResult = vault.renderForConsumer(tokenized, 'original');
    const { text: newResult } = vault.renderForConsumerWithTrace(tokenized, 'original');
    expect(newResult).toBe(oldResult);
  });

  it('returns defensive copies — modifying renderedTokens does not affect vault', () => {
    vault.tokenize('SSN: 123-45-6789');
    const allTokens = vault.listTokens();
    const { renderedTokens } = vault.renderForConsumerWithTrace(allTokens[0].token, 'original');
    renderedTokens[0].original = 'TAMPERED';

    // Vault should be unaffected
    const freshTokens = vault.listTokens();
    expect(freshTokens[0].original).toBe('123-45-6789');
  });
});

// ---------------------------------------------------------------------------
// R2: Deep tokenization of string leaves in nested structures
// Tests exercise the same recursive walk logic used by internal-tools.ts
// ---------------------------------------------------------------------------

describe('R2: Deep tokenization of string leaves in nested structures', () => {
  // F-NIT: Now imports the REAL production function instead of a mirrored copy.
  // The function is exported from internal-tools.ts for testability.
  function tokenizeDeep(value: unknown, vault: PIIVault): unknown {
    return tokenizeStringLeavesDeep(value, vault, new WeakMap());
  }

  it('tokenizes a flat string value', () => {
    const vault = new PIIVault();
    const result = tokenizeDeep('SSN: 123-45-6789', vault);
    expect(result).toMatch(/\{\{PII:ssn:[a-f0-9-]+\}\}/);
    expect(result).not.toContain('123-45-6789');
  });

  it('tokenizes nested object string leaves', () => {
    const vault = new PIIVault();
    const input = {
      customer: {
        email: 'alice@example.com',
        ssn: '123-45-6789',
      },
      note: 'no PII here',
    };
    const result = tokenizeDeep(input, vault) as Record<string, unknown>;
    const customer = result.customer as Record<string, unknown>;

    expect(customer.email).toMatch(/\{\{PII:email:[a-f0-9-]+\}\}/);
    expect(customer.ssn).toMatch(/\{\{PII:ssn:[a-f0-9-]+\}\}/);
    expect(result.note).toBe('no PII here');
  });

  it('tokenizes string leaves in arrays', () => {
    const vault = new PIIVault();
    const input = ['123-45-6789', 'no PII', 'alice@example.com'];
    const result = tokenizeDeep(input, vault) as string[];

    expect(result[0]).toMatch(/\{\{PII:ssn:[a-f0-9-]+\}\}/);
    expect(result[1]).toBe('no PII');
    expect(result[2]).toMatch(/\{\{PII:email:[a-f0-9-]+\}\}/);
  });

  it('tokenizes deeply nested mixed structures', () => {
    const vault = new PIIVault();
    const input = {
      level1: {
        level2: {
          items: ['555-867-5309', { inner: '123-45-6789' }],
        },
      },
    };
    const result = tokenizeDeep(input, vault) as Record<string, unknown>;
    const level2 = (result.level1 as Record<string, unknown>).level2 as Record<string, unknown>;
    const items = level2.items as unknown[];

    expect(items[0]).toMatch(/\{\{PII:phone:[a-f0-9-]+\}\}/);
    expect((items[1] as Record<string, unknown>).inner).toMatch(/\{\{PII:ssn:[a-f0-9-]+\}\}/);
  });

  it('passes through non-string scalars unchanged', () => {
    const vault = new PIIVault();
    const input = { count: 42, active: true, empty: null, undef: undefined };
    const result = tokenizeDeep(input, vault) as Record<string, unknown>;

    expect(result.count).toBe(42);
    expect(result.active).toBe(true);
    expect(result.empty).toBe(null);
    expect(result.undef).toBeUndefined();
  });

  it('handles cyclic objects without infinite recursion', () => {
    const vault = new PIIVault();
    const obj: Record<string, unknown> = { name: '123-45-6789' };
    obj.self = obj; // cycle

    const result = tokenizeDeep(obj, vault) as Record<string, unknown>;
    // The name should be tokenized
    expect(result.name).toMatch(/\{\{PII:ssn:[a-f0-9-]+\}\}/);
    // F-3: With WeakMap, cycle property now points to the TOKENIZED clone
    expect(result.self).toBe(result);
  });

  // F-3: Shared non-cyclic object — both references see the tokenized version
  it('tokenizes shared non-cyclic objects at all positions (F-3)', () => {
    const vault = new PIIVault();
    const shared = { ssn: '123-45-6789' };
    const input = { a: shared, b: shared };

    const result = tokenizeDeep(input, vault) as Record<string, Record<string, unknown>>;

    // Both a.ssn and b.ssn should be tokenized
    expect(result.a.ssn).toMatch(/\{\{PII:ssn:[a-f0-9-]+\}\}/);
    expect(result.b.ssn).toMatch(/\{\{PII:ssn:[a-f0-9-]+\}\}/);

    // Both should reference the SAME tokenized clone
    expect(result.a).toBe(result.b);
  });

  // F-3: Shared array — both references see the tokenized version
  it('tokenizes shared arrays at all positions (F-3)', () => {
    const vault = new PIIVault();
    const sharedArr = ['alice@example.com', 'no PII'];
    const input = { x: sharedArr, y: sharedArr };

    const result = tokenizeDeep(input, vault) as Record<string, unknown[]>;

    expect(result.x[0]).toMatch(/\{\{PII:email:[a-f0-9-]+\}\}/);
    expect(result.y[0]).toMatch(/\{\{PII:email:[a-f0-9-]+\}\}/);
    expect(result.x[1]).toBe('no PII');
    expect(result.x).toBe(result.y);
  });
});

// ---------------------------------------------------------------------------
// F-1: Centralized audit emission in restorePIITokensForToolExecution
// ---------------------------------------------------------------------------

describe('F-1: Centralized audit emission via auditContext', () => {
  let vault: PIIVault;
  let session: RuntimeSession;

  beforeEach(() => {
    vault = new PIIVault();
    session = {
      id: 'session-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentName: 'test-agent',
      piiVault: vault,
      piiPatternConfigs: undefined,
    } as Partial<RuntimeSession> as RuntimeSession;
  });

  it('emits pii_plaintext_dispensed when auditContext is provided and piiAccess is original', () => {
    const input = 'SSN: 123-45-6789';
    const { text: tokenized } = vault.tokenize(input);

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const auditContext: PIIAuditContext = {
      onTraceEvent: (e) => events.push(e),
      toolName: 'crm_lookup',
      agentId: 'test-agent',
      sessionId: 'session-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
    };

    const { value } = restorePIITokensForToolExecution(session, tokenized, {
      piiAccess: 'original',
      auditContext,
    });

    expect(value).toBe(input);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('pii_plaintext_dispensed');
    expect(events[0].data.toolName).toBe('crm_lookup');
    expect(events[0].data.entityType).toBe('ssn');
    expect(events[0].data.piiAccess).toBe('original');
    expect(typeof events[0].data.entityHash).toBe('string');
    expect((events[0].data.entityHash as string).length).toBe(64);
  });

  it('does NOT emit when piiAccess is not original', () => {
    const input = 'SSN: 123-45-6789';
    const { text: tokenized } = vault.tokenize(input);

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const auditContext: PIIAuditContext = {
      onTraceEvent: (e) => events.push(e),
      toolName: 'crm_lookup',
      agentId: 'test-agent',
    };

    restorePIITokensForToolExecution(session, tokenized, {
      piiAccess: 'tools',
      auditContext,
    });

    expect(events).toHaveLength(0);
  });

  it('does NOT emit when auditContext is not provided', () => {
    const input = 'SSN: 123-45-6789';
    const { text: tokenized } = vault.tokenize(input);

    // No auditContext — should work without emitting
    const { dispensedTokens } = restorePIITokensForToolExecution(session, tokenized, {
      piiAccess: 'original',
    });

    // Tokens are still returned for backward compatibility
    expect(dispensedTokens.length).toBeGreaterThanOrEqual(1);
  });

  // F-5: Dedup across nested leaves — same token in multiple positions → 1 event
  it('deduplicates dispensedTokens across nested leaves (F-5)', () => {
    const { text: tokenizedSSN, tokens } = vault.tokenize('SSN: 123-45-6789');
    expect(tokens).toHaveLength(1);

    // Same tokenized SSN appears in two different leaves
    const nestedInput = {
      primary: tokenizedSSN,
      secondary: tokenizedSSN,
    };

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const auditContext: PIIAuditContext = {
      onTraceEvent: (e) => events.push(e),
      toolName: 'crm_lookup',
      agentId: 'test-agent',
      sessionId: 'session-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
    };

    const { value, dispensedTokens } = restorePIITokensForToolExecution(session, nestedInput, {
      piiAccess: 'original',
      auditContext,
    });

    const result = value as Record<string, unknown>;
    expect(result.primary).toBe('SSN: 123-45-6789');
    expect(result.secondary).toBe('SSN: 123-45-6789');

    // dispensedTokens may contain duplicates (one per leaf)
    expect(dispensedTokens.length).toBe(2);

    // But audit events should be deduplicated — only 1 event per unique token
    const dispensedEvents = events.filter((e) => e.type === 'pii_plaintext_dispensed');
    expect(dispensedEvents).toHaveLength(1);
    expect(dispensedEvents[0].data.entityType).toBe('ssn');
  });

  // F-10: tenantId sentinel when empty
  it('uses __internal__ sentinel when tenantId is empty (F-10)', () => {
    const emptyTenantSession = {
      ...session,
      tenantId: '',
    } as Partial<RuntimeSession> as RuntimeSession;

    const input = 'SSN: 123-45-6789';
    const { text: tokenized } = vault.tokenize(input);

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const auditContext: PIIAuditContext = {
      onTraceEvent: (e) => events.push(e),
      toolName: 'crm_lookup',
      agentId: 'test-agent',
      sessionId: 'session-1',
      tenantId: '',
      projectId: 'project-1',
    };

    restorePIITokensForToolExecution(emptyTenantSession, tokenized, {
      piiAccess: 'original',
      auditContext,
    });

    // Should emit pii_audit_missing_tenant warning THEN pii_plaintext_dispensed
    const warningEvents = events.filter((e) => e.type === 'pii_audit_missing_tenant');
    expect(warningEvents).toHaveLength(1);

    const dispensedEvents = events.filter((e) => e.type === 'pii_plaintext_dispensed');
    expect(dispensedEvents).toHaveLength(1);
    expect(dispensedEvents[0].data.tenantId).toBe('__internal__');
  });
});

// ---------------------------------------------------------------------------
// F-2: Pause/resume vault round-trip for 'original' consumer
// ---------------------------------------------------------------------------

describe('F-2: Serialize/deserialize vault — original consumer round-trip', () => {
  it('serialize → deserialize → renderForConsumer(original) returns plaintext', () => {
    const vault = new PIIVault();
    const input = 'SSN: 123-45-6789, Phone: 555-867-5309';
    const { text: tokenized } = vault.tokenize(input);

    // Serialize and deserialize
    const json = vault.serialize();
    const restored = PIIVault.deserialize(json);

    // The restored vault should resolve 'original' to plaintext
    const result = restored.renderForConsumer(tokenized, 'original');
    expect(result).toBe(input);
  });

  it('deserialized vault preserves token IDs for renderForConsumerWithTrace', () => {
    const vault = new PIIVault();
    const { text: tokenized, tokens } = vault.tokenize('SSN: 123-45-6789');
    expect(tokens).toHaveLength(1);
    const originalTokenId = tokens[0].id;

    const json = vault.serialize();
    const restored = PIIVault.deserialize(json);

    const { text, renderedTokens } = restored.renderForConsumerWithTrace(tokenized, 'original');
    expect(text).toBe('SSN: 123-45-6789');
    expect(renderedTokens).toHaveLength(1);
    expect(renderedTokens[0].id).toBe(originalTokenId);
    expect(renderedTokens[0].type).toBe('ssn');
    expect(renderedTokens[0].original).toBe('123-45-6789');
  });

  it('restorePIITokensForToolExecution on deserialized vault returns correct dispensedTokens', () => {
    const vault = new PIIVault();
    const { text: tokenized, tokens } = vault.tokenize('SSN: 123-45-6789');
    expect(tokens).toHaveLength(1);

    const json = vault.serialize();
    const restored = PIIVault.deserialize(json);

    const session = {
      piiVault: restored,
      piiPatternConfigs: undefined,
    } as Partial<RuntimeSession> as RuntimeSession;

    const { value, dispensedTokens } = restorePIITokensForToolExecution(session, tokenized, {
      piiAccess: 'original',
    });
    expect(value).toBe('SSN: 123-45-6789');
    expect(dispensedTokens).toHaveLength(1);
    expect(dispensedTokens[0].type).toBe('ssn');
    expect(dispensedTokens[0].original).toBe('123-45-6789');
  });
});

// ─── F-6: applyMask preset verification ────────────────────────────────────

describe('PII Vault Boundary — applyMask mask style presets (F-6)', () => {
  it('full mask: showLast=0 produces ***-**-**** for SSN (AC-F6.1)', () => {
    const result = applyMask('123-45-6789', { showFirst: 0, showLast: 0, maskChar: '*' }, 'ssn');
    expect(result).toBe('***********');
  });

  it('last-4-visible: showLast=4 produces *******6789 for SSN (AC-F6.3)', () => {
    const result = applyMask('123-45-6789', { showFirst: 0, showLast: 4, maskChar: '*' }, 'ssn');
    expect(result).toBe('*******6789');
  });

  it('full mask for credit card: showLast=0 masks all digits', () => {
    const result = applyMask(
      '4111-1111-1111-1111',
      { showFirst: 0, showLast: 0, maskChar: '*' },
      'credit_card',
    );
    expect(result).toBe('*******************');
  });

  it('last-4-visible for credit card: showLast=4 reveals last 4', () => {
    const result = applyMask(
      '4111-1111-1111-1111',
      { showFirst: 0, showLast: 4, maskChar: '*' },
      'credit_card',
    );
    expect(result).toBe('***************1111');
  });

  it('custom mask: showFirst=2, showLast=3 reveals prefix and suffix', () => {
    const result = applyMask('123-45-6789', { showFirst: 2, showLast: 3, maskChar: '#' }, 'ssn');
    expect(result).toBe('12######789');
  });

  it('first-4-visible: showFirst=4 produces 4111*************** for credit card (F-6 follow-up)', () => {
    const result = applyMask(
      '4111-1111-1111-1111',
      { showFirst: 4, showLast: 0, maskChar: '*' },
      'credit_card',
    );
    expect(result).toBe('4111***************');
  });

  it('first-4-visible for IBAN-style prefix: showFirst=4 reveals country+check', () => {
    const result = applyMask('GB82WEST12345698765432', {
      showFirst: 4,
      showLast: 0,
      maskChar: '*',
    });
    expect(result).toBe('GB82******************');
  });

  it('returns value unchanged when showFirst + showLast >= length', () => {
    const result = applyMask('AB', { showFirst: 1, showLast: 1, maskChar: '*' });
    expect(result).toBe('AB');
  });
});

// ─── F-11: Pattern-override suppression warning ────────────────────────────

describe('PII Vault Boundary — pattern-override suppression warning (F-11)', () => {
  let vault: PIIVault;

  beforeEach(() => {
    vault = new PIIVault();
  });

  it('emits pii_pattern_override_suppressed_original when pattern forces non-original mode (AC-F11.1)', () => {
    const { text: tokenized } = vault.tokenize('SSN: 123-45-6789');
    const patternConfigs: PIIPatternConfig[] = [
      {
        patternName: 'ssn',
        defaultRenderMode: 'redacted',
        consumerAccess: [{ consumer: 'original', renderMode: 'redacted' }],
      },
    ];

    const session = {
      piiVault: vault,
      piiPatternConfigs: patternConfigs,
    } as Partial<RuntimeSession> as RuntimeSession;

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const auditContext: PIIAuditContext = {
      onTraceEvent: (event) => events.push(event),
      toolName: 'crm_lookup',
      agentId: 'agent-1',
      sessionId: 'session-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
    };

    restorePIITokensForToolExecution(session, tokenized, {
      piiAccess: 'original',
      auditContext,
    });

    const suppressionEvents = events.filter(
      (e) => e.type === 'pii_pattern_override_suppressed_original',
    );
    expect(suppressionEvents).toHaveLength(1);
    expect(suppressionEvents[0].data.toolName).toBe('crm_lookup');
    expect(suppressionEvents[0].data.entityType).toBe('ssn');
    expect(suppressionEvents[0].data.requestedMode).toBe('original');
    expect(suppressionEvents[0].data.actualMode).toBe('redacted');
  });

  it('does NOT emit suppression warning when no pattern override exists (AC-F11.2)', () => {
    const { text: tokenized } = vault.tokenize('SSN: 123-45-6789');

    const session = {
      piiVault: vault,
      piiPatternConfigs: undefined,
    } as Partial<RuntimeSession> as RuntimeSession;

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const auditContext: PIIAuditContext = {
      onTraceEvent: (event) => events.push(event),
      toolName: 'crm_lookup',
      sessionId: 'session-1',
      tenantId: 'tenant-1',
    };

    restorePIITokensForToolExecution(session, tokenized, {
      piiAccess: 'original',
      auditContext,
    });

    const suppressionEvents = events.filter(
      (e) => e.type === 'pii_pattern_override_suppressed_original',
    );
    expect(suppressionEvents).toHaveLength(0);
  });

  it('does NOT emit suppression when piiAccess is not original', () => {
    const { text: tokenized } = vault.tokenize('SSN: 123-45-6789');
    const patternConfigs: PIIPatternConfig[] = [
      {
        patternName: 'ssn',
        defaultRenderMode: 'redacted',
        consumerAccess: [{ consumer: 'tools', renderMode: 'masked' }],
      },
    ];

    const session = {
      piiVault: vault,
      piiPatternConfigs: patternConfigs,
    } as Partial<RuntimeSession> as RuntimeSession;

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const auditContext: PIIAuditContext = {
      onTraceEvent: (event) => events.push(event),
      toolName: 'crm_lookup',
      sessionId: 'session-1',
      tenantId: 'tenant-1',
    };

    restorePIITokensForToolExecution(session, tokenized, {
      piiAccess: 'tools',
      auditContext,
    });

    const suppressionEvents = events.filter(
      (e) => e.type === 'pii_pattern_override_suppressed_original',
    );
    expect(suppressionEvents).toHaveLength(0);
  });
});
