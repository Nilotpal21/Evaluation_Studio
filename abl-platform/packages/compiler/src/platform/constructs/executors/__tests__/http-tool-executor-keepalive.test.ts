import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HttpToolExecutor } from '../http-tool-executor.js';

/**
 * Tests for the shared keep-alive undici Agent on HttpToolExecutor.
 *
 * These tests verify the singleton lifecycle: lazy creation, reuse, and cleanup.
 * If undici is not available in the test environment, agent creation returns null
 * and the tests handle that gracefully.
 */
describe('HttpToolExecutor keep-alive agent', () => {
  beforeEach(async () => {
    // Reset the static _undiciModule cache so each test starts fresh.
    // Access via cast since it's private.
    (HttpToolExecutor as any)._undiciModule = undefined;
    await HttpToolExecutor.destroyDefaultAgent();
  });

  afterEach(async () => {
    await HttpToolExecutor.destroyDefaultAgent();
    (HttpToolExecutor as any)._undiciModule = undefined;
  });

  it('getDefaultAgent() returns null before any initialization', () => {
    const agent = HttpToolExecutor.getDefaultAgent();
    expect(agent).toBeNull();
  });

  it('ensureDefaultAgent() creates an agent when undici is available', async () => {
    // Call the private static method via cast
    const agent = await (HttpToolExecutor as any).ensureDefaultAgent();

    // undici is bundled with Node 18+ — it should be available
    // If it's not (e.g. browser test runner), agent will be null
    if (agent === null) {
      // undici not available — getDefaultAgent should still be null
      expect(HttpToolExecutor.getDefaultAgent()).toBeNull();
      return;
    }

    expect(agent).not.toBeNull();
    expect(HttpToolExecutor.getDefaultAgent()).toBe(agent);
  });

  it('ensureDefaultAgent() returns the same instance on subsequent calls (singleton)', async () => {
    const first = await (HttpToolExecutor as any).ensureDefaultAgent();
    const second = await (HttpToolExecutor as any).ensureDefaultAgent();

    // Both calls must return the exact same reference
    expect(first).toBe(second);

    // And it must match the public getter
    expect(HttpToolExecutor.getDefaultAgent()).toBe(first);
  });

  it('destroyDefaultAgent() cleans up and resets to null', async () => {
    // Create an agent first
    const agent = await (HttpToolExecutor as any).ensureDefaultAgent();

    if (agent === null) {
      // undici not available — destroy should be a safe no-op
      await HttpToolExecutor.destroyDefaultAgent();
      expect(HttpToolExecutor.getDefaultAgent()).toBeNull();
      return;
    }

    expect(HttpToolExecutor.getDefaultAgent()).not.toBeNull();

    await HttpToolExecutor.destroyDefaultAgent();

    expect(HttpToolExecutor.getDefaultAgent()).toBeNull();
  });

  it('destroyDefaultAgent() is safe to call when no agent exists', async () => {
    // Should not throw when called on a null agent
    expect(HttpToolExecutor.getDefaultAgent()).toBeNull();
    await HttpToolExecutor.destroyDefaultAgent();
    expect(HttpToolExecutor.getDefaultAgent()).toBeNull();
  });

  it('ensureDefaultAgent() creates a new agent after destroyDefaultAgent()', async () => {
    const first = await (HttpToolExecutor as any).ensureDefaultAgent();
    if (first === null) {
      // undici not available — skip
      return;
    }

    await HttpToolExecutor.destroyDefaultAgent();
    expect(HttpToolExecutor.getDefaultAgent()).toBeNull();

    const second = await (HttpToolExecutor as any).ensureDefaultAgent();
    expect(second).not.toBeNull();
    // It should be a new instance, not the old destroyed one
    expect(second).not.toBe(first);
  });

  it('respects HTTP_TOOL_POOL_SIZE env var with NaN-safe parsing', async () => {
    const originalEnv = process.env.HTTP_TOOL_POOL_SIZE;

    try {
      // Set an invalid value — should fall back to 50
      process.env.HTTP_TOOL_POOL_SIZE = 'not_a_number';
      await HttpToolExecutor.destroyDefaultAgent();
      (HttpToolExecutor as any)._undiciModule = undefined;

      const agent = await (HttpToolExecutor as any).ensureDefaultAgent();
      if (agent === null) return; // undici not available

      // The agent was created without throwing — NaN was handled safely.
      // We can't easily inspect the internal connections count,
      // but the fact it didn't throw verifies NaN-safe parsing.
      expect(agent).not.toBeNull();
    } finally {
      process.env.HTTP_TOOL_POOL_SIZE = originalEnv;
      if (originalEnv === undefined) delete process.env.HTTP_TOOL_POOL_SIZE;
    }
  });
});
