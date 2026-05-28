/**
 * Prompt Library Performance Benchmark
 *
 * Validates §7 performance targets from the test spec:
 *   - Single prompt CRUD round-trip < 200ms p95
 *   - List (100 prompts) response < 500ms p95
 *   - Concurrent 10-request burst — all under 1s wall-clock
 *
 * Uses real MongoDB (MongoMemoryServer) + PromptLibraryService directly.
 * No HTTP server needed — measures pure service+DB latency.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { PromptLibraryItem, PromptLibraryVersion } from '@agent-platform/database/models';
import { PromptLibraryService } from '../services/prompt-library/prompt-library-service.js';

const TENANT_ID = 'perf-tenant-001';
const PROJECT_ID = 'perf-project-001';
const USER_ID = 'perf-user-001';

const P95_CRUD_MS = 200;
const P95_LIST_MS = 500;
const BURST_WALL_MS = 1_000;

let mongod: MongoMemoryServer;
let service: PromptLibraryService;

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * 0.95);
  return sorted[Math.min(idx, sorted.length - 1)];
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({
    binary: { version: process.env.MONGOMS_VERSION || '7.0.20' },
    instance: { launchTimeout: 30_000 },
  });
  await mongoose.connect(mongod.getUri(), { autoIndex: true });
  service = new PromptLibraryService();
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

describe('Prompt Library Performance', () => {
  test('createPrompt p95 < 200ms over 20 samples', async () => {
    const samples: number[] = [];

    for (let i = 0; i < 20; i++) {
      const t0 = Date.now();
      await service.createPrompt({
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        name: `perf-prompt-create-${i}-${Date.now()}`,
        createdBy: USER_ID,
      });
      samples.push(Date.now() - t0);
    }

    const result = p95(samples);
    expect(result, `createPrompt p95 = ${result}ms, target < ${P95_CRUD_MS}ms`).toBeLessThan(
      P95_CRUD_MS,
    );
  }, 30_000);

  test('createVersion p95 < 200ms over 20 samples', async () => {
    const item = await service.createPrompt({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      name: `perf-ver-${Date.now()}`,
      createdBy: USER_ID,
    });

    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = Date.now();
      await service.createVersion(String(item._id), {
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        template: `Template ${i}`,
        variables: ['x'],
        createdBy: USER_ID,
      });
      samples.push(Date.now() - t0);
    }

    const result = p95(samples);
    expect(result, `createVersion p95 = ${result}ms, target < ${P95_CRUD_MS}ms`).toBeLessThan(
      P95_CRUD_MS,
    );
  }, 30_000);

  test('listPrompts with 100 items p95 < 500ms over 10 samples', async () => {
    // Seed 100 prompts
    const seeded: string[] = [];
    for (let i = 0; i < 100; i++) {
      const item = await service.createPrompt({
        tenantId: TENANT_ID,
        projectId: `perf-list-proj-${i % 5}`,
        name: `list-perf-${i}`,
        createdBy: USER_ID,
      });
      seeded.push(String(item._id));
    }

    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = Date.now();
      await service.listPrompts({
        tenantId: TENANT_ID,
        projectId: 'perf-list-proj-0',
        limit: 100,
        offset: 0,
      });
      samples.push(Date.now() - t0);
    }

    const result = p95(samples);
    expect(result, `listPrompts p95 = ${result}ms, target < ${P95_LIST_MS}ms`).toBeLessThan(
      P95_LIST_MS,
    );
  }, 60_000);

  test('10 concurrent createPrompt calls complete within 1s wall-clock', async () => {
    const t0 = Date.now();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        service.createPrompt({
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
          name: `burst-${i}-${Date.now()}`,
          createdBy: USER_ID,
        }),
      ),
    );
    const wallMs = Date.now() - t0;
    expect(wallMs, `10 concurrent creates = ${wallMs}ms, target < ${BURST_WALL_MS}ms`).toBeLessThan(
      BURST_WALL_MS,
    );
  }, 30_000);

  test('promoteVersion p95 < 200ms over 10 samples', async () => {
    const samples: number[] = [];

    for (let i = 0; i < 10; i++) {
      const item = await service.createPrompt({
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        name: `perf-promote-${i}-${Date.now()}`,
        createdBy: USER_ID,
      });
      const v = await service.createVersion(String(item._id), {
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        template: 'Promote target',
        variables: [],
        createdBy: USER_ID,
      });

      const t0 = Date.now();
      await service.promoteVersion(String(item._id), String(v._id), {
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        userId: USER_ID,
      });
      samples.push(Date.now() - t0);
    }

    const result = p95(samples);
    expect(result, `promoteVersion p95 = ${result}ms, target < ${P95_CRUD_MS}ms`).toBeLessThan(
      P95_CRUD_MS,
    );
  }, 30_000);
});
