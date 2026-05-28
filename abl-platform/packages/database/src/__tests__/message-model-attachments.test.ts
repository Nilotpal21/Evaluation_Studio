import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
  initTestDEKFacade,
} from './helpers/setup-mongo.js';
import { Message } from '../models/message.model.js';

beforeAll(async () => {
  await setupTestMongo();
  await initTestDEKFacade('a'.repeat(64));
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

// ─── Helpers ──────────────────────────────────────────────────────────────

const validMessage = (overrides: Record<string, unknown> = {}) => ({
  sessionId: 'sess-1',
  tenantId: 'tenant-1',
  projectId: 'project-1',
  role: 'user' as const,
  content: 'Hello world',
  channel: 'web',
  ...overrides,
});

// ─── Message Model — attachmentIds ────────────────────────────────────────

describe('Message Model — attachmentIds', () => {
  it('defaults attachmentIds to empty array', () => {
    const doc = new Message(validMessage());
    expect(doc.attachmentIds).toEqual([]);
  });

  it('creates a message with attachmentIds', () => {
    const ids = ['att-1', 'att-2'];
    const doc = new Message(validMessage({ attachmentIds: ids }));
    expect(doc.attachmentIds).toEqual(ids);
  });

  it('stores multiple attachment IDs', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const ids = ['att-aaa', 'att-bbb', 'att-ccc'];
    const doc = await Message.create(validMessage({ attachmentIds: ids }));

    expect(doc.attachmentIds).toEqual(ids);
    expect(doc.attachmentIds).toHaveLength(3);

    // Re-fetch from DB to verify persistence
    const fetched = await Message.findOne({ _id: doc._id, tenantId: 'tenant-1' });
    expect(fetched).not.toBeNull();
    expect(fetched!.attachmentIds).toEqual(ids);
  });

  it('existing messages without attachmentIds still work (backward compat)', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    // Create a normal encrypted message, then remove attachmentIds to simulate
    // a pre-migration record that predates the field.
    const collection = Message.collection;
    const created = await Message.create({
      ...validMessage(),
      _id: 'legacy-msg-1',
      content: 'Legacy message',
    });
    expect(created.attachmentIds).toEqual([]);

    await collection.updateOne(
      { _id: 'legacy-msg-1', tenantId: 'tenant-1' },
      { $unset: { attachmentIds: '' } },
    );

    const fetched = await Message.findOne({ _id: 'legacy-msg-1', tenantId: 'tenant-1' });
    expect(fetched).not.toBeNull();
    expect(fetched!.content).toBe('Legacy message');
    // Mongoose applies the schema default when the field is absent from the stored doc
    expect(fetched!.attachmentIds).toEqual([]);
  });
});
