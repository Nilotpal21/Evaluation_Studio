/**
 * agent-attribution — feedback target lookup.
 *
 * Uses the real InMemoryMessageStore (no platform mocks). Verifies:
 *  - Returns the message + resolved agentName when scope matches.
 *  - Returns null on missing / cross-scope / cross-session messageId.
 *  - Falls back to '' when no agentName metadata is present.
 */

import { describe, it, expect } from 'vitest';
import { InMemoryMessageStore } from '@abl/compiler/platform/stores/message-store.js';
import { resolveTarget } from '../agent-attribution.js';

const TENANT = 'tenant-A';
const PROJECT = 'proj-1';
const SESSION = 'sess-1';

async function seed(store: InMemoryMessageStore, params?: { agentName?: string }) {
  await store.addMessage({
    sessionId: SESSION,
    tenantId: TENANT,
    projectId: PROJECT,
    role: 'assistant',
    content: 'reply',
    channel: 'web_chat',
    traceId: 't-1',
    messageId: 'm-1',
    ...(params?.agentName ? { agentName: params.agentName } : {}),
  });
}

describe('resolveTarget', () => {
  it('returns message + agentName when scope matches', async () => {
    const store = new InMemoryMessageStore({ type: 'memory' });
    await seed(store, { agentName: 'orchestrator' });
    const result = await resolveTarget(store, TENANT, PROJECT, SESSION, 'm-1');
    expect(result?.message.id).toBe('m-1');
    expect(result?.agentName).toBe('orchestrator');
  });

  it('returns null when messageId is unknown', async () => {
    const store = new InMemoryMessageStore({ type: 'memory' });
    await seed(store);
    const result = await resolveTarget(store, TENANT, PROJECT, SESSION, 'unknown');
    expect(result).toBeNull();
  });

  it('returns null on tenant mismatch', async () => {
    const store = new InMemoryMessageStore({ type: 'memory' });
    await seed(store);
    expect(await resolveTarget(store, 't-other', PROJECT, SESSION, 'm-1')).toBeNull();
  });

  it('returns null on project mismatch', async () => {
    const store = new InMemoryMessageStore({ type: 'memory' });
    await seed(store);
    expect(await resolveTarget(store, TENANT, 'p-other', SESSION, 'm-1')).toBeNull();
  });

  it('returns null on session mismatch', async () => {
    const store = new InMemoryMessageStore({ type: 'memory' });
    await seed(store);
    expect(await resolveTarget(store, TENANT, PROJECT, 'sess-other', 'm-1')).toBeNull();
  });

  it('defaults agentName to empty string when metadata is absent', async () => {
    const store = new InMemoryMessageStore({ type: 'memory' });
    await seed(store);
    const result = await resolveTarget(store, TENANT, PROJECT, SESSION, 'm-1');
    expect(result?.agentName).toBe('');
  });
});
