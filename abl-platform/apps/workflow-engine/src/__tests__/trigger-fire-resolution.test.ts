/**
 * Trigger Fire Resolution Tests
 *
 * Tests version-first binding, deployment fallback, working copy fallback,
 * and environment matching in the TriggerEngine.
 *
 * No vi.mock() — uses DI test doubles conforming to TriggerEngineDeps interface.
 * The environmentsMatch() pure function is tested directly.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  TriggerEngine,
  environmentsMatch,
  type TriggerEngineDeps,
} from '../services/trigger-engine.js';

// ─── DI Test Doubles ──────────────────────────────────────────────────────

/**
 * Build a minimal set of TriggerEngineDeps test doubles.
 * Each model method stores/retrieves from simple in-memory state that
 * the test configures before exercising the engine.
 */
function createTestDeps(): TriggerEngineDeps & {
  /** Direct access for test setup */
  _triggers: Map<string, Record<string, unknown>>;
  _workflows: Map<string, Record<string, unknown>>;
  _deployments: Record<string, unknown>[];
  _versions: Map<string, Record<string, unknown>>;
  _startWorkflowCalls: Array<{ executionId: string; input: Record<string, unknown> }>;
} {
  const triggers = new Map<string, Record<string, unknown>>();
  const workflows = new Map<string, Record<string, unknown>>();
  const deployments: Record<string, unknown>[] = [];
  const versions = new Map<string, Record<string, unknown>>();
  const startWorkflowCalls: Array<{
    executionId: string;
    input: Record<string, unknown>;
  }> = [];

  return {
    _triggers: triggers,
    _workflows: workflows,
    _deployments: deployments,
    _versions: versions,
    _startWorkflowCalls: startWorkflowCalls,

    triggerModel: {
      create: async (data: unknown) => {
        const doc = data as Record<string, unknown>;
        triggers.set(doc._id as string, doc);
        return { _id: doc._id as string };
      },
      find: (filter: Record<string, unknown>) => ({
        lean: async () => {
          return Array.from(triggers.values()).filter((t) => {
            for (const [k, v] of Object.entries(filter)) {
              if (t[k] !== v) return false;
            }
            return true;
          });
        },
      }),
      findOne: async (filter: Record<string, unknown>) => {
        for (const t of triggers.values()) {
          let match = true;
          for (const [k, v] of Object.entries(filter)) {
            if (t[k] !== v) {
              match = false;
              break;
            }
          }
          if (match) return t;
        }
        return null;
      },
      findOneAndUpdate: async (
        filter: Record<string, unknown>,
        _update: Record<string, unknown>,
      ) => {
        for (const t of triggers.values()) {
          let match = true;
          for (const [k, v] of Object.entries(filter)) {
            if (t[k] !== v) {
              match = false;
              break;
            }
          }
          if (match) return t;
        }
        return null;
      },
    },

    workflowModel: {
      findOne: async (filter: Record<string, unknown>) => {
        for (const w of workflows.values()) {
          if (w._id === filter._id) {
            return w as {
              _id: string;
              name: string;
              steps?: unknown[];
              nodes?: unknown[];
              edges?: unknown[];
            };
          }
        }
        return null;
      },
      findOneAndUpdate: async () => null,
    },

    restateClient: {
      startWorkflow: async (executionId: string, input: Record<string, unknown>) => {
        startWorkflowCalls.push({ executionId, input });
      },
    },

    deploymentModel: {
      findOne: (filter: Record<string, unknown>) => ({
        sort: (_sort: Record<string, number>) => ({
          lean: async () => {
            for (const d of deployments) {
              let match = true;
              for (const [k, v] of Object.entries(filter)) {
                if (d[k] !== v) {
                  match = false;
                  break;
                }
              }
              if (match) return d;
            }
            return null;
          },
        }),
      }),
    },

    workflowVersionModel: {
      findOne: (filter: Record<string, unknown>) => ({
        lean: async () => {
          // Support lookup by _id or by composite key
          for (const v of versions.values()) {
            let match = true;
            for (const [k, val] of Object.entries(filter)) {
              if (
                val !== null &&
                typeof val === 'object' &&
                '$ne' in (val as Record<string, unknown>)
              ) {
                if (v[k] === (val as Record<string, unknown>).$ne) {
                  match = false;
                  break;
                }
                continue;
              }
              if (v[k] !== val) {
                match = false;
                break;
              }
            }
            if (match) return v;
          }
          return null;
        },
      }),
      find: (filter: Record<string, unknown>) => ({
        lean: async () => {
          return Array.from(versions.values()).filter((v) => {
            for (const [k, val] of Object.entries(filter)) {
              // Only support the literal `{ $ne: 'draft' }` predicate we use
              // in trigger-engine for draft exclusion.
              if (
                val !== null &&
                typeof val === 'object' &&
                '$ne' in (val as Record<string, unknown>)
              ) {
                if (v[k] === (val as Record<string, unknown>).$ne) return false;
                continue;
              }
              if (v[k] !== val) return false;
            }
            return true;
          });
        },
      }),
    },
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('TriggerEngine fire-time resolution (DI doubles)', () => {
  let deps: ReturnType<typeof createTestDeps>;
  let engine: TriggerEngine;

  beforeEach(() => {
    deps = createTestDeps();
    engine = new TriggerEngine(deps);
  });

  // ─── 1. Version-first binding ─────────────────────────────────────────

  describe('version-first binding', () => {
    it('loads version definition when trigger has workflowVersionId', async () => {
      deps._triggers.set('trig-1', {
        _id: 'trig-1',
        workflowId: 'wf-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        status: 'active',
        workflowVersionId: 'wfv-1',
      });

      deps._workflows.set('wf-1', {
        _id: 'wf-1',
        name: 'test_workflow',
        steps: [{ id: 's-working', type: 'http' }],
        nodes: [],
        edges: [],
      });

      deps._versions.set('wfv-1', {
        _id: 'wfv-1',
        workflowId: 'wf-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        version: 'v1.0.0',
        definition: {
          nodes: [
            {
              id: 'n1',
              nodeType: 'start',
              name: 'Start',
              config: {},
            },
            {
              id: 'n2',
              nodeType: 'end',
              name: 'End',
              config: {},
            },
          ],
          edges: [{ id: 'e1', source: 'n1', sourceHandle: 'default', target: 'n2' }],
        },
      });

      const result = await engine.fireWebhookTrigger('trig-1', {}, 'tenant-1', 'project-1');

      expect(result.executionId).toBeDefined();
      expect(deps._startWorkflowCalls).toHaveLength(1);

      const call = deps._startWorkflowCalls[0];
      // Should use version, not working copy steps
      expect(call.input.workflowVersion).toBe('v1.0.0');
      expect(call.input.workflowVersionId).toBe('wfv-1');
    });

    it('falls back when the pinned version belongs to another workflow', async () => {
      deps._triggers.set('trig-1b', {
        _id: 'trig-1b',
        workflowId: 'wf-1b',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        status: 'active',
        workflowVersionId: 'wfv-foreign',
      });

      deps._workflows.set('wf-1b', {
        _id: 'wf-1b',
        name: 'fallback_workflow',
        steps: [{ id: 's-working', type: 'http' }],
        nodes: [],
        edges: [],
      });

      deps._versions.set('wfv-foreign', {
        _id: 'wfv-foreign',
        workflowId: 'wf-other',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        version: 'v9.9.9',
        definition: {
          nodes: [
            { id: 'n1', nodeType: 'start', name: 'Start', config: {} },
            { id: 'n2', nodeType: 'end', name: 'End', config: {} },
          ],
          edges: [{ id: 'e1', source: 'n1', sourceHandle: 'default', target: 'n2' }],
        },
      });

      const result = await engine.fireWebhookTrigger('trig-1b', {}, 'tenant-1', 'project-1');

      expect(result.executionId).toBeDefined();
      const call = deps._startWorkflowCalls[0];
      expect(call.input.workflowVersion).toBeUndefined();
      expect(call.input.workflowVersionId).toBeUndefined();
      expect(call.input.steps).toEqual([{ id: 's-working', type: 'http' }]);
    });
  });

  // ─── 2. Fallback to working copy ──────────────────────────────────────

  describe('working copy fallback', () => {
    it('uses workflow steps when trigger has no workflowVersionId', async () => {
      deps._triggers.set('trig-2', {
        _id: 'trig-2',
        workflowId: 'wf-2',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        status: 'active',
        // no workflowVersionId
        // no environment
      });

      deps._workflows.set('wf-2', {
        _id: 'wf-2',
        name: 'working_copy_wf',
        steps: [{ id: 's1', type: 'http' }],
        nodes: [],
        edges: [],
      });

      const result = await engine.fireWebhookTrigger('trig-2', {}, 'tenant-1', 'project-1');

      expect(result.executionId).toBeDefined();
      expect(deps._startWorkflowCalls).toHaveLength(1);

      const call = deps._startWorkflowCalls[0];
      expect(call.input.steps).toEqual([{ id: 's1', type: 'http' }]);
      // No version info
      expect(call.input.workflowVersion).toBeUndefined();
      expect(call.input.deploymentId).toBeUndefined();
    });
  });

  // ─── 3. fireWebhookTrigger version-first ──────────────────────────────

  describe('version-first skips deployment resolution', () => {
    it('does not look up deployment when version is pinned', async () => {
      deps._triggers.set('trig-3', {
        _id: 'trig-3',
        workflowId: 'wf-3',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        status: 'active',
        workflowVersionId: 'wfv-3',
        environment: 'production',
      });

      deps._workflows.set('wf-3', {
        _id: 'wf-3',
        name: 'pinned_workflow',
        steps: [],
        nodes: [],
        edges: [],
      });

      deps._versions.set('wfv-3', {
        _id: 'wfv-3',
        workflowId: 'wf-3',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        version: 'v2.0.0',
        definition: {
          nodes: [
            { id: 'n1', nodeType: 'start', name: 'Start', config: {} },
            { id: 'n2', nodeType: 'end', name: 'End', config: {} },
          ],
          edges: [{ id: 'e1', source: 'n1', sourceHandle: 'default', target: 'n2' }],
        },
      });

      // Add a deployment — it should NOT be used since version is pinned
      deps._deployments.push({
        _id: 'deploy-99',
        projectId: 'project-1',
        tenantId: 'tenant-1',
        environment: 'production',
        status: 'active',
        workflowVersionManifest: { pinned_workflow: 'v0.0.1' },
      });

      const result = await engine.fireWebhookTrigger(
        'trig-3',
        { environment: 'production' },
        'tenant-1',
        'project-1',
      );

      expect(result.executionId).toBeDefined();
      const call = deps._startWorkflowCalls[0];
      expect(call.input.workflowVersion).toBe('v2.0.0');
      // deploymentId should NOT be set since we used version-first
      expect(call.input.deploymentId).toBeUndefined();
    });
  });

  // ─── 4. Deployment fallback resolution ────────────────────────────────

  describe('deployment fallback', () => {
    it('resolves via deployment when trigger has environment but no versionId', async () => {
      deps._triggers.set('trig-4', {
        _id: 'trig-4',
        workflowId: 'wf-4',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        status: 'active',
        environment: 'staging',
        // no workflowVersionId
      });

      deps._workflows.set('wf-4', {
        _id: 'wf-4',
        name: 'deploy_fallback_wf',
        steps: [{ id: 's-fallback', type: 'http' }],
        nodes: [],
        edges: [],
      });

      deps._deployments.push({
        _id: 'deploy-stg',
        projectId: 'project-1',
        tenantId: 'tenant-1',
        environment: 'staging',
        status: 'active',
        workflowVersionManifest: { deploy_fallback_wf: 'v3.0.0' },
      });

      deps._versions.set('wfv-deploy', {
        _id: 'wfv-deploy',
        workflowId: 'wf-4',
        projectId: 'project-1',
        version: 'v3.0.0',
        tenantId: 'tenant-1',
        definition: {
          nodes: [
            { id: 'n1', nodeType: 'start', name: 'Start', config: {} },
            { id: 'n2', nodeType: 'end', name: 'End', config: {} },
          ],
          edges: [{ id: 'e1', source: 'n1', sourceHandle: 'default', target: 'n2' }],
        },
      });

      const result = await engine.fireWebhookTrigger(
        'trig-4',
        { environment: 'staging' },
        'tenant-1',
        'project-1',
      );

      expect(result.executionId).toBeDefined();
      const call = deps._startWorkflowCalls[0];
      expect(call.input.workflowVersion).toBe('v3.0.0');
      expect(call.input.deploymentId).toBe('deploy-stg');
    });

    it('falls back to working copy when deployment has no manifest entry', async () => {
      deps._triggers.set('trig-5', {
        _id: 'trig-5',
        workflowId: 'wf-5',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        status: 'active',
        environment: 'staging',
      });

      deps._workflows.set('wf-5', {
        _id: 'wf-5',
        name: 'no_manifest_wf',
        steps: [{ id: 's-wc', type: 'http' }],
        nodes: [],
        edges: [],
      });

      deps._deployments.push({
        _id: 'deploy-empty',
        projectId: 'project-1',
        tenantId: 'tenant-1',
        environment: 'staging',
        status: 'active',
        workflowVersionManifest: {}, // no entry for this workflow
      });

      const result = await engine.fireWebhookTrigger(
        'trig-5',
        { environment: 'staging' },
        'tenant-1',
        'project-1',
      );

      expect(result.executionId).toBeDefined();
      const call = deps._startWorkflowCalls[0];
      expect(call.input.steps).toEqual([{ id: 's-wc', type: 'http' }]);
      expect(call.input.workflowVersion).toBeUndefined();
      expect(call.input.deploymentId).toBeUndefined();
    });

    it('falls back to working copy when no active deployment exists', async () => {
      deps._triggers.set('trig-6', {
        _id: 'trig-6',
        workflowId: 'wf-6',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        status: 'active',
        environment: 'production',
      });

      deps._workflows.set('wf-6', {
        _id: 'wf-6',
        name: 'no_deploy_wf',
        steps: [{ id: 's-nodeploy', type: 'http' }],
        nodes: [],
        edges: [],
      });

      // No deployments added

      const result = await engine.fireWebhookTrigger(
        'trig-6',
        { environment: 'production' },
        'tenant-1',
        'project-1',
      );

      const call = deps._startWorkflowCalls[0];
      expect(call.input.steps).toEqual([{ id: 's-nodeploy', type: 'http' }]);
      expect(call.input.workflowVersion).toBeUndefined();
    });
  });

  // ─── 5. Semver-desc default resolution ────────────────────────────────

  describe('semver-desc default resolution (legacy trigger, no deployment)', () => {
    it('picks the highest-semver active published version when trigger has no pin and no deployment', async () => {
      deps._triggers.set('trig-legacy', {
        _id: 'trig-legacy',
        workflowId: 'wf-legacy',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        status: 'active',
        // no workflowVersionId — legacy registration
        // no environment — no deployment resolution
      });

      deps._workflows.set('wf-legacy', {
        _id: 'wf-legacy',
        name: 'legacy_wf',
        steps: [{ id: 's-draft', type: 'http' }],
        nodes: [],
        edges: [],
      });

      const seedVersion = (id: string, version: string) => {
        deps._versions.set(id, {
          _id: id,
          workflowId: 'wf-legacy',
          tenantId: 'tenant-1',
          projectId: 'project-1',
          state: 'active',
          deleted: false,
          version,
          definition: {
            nodes: [
              { id: 'n1', nodeType: 'start', name: 'Start', config: {} },
              { id: 'n2', nodeType: 'end', name: 'End', config: {} },
            ],
            edges: [{ id: 'e1', source: 'n1', sourceHandle: 'default', target: 'n2' }],
          },
        });
      };
      seedVersion('wfv-legacy-a', 'v0.9.0');
      seedVersion('wfv-legacy-b', 'v1.2.0');
      seedVersion('wfv-legacy-c', 'v0.10.0');

      const result = await engine.fireWebhookTrigger('trig-legacy', {}, 'tenant-1', 'project-1');

      expect(result.executionId).toBeDefined();
      const call = deps._startWorkflowCalls[0];
      expect(call.input.workflowVersion).toBe('v1.2.0');
      expect(call.input.workflowVersionId).toBe('wfv-legacy-b');
      expect(call.input.deploymentId).toBeUndefined();
      // Draft working-copy step must NOT have been executed
      expect(call.input.steps).not.toEqual([{ id: 's-draft', type: 'http' }]);
    });

    it('falls through to working copy when every active candidate is inactive', async () => {
      deps._triggers.set('trig-inactive', {
        _id: 'trig-inactive',
        workflowId: 'wf-inactive',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        status: 'active',
      });

      deps._workflows.set('wf-inactive', {
        _id: 'wf-inactive',
        name: 'inactive_wf',
        steps: [{ id: 's-wc-inactive', type: 'http' }],
        nodes: [],
        edges: [],
      });

      deps._versions.set('wfv-inactive', {
        _id: 'wfv-inactive',
        workflowId: 'wf-inactive',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        state: 'inactive', // excluded by the state:'active' filter
        deleted: false,
        version: 'v1.0.0',
        definition: { nodes: [], edges: [] },
      });

      const result = await engine.fireWebhookTrigger('trig-inactive', {}, 'tenant-1', 'project-1');

      const call = deps._startWorkflowCalls[0];
      expect(call.input.workflowVersion).toBeUndefined();
      expect(call.input.steps).toEqual([{ id: 's-wc-inactive', type: 'http' }]);
      expect(result.executionId).toBeDefined();
    });

    it('excludes soft-deleted versions from the default resolution', async () => {
      deps._triggers.set('trig-deleted', {
        _id: 'trig-deleted',
        workflowId: 'wf-deleted',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        status: 'active',
      });

      deps._workflows.set('wf-deleted', {
        _id: 'wf-deleted',
        name: 'deleted_wf',
        steps: [{ id: 's-wc-deleted', type: 'http' }],
        nodes: [],
        edges: [],
      });

      // A version with higher semver but deleted=true must NOT win.
      deps._versions.set('wfv-deleted', {
        _id: 'wfv-deleted',
        workflowId: 'wf-deleted',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        state: 'active',
        deleted: true,
        version: 'v2.0.0',
        definition: { nodes: [], edges: [] },
      });
      deps._versions.set('wfv-kept', {
        _id: 'wfv-kept',
        workflowId: 'wf-deleted',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        state: 'active',
        deleted: false,
        version: 'v1.5.0',
        definition: {
          nodes: [
            { id: 'n1', nodeType: 'start', name: 'Start', config: {} },
            { id: 'n2', nodeType: 'end', name: 'End', config: {} },
          ],
          edges: [{ id: 'e1', source: 'n1', sourceHandle: 'default', target: 'n2' }],
        },
      });

      const result = await engine.fireWebhookTrigger('trig-deleted', {}, 'tenant-1', 'project-1');

      const call = deps._startWorkflowCalls[0];
      expect(call.input.workflowVersion).toBe('v1.5.0');
      expect(call.input.workflowVersionId).toBe('wfv-kept');
      expect(result.executionId).toBeDefined();
    });
  });

  // ─── 6. environmentsMatch() predicate ─────────────────────────────────

  describe('environmentsMatch — pure function', () => {
    it('case 1: both equal non-null → true', () => {
      expect(environmentsMatch('production', 'production')).toBe(true);
    });

    it('case 2: both non-null but different → false', () => {
      expect(environmentsMatch('staging', 'production')).toBe(false);
    });

    it('case 3: event null + trigger set → false', () => {
      expect(environmentsMatch(null, 'production')).toBe(false);
      expect(environmentsMatch(undefined, 'production')).toBe(false);
    });

    it('case 4: event set + trigger null → false', () => {
      expect(environmentsMatch('staging', null)).toBe(false);
      expect(environmentsMatch('staging', undefined)).toBe(false);
    });

    it('case 5: both null/undefined → true', () => {
      expect(environmentsMatch(null, null)).toBe(true);
      expect(environmentsMatch(undefined, undefined)).toBe(true);
      expect(environmentsMatch(null, undefined)).toBe(true);
      expect(environmentsMatch(undefined, null)).toBe(true);
    });
  });

  // ─── 7. Environment mismatch skips trigger ────────────────────────────

  describe('environment mismatch', () => {
    it('throws on environment mismatch', async () => {
      deps._triggers.set('trig-env', {
        _id: 'trig-env',
        workflowId: 'wf-env',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        status: 'active',
        environment: 'production',
      });

      deps._workflows.set('wf-env', {
        _id: 'wf-env',
        name: 'env_mismatch_wf',
        steps: [],
        nodes: [],
        edges: [],
      });

      await expect(
        engine.fireWebhookTrigger('trig-env', { environment: 'staging' }, 'tenant-1', 'project-1'),
      ).rejects.toThrow(/Environment mismatch/);

      expect(deps._startWorkflowCalls).toHaveLength(0);
    });
  });
});
