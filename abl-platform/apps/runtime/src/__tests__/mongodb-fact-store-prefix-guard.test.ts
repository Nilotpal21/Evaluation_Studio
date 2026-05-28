/**
 * INT-4 (step 4-5) — Deep guard verification for `MongoDBFactStore`'s
 * reserved-prefix bypass.
 *
 * Asserts that:
 *   1. Direct calls to `MongoDBFactStore.set()` with a `wf:` key are REJECTED
 *      with `ReservedPrefixError` (code `RESERVED_PREFIX`).
 *   2. `FactStoreWorkflowAdapter.setWorkflowKey()` SUCCEEDS for the same
 *      logical key — the adapter is the only path that injects
 *      `__originAdapter='workflow'` into `_setInternal`.
 *   3. Workflow-scope facts are isolated by `workflowId`.
 *
 * Pattern: real `MongoMemoryServer` + real Mongoose connection. NO mocks of
 * platform components. No `vi.mock`, no DI substitutes. The fact model is
 * registered against the real `mongoose` global so its existing TTL index,
 * tenant-isolation plugin, and unique compound index all run.
 *
 * Note: file is named without `.integration.` suffix to match the
 * `env-vars-namespace-pagination.test.ts` pattern — the test still runs
 * a real MongoMemoryServer end-to-end against the project fact-store.
 */

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  MongoDBFactStore,
  PROJECT_SCOPE_USER_ID,
  ReservedPrefixError,
} from '../services/stores/mongodb-fact-store.js';
import { FactStoreWorkflowAdapter } from '../services/stores/fact-store-workflow-adapter.js';
import { buildWorkflowKey } from '../services/stores/workflow-memory-constants.js';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({
    binary: { version: process.env.MONGOMS_VERSION || '7.0.20' },
    instance: { launchTimeout: 30_000 },
  });
  await mongoose.connect(mongod.getUri());
});

