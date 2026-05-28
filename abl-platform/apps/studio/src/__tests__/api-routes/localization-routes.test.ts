import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const mockRequireAuth = vi.fn();
const mockIsAuthError = vi.fn(() => false);
const mockRequireProjectMemberOrAdmin = vi.fn();
const mockIsAccessError = vi.fn(() => false);
const mockProjectConfigVariableFindOne = vi.fn();
const mockProjectConfigVariableCreate = vi.fn();
const mockProjectConfigVariableFindOneAndUpdate = vi.fn();
const mockProjectConfigVariableFindOneAndDelete = vi.fn();

type LocalizationDoc = {
  _id: string;
  tenantId: string;
  projectId: string;
  key: string;
  value: string;
  description: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const TEST_USER = {
  id: 'user-1',
  email: 'localization@test.example',
  name: 'Localization Tester',
  tenantId: 'tenant-1',
  permissions: ['*:*'],
};

const TEST_PROJECT_ACCESS = {
  project: {
    id: 'proj-1',
    name: 'Localization Project',
    tenantId: 'tenant-1',
  },
};

let nextId = 1;
let localizationDocs: LocalizationDoc[] = [];

function cloneValue<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value)) as T;
}

function makeRequest(path: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

function applyProjection<T extends Record<string, unknown> | null>(
  value: T,
  projection?: string,
): T {
  if (!value || !projection) {
    return value ? cloneValue(value) : value;
  }

  const keys = projection.split(/\s+/).filter(Boolean);
  return cloneValue(
    Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, value[key]])),
  ) as T;
}

function makeQuery<T extends Record<string, unknown> | null>(resolver: () => T) {
  let projection: string | undefined;

  const execute = () => applyProjection(resolver(), projection);

  const query = {
    select(value: string) {
      projection = value;
      return query;
    },
    lean() {
      return query;
    },
    then<TResult1 = Awaited<ReturnType<typeof execute>>, TResult2 = never>(
      onfulfilled?:
        | ((value: Awaited<ReturnType<typeof execute>>) => TResult1 | PromiseLike<TResult1>)
        | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) {
      return Promise.resolve(execute()).then(onfulfilled, onrejected);
    },
    catch<TResult = never>(
      onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
    ) {
      return Promise.resolve(execute()).catch(onrejected);
    },
    finally(onfinally?: (() => void) | null) {
      return Promise.resolve(execute()).finally(onfinally);
    },
  };

  return query;
}

function matchesFilter(record: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = record[key];

    if (expected instanceof RegExp) {
      return typeof actual === 'string' && expected.test(actual);
    }

    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if ('$ne' in expected) {
        return actual !== (expected as { $ne?: unknown }).$ne;
      }
    }

    return actual === expected;
  });
}

function validateRelativePath(relativePath: string): {
  relativePath: string;
  localeCode: string;
  fileName: string;
  assetName: string;
  scope: 'shared' | 'agent';
} {
  const trimmed = relativePath.trim().replace(/\\/g, '/');
  const parts = trimmed.split('/').filter(Boolean);
  if (
    trimmed.length === 0 ||
    trimmed.startsWith('/') ||
    trimmed.includes('..') ||
    parts.length !== 2 ||
    !parts[1]?.endsWith('.json')
  ) {
    throw new Error(`Invalid locale asset path: ${relativePath}`);
  }

  const localeCode = parts[0]!;
  const fileName = parts[1]!;
  const assetName = fileName.replace(/\.json$/i, '');

  if (!/^[A-Za-z0-9_-]+$/.test(localeCode) || !/^[A-Za-z0-9_.-]+\.json$/i.test(fileName)) {
    throw new Error(`Invalid locale asset path: ${relativePath}`);
  }

  return {
    relativePath: `${localeCode}/${fileName}`,
    localeCode,
    fileName,
    assetName,
    scope: assetName === '_shared' ? 'shared' : 'agent',
  };
}

