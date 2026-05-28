import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import mongoose from 'mongoose';
import {
  clearCollections,
  isMongoReady,
  setupTestMongo,
  teardownTestMongo,
} from './helpers/setup-mongo.js';
import { ArchSession } from '../models/arch-session.model.js';

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

describe('ArchSession model', () => {
  test('declares surface and thread scoped uniqueness for active Arch sessions', () => {
    const indexes = ArchSession.schema.indexes();

    expect(indexes).toEqual(
      expect.arrayContaining([
        [
          {
            tenantId: 1,
            userId: 1,
            'metadata.mode': 1,
            'metadata.projectId': 1,
            'metadata.surface': 1,
            'metadata.agentNameKey': 1,
            'metadata.threadId': 1,
          },
          expect.objectContaining({
            unique: true,
            partialFilterExpression: {
              state: { $in: ['IDLE', 'ACTIVE', 'GATE_PENDING'] },
            },
          }),
        ],
      ]),
    );
  });

  test('hydrates metadata.buildProgress from raw Mongo documents', async () => {
    if (!isMongoReady()) return;

    const buildProgress = {
      stage: 'complete',
      agentStatuses: {
        SupportTriage: 'warning',
        PasswordReset: 'warning',
      },
      toolStatuses: {
        verify_user_account: 'generated',
      },
    };

    await mongoose.connection.collection('arch_sessions').insertOne({
      _id: 'sess-build-progress',
      tenantId: 'tenant-1',
      userId: 'user-1',
      state: 'ACTIVE',
      metadata: {
        phase: 'BUILD',
        mode: 'ONBOARDING',
        specification: {
          version: 1,
          projectName: 'ITSupport Hub',
          description: 'Support automation project',
          channels: ['chat'],
          language: 'English',
          uploadedFiles: [],
          conversationNotes: [],
        },
        pendingInteraction: null,
        messages: [],
        topology: {
          agents: [{ name: 'SupportTriage' }, { name: 'PasswordReset' }],
        },
        topologyApproved: true,
        buildProgress,
        files: {},
        toolDsls: {},
      },
      archivedAt: null,
      _v: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const doc = await ArchSession.findOne({ _id: 'sess-build-progress' });

    expect(doc?.metadata.buildProgress).toEqual(buildProgress);
  });
});
