import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearCollections, setupTestMongo, teardownTestMongo } from '../helpers/setup-mongo.js';

let Project: any;
let PublicApiKey: any;
let SDKChannel: any;
let createSDKChannel: any;
let findSDKChannelById: any;

beforeAll(async () => {
  await setupTestMongo();

  const models = await import('@agent-platform/database/models');
  models.setMasterKey('a'.repeat(64));
  Project = models.Project;
  PublicApiKey = models.PublicApiKey;
  SDKChannel = models.SDKChannel;

  const channelRepo = await import('../../repos/channel-repo.js');
  createSDKChannel = channelRepo.createSDKChannel;
  findSDKChannelById = channelRepo.findSDKChannelById;
});

beforeEach(async () => {
  await clearCollections();
});

afterAll(async () => {
  await teardownTestMongo();
});

describe('SDK channel auth profile cleanup', () => {
  it('createSDKChannel ignores retired authProfileId input', async () => {
    const project = await Project.create({
      name: 'Channel Repo Legacy Auth Cleanup Project',
      slug: `channel-repo-legacy-auth-cleanup-${Date.now()}`,
      ownerId: 'owner-channel-legacy-auth-cleanup',
      tenantId: 'tenant-ch-legacy-auth',
    });

    await PublicApiKey.create({
      _id: 'key-legacy-auth',
      projectId: project._id,
      tenantId: 'tenant-ch-legacy-auth',
      keyPrefix: 'pk_',
      keyHash: 'hash-channel-legacy-auth',
      name: 'Channel Repo Legacy Auth Key',
      isActive: true,
    });

    const result = await createSDKChannel({
      tenantId: 'tenant-ch-legacy-auth',
      projectId: String(project._id),
      name: 'Legacy Auth Cleanup Channel',
      channelType: 'web',
      publicApiKeyId: 'key-legacy-auth',
      authProfileId: 'profile-retired',
    } as any);

    expect(result).not.toHaveProperty('authProfileId');

    const stored = await SDKChannel.collection.findOne({ _id: result.id });
    expect(stored?.authProfileId).toBeUndefined();
  });

  it('findSDKChannelById strips legacy authProfileId from raw documents', async () => {
    await SDKChannel.collection.insertOne({
      _id: 'sdk-channel-legacy-auth-profile',
      tenantId: 'tenant-legacy-auth',
      projectId: 'proj-legacy-auth',
      name: 'Legacy Auth Profile Channel',
      channelType: 'web',
      publicApiKeyId: 'key-legacy-auth-profile',
      config: {},
      isActive: true,
      environment: null,
      followEnvironment: true,
      authProfileId: 'profile-retired',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await findSDKChannelById(
      'sdk-channel-legacy-auth-profile',
      'proj-legacy-auth',
      'tenant-legacy-auth',
    );

    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('authProfileId');
  });
});
