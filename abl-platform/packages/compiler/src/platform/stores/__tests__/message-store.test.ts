/**
 * MessageStore — InMemoryMessageStore unit tests.
 *
 * Covers the new contract surface added for ABLP-1068:
 *  - `addMessage` honours `params.messageId` (binds transport responseMessageId → durable id).
 *  - `addMessage` honours `params.agentName` (surfaced as metadata.agentName).
 *  - `getMessageById(tenantId, projectId, sessionId, messageId)` enforces scope:
 *    returns the row when all four match, returns null otherwise.
 *  - Cross-scope lookups return null (per Resource Isolation invariant — 404, not 403).
 *
 * No platform mocks; the in-memory store is the contract target so this drives
 * the abstract interface design without any IO.
 */

import { describe, it, expect } from 'vitest';
import { InMemoryMessageStore } from '../message-store.js';

const TENANT = 'tenant-A';
const PROJECT = 'proj-1';
const SESSION = 'sess-1';

function makeStore() {
  return new InMemoryMessageStore({ type: 'memory' });
}

describe('InMemoryMessageStore — messageId / agentName / getMessageById', () => {
  it('honours an explicit messageId', async () => {
    const store = makeStore();
    const msg = await store.addMessage({
      sessionId: SESSION,
      tenantId: TENANT,
      projectId: PROJECT,
      role: 'assistant',
      content: 'hello',
      channel: 'web_chat',
      traceId: 'trace-1',
      messageId: 'custom-id-123',
    });
    expect(msg.id).toBe('custom-id-123');
  });

  it('generates a random id when messageId is omitted', async () => {
    const store = makeStore();
    const msg = await store.addMessage({
      sessionId: SESSION,
      tenantId: TENANT,
      projectId: PROJECT,
      role: 'assistant',
      content: 'hello',
      channel: 'web_chat',
      traceId: 'trace-1',
    });
    expect(msg.id).toBeTruthy();
    expect(msg.id).not.toBe('custom-id-123');
  });

  it('surfaces params.agentName in metadata', async () => {
    const store = makeStore();
    const msg = await store.addMessage({
      sessionId: SESSION,
      tenantId: TENANT,
      projectId: PROJECT,
      role: 'assistant',
      content: 'hello',
      channel: 'web_chat',
      traceId: 'trace-1',
      agentName: 'orchestrator',
    });
    expect(msg.metadata.agentName).toBe('orchestrator');
  });

  it('does not overwrite an existing metadata.agentName', async () => {
    const store = makeStore();
    const msg = await store.addMessage({
      sessionId: SESSION,
      tenantId: TENANT,
      projectId: PROJECT,
      role: 'assistant',
      content: 'hello',
      channel: 'web_chat',
      traceId: 'trace-1',
      agentName: 'param-agent',
      metadata: { agentName: 'metadata-agent', model: 'gpt-4' },
    });
    expect(msg.metadata.agentName).toBe('metadata-agent');
    expect(msg.metadata.model).toBe('gpt-4');
  });

  it('getMessageById returns the row when scope matches exactly', async () => {
    const store = makeStore();
    const msg = await store.addMessage({
      sessionId: SESSION,
      tenantId: TENANT,
      projectId: PROJECT,
      role: 'assistant',
      content: 'persisted',
      channel: 'web_chat',
      traceId: 'trace-1',
      messageId: 'm-1',
      agentName: 'orchestrator',
    });
    const found = await store.getMessageById(TENANT, PROJECT, SESSION, 'm-1');
    expect(found?.id).toBe(msg.id);
    expect(found?.content).toBe('persisted');
    expect(found?.metadata.agentName).toBe('orchestrator');
  });

  it('getMessageById returns null when messageId is unknown', async () => {
    const store = makeStore();
    await store.addMessage({
      sessionId: SESSION,
      tenantId: TENANT,
      projectId: PROJECT,
      role: 'assistant',
      content: 'persisted',
      channel: 'web_chat',
      traceId: 'trace-1',
      messageId: 'm-1',
    });
    const found = await store.getMessageById(TENANT, PROJECT, SESSION, 'm-unknown');
    expect(found).toBeNull();
  });

  it('getMessageById returns null on tenant mismatch (cross-scope)', async () => {
    const store = makeStore();
    await store.addMessage({
      sessionId: SESSION,
      tenantId: TENANT,
      projectId: PROJECT,
      role: 'assistant',
      content: 'persisted',
      channel: 'web_chat',
      traceId: 'trace-1',
      messageId: 'm-1',
    });
    const found = await store.getMessageById('tenant-OTHER', PROJECT, SESSION, 'm-1');
    expect(found).toBeNull();
  });

  it('getMessageById returns null on project mismatch (cross-scope)', async () => {
    const store = makeStore();
    await store.addMessage({
      sessionId: SESSION,
      tenantId: TENANT,
      projectId: PROJECT,
      role: 'assistant',
      content: 'persisted',
      channel: 'web_chat',
      traceId: 'trace-1',
      messageId: 'm-1',
    });
    const found = await store.getMessageById(TENANT, 'proj-OTHER', SESSION, 'm-1');
    expect(found).toBeNull();
  });

  it('getMessageById returns null on session mismatch (cross-scope)', async () => {
    const store = makeStore();
    await store.addMessage({
      sessionId: SESSION,
      tenantId: TENANT,
      projectId: PROJECT,
      role: 'assistant',
      content: 'persisted',
      channel: 'web_chat',
      traceId: 'trace-1',
      messageId: 'm-1',
    });
    const found = await store.getMessageById(TENANT, PROJECT, 'sess-OTHER', 'm-1');
    expect(found).toBeNull();
  });

  it('getMessageById finds user messages and assistant messages alike', async () => {
    const store = makeStore();
    await store.addMessage({
      sessionId: SESSION,
      tenantId: TENANT,
      projectId: PROJECT,
      role: 'user',
      content: 'q',
      channel: 'web_chat',
      traceId: 'trace-1',
      messageId: 'u-1',
    });
    await store.addMessage({
      sessionId: SESSION,
      tenantId: TENANT,
      projectId: PROJECT,
      role: 'assistant',
      content: 'a',
      channel: 'web_chat',
      traceId: 'trace-1',
      messageId: 'a-1',
    });
    const u = await store.getMessageById(TENANT, PROJECT, SESSION, 'u-1');
    const a = await store.getMessageById(TENANT, PROJECT, SESSION, 'a-1');
    expect(u?.role).toBe('user');
    expect(a?.role).toBe('assistant');
  });

  it('cleanup also drops the scope index', async () => {
    const store = makeStore();
    await store.addMessage({
      sessionId: SESSION,
      tenantId: TENANT,
      projectId: PROJECT,
      role: 'assistant',
      content: 'old',
      channel: 'web_chat',
      traceId: 'trace-1',
      messageId: 'm-old',
    });
    // Drop everything older than now + buffer — the message was just added so
    // its timestamp is strictly less than `now + 100ms` even on fast hardware.
    const cleaned = await store.cleanup(-100);
    expect(cleaned).toBeGreaterThan(0);
    const found = await store.getMessageById(TENANT, PROJECT, SESSION, 'm-old');
    expect(found).toBeNull();
  });
});
