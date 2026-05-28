import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  requireMongo,
} from './helpers/setup-mongo.js';
import { PromptLibraryVersion } from '../models/prompt-library-version.model.js';
import { computeSourceHash } from '../models/prompt-library-version.model.js';

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

const validVersion = () => ({
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  promptId: 'pl_abc123',
  versionNumber: 1,
  template: 'Hello {{name}}, welcome to {{company}}',
  variables: ['name', 'company'],
  sourceHash: computeSourceHash('Hello {{name}}, welcome to {{company}}', ['name', 'company']),
  createdBy: 'user-1',
});

describe('PromptLibraryVersion model', () => {
  it('creates version with required fields and _id starts with plv_', async ({ skip }) => {
    requireMongo(skip);
    const doc = await PromptLibraryVersion.create(validVersion());
    expect(doc._id).toBeDefined();
    expect(doc._id).toMatch(/^plv_/);
    expect(doc.promptId).toBe('pl_abc123');
    expect(doc.versionNumber).toBe(1);
    expect(doc.template).toBe('Hello {{name}}, welcome to {{company}}');
    expect(doc.variables).toEqual(['name', 'company']);
  });

  it('defaults status to draft', async ({ skip }) => {
    requireMongo(skip);
    const doc = await PromptLibraryVersion.create(validVersion());
    expect(doc.status).toBe('draft');
    expect(doc.publishedAt).toBeNull();
    expect(doc.publishedBy).toBeNull();
  });

  it('enforces unique index on tenantId + projectId + promptId + versionNumber', async ({
    skip,
  }) => {
    requireMongo(skip);
    await PromptLibraryVersion.create(validVersion());
    await expect(PromptLibraryVersion.create(validVersion())).rejects.toThrow();
  });

  it('allows same versionNumber for different promptIds', async ({ skip }) => {
    requireMongo(skip);
    const v1 = await PromptLibraryVersion.create(validVersion());
    const v2 = await PromptLibraryVersion.create({
      ...validVersion(),
      promptId: 'pl_def456',
    });
    expect(v1._id).not.toBe(v2._id);
  });

  it('requires template', () => {
    const data = validVersion();
    delete (data as any).template;
    const err = new PromptLibraryVersion(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.template).toBeDefined();
  });

  it('requires sourceHash', () => {
    const data = validVersion();
    delete (data as any).sourceHash;
    const err = new PromptLibraryVersion(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.sourceHash).toBeDefined();
  });
});

describe('computeSourceHash', () => {
  it('produces same hash regardless of variable order', () => {
    const hash1 = computeSourceHash('Hello {{a}} {{b}}', ['a', 'b']);
    const hash2 = computeSourceHash('Hello {{a}} {{b}}', ['b', 'a']);
    expect(hash1).toBe(hash2);
  });

  it('produces different hash for different templates', () => {
    const hash1 = computeSourceHash('Hello {{name}}', ['name']);
    const hash2 = computeSourceHash('Hello  {{name}}', ['name']);
    expect(hash1).not.toBe(hash2);
  });

  it('produces different hash when a variable is added', () => {
    const hash1 = computeSourceHash('Hello {{name}}', ['name']);
    const hash2 = computeSourceHash('Hello {{name}}', ['name', 'extra']);
    expect(hash1).not.toBe(hash2);
  });

  it('returns a hex string of 64 characters (SHA-256)', () => {
    const hash = computeSourceHash('test', []);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