function formatLocalizationAsset(doc: LocalizationDoc) {
  const path = validateRelativePath(doc.key.replace(/^locale:/, ''));
  return {
    id: doc._id,
    key: doc.key,
    value: doc.value,
    description: doc.description,
    relativePath: path.relativePath,
    filePath: `locales/${path.relativePath}`,
    localeCode: path.localeCode,
    fileName: path.fileName,
    assetName: path.assetName,
    scope: path.scope,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

vi.mock('@/lib/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  isAuthError: (...args: unknown[]) => mockIsAuthError(...args),
  formatUserLabel: (user: { name?: string; email?: string; id: string }) =>
    user.name || user.email || user.id,
}));

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: vi.fn(),
  isAccessError: (...args: unknown[]) => mockIsAccessError(...args),
}));

vi.mock('@/lib/require-project-member-or-admin', () => ({
  requireProjectMemberOrAdmin: (...args: unknown[]) => mockRequireProjectMemberOrAdmin(...args),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@agent-platform/database/models', () => ({
  ProjectConfigVariable: {
    findOne: (...args: unknown[]) => mockProjectConfigVariableFindOne(...args),
    create: (...args: unknown[]) => mockProjectConfigVariableCreate(...args),
    findOneAndUpdate: (...args: unknown[]) => mockProjectConfigVariableFindOneAndUpdate(...args),
    findOneAndDelete: (...args: unknown[]) => mockProjectConfigVariableFindOneAndDelete(...args),
  },
}));

vi.mock('@/lib/localization-assets', () => ({
  buildLocalizationAssetKey: (relativePath: string) => {
    const parsed = validateRelativePath(relativePath);
    return `locale:${parsed.relativePath}`;
  },
  formatLocalizationAssetJson: (value: string) => {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('Locale asset content must be a JSON object');
    }

    return JSON.stringify(parsed, null, 2);
  },
  listProjectLocalizationAssets: async (projectId: string, tenantId: string) =>
    localizationDocs
      .filter((doc) => doc.projectId === projectId && doc.tenantId === tenantId)
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((doc) => formatLocalizationAsset(doc)),
  getProjectLocalizationAssetById: async (assetId: string, projectId: string, tenantId: string) => {
    const doc = localizationDocs.find(
      (candidate) =>
        candidate._id === assetId &&
        candidate.projectId === projectId &&
        candidate.tenantId === tenantId &&
        candidate.key.startsWith('locale:'),
    );
    return doc ? formatLocalizationAsset(doc) : null;
  },
}));

import {
  GET as listLocalizationAssets,
  POST as createLocalizationAsset,
} from '@/app/api/projects/[id]/localization/route';
import {
  GET as getLocalizationAsset,
  PATCH as updateLocalizationAsset,
  DELETE as deleteLocalizationAsset,
} from '@/app/api/projects/[id]/localization/[assetId]/route';

