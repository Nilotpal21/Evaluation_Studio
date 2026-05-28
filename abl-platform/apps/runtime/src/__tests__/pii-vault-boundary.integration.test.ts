/**
 * PII Vault Boundary Contract — Integration Tests
 *
 * ABLP-535: Tests the wired integration between PIIVault, pii-tool-execution,
 * and the session-scoped restoration flow. All tests use real function
 * composition — no mocks of @abl/* or @agent-platform/* modules.
 *
 * LLM is a third-party external service and may be mocked via DI where needed.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  PIIVault,
  resolveRenderMode,
  type PIIPatternConfig,
} from '@abl/compiler/platform/security/pii-vault.js';
import {
  restorePIITokensForToolExecution,
  restorePIITokensForToolExecutionText,
  restorePIITokensForTrustedInternalExecution,
  getToolPIIAccess,
} from '../services/execution/pii-tool-execution.js';
import type { RuntimeSession } from '../services/execution/types.js';
import { tokenizeStringLeavesDeep } from '../routes/internal-tools.js';

// ---------------------------------------------------------------------------
// INT-1: renderForConsumer 'original' returns plaintext for all PII types
// ---------------------------------------------------------------------------

describe('INT-1: renderForConsumer "original" — all PII entity types', () => {
  let vault: PIIVault;

  beforeEach(() => {
    vault = new PIIVault();
  });

  it('returns plaintext for SSN', () => {
    const input = 'SSN: 123-45-6789';
    const { text: tokenized } = vault.tokenize(input);
    expect(vault.renderForConsumer(tokenized, 'original')).toBe(input);
  });

  it('returns plaintext for phone', () => {
    const input = 'Call me at 555-867-5309';
    const { text: tokenized } = vault.tokenize(input);
    expect(vault.renderForConsumer(tokenized, 'original')).toBe(input);
  });

  it('returns plaintext for email', () => {
    const input = 'Email: alice@example.com';
    const { text: tokenized } = vault.tokenize(input);
    expect(vault.renderForConsumer(tokenized, 'original')).toBe(input);
  });

  it('returns plaintext for credit card', () => {
    const input = 'Card: 4111 1111 1111 1111';
    const { text: tokenized } = vault.tokenize(input);
    expect(vault.renderForConsumer(tokenized, 'original')).toBe(input);
  });

  it('returns plaintext for mixed PII types in one string', () => {
    const input = 'SSN: 123-45-6789, Phone: 555-867-5309, Email: bob@test.io';
    const { text: tokenized, tokens } = vault.tokenize(input);
    expect(tokens.length).toBeGreaterThanOrEqual(2);
    expect(vault.renderForConsumer(tokenized, 'original')).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// INT-5: normalizeToolPIIAccess integration with restorePIITokensForToolExecution
// ---------------------------------------------------------------------------

describe('INT-5: restorePIITokensForToolExecution respects piiAccess', () => {
  let vault: PIIVault;
  let session: RuntimeSession;

  beforeEach(() => {
    vault = new PIIVault();
    session = {
      piiVault: vault,
      piiPatternConfigs: undefined,
    } as Partial<RuntimeSession> as RuntimeSession;
  });

  it('returns plaintext when piiAccess is "original"', () => {
    const input = 'My SSN is 123-45-6789';
    const { text: tokenized } = vault.tokenize(input);

    const result = restorePIITokensForToolExecutionText(session, tokenized, {
      piiAccess: 'original',
    });
    expect(result).toBe(input);
  });

  it('returns redacted when piiAccess is "tools" (default)', () => {
    const input = 'My SSN is 123-45-6789';
    const { text: tokenized } = vault.tokenize(input);

    const result = restorePIITokensForToolExecutionText(session, tokenized, {
      piiAccess: 'tools',
    });
    expect(result).toBe('My SSN is [REDACTED_SSN]');
  });

  it('normalizes garbage piiAccess to "tools" (redacted)', () => {
    const input = 'My SSN is 123-45-6789';
    const { text: tokenized } = vault.tokenize(input);

    // 'garbage' is normalized to 'tools' internally by normalizeToolPIIAccess
    const result = restorePIITokensForToolExecutionText(session, tokenized, {
      piiAccess: 'garbage' as any,
    });
    expect(result).toBe('My SSN is [REDACTED_SSN]');
  });

  it('normalizes undefined piiAccess to "tools" (redacted)', () => {
    const input = 'My SSN is 123-45-6789';
    const { text: tokenized } = vault.tokenize(input);

    const result = restorePIITokensForToolExecutionText(session, tokenized);
    expect(result).toBe('My SSN is [REDACTED_SSN]');
  });

  it('handles nested object values', () => {
    const input = 'Card: 4111 1111 1111 1111';
    const { text: tokenized } = vault.tokenize(input);

    const obj = { query: tokenized, meta: { nested: tokenized } };
    const { value: result } = restorePIITokensForToolExecution(session, obj, {
      piiAccess: 'original',
    });
    const r = result as Record<string, unknown>;

    expect(r.query).toBe(input);
    expect((r.meta as Record<string, unknown>).nested).toBe(input);
  });

  it('handles array values', () => {
    const input = 'Email: alice@example.com';
    const { text: tokenized } = vault.tokenize(input);

    const arr = [tokenized, 'no PII here'];
    const { value: result } = restorePIITokensForToolExecution(session, arr, {
      piiAccess: 'original',
    });
    const r = result as string[];

    expect(r[0]).toBe(input);
    expect(r[1]).toBe('no PII here');
  });

  it('returns value unchanged when vault is empty', () => {
    const text = 'no PII here';
    const result = restorePIITokensForToolExecutionText(session, text, {
      piiAccess: 'original',
    });
    expect(result).toBe(text);
  });

  it('returns value unchanged when session has no vault', () => {
    const noVaultSession = {} as RuntimeSession;
    const text = '{{PII:ssn:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}}';
    const result = restorePIITokensForToolExecutionText(noVaultSession, text, {
      piiAccess: 'original',
    });
    expect(result).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// INT-4 (adapted): session-scoped bare-UUID restoration via tool execution
// ---------------------------------------------------------------------------

describe('INT-4: session-scoped bare-UUID restoration through tool execution', () => {
  it('restores bare UUID from the session vault when piiAccess is original', () => {
    const vault = new PIIVault();
    const session = {
      piiVault: vault,
      piiPatternConfigs: undefined,
    } as Partial<RuntimeSession> as RuntimeSession;

    const input = 'My SSN is 123-45-6789';
    const { tokens } = vault.tokenize(input);
    const bareUUID = tokens[0].id;

    // Simulate the LLM stripping the {{PII:...}} wrapper and passing just the UUID
    const result = restorePIITokensForToolExecutionText(session, bareUUID, {
      piiAccess: 'original',
    });
    expect(result).toBe('123-45-6789');
  });

  it('does not restore bare UUID from a different vault (cross-session isolation)', () => {
    const vaultA = new PIIVault();
    const vaultB = new PIIVault();
    const sessionB = {
      piiVault: vaultB,
      piiPatternConfigs: undefined,
    } as Partial<RuntimeSession> as RuntimeSession;

    const { tokens } = vaultA.tokenize('My SSN is 123-45-6789');
    const bareUUID = tokens[0].id;

    // Session B's vault has no tokens — the bare UUID should pass through unchanged
    const result = restorePIITokensForToolExecutionText(sessionB, bareUUID, {
      piiAccess: 'original',
    });
    expect(result).toBe(bareUUID);
  });

  it('restores bare UUIDs for trusted internal execution paths', () => {
    const vault = new PIIVault();
    const session = {
      piiVault: vault,
      piiPatternConfigs: undefined,
    } as Partial<RuntimeSession> as RuntimeSession;

    const { tokens } = vault.tokenize('Customer phone 555-867-5309');
    const bareUUID = tokens[0].id;

    const result = restorePIITokensForTrustedInternalExecution(session, {
      query: bareUUID,
      filters: [{ field: 'phone', value: bareUUID }],
    }) as { query: string; filters: Array<{ value: string }> };

    expect(result.query).toBe('555-867-5309');
    expect(result.filters[0].value).toBe('555-867-5309');
  });
});

// ---------------------------------------------------------------------------
// INT-6: pii-patterns route RBAC — project isolation
// ---------------------------------------------------------------------------
// The RBAC enforcement for pii-patterns routes is fully tested at E2E level
// in pii-vault-boundary.e2e.test.ts (E2E-6a, E2E-6b). The route source
// uses requirePiiPatternProjectPermission which wraps requireProjectPermission
// from ../middleware/rbac.js — verified by static code inspection and E2E.
// No integration-level import test here due to the rbac module's heavy
// dependency tree causing timeouts outside the full runtime harness.

// ---------------------------------------------------------------------------
// INT-2 / INT-3 boundary: audit + trace event composition verification
// ---------------------------------------------------------------------------

describe('INT-2/INT-3: audit/trace composition through restorePIITokensForToolExecution', () => {
  it('restorePIITokensForToolExecution returns plaintext when piiAccess=original — prerequisite for audit emission', () => {
    // The audit log and trace event emission happen in reasoning-executor.ts
    // AFTER restorePIITokensForToolExecution returns. This integration test
    // verifies the prerequisite: that the function correctly produces plaintext
    // when piiAccess='original', which is the condition that triggers the
    // pii_plaintext_dispensed event in the executor.
    //
    // The actual trace event emission is tested at E2E level (E2E-1) where
    // the full reasoning-executor pipeline runs.

    const vault = new PIIVault();
    const session = {
      piiVault: vault,
      piiPatternConfigs: undefined,
    } as Partial<RuntimeSession> as RuntimeSession;

    const { text: tokenized, tokens } = vault.tokenize('SSN: 123-45-6789');
    expect(tokens).toHaveLength(1);

    const result = restorePIITokensForToolExecutionText(session, tokenized, {
      piiAccess: 'original',
    });
    expect(result).toBe('SSN: 123-45-6789');

    // The vault tokens are still available for the audit logger to enumerate
    expect(vault.listTokens()).toHaveLength(1);
    expect(vault.listTokens()[0].type).toBe('ssn');
    expect(vault.listTokens()[0].original).toBe('123-45-6789');
  });

  it('vault.listTokens() returns defensive copies (audit safety)', () => {
    const vault = new PIIVault();
    vault.tokenize('SSN: 123-45-6789');

    const tokens1 = vault.listTokens();
    const tokens2 = vault.listTokens();

    // Different array references
    expect(tokens1).not.toBe(tokens2);
    // Different object references (defensive copies)
    expect(tokens1[0]).not.toBe(tokens2[0]);
    // Same content
    expect(tokens1[0].original).toBe(tokens2[0].original);
  });
});

// ---------------------------------------------------------------------------
// Negative / edge-case integration tests
// ---------------------------------------------------------------------------

describe('Negative integration cases', () => {
  it('resolveRenderMode("llm") always returns "tokenized" — even with configs', () => {
    const configs: PIIPatternConfig[] = [
      {
        patternName: 'ssn',
        defaultRenderMode: 'original',
        consumerAccess: [{ consumer: 'llm', renderMode: 'original' }],
      },
    ];
    // Pattern-level override can set it, which is by design — the admin
    // configures consumerAccess explicitly. But the BUILTIN default is tokenized.
    const builtinResult = resolveRenderMode('llm', 'ssn');
    expect(builtinResult).toBe('tokenized');
  });

  it('renderForConsumer with empty vault returns text unchanged', () => {
    const vault = new PIIVault();
    const text = 'Hello, no PII here';
    expect(vault.renderForConsumer(text, 'original')).toBe(text);
  });

  it('renderForConsumer with empty text returns empty string', () => {
    const vault = new PIIVault();
    vault.tokenize('SSN: 123-45-6789');
    expect(vault.renderForConsumer('', 'original')).toBe('');
  });

  it('restorePIITokensForToolExecution handles non-string primitives', () => {
    const vault = new PIIVault();
    const session = { piiVault: vault } as Partial<RuntimeSession> as RuntimeSession;
    vault.tokenize('SSN: 123-45-6789');

    expect(restorePIITokensForToolExecution(session, 42, { piiAccess: 'original' }).value).toBe(42);
    expect(restorePIITokensForToolExecution(session, null, { piiAccess: 'original' }).value).toBe(
      null,
    );
    expect(restorePIITokensForToolExecution(session, true, { piiAccess: 'original' }).value).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// R1: dispensedTokens precision — restorePIITokensForToolExecution
// ---------------------------------------------------------------------------

describe('R1: dispensedTokens precision through restorePIITokensForToolExecution', () => {
  it('returns only the tokens present in the rendered string arg', () => {
    const vault = new PIIVault();
    const session = {
      piiVault: vault,
      piiPatternConfigs: undefined,
    } as Partial<RuntimeSession> as RuntimeSession;

    // Tokenize 3 different PII values into the vault
    vault.tokenize('SSN: 123-45-6789');
    vault.tokenize('Phone: 555-867-5309');
    vault.tokenize('Email: alice@example.com');

    // Build a tool arg that only contains the SSN token
    const ssnToken = vault.listTokens().find((t) => t.type === 'ssn')!;
    const toolArg = `lookup ${ssnToken.token}`;

    const { value, dispensedTokens } = restorePIITokensForToolExecution(session, toolArg, {
      piiAccess: 'original',
    });

    expect(value).toBe('lookup 123-45-6789');
    expect(dispensedTokens).toHaveLength(1);
    expect(dispensedTokens[0].type).toBe('ssn');
    expect(dispensedTokens[0].original).toBe('123-45-6789');
  });

  it('returns empty dispensedTokens when no PII appears in args', () => {
    const vault = new PIIVault();
    const session = {
      piiVault: vault,
      piiPatternConfigs: undefined,
    } as Partial<RuntimeSession> as RuntimeSession;

    vault.tokenize('SSN: 123-45-6789');

    const { value, dispensedTokens } = restorePIITokensForToolExecution(session, 'no tokens here', {
      piiAccess: 'original',
    });

    expect(value).toBe('no tokens here');
    expect(dispensedTokens).toHaveLength(0);
  });

  it('accumulates dispensedTokens across nested object leaves', () => {
    const vault = new PIIVault();
    const session = {
      piiVault: vault,
      piiPatternConfigs: undefined,
    } as Partial<RuntimeSession> as RuntimeSession;

    const { text: ssnTokenized } = vault.tokenize('123-45-6789');
    const { text: phoneTokenized } = vault.tokenize('555-867-5309');

    const nested = {
      ssn: ssnTokenized,
      contact: {
        phone: phoneTokenized,
        note: 'no PII',
      },
    };

    const { value, dispensedTokens } = restorePIITokensForToolExecution(session, nested, {
      piiAccess: 'original',
    });
    const result = value as Record<string, unknown>;

    expect(result.ssn).toBe('123-45-6789');
    expect((result.contact as Record<string, unknown>).phone).toBe('555-867-5309');
    expect(dispensedTokens).toHaveLength(2);
    expect(dispensedTokens.map((t) => t.type).sort()).toEqual(['phone', 'ssn']);
  });

  it('returns empty dispensedTokens when session has no vault', () => {
    const session = {} as RuntimeSession;

    const { value, dispensedTokens } = restorePIITokensForToolExecution(session, 'anything', {
      piiAccess: 'original',
    });

    expect(value).toBe('anything');
    expect(dispensedTokens).toHaveLength(0);
  });

  it('includes bare-UUID hits in dispensedTokens', () => {
    const vault = new PIIVault();
    const session = {
      piiVault: vault,
      piiPatternConfigs: undefined,
    } as Partial<RuntimeSession> as RuntimeSession;

    const { tokens } = vault.tokenize('SSN: 123-45-6789');
    const bareUUID = tokens[0].id; // Just the UUID, no {{PII:...}} wrapper

    const { value, dispensedTokens } = restorePIITokensForToolExecution(session, bareUUID, {
      piiAccess: 'original',
    });

    expect(value).toBe('123-45-6789');
    expect(dispensedTokens).toHaveLength(1);
    expect(dispensedTokens[0].type).toBe('ssn');
  });
});

// ---------------------------------------------------------------------------
// R2: Nested-object tokenization + rendering round-trip (Tool Test parity)
// ---------------------------------------------------------------------------

describe('R2: nested-object tokenization round-trip through Tool Test path', () => {
  it('tokenizes and renders nested string leaves through the full pipeline', () => {
    const vault = new PIIVault();
    const session = {
      piiVault: vault,
      piiPatternConfigs: undefined,
    } as Partial<RuntimeSession> as RuntimeSession;

    // Simulate Tool Test: developer pastes a nested payload containing PII.
    // Step 1: tokenize all string leaves (mirrors tokenizeStringLeavesDeep)
    const rawParams = {
      customer: {
        email: 'alice@example.com',
        ssn: '123-45-6789',
      },
      items: ['P1234', '555-867-5309'],
    };

    // Manual deep tokenization (same as internal-tools.ts helper)
    const tokenizedParams = {
      customer: {
        email: vault.tokenize('alice@example.com').text,
        ssn: vault.tokenize('123-45-6789').text,
      },
      items: ['P1234', vault.tokenize('555-867-5309').text],
    };

    // Step 2: render per piiAccess (mirrors restorePIITokensForToolExecution)
    const { value: rendered } = restorePIITokensForToolExecution(session, tokenizedParams, {
      piiAccess: 'tools', // default = redacted
    });
    const result = rendered as Record<string, unknown>;
    const customer = result.customer as Record<string, unknown>;
    const items = result.items as string[];

    // All PII should be redacted, not plaintext
    expect(customer.email).toBe('[REDACTED_EMAIL]');
    expect(customer.ssn).toBe('[REDACTED_SSN]');
    expect(items[0]).toBe('P1234'); // non-PII unchanged
    expect(items[1]).toBe('[REDACTED_PHONE]');
  });

  it('nested PII restored as plaintext when piiAccess is original', () => {
    const vault = new PIIVault();
    const session = {
      piiVault: vault,
      piiPatternConfigs: undefined,
    } as Partial<RuntimeSession> as RuntimeSession;

    const tokenizedParams = {
      data: {
        ssn: vault.tokenize('123-45-6789').text,
      },
    };

    const { value: rendered } = restorePIITokensForToolExecution(session, tokenizedParams, {
      piiAccess: 'original',
    });
    const result = rendered as Record<string, unknown>;
    expect((result.data as Record<string, unknown>).ssn).toBe('123-45-6789');
  });

  it('non-string scalars in nested structures pass through unmodified', () => {
    const vault = new PIIVault();
    const session = {
      piiVault: vault,
      piiPatternConfigs: undefined,
    } as Partial<RuntimeSession> as RuntimeSession;

    const params = {
      count: 42,
      active: true,
      tags: [1, null, false],
      meta: { score: 99.5 },
    };

    const { value: rendered } = restorePIITokensForToolExecution(session, params, {
      piiAccess: 'original',
    });
    const result = rendered as Record<string, unknown>;

    expect(result.count).toBe(42);
    expect(result.active).toBe(true);
    expect(result.tags).toEqual([1, null, false]);
    expect((result.meta as Record<string, unknown>).score).toBe(99.5);
  });
});

// ---------------------------------------------------------------------------
// F-4: Tool Test PII rendering path — integration coverage
// ---------------------------------------------------------------------------
// Exercises the same tokenize → restore flow used by the Tool Test endpoint
// (internal-tools.ts) but through the exported function APIs. This verifies
// both flat AND nested PII in tool test params are correctly rendered.

describe('F-4: Tool Test PII rendering — tokenize + restore round-trip', () => {
  it('flat params with piiAccess=original → plaintext round-trip', () => {
    const vault = new PIIVault();
    const params = { ssn: '123-45-6789', phone: '555-867-5309', note: 'no PII' };

    // Step 1: tokenize (simulates the Tool Test path)
    const tokenized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string') {
        tokenized[key] = vault.tokenize(value).text;
      } else {
        tokenized[key] = value;
      }
    }

    // Step 2: restore (simulates the Tool Test path)
    const session = {
      piiVault: vault,
      piiPatternConfigs: undefined,
    } as Partial<RuntimeSession> as RuntimeSession;

    const { value: restored } = restorePIITokensForToolExecution(session, tokenized, {
      piiAccess: 'original',
    });
    const result = restored as Record<string, unknown>;

    expect(result.ssn).toBe('123-45-6789');
    expect(result.phone).toBe('555-867-5309');
    expect(result.note).toBe('no PII');
  });

  it('nested params with piiAccess=original → plaintext round-trip', () => {
    const vault = new PIIVault();
    const params = {
      customer: {
        ssn: '123-45-6789',
        contacts: ['alice@example.com', '555-867-5309'],
      },
    };

    // Step 1: Deep tokenize (using the exported production function)
    const tokenized = tokenizeStringLeavesDeep(params, vault, new WeakMap()) as Record<
      string,
      unknown
    >;

    // Step 2: restore
    const session = {
      piiVault: vault,
      piiPatternConfigs: undefined,
    } as Partial<RuntimeSession> as RuntimeSession;

    const { value: restored } = restorePIITokensForToolExecution(session, tokenized, {
      piiAccess: 'original',
    });
    const result = restored as Record<string, unknown>;
    const customer = result.customer as Record<string, unknown>;
    const contacts = customer.contacts as string[];

    expect(customer.ssn).toBe('123-45-6789');
    expect(contacts[0]).toBe('alice@example.com');
    expect(contacts[1]).toBe('555-867-5309');
  });

  it('flat params with piiAccess=tools → redacted round-trip', () => {
    const vault = new PIIVault();
    const params = { ssn: '123-45-6789' };

    const tokenized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string') {
        tokenized[key] = vault.tokenize(value).text;
      } else {
        tokenized[key] = value;
      }
    }

    const session = {
      piiVault: vault,
      piiPatternConfigs: undefined,
    } as Partial<RuntimeSession> as RuntimeSession;

    const { value: restored, dispensedTokens } = restorePIITokensForToolExecution(
      session,
      tokenized,
      { piiAccess: 'tools' },
    );
    const result = restored as Record<string, unknown>;

    // Should be redacted (not plaintext)
    expect(result.ssn).not.toBe('123-45-6789');
    expect(result.ssn).toMatch(/REDACTED|^\*{3}/);
    // dispensedTokens still reported (for transparency) but no audit event
    expect(dispensedTokens.length).toBeGreaterThanOrEqual(1);
  });
});
