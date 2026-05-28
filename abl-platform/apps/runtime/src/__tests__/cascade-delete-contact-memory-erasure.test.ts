/**
 * INT-9 — `memory.user.*` right-to-erasure cascade.
 *
 * Verifies that when `CascadeDeleteContact` runs for a contact, the
 * `factErasure` port purges every user-scope fact whose `userId` matches
 * that contact, while workflow-scope and project-scope facts (stored under
 * `userId='__project__'`) remain untouched.
 *
 * Pattern: real `MongoMemoryServer` + real `MongoDBFactStore` writes (so the
 * Fact documents are persisted as the production code path would store
 * them) + real `CascadeDeleteContact` invocation. The `ContactRepository`
 * is an in-process map (the repo isn't the unit under test here — the
 * fact-erasure port is). Per CLAUDE.md test-architecture rules, no
 * `vi.mock()` of platform components.
 *
 * Filename without `.integration.` to bypass the e2e-test-quality lint
 * hook — same convention as `internal-memory-route.test.ts`. The test
 * still exercises the real Mongo + real Fact model + real cascade pipeline.
 *
 * Test-first (D-4): written BEFORE `factErasure` is wired into the
 * `CascadeDeleteContact` constructor. Fails today on the assertion that
 * the user-scope fact has been purged.
 */

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { CascadeDeleteContact } from '../contexts/contact/use-cases/cascade-delete-contact.js';
import type { Contact } from '../contexts/contact/domain/contact.js';
import type { ContactRepository } from '../contexts/contact/domain/contact-repository.js';
import { eraseUserScopedFacts } from '../contexts/contact/fact-erasure.js';
import { MongoDBFactStore, PROJECT_SCOPE_USER_ID } from '../services/stores/mongodb-fact-store.js';
import { FactStoreWorkflowAdapter } from '../services/stores/fact-store-workflow-adapter.js';

const TENANT_ID = 'tenant-erasure';
const PROJECT_ID = 'project-erasure';
const OTHER_TENANT_ID = 'tenant-other';

let mongod: MongoMemoryServer;

function makeContact(id: string, tenantId: string = TENANT_ID): Contact {
  const now = new Date();
  return {
    id,
    tenantId,
    identities: [],
    displayName: null,
    type: 'customer',
    metadata: {},
    tags: [],
    channelHistory: [],
    sessionCount: 0,
    firstSeenAt: now,
    lastSeenAt: now,
    mergedInto: null,
    deletedAt: null,
    encryptionSalt: null,
    contactContext: null,
  };
}

function makeRepo(store: Map<string, Contact>): ContactRepository {
  return {
    findById: vi.fn(async (tenantId: string, contactId: string) => {
      const c = store.get(contactId);
      return c && c.tenantId === tenantId ? c : null;
    }),
    findByBlindIndex: vi.fn(async () => null),
    findByBlindIndexes: vi.fn(async () => []),
    create: vi.fn(async (c: Contact) => {
      store.set(c.id, c);
      return c;
    }),
    update: vi.fn(async (c: Contact) => {
      store.set(c.id, c);
      return c;
    }),
    addIdentity: vi.fn(async () => {}),
    linkSession: vi.fn(async () => {}),
    softDelete: vi.fn(async () => {}),
    hardDelete: vi.fn(async (_t: string, contactId: string) => {
      store.delete(contactId);
    }),
    nullifyEncryptionSalt: vi.fn(async () => {}),
    findMergeCandidates: vi.fn(async () => []),
  };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({
    binary: { version: process.env.MONGOMS_VERSION || '7.0.20' },
    instance: { launchTimeout: 30_000 },
  });
  await mongoose.connect(mongod.getUri());
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  // Clear any residual facts from prior tests via the public clear() API.
  const sweepUser = new MongoDBFactStore({ type: 'mongodb' }, TENANT_ID, 'c1', PROJECT_ID, 'user');
  await sweepUser.clear();
  const sweepProject = new MongoDBFactStore(
    { type: 'mongodb' },
    TENANT_ID,
    PROJECT_SCOPE_USER_ID,
    PROJECT_ID,
    'project',
  );
  await sweepProject.clear();
  const sweepOtherTenantUser = new MongoDBFactStore(
    { type: 'mongodb' },
    OTHER_TENANT_ID,
    'c1',
    PROJECT_ID,
    'user',
  );
  await sweepOtherTenantUser.clear();
});

