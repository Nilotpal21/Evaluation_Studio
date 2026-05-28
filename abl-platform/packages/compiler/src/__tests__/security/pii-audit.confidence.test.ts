/**
 * INT-11: confidence + recognizer fields persist through PIIAuditLogger.
 *
 * Uses the existing DI test-double pattern (constructor-injected store
 * captures inserts) — no module mocks. Asserts both fields survive the
 * buffer → flush → store.insert pipeline.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PIIAuditLogger,
  type PIIAuditStore,
  type PIIAuditEntry,
} from '../../platform/security/pii-audit.js';

function createCapturingStore(): PIIAuditStore & {
  inserted: Array<PIIAuditEntry & { expireAt: Date }>;
} {
  const inserted: Array<PIIAuditEntry & { expireAt: Date }> = [];
  return {
    inserted,
    insert: vi.fn(async (entry: PIIAuditEntry & { expireAt: Date }) => {
      inserted.push(entry);
    }),
  };
}

describe('INT-11: confidence + recognizer DI capture through PIIAuditLogger', () => {
  let store: ReturnType<typeof createCapturingStore>;
  let logger: PIIAuditLogger;

  beforeEach(() => {
    vi.useFakeTimers();
    store = createCapturingStore();
    logger = new PIIAuditLogger(store);
  });

  afterEach(async () => {
    await logger.flush();
    vi.useRealTimers();
  });

  test('confidence + recognizer flow through to store.insert', async () => {
    logger.log({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      sessionId: 'session-1',
      tokenId: 'token-1',
      piiType: 'eu_iban',
      consumer: 'tools',
      action: 'tokenize',
      confidence: 0.95,
      recognizer: 'eu-iban',
    });

    await logger.flush();
    expect(store.insert).toHaveBeenCalledTimes(1);
    expect(store.inserted[0].confidence).toBe(0.95);
    expect(store.inserted[0].recognizer).toBe('eu-iban');
  });

  test('legacy entries (no confidence/recognizer) still insert with undefined fields', async () => {
    logger.log({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      sessionId: 'session-1',
      tokenId: 'token-1',
      piiType: 'email',
      consumer: 'llm',
      action: 'tokenize',
    });

    await logger.flush();
    expect(store.inserted[0].confidence).toBeUndefined();
    expect(store.inserted[0].recognizer).toBeUndefined();
    // Other fields still populated
    expect(store.inserted[0].piiType).toBe('email');
    expect(store.inserted[0].action).toBe('tokenize');
  });

  test('multiple buffered entries each preserve their own confidence/recognizer', async () => {
    logger.log({
      tenantId: 't',
      projectId: 'p',
      sessionId: 's',
      tokenId: 'tok-A',
      piiType: 'email',
      consumer: 'llm',
      action: 'tokenize',
      confidence: 1.0,
      recognizer: 'core-email',
    });
    logger.log({
      tenantId: 't',
      projectId: 'p',
      sessionId: 's',
      tokenId: 'tok-B',
      piiType: 'eu_iban',
      consumer: 'llm',
      action: 'tokenize',
      confidence: 0.85,
      recognizer: 'eu-iban',
    });
    logger.log({
      tenantId: 't',
      projectId: 'p',
      sessionId: 's',
      tokenId: 'tok-C',
      piiType: 'in_aadhaar',
      consumer: 'llm',
      action: 'tokenize',
      confidence: 0.7,
      recognizer: 'in-aadhaar',
    });

    await logger.flush();

    expect(store.inserted).toHaveLength(3);
    const byToken = new Map(store.inserted.map((e) => [e.tokenId, e]));
    expect(byToken.get('tok-A')?.recognizer).toBe('core-email');
    expect(byToken.get('tok-B')?.recognizer).toBe('eu-iban');
    expect(byToken.get('tok-C')?.recognizer).toBe('in-aadhaar');
    expect(byToken.get('tok-A')?.confidence).toBe(1.0);
    expect(byToken.get('tok-B')?.confidence).toBe(0.85);
    expect(byToken.get('tok-C')?.confidence).toBe(0.7);
  });
});