afterEach(async () => {
  // Clear via the project-scope store's clear() — uses the public API,
  // avoids importing the Fact model directly.
  const sweep = new MongoDBFactStore(
    { type: 'mongodb' },
    'tA',
    PROJECT_SCOPE_USER_ID,
    'pA',
    'project',
  );
  await sweep.clear();
  const sweepUser = new MongoDBFactStore({ type: 'mongodb' }, 'tA', 'u-1', 'pA', 'user');
  await sweepUser.clear();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

describe('INT-4 — MongoDBFactStore reserved-prefix deep guard', () => {
  it('rejects direct set() of a wf: key with ReservedPrefixError', async () => {
    const store = new MongoDBFactStore(
      { type: 'mongodb' },
      'tA',
      PROJECT_SCOPE_USER_ID,
      'pA',
      'project',
    );

    let caught: unknown;
    try {
      await store.set({ key: 'wf:wf-123:lastCursor', value: { v: 1 } });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ReservedPrefixError);
    expect((caught as ReservedPrefixError).code).toBe('RESERVED_PREFIX');
    expect((caught as ReservedPrefixError).message).toContain('wf:wf-123:lastCursor');

    // Persistence side-effect — verify via the public read API. The adapter's
    // get path also routes through the project-scope fact-store, so this
    // verifies the throw happens BEFORE the upsert.
    const probe = await store.get({ key: 'wf:wf-123:lastCursor' });
    expect(probe).toBeNull();
  });

  it('still allows non-wf keys via direct set() (regression)', async () => {
    const store = new MongoDBFactStore(
      { type: 'mongodb' },
      'tA',
      PROJECT_SCOPE_USER_ID,
      'pA',
      'project',
    );

    const fact = await store.set({ key: 'project.config.theme', value: 'dark' });
    expect(fact.key).toBe('project.config.theme');
    expect(fact.value).toBe('dark');

    const stored = await store.get({ key: 'project.config.theme' });
    expect(stored?.value).toBe('dark');
  });
});

describe('INT-4 — FactStoreWorkflowAdapter happy path', () => {
  it('writes a wf: key via the adapter and reads it back through both surfaces', async () => {
    const adapter = new FactStoreWorkflowAdapter({ type: 'mongodb' }, 'tA', 'pA', 'wf-456');

    const written = await adapter.setWorkflowKey('lastCursor', { offset: 42 });
    expect(written.key).toBe(buildWorkflowKey('wf-456', 'lastCursor'));
    expect(written.value).toEqual({ offset: 42 });

    // Read via adapter
    const read = await adapter.getWorkflowKey('lastCursor');
    expect(read).not.toBeNull();
    expect(read?.value).toEqual({ offset: 42 });

    // Read via raw fact-store with the project-scope sentinel — should also see it
    const projectStore = new MongoDBFactStore(
      { type: 'mongodb' },
      'tA',
      PROJECT_SCOPE_USER_ID,
      'pA',
      'project',
    );
    const direct = await projectStore.get({ key: buildWorkflowKey('wf-456', 'lastCursor') });
    expect(direct).not.toBeNull();
    expect(direct?.value).toEqual({ offset: 42 });
  });

  it('isolates workflows from each other (different workflowIds yield distinct storage keys)', async () => {
    const a = new FactStoreWorkflowAdapter({ type: 'mongodb' }, 'tA', 'pA', 'wf-A');
    const b = new FactStoreWorkflowAdapter({ type: 'mongodb' }, 'tA', 'pA', 'wf-B');

    await a.setWorkflowKey('counter', 1);
    await b.setWorkflowKey('counter', 99);

    expect((await a.getWorkflowKey('counter'))?.value).toBe(1);
    expect((await b.getWorkflowKey('counter'))?.value).toBe(99);
  });

  it('deleteWorkflowKey returns false when no fact exists', async () => {
    const adapter = new FactStoreWorkflowAdapter({ type: 'mongodb' }, 'tA', 'pA', 'wf-789');
    expect(await adapter.deleteWorkflowKey('absent')).toBe(false);
  });

  it('deleteWorkflowKey tombstones the fact (Phase 1b — soft-delete behavior)', async () => {
    const adapter = new FactStoreWorkflowAdapter({ type: 'mongodb' }, 'tA', 'pA', 'wf-789');
    await adapter.setWorkflowKey('toBeDeleted', 'v');

    const deleted = await adapter.deleteWorkflowKey('toBeDeleted');
    expect(deleted).toBe(true);

    // Reads via the public API exclude tombstones — fact is invisible
    const after = await adapter.getWorkflowKey('toBeDeleted');
    expect(after).toBeNull();
  });

  it('subsequent setWorkflowKey resurrects a tombstoned key (Phase 1b — _setInternal $unset)', async () => {
    const adapter = new FactStoreWorkflowAdapter({ type: 'mongodb' }, 'tA', 'pA', 'wf-resurrect');
    await adapter.setWorkflowKey('cycle', 'before');
    await adapter.deleteWorkflowKey('cycle');
    expect(await adapter.getWorkflowKey('cycle')).toBeNull();

    // Rewrite — the upsert clears `isDeleted` / `deletedAt` via $unset
    const fresh = await adapter.setWorkflowKey('cycle', 'after');
    expect(fresh.value).toBe('after');

    const read = await adapter.getWorkflowKey('cycle');
    expect(read?.value).toBe('after');
  });

  it('returns false on a second delete (tombstone idempotency)', async () => {
    const adapter = new FactStoreWorkflowAdapter({ type: 'mongodb' }, 'tA', 'pA', 'wf-idem');
    await adapter.setWorkflowKey('once', 'v');

    expect(await adapter.deleteWorkflowKey('once')).toBe(true); // tombstoned
    expect(await adapter.deleteWorkflowKey('once')).toBe(false); // already a tombstone — no live fact to tombstone
  });
});
