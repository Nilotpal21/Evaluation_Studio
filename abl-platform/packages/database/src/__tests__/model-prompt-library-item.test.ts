import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  requireMongo,
} from './helpers/setup-mongo.js';
import { PromptLibraryItem } from '../models/prompt-library-item.model.js';

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

const validItem = () => ({
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  name: 'greeting-prompt',
  createdBy: 'user-1',
});

describe('PromptLibraryItem model', () => {
  it('creates item with all required fields and _id starts with pl_', async ({ skip }) => {
    requireMongo(skip);
    const doc = await PromptLibraryItem.create(validItem());
    expect(doc._id).toBeDefined();
    expect(doc._id).toMatch(/^pl_/);
    expect(doc.tenantId).toBe('tenant-1');
    expect(doc.projectId).toBe('proj-1');
    expect(doc.name).toBe('greeting-prompt');
    expect(doc.createdBy).toBe('user-1');
  });

  it('defaults status to active, usageCount to 0, tags to []', async ({ skip }) => {
    requireMongo(skip);
    const doc = await PromptLibraryItem.create(validItem());
    expect(doc.status).toBe('active');
    expect(doc.usageCount).toBe(0);
    expect(doc.tags).toEqual([]);
    expect(doc.nextVersionNumber).toBe(0);
  });

  it('enforces unique index on tenantId + projectId + name', async ({ skip }) => {
    requireMongo(skip);
    await PromptLibraryItem.create(validItem());
    await expect(PromptLibraryItem.create(validItem())).rejects.toThrow();
  });

  it('allows same name in different projects', async ({ skip }) => {
    requireMongo(skip);
    const v1 = await PromptLibraryItem.create(validItem());
    const v2 = await PromptLibraryItem.create({
      ...validItem(),
      projectId: 'proj-2',
    });
    expect(v1._id).not.toBe(v2._id);
  });

  it('allows same name in different tenants', async ({ skip }) => {
    requireMongo(skip);
    const v1 = await PromptLibraryItem.create(validItem());
    const v2 = await PromptLibraryItem.create({
      ...validItem(),
      tenantId: 'tenant-2',
    });
    expect(v1._id).not.toBe(v2._id);
  });

  it('requires tenantId', () => {
    const data = validItem();
    delete (data as any).tenantId;
    const err = new PromptLibraryItem(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires name', () => {
    const data = validItem();
    delete (data as any).name;
    const err = new PromptLibraryItem(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.name).toBeDefined();
  });

  it('requires createdBy', () => {
    const data = validItem();
    delete (data as any).createdBy;
    const err = new PromptLibraryItem(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.createdBy).toBeDefined();
  });

  it('stores optional description and tags', async ({ skip }) => {
    requireMongo(skip);
    const doc = await PromptLibraryItem.create({
      ...validItem(),
      description: 'A greeting prompt template',
      tags: ['greeting', 'onboarding'],
    });
    const fetched = await PromptLibraryItem.findOne({
      _id: doc._id,
      tenantId: 'tenant-1',
    }).lean();
    expect(fetched!.description).toBe('A greeting prompt template');
    expect(fetched!.tags).toEqual(['greeting', 'onboarding']);
  });
});