beforeEach(() => {
  nextId = 1;
  localizationDocs = [
    {
      _id: 'asset-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      key: 'locale:en/messages.json',
      value: JSON.stringify({ messages: { conversation_complete: 'Done' } }, null, 2),
      description: 'English messages',
      createdBy: 'seed',
      updatedBy: 'seed',
      createdAt: new Date('2026-04-15T10:00:00.000Z'),
      updatedAt: new Date('2026-04-15T10:00:00.000Z'),
    },
    {
      _id: 'asset-2',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      key: 'locale:fr/messages.json',
      value: JSON.stringify({ messages: { conversation_complete: 'Termine' } }, null, 2),
      description: 'French messages',
      createdBy: 'seed',
      updatedBy: 'seed',
      createdAt: new Date('2026-04-15T11:00:00.000Z'),
      updatedAt: new Date('2026-04-15T11:00:00.000Z'),
    },
    {
      _id: 'asset-3',
      tenantId: 'tenant-1',
      projectId: 'proj-other',
      key: 'locale:es/messages.json',
      value: JSON.stringify({ messages: { conversation_complete: 'Listo' } }, null, 2),
      description: 'Other project messages',
      createdBy: 'seed',
      updatedBy: 'seed',
      createdAt: new Date('2026-04-15T12:00:00.000Z'),
      updatedAt: new Date('2026-04-15T12:00:00.000Z'),
    },
  ];

  mockRequireAuth.mockResolvedValue(TEST_USER);
  mockRequireProjectMemberOrAdmin.mockResolvedValue(TEST_PROJECT_ACCESS);
  mockProjectConfigVariableFindOne.mockImplementation((filter: Record<string, unknown>) =>
    makeQuery(() => {
      const doc = localizationDocs.find((candidate) => matchesFilter(candidate, filter));
      return doc ? cloneValue(doc) : null;
    }),
  );
  mockProjectConfigVariableCreate.mockImplementation(async (input: Record<string, unknown>) => {
    const now = new Date('2026-04-16T10:00:00.000Z');
    const doc: LocalizationDoc = {
      _id: `asset-${++nextId}`,
      tenantId: String(input.tenantId),
      projectId: String(input.projectId),
      key: String(input.key),
      value: String(input.value),
      description: (input.description as string | null | undefined) ?? null,
      createdBy: (input.createdBy as string | null | undefined) ?? null,
      updatedBy: (input.updatedBy as string | null | undefined) ?? null,
      createdAt: now,
      updatedAt: now,
    };
    localizationDocs.push(doc);
    return cloneValue(doc);
  });
  mockProjectConfigVariableFindOneAndUpdate.mockImplementation(
    (
      filter: Record<string, unknown>,
      update: { $set?: Record<string, unknown> },
      _options: Record<string, unknown>,
    ) =>
      makeQuery(() => {
        const doc = localizationDocs.find((candidate) => matchesFilter(candidate, filter));
        if (!doc) {
          return null;
        }

        if (update.$set) {
          Object.assign(doc, update.$set);
        }
        doc.updatedAt = new Date('2026-04-16T11:00:00.000Z');
        return cloneValue(doc);
      }),
  );
  mockProjectConfigVariableFindOneAndDelete.mockImplementation((filter: Record<string, unknown>) =>
    makeQuery(() => {
      const index = localizationDocs.findIndex((candidate) => matchesFilter(candidate, filter));
      if (index < 0) {
        return null;
      }

      const [deleted] = localizationDocs.splice(index, 1);
      return deleted ? cloneValue(deleted) : null;
    }),
  );
});

