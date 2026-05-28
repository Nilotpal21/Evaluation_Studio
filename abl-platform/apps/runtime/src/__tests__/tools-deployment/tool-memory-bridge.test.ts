/**
 * Tool Memory Bridge Tests
 *
 * Tests the imperative memory API (get_content/set_content/delete_content)
 * that sandbox/lambda tools use to access memory. Validates:
 * - Scope auto-resolution from MEMORY declarations
 * - Access enforcement (read-only keys throw on write)
 * - Undeclared key errors
 * - Legacy wrapper format { data: { content: value } }
 * - Routing to correct store (session, user, project)
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { InMemoryFactStore } from '@abl/compiler/platform/stores/fact-store.js';
import type { MemoryConfig } from '@abl/compiler/platform/ir/schema.js';
import { ToolMemoryBridge } from '../../services/execution/tool-memory-bridge.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createFactStore(): InMemoryFactStore {
  return new InMemoryFactStore({ type: 'memory' });
}

function makeMemoryConfig(overrides?: Partial<MemoryConfig>): MemoryConfig {
  return {
    session: [],
    persistent: [],
    remember: [],
    recall: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// get_content
// ---------------------------------------------------------------------------

describe('ToolMemoryBridge: get_content', () => {
  let userStore: InMemoryFactStore;
  let projectStore: InMemoryFactStore;

  beforeEach(() => {
    userStore = createFactStore();
    projectStore = createFactStore();
  });

  afterEach(() => {
    userStore.stop();
    projectStore.stop();
  });

  test('reads session var from session values', async () => {
    const sessionValues: Record<string, unknown> = { current_step: 'greeting' };
    const memory = makeMemoryConfig({
      session: [{ name: 'current_step' }],
    });

    const bridge = new ToolMemoryBridge({
      memory,
      sessionValues,
      userFactStore: userStore,
      projectFactStore: projectStore,
      agentName: 'TestAgent',
      sessionId: 'sess-1',
    });

    const result = await bridge.get_content('current_step');
    expect(result).toEqual({ data: { content: 'greeting' } });
  });

  test('reads user-scoped persistent from user FactStore', async () => {
    await userStore.set({
      key: 'user.prefs',
      value: { theme: 'dark' },
      source: { type: 'agent' },
    });

    const memory = makeMemoryConfig({
      persistent: [{ path: 'user.prefs', scope: 'user', access: 'readwrite', type: 'object' }],
    });

    const bridge = new ToolMemoryBridge({
      memory,
      sessionValues: {},
      userFactStore: userStore,
      projectFactStore: projectStore,
      agentName: 'TestAgent',
      sessionId: 'sess-1',
    });

    const result = await bridge.get_content('user.prefs');
    expect(result).toEqual({ data: { content: { theme: 'dark' } } });
  });

  test('reads project-scoped persistent from project FactStore', async () => {
    await projectStore.set({
      key: 'global_config',
      value: { feature_flag: true },
      source: { type: 'system' },
    });

    const memory = makeMemoryConfig({
      persistent: [{ path: 'global_config', scope: 'project', access: 'read', type: 'object' }],
    });

    const bridge = new ToolMemoryBridge({
      memory,
      sessionValues: {},
      userFactStore: userStore,
      projectFactStore: projectStore,
      agentName: 'TestAgent',
      sessionId: 'sess-1',
    });

    const result = await bridge.get_content('global_config');
    expect(result).toEqual({ data: { content: { feature_flag: true } } });
  });

  test('returns null content for non-existent persistent key', async () => {
    const memory = makeMemoryConfig({
      persistent: [{ path: 'missing_key', scope: 'user', access: 'read' }],
    });

    const bridge = new ToolMemoryBridge({
      memory,
      sessionValues: {},
      userFactStore: userStore,
      projectFactStore: projectStore,
      agentName: 'TestAgent',
      sessionId: 'sess-1',
    });

    const result = await bridge.get_content('missing_key');
    expect(result).toEqual({ data: { content: null } });
  });

  test('throws for undeclared key', async () => {
    const memory = makeMemoryConfig();
    const bridge = new ToolMemoryBridge({
      memory,
      sessionValues: {},
      userFactStore: userStore,
      projectFactStore: projectStore,
      agentName: 'TestAgent',
      sessionId: 'sess-1',
    });

    await expect(bridge.get_content('undeclared_key')).rejects.toThrow(
      "Key 'undeclared_key' not declared in MEMORY section",
    );
  });
});

// ---------------------------------------------------------------------------
// set_content
// ---------------------------------------------------------------------------

describe('ToolMemoryBridge: set_content', () => {
  let userStore: InMemoryFactStore;
  let projectStore: InMemoryFactStore;

  beforeEach(() => {
    userStore = createFactStore();
    projectStore = createFactStore();
  });

  afterEach(() => {
    userStore.stop();
    projectStore.stop();
  });

  test('writes session var to session values', async () => {
    const sessionValues: Record<string, unknown> = {};
    const memory = makeMemoryConfig({
      session: [{ name: 'current_step' }],
    });

    const bridge = new ToolMemoryBridge({
      memory,
      sessionValues,
      userFactStore: userStore,
      projectFactStore: projectStore,
      agentName: 'TestAgent',
      sessionId: 'sess-1',
    });

    await bridge.set_content('current_step', 'confirmation');
    expect(sessionValues.current_step).toEqual('confirmation');
  });

  test('writes user-scoped persistent to user FactStore', async () => {
    const memory = makeMemoryConfig({
      persistent: [{ path: 'user.message', scope: 'user', access: 'readwrite' }],
    });

    const bridge = new ToolMemoryBridge({
      memory,
      sessionValues: {},
      userFactStore: userStore,
      projectFactStore: projectStore,
      agentName: 'TestAgent',
      sessionId: 'sess-1',
    });

    await bridge.set_content('user.message', { msg: 'Password reset successful' });

    const fact = await userStore.get({ key: 'user.message' });
    expect(fact).not.toBeNull();
    expect(fact!.value).toEqual({ msg: 'Password reset successful' });
  });

  test('records tool-derived memory provenance with the active agent and session', async () => {
    const memory = makeMemoryConfig({
      persistent: [{ path: 'user.last_tool_result', scope: 'user', access: 'readwrite' }],
    });

    const bridge = new ToolMemoryBridge({
      memory,
      sessionValues: {},
      userFactStore: userStore,
      projectFactStore: projectStore,
      agentName: 'BillingAgent',
      sessionId: 'sess-contact-42',
    });

    await bridge.set_content('user.last_tool_result', {
      invoiceId: 'inv-42',
      status: 'paid',
    });

    const fact = await userStore.get({ key: 'user.last_tool_result' });
    expect(fact).not.toBeNull();
    expect(fact!.source).toEqual({
      type: 'agent',
      agentName: 'BillingAgent',
      sessionId: 'sess-contact-42',
    });
  });

  test('writes project-scoped persistent to project FactStore', async () => {
    const memory = makeMemoryConfig({
      persistent: [{ path: 'shared_counter', scope: 'project', access: 'readwrite' }],
    });

    const bridge = new ToolMemoryBridge({
      memory,
      sessionValues: {},
      userFactStore: userStore,
      projectFactStore: projectStore,
      agentName: 'TestAgent',
      sessionId: 'sess-1',
    });

    await bridge.set_content('shared_counter', 42);

    const fact = await projectStore.get({ key: 'shared_counter' });
    expect(fact).not.toBeNull();
    expect(fact!.value).toEqual(42);
  });

  test('throws for read-only key', async () => {
    const memory = makeMemoryConfig({
      persistent: [{ path: 'global_config', scope: 'project', access: 'read' }],
    });

    const bridge = new ToolMemoryBridge({
      memory,
      sessionValues: {},
      userFactStore: userStore,
      projectFactStore: projectStore,
      agentName: 'TestAgent',
      sessionId: 'sess-1',
    });

    await expect(bridge.set_content('global_config', 'new_value')).rejects.toThrow(
      "Key 'global_config' is read-only",
    );
  });

  test('throws for undeclared key', async () => {
    const memory = makeMemoryConfig();
    const bridge = new ToolMemoryBridge({
      memory,
      sessionValues: {},
      userFactStore: userStore,
      projectFactStore: projectStore,
      agentName: 'TestAgent',
      sessionId: 'sess-1',
    });

    await expect(bridge.set_content('unknown', 'value')).rejects.toThrow(
      "Key 'unknown' not declared in MEMORY section",
    );
  });
});

// ---------------------------------------------------------------------------
// delete_content
// ---------------------------------------------------------------------------

describe('ToolMemoryBridge: delete_content', () => {
  let userStore: InMemoryFactStore;
  let projectStore: InMemoryFactStore;

  beforeEach(() => {
    userStore = createFactStore();
    projectStore = createFactStore();
  });

  afterEach(() => {
    userStore.stop();
    projectStore.stop();
  });

  test('deletes session var', async () => {
    const sessionValues: Record<string, unknown> = { temp_data: 'foo' };
    const memory = makeMemoryConfig({
      session: [{ name: 'temp_data' }],
    });

    const bridge = new ToolMemoryBridge({
      memory,
      sessionValues,
      userFactStore: userStore,
      projectFactStore: projectStore,
      agentName: 'TestAgent',
      sessionId: 'sess-1',
    });

    const result = await bridge.delete_content('temp_data');
    expect(result).toBe(true);
    expect('temp_data' in sessionValues).toBe(false);
  });

  test('returns false when deleting non-existent session var', async () => {
    const sessionValues: Record<string, unknown> = {};
    const memory = makeMemoryConfig({
      session: [{ name: 'missing' }],
    });

    const bridge = new ToolMemoryBridge({
      memory,
      sessionValues,
      userFactStore: userStore,
      projectFactStore: projectStore,
      agentName: 'TestAgent',
      sessionId: 'sess-1',
    });

    const result = await bridge.delete_content('missing');
    expect(result).toBe(false);
  });

  test('deletes user-scoped persistent from user FactStore', async () => {
    await userStore.set({
      key: 'temp_results',
      value: 'data',
      source: { type: 'agent' },
    });

    const memory = makeMemoryConfig({
      persistent: [{ path: 'temp_results', scope: 'user', access: 'readwrite' }],
    });

    const bridge = new ToolMemoryBridge({
      memory,
      sessionValues: {},
      userFactStore: userStore,
      projectFactStore: projectStore,
      agentName: 'TestAgent',
      sessionId: 'sess-1',
    });

    const result = await bridge.delete_content('temp_results');
    expect(result).toBe(true);

    const fact = await userStore.get({ key: 'temp_results' });
    expect(fact).toBeNull();
  });

  test('throws for read-only key', async () => {
    const memory = makeMemoryConfig({
      persistent: [{ path: 'immutable_config', scope: 'project', access: 'read' }],
    });

    const bridge = new ToolMemoryBridge({
      memory,
      sessionValues: {},
      userFactStore: userStore,
      projectFactStore: projectStore,
      agentName: 'TestAgent',
      sessionId: 'sess-1',
    });

    await expect(bridge.delete_content('immutable_config')).rejects.toThrow(
      "Key 'immutable_config' is read-only",
    );
  });

  test('throws for undeclared key', async () => {
    const memory = makeMemoryConfig();
    const bridge = new ToolMemoryBridge({
      memory,
      sessionValues: {},
      userFactStore: userStore,
      projectFactStore: projectStore,
      agentName: 'TestAgent',
      sessionId: 'sess-1',
    });

    await expect(bridge.delete_content('nope')).rejects.toThrow(
      "Key 'nope' not declared in MEMORY section",
    );
  });
});

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

describe('ToolMemoryBridge: scope resolution', () => {
  let userStore: InMemoryFactStore;
  let projectStore: InMemoryFactStore;

  beforeEach(() => {
    userStore = createFactStore();
    projectStore = createFactStore();
  });

  afterEach(() => {
    userStore.stop();
    projectStore.stop();
  });

  test('resolves scope from declarations — session, user, project all in one bridge', async () => {
    await userStore.set({
      key: 'user.loyalty',
      value: 'gold',
      source: { type: 'agent' },
    });
    await projectStore.set({
      key: 'app.version',
      value: '2.0',
      source: { type: 'system' },
    });

    const sessionValues: Record<string, unknown> = { step: 'checkout' };
    const memory = makeMemoryConfig({
      session: [{ name: 'step' }],
      persistent: [
        { path: 'user.loyalty', scope: 'user', access: 'read' },
        { path: 'app.version', scope: 'project', access: 'read' },
      ],
    });

    const bridge = new ToolMemoryBridge({
      memory,
      sessionValues,
      userFactStore: userStore,
      projectFactStore: projectStore,
      agentName: 'TestAgent',
      sessionId: 'sess-1',
    });

    const stepResult = await bridge.get_content('step');
    expect(stepResult.data.content).toBe('checkout');

    const loyaltyResult = await bridge.get_content('user.loyalty');
    expect(loyaltyResult.data.content).toBe('gold');

    const versionResult = await bridge.get_content('app.version');
    expect(versionResult.data.content).toBe('2.0');
  });

  test('throws when no fact store available for scope', async () => {
    const memory = makeMemoryConfig({
      persistent: [{ path: 'needs_store', scope: 'project', access: 'read' }],
    });

    const bridge = new ToolMemoryBridge({
      memory,
      sessionValues: {},
      // No projectFactStore provided
      userFactStore: userStore,
      agentName: 'TestAgent',
      sessionId: 'sess-1',
    });

    await expect(bridge.get_content('needs_store')).rejects.toThrow(
      'No fact store available for project scope',
    );
  });

  test('write access allows readwrite paths', async () => {
    const memory = makeMemoryConfig({
      persistent: [{ path: 'rw_path', scope: 'user', access: 'readwrite' }],
    });

    const bridge = new ToolMemoryBridge({
      memory,
      sessionValues: {},
      userFactStore: userStore,
      projectFactStore: projectStore,
      agentName: 'TestAgent',
      sessionId: 'sess-1',
    });

    // Should not throw
    await bridge.set_content('rw_path', 'new_value');
    const fact = await userStore.get({ key: 'rw_path' });
    expect(fact).not.toBeNull();
  });

  test('write access allows write-only paths', async () => {
    const memory = makeMemoryConfig({
      persistent: [{ path: 'wo_path', scope: 'user', access: 'write' }],
    });

    const bridge = new ToolMemoryBridge({
      memory,
      sessionValues: {},
      userFactStore: userStore,
      projectFactStore: projectStore,
      agentName: 'TestAgent',
      sessionId: 'sess-1',
    });

    // Should not throw
    await bridge.set_content('wo_path', 'data');
    const fact = await userStore.get({ key: 'wo_path' });
    expect(fact).not.toBeNull();
  });
});
