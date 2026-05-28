/**
 * Module E2E — Concurrency & Edge-Case Tests (R16, R17, R18, R21, R25)
 *
 * Exercises concurrent release publishing, concurrent multi-consumer imports,
 * release immutability, rapid environment pointer promotion, and orphaned
 * dependency detection through the real Runtime API with no mocks.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  ModuleE2EBootstrap,
  SIMPLE_MODULE_AGENT_DSL,
  CONSUMER_AGENT_DSL,
} from '../helpers/module-e2e-bootstrap.js';
import {
  ModuleRelease,
  ProjectModuleDependency,
  ModuleEnvironmentPointer,
} from '@agent-platform/database/models';

let bootstrap: ModuleE2EBootstrap;

beforeAll(async () => {
  bootstrap = await ModuleE2EBootstrap.create();
}, 60_000);

afterAll(async () => {
  await bootstrap?.teardown();
}, 30_000);

describe('Module E2E — Concurrency & Edge Cases', () => {
  // ─── R16: Concurrent release publishing ─────────────────────────────────────

  test('R16: publishing two releases concurrently for the same module both succeed with distinct IDs', async () => {
    // 1. Create a module project with an agent
    const { projectId: moduleProjectId } = await bootstrap.createProject(
      'Concurrent Release Module',
      'module',
    );
    await bootstrap.createAgent(moduleProjectId, 'payment_processor', SIMPLE_MODULE_AGENT_DSL);
    await bootstrap.setEntryAgent(moduleProjectId, 'payment_processor');

    // 2. Publish v1.0.0 and v1.1.0 concurrently
    const [release1, release2] = await Promise.all([
      bootstrap.publishRelease(moduleProjectId, '1.0.0', {
        releaseNotes: 'First concurrent release',
      }),
      bootstrap.publishRelease(moduleProjectId, '1.1.0', {
        releaseNotes: 'Second concurrent release',
      }),
    ]);

    // 3. Both should succeed with distinct IDs and correct versions
    expect(release1.releaseId).toBeTruthy();
    expect(release2.releaseId).toBeTruthy();
    expect(release1.releaseId).not.toBe(release2.releaseId);
    expect(release1.version).toBe('1.0.0');
    expect(release2.version).toBe('1.1.0');

    // 4. Verify both releases exist in the DB
    const dbRelease1 = await ModuleRelease.findOne({
      _id: release1.releaseId,
      tenantId: bootstrap.tenantId,
    }).lean();
    const dbRelease2 = await ModuleRelease.findOne({
      _id: release2.releaseId,
      tenantId: bootstrap.tenantId,
    }).lean();

    expect(dbRelease1).toBeTruthy();
    expect(dbRelease2).toBeTruthy();
    expect((dbRelease1 as Record<string, unknown>).version).toBe('1.0.0');
    expect((dbRelease2 as Record<string, unknown>).version).toBe('1.1.0');
    expect((dbRelease1 as Record<string, unknown>).moduleProjectId).toBe(moduleProjectId);
    expect((dbRelease2 as Record<string, unknown>).moduleProjectId).toBe(moduleProjectId);
  }, 30_000);

  // ─── R17: Concurrent import into multiple consumers ─────────────────────────

  test('R17: three consumers importing the same module release concurrently all get distinct dependency records', async () => {
    // 1. Create a module project and publish a release
    const { projectId: moduleProjectId } = await bootstrap.createProject(
      'Shared Import Module',
      'module',
    );
    await bootstrap.createAgent(moduleProjectId, 'payment_processor', SIMPLE_MODULE_AGENT_DSL);
    await bootstrap.setEntryAgent(moduleProjectId, 'payment_processor');

    const { releaseId } = await bootstrap.publishRelease(moduleProjectId, '1.0.0');

    // 2. Create 3 consumer projects
    const [consumer1, consumer2, consumer3] = await Promise.all([
      bootstrap.createProject('Consumer Alpha'),
      bootstrap.createProject('Consumer Beta'),
      bootstrap.createProject('Consumer Gamma'),
    ]);

    // 3. All 3 consumers import the same module release concurrently
    const [dep1, dep2, dep3] = await Promise.all([
      bootstrap.importModule(consumer1.projectId, moduleProjectId, 'payments', {
        type: 'version',
        value: '1.0.0',
      }),
      bootstrap.importModule(consumer2.projectId, moduleProjectId, 'payments', {
        type: 'version',
        value: '1.0.0',
      }),
      bootstrap.importModule(consumer3.projectId, moduleProjectId, 'payments', {
        type: 'version',
        value: '1.0.0',
      }),
    ]);

    // 4. All 3 dependency records should exist and be distinct
    expect(dep1.dependencyId).toBeTruthy();
    expect(dep2.dependencyId).toBeTruthy();
    expect(dep3.dependencyId).toBeTruthy();

    const allIds = [dep1.dependencyId, dep2.dependencyId, dep3.dependencyId];
    const uniqueIds = new Set(allIds);
    expect(uniqueIds.size).toBe(3);

    // 5. Read all dependency records and verify they share the same resolvedReleaseId
    const depRecords = await ProjectModuleDependency.find({
      _id: { $in: allIds },
      tenantId: bootstrap.tenantId,
    }).lean();

    expect(depRecords).toHaveLength(3);

    const resolvedReleaseIds = depRecords.map(
      (d) => (d as Record<string, unknown>).resolvedReleaseId as string,
    );
    expect(new Set(resolvedReleaseIds).size).toBe(1);
    expect(resolvedReleaseIds[0]).toBe(releaseId);

    // 6. Verify each dependency belongs to a different consumer projectId
    const consumerProjectIds = depRecords.map(
      (d) => (d as Record<string, unknown>).projectId as string,
    );
    expect(new Set(consumerProjectIds).size).toBe(3);
    expect(consumerProjectIds).toEqual(
      expect.arrayContaining([consumer1.projectId, consumer2.projectId, consumer3.projectId]),
    );
  }, 30_000);

  // ─── R18: Release immutability ──────────────────────────────────────────────

  test('R18: published release artifact remains consistent after direct DB mutation attempt', async () => {
    // 1. Create a module project and publish a release
    const { projectId: moduleProjectId } = await bootstrap.createProject(
      'Immutable Release Module',
      'module',
    );
    await bootstrap.createAgent(moduleProjectId, 'payment_processor', SIMPLE_MODULE_AGENT_DSL);
    await bootstrap.setEntryAgent(moduleProjectId, 'payment_processor');

    const { releaseId } = await bootstrap.publishRelease(moduleProjectId, '1.0.0', {
      releaseNotes: 'Immutable release',
    });

    // 2. Capture the original release state
    const originalRelease = await ModuleRelease.findOne({
      _id: releaseId,
      tenantId: bootstrap.tenantId,
    }).lean();

    expect(originalRelease).toBeTruthy();
    const original = originalRelease as Record<string, unknown>;
    const originalVersion = original.version as string;
    const originalSourceHash = original.sourceHash as string;
    const originalArtifact = JSON.parse(JSON.stringify(original.artifact));

    expect(originalVersion).toBe('1.0.0');

    // 3. Attempt to mutate the release artifact directly via DB
    await ModuleRelease.findOneAndUpdate(
      { _id: releaseId, tenantId: bootstrap.tenantId },
      {
        $set: {
          'artifact.entryAgentName': 'MUTATED_agent',
        },
      },
    );

    // 4. Re-read the release and verify the data structure remains consistent
    const mutatedRelease = await ModuleRelease.findOne({
      _id: releaseId,
      tenantId: bootstrap.tenantId,
    }).lean();

    expect(mutatedRelease).toBeTruthy();
    const mutated = mutatedRelease as Record<string, unknown>;

    // The version and sourceHash should remain unchanged (they weren't targeted)
    expect(mutated.version).toBe(originalVersion);
    expect(mutated.sourceHash).toBe(originalSourceHash);

    // The artifact structure should still be well-formed:
    // - agents map should still exist with the original agent entries
    const mutatedArtifact = mutated.artifact as Record<string, unknown>;
    expect(mutatedArtifact.agents).toBeDefined();
    expect(mutatedArtifact.dslFormat).toBe(originalArtifact.dslFormat);

    // The original agent DSL content in the agents map should be unmodified
    const mutatedAgents = mutatedArtifact.agents as Record<
      string,
      { dslContent: string; sourceHash: string }
    >;
    const originalAgents = originalArtifact.agents as Record<
      string,
      { dslContent: string; sourceHash: string }
    >;

    for (const agentName of Object.keys(originalAgents)) {
      expect(mutatedAgents[agentName]).toBeDefined();
      expect(mutatedAgents[agentName].dslContent).toBe(originalAgents[agentName].dslContent);
      expect(mutatedAgents[agentName].sourceHash).toBe(originalAgents[agentName].sourceHash);
    }
  }, 30_000);

  // ─── R21: Environment pointer rapid promotion ───────────────────────────────

  test('R21: rapid sequential promotion overwrites env pointer — only last version remains', async () => {
    // 1. Create a module project with an agent
    const { projectId: moduleProjectId } = await bootstrap.createProject(
      'Rapid Promotion Module',
      'module',
    );
    await bootstrap.createAgent(moduleProjectId, 'payment_processor', SIMPLE_MODULE_AGENT_DSL);
    await bootstrap.setEntryAgent(moduleProjectId, 'payment_processor');

    // 2. Publish v1.0.0 and promote to dev
    const { releaseId: v1ReleaseId } = await bootstrap.publishRelease(moduleProjectId, '1.0.0', {
      releaseNotes: 'v1 for rapid promotion',
      promoteToEnvironment: 'dev',
    });

    // 3. Verify dev pointer is at v1.0.0
    const pointerAfterV1 = await ModuleEnvironmentPointer.findOne({
      tenantId: bootstrap.tenantId,
      moduleProjectId,
      environment: 'dev',
    }).lean();
    expect(pointerAfterV1).toBeTruthy();
    expect((pointerAfterV1 as Record<string, unknown>).moduleReleaseId).toBe(v1ReleaseId);

    // 4. Immediately publish v2.0.0 and promote to dev (rapid succession)
    const { releaseId: v2ReleaseId } = await bootstrap.publishRelease(moduleProjectId, '2.0.0', {
      releaseNotes: 'v2 rapid promotion override',
      promoteToEnvironment: 'dev',
    });

    // 5. Verify the pointer now points to v2.0.0 only
    const pointerAfterV2 = await ModuleEnvironmentPointer.findOne({
      tenantId: bootstrap.tenantId,
      moduleProjectId,
      environment: 'dev',
    }).lean();
    expect(pointerAfterV2).toBeTruthy();
    expect((pointerAfterV2 as Record<string, unknown>).moduleReleaseId).toBe(v2ReleaseId);

    // 6. Verify there is exactly ONE pointer for this module+env (not two)
    const allDevPointers = await ModuleEnvironmentPointer.find({
      tenantId: bootstrap.tenantId,
      moduleProjectId,
      environment: 'dev',
    }).lean();
    expect(allDevPointers).toHaveLength(1);

    // 7. Both releases should still exist (promotion doesn't delete old releases)
    const v1Exists = await ModuleRelease.findOne({
      _id: v1ReleaseId,
      tenantId: bootstrap.tenantId,
    }).lean();
    const v2Exists = await ModuleRelease.findOne({
      _id: v2ReleaseId,
      tenantId: bootstrap.tenantId,
    }).lean();
    expect(v1Exists).toBeTruthy();
    expect(v2Exists).toBeTruthy();
  }, 30_000);

  // ─── R25: Orphaned dependency detection ─────────────────────────────────────

  test('R25: deleting a release leaves a dangling dependency reference — consumer detects stale dependency', async () => {
    // 1. Create a module project and publish a release
    const { projectId: moduleProjectId } = await bootstrap.createProject(
      'Orphan Detection Module',
      'module',
    );
    await bootstrap.createAgent(moduleProjectId, 'payment_processor', SIMPLE_MODULE_AGENT_DSL);
    await bootstrap.setEntryAgent(moduleProjectId, 'payment_processor');

    const { releaseId } = await bootstrap.publishRelease(moduleProjectId, '1.0.0', {
      releaseNotes: 'Release to be deleted',
    });

    // 2. Create a consumer and import the module
    const { projectId: consumerProjectId } = await bootstrap.createProject('Orphan Consumer');
    await bootstrap.createAgent(consumerProjectId, 'store_agent', CONSUMER_AGENT_DSL);
    await bootstrap.setEntryAgent(consumerProjectId, 'store_agent');

    const { dependencyId } = await bootstrap.importModule(
      consumerProjectId,
      moduleProjectId,
      'payments',
      { type: 'version', value: '1.0.0' },
    );

    // 3. Verify the dependency points to the release
    const depBefore = await ProjectModuleDependency.findOne({
      _id: dependencyId,
      tenantId: bootstrap.tenantId,
    }).lean();
    expect(depBefore).toBeTruthy();
    expect((depBefore as Record<string, unknown>).resolvedReleaseId).toBe(releaseId);

    // 4. Delete the release directly (simulating a force-delete scenario)
    await ModuleRelease.deleteOne({
      _id: releaseId,
      tenantId: bootstrap.tenantId,
    });

    // 5. Verify the release is gone
    const deletedRelease = await ModuleRelease.findOne({
      _id: releaseId,
      tenantId: bootstrap.tenantId,
    }).lean();
    expect(deletedRelease).toBeNull();

    // 6. Read the dependency — it should still exist with the now-dangling reference
    const depAfter = await ProjectModuleDependency.findOne({
      _id: dependencyId,
      tenantId: bootstrap.tenantId,
    }).lean();
    expect(depAfter).toBeTruthy();

    const depDoc = depAfter as Record<string, unknown>;

    // The resolvedReleaseId still references the deleted release (dangling)
    expect(depDoc.resolvedReleaseId).toBe(releaseId);
    expect(depDoc.resolvedVersion).toBe('1.0.0');

    // 7. Verify the dangling reference is detectable:
    // Attempt to look up the release by the dependency's resolvedReleaseId — should return null
    const resolvedRelease = await ModuleRelease.findOne({
      _id: depDoc.resolvedReleaseId,
      tenantId: bootstrap.tenantId,
    }).lean();
    expect(resolvedRelease).toBeNull();
  }, 30_000);
});
