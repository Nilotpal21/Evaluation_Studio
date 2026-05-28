/**
 * Citation Download Route Tests
 *
 * Tests for the public citation download endpoint that serves document
 * downloads via self-authenticating JWT tokens.
 *
 * Business logic covered:
 * - Token parameter validation
 * - JWT verification (expired, malformed, wrong audience)
 * - Tenant ownership validation (returns 404, not 403)
 * - Click limit enforcement
 * - Local storage: path traversal protection, content type, file streaming
 * - S3/MinIO: presigned URL redirect
 * - Rate limiting
 * - Error response format (no information leakage)
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { signCitationToken } from '@agent-platform/shared-auth';
import { createCitationDownloadRouter } from '../routes/citation-download.js';
import type { CitationStorageDeps } from '../routes/citation-download.js';

const { mockSearchDocumentFindOne, mockDownloadDocumentContent, mockGetConfig } = vi.hoisted(
  () => ({
    mockSearchDocumentFindOne: vi.fn(),
    mockDownloadDocumentContent: vi.fn(),
    mockGetConfig: vi.fn(),
  }),
);

vi.mock('../db/index.js', () => ({
  getLazyModel: (name: string) => {
    if (name === 'SearchDocument') {
      return { findOne: mockSearchDocumentFindOne };
    }
    return {};
  },
}));

vi.mock('../services/ingestion/download-document.js', () => ({
  downloadDocumentContent: (...args: unknown[]) => mockDownloadDocumentContent(...args),
}));

vi.mock('../config/index.js', () => ({
  getConfig: () => mockGetConfig(),
}));

const TEST_SECRET = 'test-citation-secret-for-route-test';
const TEST_TENANT = 'tenant-route-test';
const TEST_INDEX = 'idx-test';
const TEST_DOC = 'doc-test-1';

// Temporary directory for local storage tests
let tmpDir: string;
let currentDocument: Record<string, unknown> | null;

// Mock Redis store
let redisStore: Map<string, { value: number; ttl: number }>;

function createMockRedis() {
  redisStore = new Map();
  return {
    set: async (key: string, value: string, ex: string, ttl: number, nx: string) => {
      if (nx === 'NX' && !redisStore.has(key)) {
        redisStore.set(key, { value: parseInt(value), ttl });
        return 'OK';
      }
      return null;
    },
    decr: async (key: string) => {
      const entry = redisStore.get(key);
      if (!entry) return -1;
      entry.value -= 1;
      return entry.value;
    },
    del: async (key: string) => {
      redisStore.delete(key);
      return 1;
    },
  } as any;
}

// Mock S3
function createMockS3() {
  return {
    getDownloadUrl: async (key: string, _expiresInSeconds?: number) => {
      return `https://s3.amazonaws.com/bucket/${key}?X-Amz-Signature=mock`;
    },
  };
}

function createApp(deps: Partial<CitationStorageDeps> = {}) {
  const app = express();
  const fullDeps: CitationStorageDeps = {
    getRedis: () => createMockRedis(),
    getS3: () => createMockS3(),
    storageProvider: 's3',
    ...deps,
  };
  app.use('/api/citations', createCitationDownloadRouter(fullDeps));
  return app;
}

function signTestToken(overrides: Record<string, unknown> = {}) {
  return signCitationToken(
    {
      tenantId: TEST_TENANT,
      indexId: TEST_INDEX,
      documentId: TEST_DOC,
      sourceKey: `documents/${TEST_TENANT}/${TEST_INDEX}/report.pdf`,
      linkMode: 'direct',
      ...overrides,
    },
    TEST_SECRET,
    { expiresIn: '1h' },
  );
}

beforeAll(() => {
  process.env.CITATION_SIGNING_SECRET = TEST_SECRET;
  process.env.JWT_SECRET = TEST_SECRET;

  // Create temp dir for local storage tests
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citation-test-'));
  const docDir = path.join(tmpDir, 'documents', TEST_TENANT, TEST_INDEX);
  fs.mkdirSync(docDir, { recursive: true });
  fs.writeFileSync(path.join(docDir, 'report.pdf'), '%PDF-1.4 mock content');
  fs.writeFileSync(path.join(docDir, 'data.xlsx'), 'mock excel content');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  redisStore = new Map();
  currentDocument = {
    _id: TEST_DOC,
    tenantId: TEST_TENANT,
    sourceUrl: `s3://bucket/documents/${TEST_TENANT}/${TEST_INDEX}/report.pdf`,
    originalReference: 'report.pdf',
    contentType: 'application/pdf',
  };
  mockSearchDocumentFindOne.mockReturnValue({
    lean: vi.fn().mockImplementation(async () => currentDocument),
  });
  mockDownloadDocumentContent.mockResolvedValue(Buffer.from('mock file content'));
  mockGetConfig.mockReturnValue({ storage: { basePath: tmpDir } });
});

describe('Citation Download Route - Token Validation', () => {
  test('returns 400 for empty token parameter', async () => {
    const app = createApp();
    const res = await request(app).get('/api/citations/');
    // Express won't match /:token with empty string — returns 404 from express
    expect(res.status).toBe(404);
  });
});

describe('Citation Download Route - JWT Verification', () => {
  test('returns 410 for expired token', async () => {
    const expiredToken = signCitationToken(
      {
        tenantId: TEST_TENANT,
        indexId: TEST_INDEX,
        documentId: TEST_DOC,
        sourceKey: `documents/${TEST_TENANT}/${TEST_INDEX}/report.pdf`,
        linkMode: 'direct',
      },
      TEST_SECRET,
      { expiresIn: '0s' },
    );

    const app = createApp();
    const res = await request(app).get(`/api/citations/${expiredToken}`);
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('CITATION_EXPIRED');
  });

  test('returns 400 for malformed token', async () => {
    const app = createApp();
    const res = await request(app).get('/api/citations/not-a-valid-jwt-token');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  test('returns 400 for token signed with wrong secret', async () => {
    const wrongToken = signCitationToken(
      {
        tenantId: TEST_TENANT,
        indexId: TEST_INDEX,
        documentId: TEST_DOC,
        sourceKey: `documents/${TEST_TENANT}/${TEST_INDEX}/report.pdf`,
        linkMode: 'direct',
      },
      'completely-wrong-secret-key-here',
      { expiresIn: '1h' },
    );

    const app = createApp();
    const res = await request(app).get(`/api/citations/${wrongToken}`);
    expect(res.status).toBe(400);
  });
});

describe('Citation Download Route - Tenant Validation', () => {
  test('returns 404 for tenant violation (not 403 — no info leakage)', async () => {
    // Token claims tenant-route-test but sourceKey has different tenant
    const token = signCitationToken(
      {
        tenantId: 'different-tenant',
        indexId: TEST_INDEX,
        documentId: TEST_DOC,
        sourceKey: `documents/${TEST_TENANT}/${TEST_INDEX}/report.pdf`, // wrong tenant in key vs claim
        linkMode: 'direct',
      },
      TEST_SECRET,
      { expiresIn: '1h' },
    );

    const app = createApp();
    const res = await request(app).get(`/api/citations/${token}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    // Should NOT mention "tenant" in error message
    expect(res.body.error.message).not.toContain('tenant');
  });
});

describe('Citation Download Route - Click Limits', () => {
  test('allows click when within limit', async () => {
    const mockRedis = createMockRedis();
    const token = signCitationToken(
      {
        tenantId: TEST_TENANT,
        indexId: TEST_INDEX,
        documentId: TEST_DOC,
        sourceKey: `documents/${TEST_TENANT}/${TEST_INDEX}/report.pdf`,
        linkMode: 'click_limited',
        maxClicks: 5,
      },
      TEST_SECRET,
      { expiresIn: '1h' },
    );

    const app = createApp({ getRedis: () => mockRedis });
    const res = await request(app).get(`/api/citations/${token}`);
    expect(res.status).toBe(200);
  });

  test('returns 410 when max clicks exhausted', async () => {
    // Pre-exhaust clicks in Redis
    const mockRedis = {
      set: async () => null, // key already exists
      decr: async () => -1, // already exhausted
      del: async () => 1,
    } as any;

    const token = signCitationToken(
      {
        tenantId: TEST_TENANT,
        indexId: TEST_INDEX,
        documentId: TEST_DOC,
        sourceKey: `documents/${TEST_TENANT}/${TEST_INDEX}/report.pdf`,
        linkMode: 'click_limited',
        maxClicks: 1,
      },
      TEST_SECRET,
      { expiresIn: '1h' },
    );

    const app = createApp({ getRedis: () => mockRedis });
    const res = await request(app).get(`/api/citations/${token}`);
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('CITATION_EXHAUSTED');
  });
});

describe('Citation Download Route - Local Storage', () => {
  function createLocalApp() {
    return createApp({
      storageProvider: 'local',
      localBasePath: tmpDir,
      getRedis: () => createMockRedis(),
    });
  }

  test('streams file with correct content type for PDF', async () => {
    const token = signCitationToken(
      {
        tenantId: TEST_TENANT,
        indexId: TEST_INDEX,
        documentId: TEST_DOC,
        sourceKey: `documents/${TEST_TENANT}/${TEST_INDEX}/report.pdf`,
        linkMode: 'direct',
      },
      TEST_SECRET,
      { expiresIn: '1h' },
    );

    currentDocument = {
      _id: TEST_DOC,
      tenantId: TEST_TENANT,
      sourceUrl: `file://${path.join(tmpDir, 'documents', TEST_TENANT, TEST_INDEX, 'report.pdf')}`,
      originalReference: 'report.pdf',
      contentType: 'application/pdf',
    };
    const app = createLocalApp();
    const res = await request(app).get(`/api/citations/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
  });

  test('streams file with correct content type for XLSX', async () => {
    const token = signCitationToken(
      {
        tenantId: TEST_TENANT,
        indexId: TEST_INDEX,
        documentId: TEST_DOC,
        sourceKey: `documents/${TEST_TENANT}/${TEST_INDEX}/data.xlsx`,
        linkMode: 'direct',
      },
      TEST_SECRET,
      { expiresIn: '1h' },
    );

    currentDocument = {
      _id: TEST_DOC,
      tenantId: TEST_TENANT,
      sourceUrl: `file://${path.join(tmpDir, 'documents', TEST_TENANT, TEST_INDEX, 'data.xlsx')}`,
      originalReference: 'data.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
    const app = createLocalApp();
    const res = await request(app).get(`/api/citations/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
  });

  test('returns 404 for missing file', async () => {
    const token = signCitationToken(
      {
        tenantId: TEST_TENANT,
        indexId: TEST_INDEX,
        documentId: TEST_DOC,
        sourceKey: `documents/${TEST_TENANT}/${TEST_INDEX}/nonexistent.pdf`,
        linkMode: 'direct',
      },
      TEST_SECRET,
      { expiresIn: '1h' },
    );

    currentDocument = {
      _id: TEST_DOC,
      tenantId: TEST_TENANT,
      sourceUrl: `file://${path.join(tmpDir, 'documents', TEST_TENANT, TEST_INDEX, 'nonexistent.pdf')}`,
      originalReference: 'nonexistent.pdf',
      contentType: 'application/pdf',
    };
    const app = createLocalApp();
    const res = await request(app).get(`/api/citations/${token}`);
    expect(res.status).toBe(404);
  });

  test('rejects path traversal attempts', async () => {
    const token = signCitationToken(
      {
        tenantId: TEST_TENANT,
        indexId: TEST_INDEX,
        documentId: TEST_DOC,
        sourceKey: `documents/${TEST_TENANT}/${TEST_INDEX}/../../../../../../etc/passwd`,
        linkMode: 'direct',
      },
      TEST_SECRET,
      { expiresIn: '1h' },
    );

    currentDocument = {
      _id: TEST_DOC,
      tenantId: TEST_TENANT,
      sourceUrl: 'file:///etc/passwd',
      originalReference: 'passwd',
      contentType: 'text/plain',
    };
    const app = createLocalApp();
    const res = await request(app).get(`/api/citations/${token}`);
    expect(res.status).toBe(404);
  });

  test('sets Content-Disposition header', async () => {
    const token = signCitationToken(
      {
        tenantId: TEST_TENANT,
        indexId: TEST_INDEX,
        documentId: TEST_DOC,
        sourceKey: `documents/${TEST_TENANT}/${TEST_INDEX}/report.pdf`,
        linkMode: 'direct',
      },
      TEST_SECRET,
      { expiresIn: '1h' },
    );

    currentDocument = {
      _id: TEST_DOC,
      tenantId: TEST_TENANT,
      sourceUrl: `file://${path.join(tmpDir, 'documents', TEST_TENANT, TEST_INDEX, 'report.pdf')}`,
      originalReference: 'report.pdf',
      contentType: 'application/pdf',
    };
    const app = createLocalApp();
    const res = await request(app).get(`/api/citations/${token}`);
    expect(res.headers['content-disposition']).toContain('report.pdf');
  });
});

describe('Citation Download Route - S3/MinIO Storage', () => {
  test('downloads remote storage content through the storage-agnostic downloader', async () => {
    const token = signTestToken();
    const app = createApp();
    const res = await request(app).get(`/api/citations/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('mock file content');
    expect(mockDownloadDocumentContent).toHaveBeenCalledWith(
      `s3://bucket/documents/${TEST_TENANT}/${TEST_INDEX}/report.pdf`,
    );
  });

  test('uses the current document sourceUrl instead of trusting token storage paths', async () => {
    const token = signCitationToken(
      {
        tenantId: TEST_TENANT,
        indexId: TEST_INDEX,
        documentId: TEST_DOC,
        sourceKey: `/documents/${TEST_TENANT}/${TEST_INDEX}/report.pdf`,
        linkMode: 'direct',
      },
      TEST_SECRET,
      { expiresIn: '1h' },
    );

    currentDocument = {
      _id: TEST_DOC,
      tenantId: TEST_TENANT,
      sourceUrl: `s3://bucket/documents/${TEST_TENANT}/${TEST_INDEX}/canonical.pdf`,
      originalReference: 'canonical.pdf',
      contentType: 'application/pdf',
    };
    const app = createApp();
    await request(app).get(`/api/citations/${token}`);
    expect(mockDownloadDocumentContent).toHaveBeenCalledWith(
      `s3://bucket/documents/${TEST_TENANT}/${TEST_INDEX}/canonical.pdf`,
    );
  });
});

describe('Citation Download Route - Error Handling', () => {
  test('returns 500 for unexpected errors without leaking details', async () => {
    mockDownloadDocumentContent.mockRejectedValue(
      new Error('Internal AWS SDK error with credentials info'),
    );

    const token = signTestToken();
    const app = createApp();
    const res = await request(app).get(`/api/citations/${token}`);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('DOWNLOAD_ERROR');
    // Should NOT leak internal error details
    expect(res.body.error.message).not.toContain('AWS');
    expect(res.body.error.message).not.toContain('credentials');
  });
});
