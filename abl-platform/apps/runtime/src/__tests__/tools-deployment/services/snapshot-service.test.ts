/**
 * Deployment Snapshot Service Tests
 *
 * Tests createDeploymentSnapshot and computeSnapshotDiff functions.
 * Verifies snapshot creation with proper variable aggregation, namespace lookups,
 * hash computation, and diff detection between snapshots.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';

// =============================================================================
// MOCKS — must be declared before imports
// =============================================================================

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockDeploymentVariableSnapshot = {
  create: vi.fn(),
};

const mockEnvironmentVariable = {
  find: vi.fn(),
};

const mockProjectConfigVariable = {
  find: vi.fn(),
};

const mockVariableNamespaceMembership = {
  find: vi.fn(),
};

const mockVariableNamespace = {
  find: vi.fn(),
};

vi.mock('@agent-platform/database/models', () => ({
  DeploymentVariableSnapshot: mockDeploymentVariableSnapshot,
  EnvironmentVariable: mockEnvironmentVariable,
  ProjectConfigVariable: mockProjectConfigVariable,
  VariableNamespaceMembership: mockVariableNamespaceMembership,
  VariableNamespace: mockVariableNamespace,
}));

// =============================================================================
// IMPORTS — after mocks
// =============================================================================

import {
  createDeploymentSnapshot,
  computeSnapshotDiff,
} from '../../../services/snapshot-service.js';

// =============================================================================
// HELPERS
// =============================================================================

function mockLeanChain(data: any[]) {
  return {
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(data),
  };
}

function mockFindChain(data: any[]) {
  return {
    lean: vi.fn().mockResolvedValue(data),
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('Snapshot Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createDeploymentSnapshot', () => {
    const baseParams = {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      deploymentId: 'deployment-1',
      environment: 'production',
      createdBy: 'user-1',
    };

    it('creates snapshot with correct env vars and config vars', async () => {
      const envVars = [
        {
          _id: 'env-1',
          key: 'API_KEY',
          encryptedValue: 'encrypted-value-1',
          isSecret: true,
          description: 'API key for service',
        },
        {
          _id: 'env-2',
          key: 'DATABASE_URL',
          encryptedValue: 'encrypted-value-2',
          isSecret: true,
          description: null,
        },
      ];

      const configVars = [
        {
          _id: 'config-1',
          key: 'MAX_RETRIES',
          value: '3',
          description: 'Maximum retry count',
        },
        {
          _id: 'config-2',
          key: 'TIMEOUT',
          value: '5000',
          description: null,
        },
      ];

      mockEnvironmentVariable.find.mockReturnValue(mockLeanChain(envVars));
      mockProjectConfigVariable.find.mockReturnValue(mockFindChain(configVars));
      mockVariableNamespaceMembership.find.mockReturnValue(mockFindChain([]));
      mockVariableNamespace.find.mockReturnValue(mockFindChain([]));
      mockDeploymentVariableSnapshot.create.mockResolvedValue({
        ...baseParams,
        snapshotVersion: 1,
        snapshotHash: 'computed-hash',
        envVars: [],
        configVars: [],
      });

      await createDeploymentSnapshot(baseParams);

      expect(mockDeploymentVariableSnapshot.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          projectId: 'project-1',
          deploymentId: 'deployment-1',
          environment: 'production',
          createdBy: 'user-1',
          snapshotVersion: 1,
          envVars: expect.arrayContaining([
            expect.objectContaining({
              key: 'API_KEY',
              encryptedValue: 'encrypted-value-1',
              isSecret: true,
              description: 'API key for service',
              sourceId: 'env-1',
              namespaces: [],
            }),
            expect.objectContaining({
              key: 'DATABASE_URL',
              encryptedValue: 'encrypted-value-2',
              isSecret: true,
              description: null,
              sourceId: 'env-2',
              namespaces: [],
            }),
          ]),
          configVars: expect.arrayContaining([
            expect.objectContaining({
              key: 'MAX_RETRIES',
              value: '3',
              description: 'Maximum retry count',
              sourceId: 'config-1',
              namespaces: [],
            }),
            expect.objectContaining({
              key: 'TIMEOUT',
              value: '5000',
              description: null,
              sourceId: 'config-2',
              namespaces: [],
            }),
          ]),
        }),
      );
    });

    it('computes SHA-256 hash from variable values', async () => {
      const envVars = [
        {
          _id: 'env-1',
          key: 'KEY_A',
          encryptedValue: 'encrypted-a',
          isSecret: true,
          description: null,
        },
      ];

      const configVars = [
        {
          _id: 'config-1',
          key: 'KEY_B',
          value: 'value-b',
          description: null,
        },
      ];

      mockEnvironmentVariable.find.mockReturnValue(mockLeanChain(envVars));
      mockProjectConfigVariable.find.mockReturnValue(mockFindChain(configVars));
      mockVariableNamespaceMembership.find.mockReturnValue(mockFindChain([]));
      mockVariableNamespace.find.mockReturnValue(mockFindChain([]));
      mockDeploymentVariableSnapshot.create.mockResolvedValue({});

      // Compute expected hash
      const hashInput = ['env:KEY_A=encrypted-a', 'config:KEY_B=value-b'].join('\n');
      const expectedHash = createHash('sha256').update(hashInput).digest('hex');

      await createDeploymentSnapshot(baseParams);

      expect(mockDeploymentVariableSnapshot.create).toHaveBeenCalledWith(
        expect.objectContaining({
          snapshotHash: expectedHash,
        }),
      );
    });

    it('includes namespace names in snapshot vars via membership lookups', async () => {
      const envVars = [
        {
          _id: 'env-1',
          key: 'API_KEY',
          encryptedValue: 'encrypted-value',
          isSecret: true,
          description: null,
        },
      ];

      const configVars = [
        {
          _id: 'config-1',
          key: 'TIMEOUT',
          value: '5000',
          description: null,
        },
      ];

      const memberships = [
        {
          variableId: 'env-1',
          namespaceId: 'ns-1',
        },
        {
          variableId: 'env-1',
          namespaceId: 'ns-2',
        },
        {
          variableId: 'config-1',
          namespaceId: 'ns-1',
        },
      ];

      const namespaces = [
        { _id: 'ns-1', name: 'production' },
        { _id: 'ns-2', name: 'api' },
      ];

      mockEnvironmentVariable.find.mockReturnValue(mockLeanChain(envVars));
      mockProjectConfigVariable.find.mockReturnValue(mockFindChain(configVars));
      mockVariableNamespaceMembership.find.mockReturnValue(mockFindChain(memberships));
      mockVariableNamespace.find.mockReturnValue(mockFindChain(namespaces));
      mockDeploymentVariableSnapshot.create.mockResolvedValue({});

      await createDeploymentSnapshot(baseParams);

      expect(mockDeploymentVariableSnapshot.create).toHaveBeenCalledWith(
        expect.objectContaining({
          envVars: [
            expect.objectContaining({
              key: 'API_KEY',
              namespaces: ['api', 'production'], // sorted
            }),
          ],
          configVars: [
            expect.objectContaining({
              key: 'TIMEOUT',
              namespaces: ['production'],
            }),
          ],
        }),
      );
    });

    it('sorts env vars and config vars by key', async () => {
      const envVars = [
        { _id: 'env-3', key: 'ZEBRA', encryptedValue: 'z', isSecret: false, description: null },
        { _id: 'env-1', key: 'ALPHA', encryptedValue: 'a', isSecret: false, description: null },
        { _id: 'env-2', key: 'BETA', encryptedValue: 'b', isSecret: false, description: null },
      ];

      const configVars = [
        { _id: 'config-2', key: 'GAMMA', value: 'g', description: null },
        { _id: 'config-1', key: 'DELTA', value: 'd', description: null },
      ];

      mockEnvironmentVariable.find.mockReturnValue(mockLeanChain(envVars));
      mockProjectConfigVariable.find.mockReturnValue(mockFindChain(configVars));
      mockVariableNamespaceMembership.find.mockReturnValue(mockFindChain([]));
      mockVariableNamespace.find.mockReturnValue(mockFindChain([]));
      mockDeploymentVariableSnapshot.create.mockResolvedValue({});

      await createDeploymentSnapshot(baseParams);

      const createCall = mockDeploymentVariableSnapshot.create.mock.calls[0][0];
      expect(createCall.envVars.map((v: any) => v.key)).toEqual(['ALPHA', 'BETA', 'ZEBRA']);
      expect(createCall.configVars.map((v: any) => v.key)).toEqual(['DELTA', 'GAMMA']);
    });

    it('handles empty variables (no env vars, no config vars)', async () => {
      mockEnvironmentVariable.find.mockReturnValue(mockLeanChain([]));
      mockProjectConfigVariable.find.mockReturnValue(mockFindChain([]));
      mockVariableNamespaceMembership.find.mockReturnValue(mockFindChain([]));
      mockVariableNamespace.find.mockReturnValue(mockFindChain([]));
      mockDeploymentVariableSnapshot.create.mockResolvedValue({});

      await createDeploymentSnapshot(baseParams);

      expect(mockDeploymentVariableSnapshot.create).toHaveBeenCalledWith(
        expect.objectContaining({
          envVars: [],
          configVars: [],
          snapshotHash: createHash('sha256').update('').digest('hex'),
        }),
      );
    });

    it('handles variables with no namespace memberships', async () => {
      const envVars = [
        {
          _id: 'env-1',
          key: 'ORPHAN_VAR',
          encryptedValue: 'value',
          isSecret: false,
          description: null,
        },
      ];

      mockEnvironmentVariable.find.mockReturnValue(mockLeanChain(envVars));
      mockProjectConfigVariable.find.mockReturnValue(mockFindChain([]));
      mockVariableNamespaceMembership.find.mockReturnValue(mockFindChain([]));
      mockVariableNamespace.find.mockReturnValue(mockFindChain([]));
      mockDeploymentVariableSnapshot.create.mockResolvedValue({});

      await createDeploymentSnapshot(baseParams);

      expect(mockDeploymentVariableSnapshot.create).toHaveBeenCalledWith(
        expect.objectContaining({
          envVars: [
            expect.objectContaining({
              key: 'ORPHAN_VAR',
              namespaces: [],
            }),
          ],
        }),
      );
    });

    it('queries environment variables without encryption metadata fields', async () => {
      mockEnvironmentVariable.find.mockReturnValue(mockLeanChain([]));
      mockProjectConfigVariable.find.mockReturnValue(mockFindChain([]));
      mockVariableNamespaceMembership.find.mockReturnValue(mockFindChain([]));
      mockVariableNamespace.find.mockReturnValue(mockFindChain([]));
      mockDeploymentVariableSnapshot.create.mockResolvedValue({});

      await createDeploymentSnapshot(baseParams);

      // Verify select() was called with fields that exclude encryption metadata
      const selectCall = mockEnvironmentVariable.find().select;
      expect(selectCall).toHaveBeenCalledWith(
        '_id key encryptedValue isSecret description environment',
      );
    });

    it('defaults isSecret to false when missing', async () => {
      const envVars = [
        {
          _id: 'env-1',
          key: 'VAR',
          encryptedValue: 'value',
          // isSecret is missing
          description: null,
        },
      ];

      mockEnvironmentVariable.find.mockReturnValue(mockLeanChain(envVars));
      mockProjectConfigVariable.find.mockReturnValue(mockFindChain([]));
      mockVariableNamespaceMembership.find.mockReturnValue(mockFindChain([]));
      mockVariableNamespace.find.mockReturnValue(mockFindChain([]));
      mockDeploymentVariableSnapshot.create.mockResolvedValue({});

      await createDeploymentSnapshot(baseParams);

      expect(mockDeploymentVariableSnapshot.create).toHaveBeenCalledWith(
        expect.objectContaining({
          envVars: [
            expect.objectContaining({
              isSecret: false,
            }),
          ],
        }),
      );
    });
  });

  describe('base + override variable merging in snapshot', () => {
    const baseParams = {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      deploymentId: 'deployment-merge',
      environment: 'staging',
      createdBy: 'user-1',
    };

    it('includes base variables (environment: null) in snapshot when no override exists', async () => {
      const envVars = [
        {
          _id: 'env-base-1',
          key: 'BASE_KEY',
          encryptedValue: 'enc-base',
          isSecret: true,
          description: null,
          environment: null,
        },
      ];

      mockEnvironmentVariable.find.mockReturnValue(mockLeanChain(envVars));
      mockProjectConfigVariable.find.mockReturnValue(mockFindChain([]));
      mockVariableNamespaceMembership.find.mockReturnValue(mockFindChain([]));
      mockVariableNamespace.find.mockReturnValue(mockFindChain([]));
      mockDeploymentVariableSnapshot.create.mockResolvedValue({});

      await createDeploymentSnapshot(baseParams);

      expect(mockDeploymentVariableSnapshot.create).toHaveBeenCalledWith(
        expect.objectContaining({
          envVars: [
            expect.objectContaining({
              key: 'BASE_KEY',
              encryptedValue: 'enc-base',
            }),
          ],
        }),
      );
    });

    it('environment-specific override wins over base for the same key', async () => {
      const envVars = [
        {
          _id: 'env-base',
          key: 'SHARED_KEY',
          encryptedValue: 'enc-base-val',
          isSecret: true,
          description: null,
          environment: null,
        },
        {
          _id: 'env-staging',
          key: 'SHARED_KEY',
          encryptedValue: 'enc-staging-val',
          isSecret: true,
          description: null,
          environment: 'staging',
        },
      ];

      mockEnvironmentVariable.find.mockReturnValue(mockLeanChain(envVars));
      mockProjectConfigVariable.find.mockReturnValue(mockFindChain([]));
      mockVariableNamespaceMembership.find.mockReturnValue(mockFindChain([]));
      mockVariableNamespace.find.mockReturnValue(mockFindChain([]));
      mockDeploymentVariableSnapshot.create.mockResolvedValue({});

      await createDeploymentSnapshot(baseParams);

      const createCall = mockDeploymentVariableSnapshot.create.mock.calls[0][0];
      expect(createCall.envVars).toHaveLength(1);
      expect(createCall.envVars[0].key).toBe('SHARED_KEY');
      expect(createCall.envVars[0].encryptedValue).toBe('enc-staging-val');
      expect(createCall.envVars[0].sourceId).toBe('env-staging');
    });

    it('both base and override variables merge correctly', async () => {
      const envVars = [
        {
          _id: 'env-base-only',
          key: 'BASE_ONLY',
          encryptedValue: 'enc-base-only',
          isSecret: false,
          description: null,
          environment: null,
        },
        {
          _id: 'env-override-base',
          key: 'OVERRIDDEN',
          encryptedValue: 'enc-base-overridden',
          isSecret: true,
          description: null,
          environment: null,
        },
        {
          _id: 'env-override-staging',
          key: 'OVERRIDDEN',
          encryptedValue: 'enc-staging-overridden',
          isSecret: true,
          description: null,
          environment: 'staging',
        },
        {
          _id: 'env-staging-only',
          key: 'STAGING_ONLY',
          encryptedValue: 'enc-staging-only',
          isSecret: false,
          description: null,
          environment: 'staging',
        },
      ];

      mockEnvironmentVariable.find.mockReturnValue(mockLeanChain(envVars));
      mockProjectConfigVariable.find.mockReturnValue(mockFindChain([]));
      mockVariableNamespaceMembership.find.mockReturnValue(mockFindChain([]));
      mockVariableNamespace.find.mockReturnValue(mockFindChain([]));
      mockDeploymentVariableSnapshot.create.mockResolvedValue({});

      await createDeploymentSnapshot(baseParams);

      const createCall = mockDeploymentVariableSnapshot.create.mock.calls[0][0];
      // Should have 3 unique keys: BASE_ONLY, OVERRIDDEN (staging wins), STAGING_ONLY
      expect(createCall.envVars).toHaveLength(3);
      const keys = createCall.envVars.map((v: any) => v.key);
      expect(keys).toEqual(['BASE_ONLY', 'OVERRIDDEN', 'STAGING_ONLY']); // sorted

      // OVERRIDDEN should use the staging value, not the base
      const overridden = createCall.envVars.find((v: any) => v.key === 'OVERRIDDEN');
      expect(overridden.encryptedValue).toBe('enc-staging-overridden');
      expect(overridden.sourceId).toBe('env-override-staging');
    });
  });

  describe('computeSnapshotDiff', () => {
    it('detects added env vars', () => {
      const source = {
        envVars: [{ key: 'VAR_A', encryptedValue: 'val-a', namespaces: ['ns1'] }],
        configVars: [],
      };

      const target = {
        envVars: [
          { key: 'VAR_A', encryptedValue: 'val-a', namespaces: ['ns1'] },
          { key: 'VAR_B', encryptedValue: 'val-b', namespaces: ['ns2'] },
        ],
        configVars: [],
      };

      const diff = computeSnapshotDiff(source, target);

      expect(diff.added).toEqual([{ key: 'VAR_B', type: 'env', namespaces: ['ns2'] }]);
      expect(diff.removed).toEqual([]);
      expect(diff.changed).toEqual([]);
    });

    it('detects removed env vars', () => {
      const source = {
        envVars: [
          { key: 'VAR_A', encryptedValue: 'val-a', namespaces: [] },
          { key: 'VAR_B', encryptedValue: 'val-b', namespaces: [] },
        ],
        configVars: [],
      };

      const target = {
        envVars: [{ key: 'VAR_A', encryptedValue: 'val-a', namespaces: [] }],
        configVars: [],
      };

      const diff = computeSnapshotDiff(source, target);

      expect(diff.added).toEqual([]);
      expect(diff.removed).toEqual([{ key: 'VAR_B', type: 'env', namespaces: [] }]);
      expect(diff.changed).toEqual([]);
    });

    it('detects changed env vars (different encryptedValue)', () => {
      const source = {
        envVars: [{ key: 'VAR_A', encryptedValue: 'old-value', namespaces: ['default'] }],
        configVars: [],
      };

      const target = {
        envVars: [{ key: 'VAR_A', encryptedValue: 'new-value', namespaces: ['default'] }],
        configVars: [],
      };

      const diff = computeSnapshotDiff(source, target);

      expect(diff.added).toEqual([]);
      expect(diff.removed).toEqual([]);
      expect(diff.changed).toEqual([
        { key: 'VAR_A', type: 'env', valueChanged: true, namespaces: ['default'] },
      ]);
    });

    it('detects added config vars', () => {
      const source = {
        envVars: [],
        configVars: [{ key: 'CONFIG_A', value: 'val-a', namespaces: [] }],
      };

      const target = {
        envVars: [],
        configVars: [
          { key: 'CONFIG_A', value: 'val-a', namespaces: [] },
          { key: 'CONFIG_B', value: 'val-b', namespaces: ['prod'] },
        ],
      };

      const diff = computeSnapshotDiff(source, target);

      expect(diff.added).toEqual([{ key: 'CONFIG_B', type: 'config', namespaces: ['prod'] }]);
      expect(diff.removed).toEqual([]);
      expect(diff.changed).toEqual([]);
    });

    it('detects removed config vars', () => {
      const source = {
        envVars: [],
        configVars: [
          { key: 'CONFIG_A', value: 'val-a', namespaces: [] },
          { key: 'CONFIG_B', value: 'val-b', namespaces: [] },
        ],
      };

      const target = {
        envVars: [],
        configVars: [{ key: 'CONFIG_A', value: 'val-a', namespaces: [] }],
      };

      const diff = computeSnapshotDiff(source, target);

      expect(diff.added).toEqual([]);
      expect(diff.removed).toEqual([{ key: 'CONFIG_B', type: 'config', namespaces: [] }]);
      expect(diff.changed).toEqual([]);
    });

    it('detects changed config vars (different value)', () => {
      const source = {
        envVars: [],
        configVars: [{ key: 'CONFIG_A', value: 'old-value', namespaces: [] }],
      };

      const target = {
        envVars: [],
        configVars: [{ key: 'CONFIG_A', value: 'new-value', namespaces: [] }],
      };

      const diff = computeSnapshotDiff(source, target);

      expect(diff.added).toEqual([]);
      expect(diff.removed).toEqual([]);
      expect(diff.changed).toEqual([
        { key: 'CONFIG_A', type: 'config', valueChanged: true, namespaces: [] },
      ]);
    });

    it('handles identical snapshots (no diff)', () => {
      const source = {
        envVars: [{ key: 'VAR_A', encryptedValue: 'val-a', namespaces: [] }],
        configVars: [{ key: 'CONFIG_A', value: 'val-a', namespaces: [] }],
      };

      const target = {
        envVars: [{ key: 'VAR_A', encryptedValue: 'val-a', namespaces: [] }],
        configVars: [{ key: 'CONFIG_A', value: 'val-a', namespaces: [] }],
      };

      const diff = computeSnapshotDiff(source, target);

      expect(diff.added).toEqual([]);
      expect(diff.removed).toEqual([]);
      expect(diff.changed).toEqual([]);
    });

    it('handles empty source and target', () => {
      const source = { envVars: [], configVars: [] };
      const target = { envVars: [], configVars: [] };

      const diff = computeSnapshotDiff(source, target);

      expect(diff.added).toEqual([]);
      expect(diff.removed).toEqual([]);
      expect(diff.changed).toEqual([]);
    });

    it('preserves namespace info in diff results', () => {
      const source = {
        envVars: [{ key: 'VAR_A', encryptedValue: 'val-a', namespaces: ['ns1', 'ns2'] }],
        configVars: [],
      };

      const target = {
        envVars: [
          { key: 'VAR_A', encryptedValue: 'new-val', namespaces: ['ns1', 'ns2'] },
          { key: 'VAR_B', encryptedValue: 'val-b', namespaces: ['ns3'] },
        ],
        configVars: [],
      };

      const diff = computeSnapshotDiff(source, target);

      expect(diff.added[0].namespaces).toEqual(['ns3']);
      expect(diff.changed[0].namespaces).toEqual(['ns1', 'ns2']);
    });

    it('handles missing namespaces field (defaults to empty array)', () => {
      const source = {
        envVars: [{ key: 'VAR_A', encryptedValue: 'val-a' } as any],
        configVars: [],
      };

      const target = {
        envVars: [
          { key: 'VAR_A', encryptedValue: 'val-a' } as any,
          { key: 'VAR_B', encryptedValue: 'val-b' } as any,
        ],
        configVars: [],
      };

      const diff = computeSnapshotDiff(source, target);

      expect(diff.added[0].namespaces).toEqual([]);
    });

    it('detects multiple changes across env and config vars', () => {
      const source = {
        envVars: [
          { key: 'ENV_A', encryptedValue: 'old-a', namespaces: [] },
          { key: 'ENV_B', encryptedValue: 'val-b', namespaces: [] },
        ],
        configVars: [
          { key: 'CONFIG_X', value: 'old-x', namespaces: [] },
          { key: 'CONFIG_Y', value: 'val-y', namespaces: [] },
        ],
      };

      const target = {
        envVars: [
          { key: 'ENV_A', encryptedValue: 'new-a', namespaces: [] },
          { key: 'ENV_C', encryptedValue: 'val-c', namespaces: [] },
        ],
        configVars: [
          { key: 'CONFIG_X', value: 'new-x', namespaces: [] },
          { key: 'CONFIG_Z', value: 'val-z', namespaces: [] },
        ],
      };

      const diff = computeSnapshotDiff(source, target);

      expect(diff.added).toEqual([
        { key: 'ENV_C', type: 'env', namespaces: [] },
        { key: 'CONFIG_Z', type: 'config', namespaces: [] },
      ]);
      expect(diff.removed).toEqual([
        { key: 'ENV_B', type: 'env', namespaces: [] },
        { key: 'CONFIG_Y', type: 'config', namespaces: [] },
      ]);
      expect(diff.changed).toEqual([
        { key: 'ENV_A', type: 'env', valueChanged: true, namespaces: [] },
        { key: 'CONFIG_X', type: 'config', valueChanged: true, namespaces: [] },
      ]);
    });
  });
});