describe('localization asset routes', () => {
  it('lists project-scoped localization assets with locale summary', async () => {
    const response = await listLocalizationAssets(
      makeRequest('/api/projects/proj-1/localization', 'GET'),
      {
        params: Promise.resolve({ id: 'proj-1' }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      locales: ['en', 'fr'],
      summary: {
        totalAssets: 2,
        totalLocales: 2,
      },
      assets: [
        expect.objectContaining({ relativePath: 'en/messages.json' }),
        expect.objectContaining({ relativePath: 'fr/messages.json' }),
      ],
    });
  });

  it('creates a localization asset with project and tenant isolation', async () => {
    const localizedMessages = {
      namespace: 'messages',
      fallbackChain: ['de', 'en'],
      messages: { conversation_complete: 'Fertig' },
    };
    const response = await createLocalizationAsset(
      makeRequest('/api/projects/proj-1/localization', 'POST', {
        relativePath: 'de/messages.json',
        value: JSON.stringify(localizedMessages),
        description: 'German messages',
      }),
      {
        params: Promise.resolve({ id: 'proj-1' }),
      },
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      asset: expect.objectContaining({
        relativePath: 'de/messages.json',
        filePath: 'locales/de/messages.json',
        localeCode: 'de',
      }),
    });
    expect(localizationDocs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectId: 'proj-1',
          tenantId: 'tenant-1',
          key: 'locale:de/messages.json',
          value: JSON.stringify(localizedMessages, null, 2),
          createdBy: 'Localization Tester',
          updatedBy: 'Localization Tester',
        }),
      ]),
    );

    const createdDoc = localizationDocs.find((doc) => doc.key === 'locale:de/messages.json');
    expect(createdDoc).toBeTruthy();
    expect(JSON.parse(createdDoc!.value)).toEqual(localizedMessages);
  });

  it('returns 409 when a localization asset already exists for the project', async () => {
    const response = await createLocalizationAsset(
      makeRequest('/api/projects/proj-1/localization', 'POST', {
        relativePath: 'fr/messages.json',
        value: JSON.stringify({ messages: { conversation_complete: 'Termine' } }),
      }),
      {
        params: Promise.resolve({ id: 'proj-1' }),
      },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Localization asset already exists',
    });
    expect(mockProjectConfigVariableFindOne).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      key: 'locale:fr/messages.json',
    });
  });

  it('rejects invalid locale paths and non-object JSON bodies', async () => {
    const invalidPathResponse = await createLocalizationAsset(
      makeRequest('/api/projects/proj-1/localization', 'POST', {
        relativePath: '../messages.json',
        value: JSON.stringify({ ok: true }),
      }),
      {
        params: Promise.resolve({ id: 'proj-1' }),
      },
    );
    expect(invalidPathResponse.status).toBe(400);

    const invalidJsonResponse = await createLocalizationAsset(
      makeRequest('/api/projects/proj-1/localization', 'POST', {
        relativePath: 'it/messages.json',
        value: JSON.stringify(['not', 'an', 'object']),
      }),
      {
        params: Promise.resolve({ id: 'proj-1' }),
      },
    );
    expect(invalidJsonResponse.status).toBe(400);
    await expect(invalidJsonResponse.json()).resolves.toEqual({
      success: false,
      error: 'Locale asset content must be a JSON object',
    });
  });

  it('updates a localization asset and blocks duplicate renames', async () => {
    const updateResponse = await updateLocalizationAsset(
      makeRequest('/api/projects/proj-1/localization/asset-1', 'PATCH', {
        relativePath: 'en/_shared.json',
        value: JSON.stringify({ messages: { conversation_complete: 'Finished' } }),
        description: 'Shared English messages',
      }),
      {
        params: Promise.resolve({ id: 'proj-1', assetId: 'asset-1' }),
      },
    );

    expect(updateResponse.status).toBe(200);
    await expect(updateResponse.json()).resolves.toMatchObject({
      success: true,
      asset: expect.objectContaining({
        relativePath: 'en/_shared.json',
        scope: 'shared',
        description: 'Shared English messages',
      }),
    });

    const duplicateRenameResponse = await updateLocalizationAsset(
      makeRequest('/api/projects/proj-1/localization/asset-1', 'PATCH', {
        relativePath: 'fr/messages.json',
      }),
      {
        params: Promise.resolve({ id: 'proj-1', assetId: 'asset-1' }),
      },
    );

    expect(duplicateRenameResponse.status).toBe(409);
    await expect(duplicateRenameResponse.json()).resolves.toEqual({
      success: false,
      error: 'Localization asset already exists',
    });
  });

  it('returns 404 for missing or cross-project asset lookups', async () => {
    const missingResponse = await getLocalizationAsset(
      makeRequest('/api/projects/proj-1/localization/asset-missing', 'GET'),
      {
        params: Promise.resolve({ id: 'proj-1', assetId: 'asset-missing' }),
      },
    );
    expect(missingResponse.status).toBe(404);

    const crossProjectResponse = await getLocalizationAsset(
      makeRequest('/api/projects/proj-1/localization/asset-3', 'GET'),
      {
        params: Promise.resolve({ id: 'proj-1', assetId: 'asset-3' }),
      },
    );
    expect(crossProjectResponse.status).toBe(404);
  });

  it('deletes a localization asset and fails closed for mismatched project scope', async () => {
    const deleteResponse = await deleteLocalizationAsset(
      makeRequest('/api/projects/proj-1/localization/asset-2', 'DELETE'),
      {
        params: Promise.resolve({ id: 'proj-1', assetId: 'asset-2' }),
      },
    );

    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toEqual({
      success: true,
      deleted: 'asset-2',
    });
    expect(localizationDocs.find((doc) => doc._id === 'asset-2')).toBeUndefined();

    const missingResponse = await deleteLocalizationAsset(
      makeRequest('/api/projects/proj-1/localization/asset-3', 'DELETE'),
      {
        params: Promise.resolve({ id: 'proj-1', assetId: 'asset-3' }),
      },
    );
    expect(missingResponse.status).toBe(404);
    expect(mockProjectConfigVariableFindOneAndDelete).toHaveBeenCalledWith({
      _id: 'asset-3',
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      key: /^locale:/,
    });
  });
});