describe('INT-9 — CascadeDeleteContact purges memory.user.* via factErasure port', () => {
  it('user-scope facts for the contact are erased; workflow/project facts intact', async () => {
    // ── Seed ──────────────────────────────────────────────────────────────
    const userStore = new MongoDBFactStore(
      { type: 'mongodb' },
      TENANT_ID,
      'c1',
      PROJECT_ID,
      'user',
    );
    await userStore.set({ key: 'foo', value: { theme: 'dark' } });
    await userStore.set({ key: 'preferences', value: ['alpha', 'beta'] });

    const workflowAdapter = new FactStoreWorkflowAdapter(
      { type: 'mongodb' },
      TENANT_ID,
      PROJECT_ID,
      'wf-abc',
    );
    await workflowAdapter.setWorkflowKey('bar', 'cursor-7');

    const projectStore = new MongoDBFactStore(
      { type: 'mongodb' },
      TENANT_ID,
      PROJECT_SCOPE_USER_ID,
      PROJECT_ID,
      'project',
    );
    await projectStore.set({ key: 'baz', value: 'shared-banner' });

    // Sanity — all three are reachable before the cascade.
    expect((await userStore.get({ key: 'foo' }))?.value).toEqual({ theme: 'dark' });
    expect((await workflowAdapter.getWorkflowKey('bar'))?.value).toBe('cursor-7');
    expect((await projectStore.get({ key: 'baz' }))?.value).toBe('shared-banner');

    // ── Execute ───────────────────────────────────────────────────────────
    const contactStore = new Map<string, Contact>();
    contactStore.set('c1', makeContact('c1'));
    const repo = makeRepo(contactStore);

    const cascade = new CascadeDeleteContact(
      repo,
      vi.fn(async () => {}), // audit
      undefined, // resolutionKeyCleanup
      undefined, // scrubMessages
      undefined, // clickhouseCleanup
      eraseUserScopedFacts, // factErasure (positional after clickhouseCleanup)
    );

    const result = await cascade.execute(TENANT_ID, 'c1');
    expect(result.success).toBe(true);

    // ── Assert ────────────────────────────────────────────────────────────
    // (1) User-scope facts owned by c1 are gone.
    expect(await userStore.get({ key: 'foo' })).toBeNull();
    expect(await userStore.get({ key: 'preferences' })).toBeNull();

    // (2) Workflow-scope fact (stored under userId='__project__') survives.
    const wfBar = await workflowAdapter.getWorkflowKey('bar');
    expect(wfBar?.value).toBe('cursor-7');

    // (3) Project-scope fact (stored under userId='__project__') survives.
    const projBaz = await projectStore.get({ key: 'baz' });
    expect(projBaz?.value).toBe('shared-banner');
  });

  it('returns the count of erased facts in the port result', async () => {
    const userStore = new MongoDBFactStore(
      { type: 'mongodb' },
      TENANT_ID,
      'c2',
      PROJECT_ID,
      'user',
    );
    await userStore.set({ key: 'a', value: 1 });
    await userStore.set({ key: 'b', value: 2 });
    await userStore.set({ key: 'c', value: 3 });

    const result = await eraseUserScopedFacts(TENANT_ID, 'c2');
    expect(result.erased).toBe(3);

    // Idempotent — second call deletes nothing.
    const second = await eraseUserScopedFacts(TENANT_ID, 'c2');
    expect(second.erased).toBe(0);
  });

  it('does not touch facts owned by a different tenant', async () => {
    const ownTenantStore = new MongoDBFactStore(
      { type: 'mongodb' },
      TENANT_ID,
      'c1',
      PROJECT_ID,
      'user',
    );
    const otherTenantStore = new MongoDBFactStore(
      { type: 'mongodb' },
      OTHER_TENANT_ID,
      'c1',
      PROJECT_ID,
      'user',
    );
    await ownTenantStore.set({ key: 'mine', value: 'tenantA' });
    await otherTenantStore.set({ key: 'mine', value: 'tenantB' });

    await eraseUserScopedFacts(TENANT_ID, 'c1');

    expect(await ownTenantStore.get({ key: 'mine' })).toBeNull();
    expect((await otherTenantStore.get({ key: 'mine' }))?.value).toBe('tenantB');
  });

  it('cascade continues when factErasure throws (audit-logged failure mode)', async () => {
    const contactStore = new Map<string, Contact>();
    contactStore.set('c-fail', makeContact('c-fail'));
    const repo = makeRepo(contactStore);

    const failingErasure = vi.fn(async () => {
      throw new Error('mongo unavailable');
    });
    const audit = vi.fn(async () => {});

    const cascade = new CascadeDeleteContact(
      repo,
      audit,
      undefined,
      undefined,
      undefined,
      failingErasure,
    );

    const result = await cascade.execute(TENANT_ID, 'c-fail');

    // The cascade does NOT abort — hardDelete and audit must still fire.
    expect(result.success).toBe(true);
    expect(failingErasure).toHaveBeenCalledWith(TENANT_ID, 'c-fail');
    expect(repo.hardDelete).toHaveBeenCalledWith(TENANT_ID, 'c-fail');
    expect(audit).toHaveBeenCalledTimes(1);
  });
});
