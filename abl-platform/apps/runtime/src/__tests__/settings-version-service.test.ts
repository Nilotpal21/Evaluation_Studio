/**
 * Settings Version Service Tests
 *
 * Tests for createVersion (happy path, dedup, auto-increment, empty settings),
 * promoteVersion (valid/invalid transitions, optimistic locking),
 * listVersions (pagination, empty).
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted Mocks ──────────────────────────────────────────────────────

const mockFindProjectSettings = vi.fn();
const mockCreateSettingsVersion = vi.fn();
const mockFindSettingsVersion = vi.fn();
const mockFindLatestSettingsVersion = vi.fn();
const mockListSettingsVersions = vi.fn();
const mockCountSettingsVersions = vi.fn();
const mockGetAllSettingsVersionNumbers = vi.fn();
const mockPromoteSettingsVersion = vi.fn();

vi.mock('../repos/project-settings-repo.js', () => ({
  findProjectSettings: (...args: any[]) => mockFindProjectSettings(...args),
  createSettingsVersion: (...args: any[]) => mockCreateSettingsVersion(...args),
  findSettingsVersion: (...args: any[]) => mockFindSettingsVersion(...args),
  findLatestSettingsVersion: (...args: any[]) => mockFindLatestSettingsVersion(...args),
  listSettingsVersions: (...args: any[]) => mockListSettingsVersions(...args),
  countSettingsVersions: (...args: any[]) => mockCountSettingsVersions(...args),
  getAllSettingsVersionNumbers: (...args: any[]) => mockGetAllSettingsVersionNumbers(...args),
  promoteSettingsVersion: (...args: any[]) => mockPromoteSettingsVersion(...args),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@agent-platform/shared/errors', () => ({
  AppError: class AppError extends Error {
    code: string;
    statusCode: number;
    constructor(message: string, opts?: any) {
      super(message);
      this.code = opts?.code ?? 'UNKNOWN';
      this.statusCode = opts?.statusCode ?? 500;
    }
  },
  ErrorCodes: {
    BAD_REQUEST: { code: 'BAD_REQUEST', statusCode: 400 },
    NOT_FOUND: { code: 'NOT_FOUND', statusCode: 404 },
    INTERNAL_ERROR: { code: 'INTERNAL_ERROR', statusCode: 500 },
    UNPROCESSABLE_ENTITY: { code: 'UNPROCESSABLE_ENTITY', statusCode: 422 },
  },
}));

import {
  SettingsVersionService,
  resetSettingsVersionService,
} from '../services/settings-version-service.js';

// ─── Setup ───────────────────────────────────────────────────────────────

describe('SettingsVersionService', () => {
  let svc: SettingsVersionService;

  beforeEach(() => {
    vi.clearAllMocks();
    resetSettingsVersionService();
    svc = new SettingsVersionService();
  });

  // =========================================================================
  // createVersion
  // =========================================================================

  describe('createVersion', () => {
    const params = {
      projectId: 'proj-1',
      tenantId: 'tenant-A',
      createdBy: 'user-1',
    };

    test('happy path — creates first version from working copy', async () => {
      mockFindProjectSettings.mockResolvedValue({
        enableThinking: true,
        thinkingBudget: 4096,
      });
      mockFindLatestSettingsVersion.mockResolvedValue(null);
      mockGetAllSettingsVersionNumbers.mockResolvedValue([]);
      mockCreateSettingsVersion.mockResolvedValue({
        _id: 'ver-001',
        version: '0.1.0',
        sourceHash: 'abc123',
      });

      const result = await svc.createVersion(params);

      expect(result.versionId).toBe('ver-001');
      expect(result.version).toBe('0.1.0');
      expect(result.sourceHash).toHaveLength(16);
      expect(result.deduplicated).toBeUndefined();
      expect(mockCreateSettingsVersion).toHaveBeenCalledOnce();
      expect(mockCreateSettingsVersion).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-A',
          projectId: 'proj-1',
          version: '0.1.0',
          status: 'draft',
          settings: { enableThinking: true, thinkingBudget: 4096, thoughtDescription: null },
          createdBy: 'user-1',
        }),
      );
    });

    test('does not snapshot SDK defaults because JWE policy is live operational config', async () => {
      mockFindProjectSettings.mockResolvedValue({
        enableThinking: true,
        thinkingBudget: null,
        sdkDefaults: {
          hostedExchangeTokenEnvelopePolicy: 'jwe_required',
        },
      });
      mockFindLatestSettingsVersion.mockResolvedValue(null);
      mockGetAllSettingsVersionNumbers.mockResolvedValue([]);
      mockCreateSettingsVersion.mockResolvedValue({
        _id: 'ver-sdk-defaults',
        version: '0.1.0',
        sourceHash: 'abc123',
      });

      await svc.createVersion(params);

      expect(mockCreateSettingsVersion).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: {
            enableThinking: true,
            thinkingBudget: null,
            thoughtDescription: null,
          },
        }),
      );
    });

    test('dedup — returns existing version when sourceHash matches latest', async () => {
      const settingsHash = '1234567890abcdef';
      mockFindProjectSettings.mockResolvedValue({
        enableThinking: false,
        thinkingBudget: null,
      });
      mockFindLatestSettingsVersion.mockResolvedValue({
        _id: 'ver-existing',
        version: '0.1.0',
        sourceHash: settingsHash,
      });

      // Compute the expected hash to match (must include thoughtDescription to match service logic)
      const { createHash } = await import('crypto');
      const expectedHash = createHash('sha256')
        .update(
          JSON.stringify({ enableThinking: false, thinkingBudget: null, thoughtDescription: null }),
        )
        .digest('hex')
        .substring(0, 16);

      // Update mock to return matching hash
      mockFindLatestSettingsVersion.mockResolvedValue({
        _id: 'ver-existing',
        version: '0.1.0',
        sourceHash: expectedHash,
      });

      const result = await svc.createVersion(params);

      expect(result.deduplicated).toBe(true);
      expect(result.versionId).toBe('ver-existing');
      expect(result.version).toBe('0.1.0');
      expect(mockCreateSettingsVersion).not.toHaveBeenCalled();
    });

    test('auto-increment — bumps patch version from existing', async () => {
      mockFindProjectSettings.mockResolvedValue({
        enableThinking: true,
        thinkingBudget: null,
      });
      mockFindLatestSettingsVersion.mockResolvedValue(null);
      mockGetAllSettingsVersionNumbers.mockResolvedValue(['0.1.0', '0.1.1', '0.1.2']);
      mockCreateSettingsVersion.mockResolvedValue({
        _id: 'ver-new',
        version: '0.1.3',
        sourceHash: 'hash123',
      });

      const result = await svc.createVersion(params);

      expect(result.version).toBe('0.1.3');
      expect(mockCreateSettingsVersion).toHaveBeenCalledWith(
        expect.objectContaining({ version: '0.1.3' }),
      );
    });

    test('empty settings — uses defaults when no working copy exists', async () => {
      mockFindProjectSettings.mockResolvedValue(null);
      mockFindLatestSettingsVersion.mockResolvedValue(null);
      mockGetAllSettingsVersionNumbers.mockResolvedValue([]);
      mockCreateSettingsVersion.mockResolvedValue({
        _id: 'ver-defaults',
        version: '0.1.0',
        sourceHash: 'hash-defaults',
      });

      const result = await svc.createVersion(params);

      expect(result.versionId).toBe('ver-defaults');
      expect(mockCreateSettingsVersion).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: { enableThinking: false, thinkingBudget: null, thoughtDescription: null },
        }),
      );
    });

    test('retries on duplicate key error (11000)', async () => {
      mockFindProjectSettings.mockResolvedValue({ enableThinking: true, thinkingBudget: null });
      mockFindLatestSettingsVersion.mockResolvedValue(null);
      mockGetAllSettingsVersionNumbers
        .mockResolvedValueOnce(['0.1.0'])
        .mockResolvedValueOnce(['0.1.0', '0.1.1']);

      const dupeError = Object.assign(new Error('duplicate key'), { code: 11000 });
      mockCreateSettingsVersion
        .mockRejectedValueOnce(dupeError)
        .mockResolvedValueOnce({ _id: 'ver-retry', version: '0.1.2' });

      const result = await svc.createVersion(params);

      expect(result.versionId).toBe('ver-retry');
      expect(mockCreateSettingsVersion).toHaveBeenCalledTimes(2);
    });

    test('throws on invalid changelog', async () => {
      await expect(svc.createVersion({ ...params, changelog: 'x'.repeat(10_001) })).rejects.toThrow(
        'changelog exceeds maximum size',
      );
    });
  });

  // =========================================================================
  // promoteVersion
  // =========================================================================

  describe('promoteVersion', () => {
    const promoteParams = {
      projectId: 'proj-1',
      version: '0.1.0',
      targetStatus: 'testing',
      promotedBy: 'user-1',
      tenantId: 'tenant-A',
    };

    test('valid transition — draft → testing', async () => {
      mockFindSettingsVersion
        .mockResolvedValueOnce({ _id: 'ver-1', status: 'draft', version: '0.1.0' })
        .mockResolvedValueOnce({
          _id: 'ver-1',
          status: 'testing',
          version: '0.1.0',
          promotedBy: 'user-1',
        });
      mockPromoteSettingsVersion.mockResolvedValue({ count: 1 });

      const result = await svc.promoteVersion(promoteParams);

      expect(result.previousStatus).toBe('draft');
      expect(mockPromoteSettingsVersion).toHaveBeenCalledWith({
        id: 'ver-1',
        currentStatus: 'draft',
        newStatus: 'testing',
        promotedBy: 'user-1',
      });
    });

    test('valid transition — testing → staged', async () => {
      mockFindSettingsVersion
        .mockResolvedValueOnce({ _id: 'ver-1', status: 'testing', version: '0.1.0' })
        .mockResolvedValueOnce({ _id: 'ver-1', status: 'staged', version: '0.1.0' });
      mockPromoteSettingsVersion.mockResolvedValue({ count: 1 });

      const result = await svc.promoteVersion({ ...promoteParams, targetStatus: 'staged' });
      expect(result.previousStatus).toBe('testing');
    });

    test('valid transition — staged → active', async () => {
      mockFindSettingsVersion
        .mockResolvedValueOnce({ _id: 'ver-1', status: 'staged', version: '0.1.0' })
        .mockResolvedValueOnce({ _id: 'ver-1', status: 'active', version: '0.1.0' });
      mockPromoteSettingsVersion.mockResolvedValue({ count: 1 });

      const result = await svc.promoteVersion({ ...promoteParams, targetStatus: 'active' });
      expect(result.previousStatus).toBe('staged');
    });

    test('valid transition — active → deprecated', async () => {
      mockFindSettingsVersion
        .mockResolvedValueOnce({ _id: 'ver-1', status: 'active', version: '0.1.0' })
        .mockResolvedValueOnce({ _id: 'ver-1', status: 'deprecated', version: '0.1.0' });
      mockPromoteSettingsVersion.mockResolvedValue({ count: 1 });

      const result = await svc.promoteVersion({
        ...promoteParams,
        targetStatus: 'deprecated',
      });
      expect(result.previousStatus).toBe('active');
    });

    test('invalid transition — draft → active (must go through staged)', async () => {
      mockFindSettingsVersion.mockResolvedValue({
        _id: 'ver-1',
        status: 'draft',
        version: '0.1.0',
      });

      await expect(
        svc.promoteVersion({ ...promoteParams, targetStatus: 'active' }),
      ).rejects.toThrow("Cannot transition from 'draft' to 'active'");
    });

    test('invalid transition — deprecated → anything', async () => {
      mockFindSettingsVersion.mockResolvedValue({
        _id: 'ver-1',
        status: 'deprecated',
        version: '0.1.0',
      });

      await expect(svc.promoteVersion({ ...promoteParams, targetStatus: 'draft' })).rejects.toThrow(
        "Cannot transition from 'deprecated' to 'draft'",
      );
    });

    test('invalid target status', async () => {
      await expect(svc.promoteVersion({ ...promoteParams, targetStatus: 'bogus' })).rejects.toThrow(
        "Invalid target status 'bogus'",
      );
    });

    test('version not found → throws NOT_FOUND', async () => {
      mockFindSettingsVersion.mockResolvedValue(null);

      await expect(svc.promoteVersion(promoteParams)).rejects.toThrow(
        "Settings version '0.1.0' not found",
      );
    });

    test('optimistic lock failure → throws UNPROCESSABLE_ENTITY', async () => {
      mockFindSettingsVersion.mockResolvedValueOnce({
        _id: 'ver-1',
        status: 'draft',
        version: '0.1.0',
      });
      mockPromoteSettingsVersion.mockResolvedValue({ count: 0 });

      await expect(svc.promoteVersion(promoteParams)).rejects.toThrow('Concurrent modification');
    });
  });

  // =========================================================================
  // listVersions
  // =========================================================================

  describe('listVersions', () => {
    test('returns paginated results', async () => {
      const mockVersions = [
        { _id: 'v2', version: '0.1.1' },
        { _id: 'v1', version: '0.1.0' },
      ];
      mockListSettingsVersions.mockResolvedValue(mockVersions);
      mockCountSettingsVersions.mockResolvedValue(5);

      const result = await svc.listVersions({
        projectId: 'proj-1',
        tenantId: 'tenant-A',
        limit: 2,
        offset: 0,
      });

      expect(result.versions).toHaveLength(2);
      expect(result.total).toBe(5);
      expect(mockListSettingsVersions).toHaveBeenCalledWith('proj-1', 'tenant-A', {
        skip: 0,
        take: 2,
      });
    });

    test('empty list', async () => {
      mockListSettingsVersions.mockResolvedValue([]);
      mockCountSettingsVersions.mockResolvedValue(0);

      const result = await svc.listVersions({
        projectId: 'proj-1',
        tenantId: 'tenant-A',
      });

      expect(result.versions).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    test('clamps limit to MAX_LIST_LIMIT (200)', async () => {
      mockListSettingsVersions.mockResolvedValue([]);
      mockCountSettingsVersions.mockResolvedValue(0);

      await svc.listVersions({
        projectId: 'proj-1',
        tenantId: 'tenant-A',
        limit: 999,
      });

      expect(mockListSettingsVersions).toHaveBeenCalledWith('proj-1', 'tenant-A', {
        skip: 0,
        take: 200,
      });
    });
  });

  // =========================================================================
  // nextVersion
  // =========================================================================

  describe('nextVersion', () => {
    test('returns 0.1.0 when no versions exist', async () => {
      mockGetAllSettingsVersionNumbers.mockResolvedValue([]);
      const result = await svc.nextVersion('proj-1', 'tenant-A');
      expect(result).toBe('0.1.0');
    });

    test('increments patch for existing versions', async () => {
      mockGetAllSettingsVersionNumbers.mockResolvedValue(['0.1.0', '0.1.1']);
      const result = await svc.nextVersion('proj-1', 'tenant-A');
      expect(result).toBe('0.1.2');
    });

    test('finds highest version across non-sequential', async () => {
      mockGetAllSettingsVersionNumbers.mockResolvedValue(['0.1.0', '0.2.0', '0.1.5']);
      const result = await svc.nextVersion('proj-1', 'tenant-A');
      expect(result).toBe('0.2.1');
    });
  });

  // =========================================================================
  // Static Validators
  // =========================================================================

  describe('static validators', () => {
    test('isValidStatus accepts valid statuses', () => {
      expect(SettingsVersionService.isValidStatus('draft')).toBe(true);
      expect(SettingsVersionService.isValidStatus('testing')).toBe(true);
      expect(SettingsVersionService.isValidStatus('staged')).toBe(true);
      expect(SettingsVersionService.isValidStatus('active')).toBe(true);
      expect(SettingsVersionService.isValidStatus('deprecated')).toBe(true);
    });

    test('isValidStatus rejects invalid statuses', () => {
      expect(SettingsVersionService.isValidStatus('bogus')).toBe(false);
      expect(SettingsVersionService.isValidStatus('')).toBe(false);
      expect(SettingsVersionService.isValidStatus(null)).toBe(false);
    });

    test('validateChangelog returns null for valid input', () => {
      expect(SettingsVersionService.validateChangelog(undefined)).toBeNull();
      expect(SettingsVersionService.validateChangelog(null)).toBeNull();
      expect(SettingsVersionService.validateChangelog('some changelog')).toBeNull();
    });

    test('validateChangelog rejects non-string', () => {
      expect(SettingsVersionService.validateChangelog(123)).toBe('changelog must be a string');
    });

    test('validateChangelog rejects oversized', () => {
      const result = SettingsVersionService.validateChangelog('x'.repeat(10_001));
      expect(result).toContain('exceeds maximum size');
    });
  });
});
