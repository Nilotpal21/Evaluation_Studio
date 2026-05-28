/**
 * resolveWorkflowDefinition — unit tests for the fire-time version cascade.
 *
 * Cascade order (first hit wins):
 *   1. pinned version id
 *   2. deployment manifest (per environment)
 *   3. semver-desc default (among active published versions)
 *   4. draft WorkflowVersion row
 *   5. working-copy legacy `.steps`
 *   6. working-copy legacy canvas (`.nodes` / `.edges`)
 *
 * The module is already DI-shaped (workflowVersionModel, deploymentModel are
 * injected). Tests use in-memory fakes and assert the resolved `tier` plus
 * version/deployment ids — no vi.mock of internal packages.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveWorkflowDefinition,
  type VersionResolutionDeps,
  type WorkflowLike,
} from '../lib/version-resolution.js';

// ─── Fakes ──────────────────────────────────────────────────────────────────

interface VersionRow {
  _id: string;
  workflowId: string;
  tenantId: string;
  projectId: string;
  version: string;
  state?: string;
  deleted?: boolean;
  definition?: { nodes?: unknown[]; edges?: unknown[] };
}

function makeWorkflowVersionModel(
  rows: VersionRow[],
): VersionResolutionDeps['workflowVersionModel'] {
  return {
    findOne(filter: Record<string, unknown>) {
      const match =
        rows.find((r) =>
          Object.entries(filter).every(([k, v]) => {
            if (v !== null && typeof v === 'object' && '$ne' in (v as Record<string, unknown>)) {
              return (r as Record<string, unknown>)[k] !== (v as { $ne: unknown }).$ne;
            }
            return (r as Record<string, unknown>)[k] === v;
          }),
        ) ?? null;
      return { lean: async () => (match ? { ...match } : null) };
    },
    find(filter: Record<string, unknown>) {
      // Match $ne on `version` and equality on the rest — enough for the
      // `version: { $ne: 'draft' }` filter used by the semver-desc tier.
      const matches = rows.filter((r) =>
        Object.entries(filter).every(([k, v]) => {
          if (v !== null && typeof v === 'object' && '$ne' in (v as Record<string, unknown>)) {
            return (r as Record<string, unknown>)[k] !== (v as { $ne: unknown }).$ne;
          }
          return (r as Record<string, unknown>)[k] === v;
        }),
      );
      return { lean: async () => matches.map((r) => ({ ...r })) };
    },
  };
}

interface DeploymentRow {
  _id: string;
  projectId: string;
  tenantId: string;
  environment: string;
  status: string;
  createdAt: Date;
  workflowVersionManifest?: Record<string, string>;
}

function makeDeploymentModel(rows: DeploymentRow[]): VersionResolutionDeps['deploymentModel'] {
  return {
    findOne(filter: Record<string, unknown>) {
      const matches = rows.filter((r) =>
        Object.entries(filter).every(([k, v]) => (r as Record<string, unknown>)[k] === v),
      );
      return {
        sort(sortSpec: Record<string, number>) {
          const sorted = [...matches];
          const [field, dir] = Object.entries(sortSpec)[0] ?? ['createdAt', -1];
          sorted.sort((a, b) => {
            const av = (a as Record<string, unknown>)[field];
            const bv = (b as Record<string, unknown>)[field];
            const av2 = av instanceof Date ? av.getTime() : (av as number);
            const bv2 = bv instanceof Date ? bv.getTime() : (bv as number);
            return dir === -1 ? bv2 - av2 : av2 - bv2;
          });
          return { lean: async () => (sorted[0] ? { ...sorted[0] } : null) };
        },
      };
    },
  };
}

function makeWorkflow(overrides?: Partial<WorkflowLike>): WorkflowLike {
  return {
    _id: 'wf-1',
    name: 'ShipOrder',
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('resolveWorkflowDefinition — Tier 1: pinned version id', () => {
  it('resolves the pinned version when it exists and tags tier=pinned', async () => {
    const versions: VersionRow[] = [
      {
        _id: 'ver-pinned',
        workflowId: 'wf-1',
        tenantId: 't1',
        projectId: 'p1',
        version: '2.0.0',
        state: 'active',
      },
    ];

    const result = await resolveWorkflowDefinition(
      {
        workflow: makeWorkflow(),
        tenantId: 't1',
        projectId: 'p1',
        pinnedVersionId: 'ver-pinned',
      },
      { workflowVersionModel: makeWorkflowVersionModel(versions) },
    );

    expect(result.tier).toBe('pinned');
    expect(result.workflowVersionId).toBe('ver-pinned');
    expect(result.workflowVersion).toBe('2.0.0');
    expect(result.deploymentId).toBeNull();
  });

  it('falls through the cascade when the pinned id does not resolve', async () => {
    // Pinned id set but no matching row → warn + fall through. Here the fall
    // through lands at working-copy-canvas because no other tiers have data.
    const result = await resolveWorkflowDefinition(
      {
        workflow: makeWorkflow(),
        tenantId: 't1',
        projectId: 'p1',
        pinnedVersionId: 'missing-ver',
      },
      { workflowVersionModel: makeWorkflowVersionModel([]) },
    );

    expect(result.tier).toBe('working-copy-canvas');
    expect(result.workflowVersionId).toBeNull();
    expect(result.workflowVersion).toBeNull();
  });

  it('does not resolve pinned versions outside the current workflow scope', async () => {
    const versions: VersionRow[] = [
      {
        _id: 'ver-foreign',
        workflowId: 'wf-foreign',
        tenantId: 't1',
        projectId: 'p1',
        version: '9.9.9',
        state: 'active',
        deleted: false,
      },
    ];

    const result = await resolveWorkflowDefinition(
      {
        workflow: makeWorkflow({
          steps: [{ id: 'legacy-step', type: 'http' }],
        }),
        tenantId: 't1',
        projectId: 'p1',
        pinnedVersionId: 'ver-foreign',
      },
      { workflowVersionModel: makeWorkflowVersionModel(versions) },
    );

    expect(result.tier).toBe('working-copy-steps');
    expect(result.workflowVersionId).toBeNull();
    expect(result.workflowVersion).toBeNull();
  });
});

describe('resolveWorkflowDefinition — Tier 2: deployment manifest', () => {
  it('resolves the version named by the active deployment for the environment', async () => {
    const versions: VersionRow[] = [
      {
        _id: 'ver-prod',
        workflowId: 'wf-1',
        tenantId: 't1',
        projectId: 'p1',
        version: '1.2.0',
      },
    ];
    const deployments: DeploymentRow[] = [
      {
        _id: 'dep-1',
        projectId: 'p1',
        tenantId: 't1',
        environment: 'prod',
        status: 'active',
        createdAt: new Date('2026-04-18T00:00:00Z'),
        workflowVersionManifest: { ShipOrder: '1.2.0' },
      },
    ];

    const result = await resolveWorkflowDefinition(
      {
        workflow: makeWorkflow(),
        tenantId: 't1',
        projectId: 'p1',
        environment: 'prod',
      },
      {
        workflowVersionModel: makeWorkflowVersionModel(versions),
        deploymentModel: makeDeploymentModel(deployments),
      },
    );

    expect(result.tier).toBe('deployment');
    expect(result.workflowVersion).toBe('1.2.0');
    expect(result.workflowVersionId).toBe('ver-prod');
    expect(result.deploymentId).toBe('dep-1');
  });

  it('picks the most recent deployment by createdAt (sort desc)', async () => {
    const versions: VersionRow[] = [
      {
        _id: 'ver-a',
        workflowId: 'wf-1',
        tenantId: 't1',
        projectId: 'p1',
        version: '1.0.0',
      },
      {
        _id: 'ver-b',
        workflowId: 'wf-1',
        tenantId: 't1',
        projectId: 'p1',
        version: '1.1.0',
      },
    ];
    const deployments: DeploymentRow[] = [
      {
        _id: 'dep-old',
        projectId: 'p1',
        tenantId: 't1',
        environment: 'prod',
        status: 'active',
        createdAt: new Date('2026-04-10T00:00:00Z'),
        workflowVersionManifest: { ShipOrder: '1.0.0' },
      },
      {
        _id: 'dep-new',
        projectId: 'p1',
        tenantId: 't1',
        environment: 'prod',
        status: 'active',
        createdAt: new Date('2026-04-18T00:00:00Z'),
        workflowVersionManifest: { ShipOrder: '1.1.0' },
      },
    ];

    const result = await resolveWorkflowDefinition(
      {
        workflow: makeWorkflow(),
        tenantId: 't1',
        projectId: 'p1',
        environment: 'prod',
      },
      {
        workflowVersionModel: makeWorkflowVersionModel(versions),
        deploymentModel: makeDeploymentModel(deployments),
      },
    );

    expect(result.deploymentId).toBe('dep-new');
    expect(result.workflowVersion).toBe('1.1.0');
  });

  it('falls through to the semver-desc tier when the deployment does not name this workflow', async () => {
    const versions: VersionRow[] = [
      {
        _id: 'ver-sem',
        workflowId: 'wf-1',
        tenantId: 't1',
        projectId: 'p1',
        version: '0.9.0',
        state: 'active',
        deleted: false,
      },
    ];
    const deployments: DeploymentRow[] = [
      {
        _id: 'dep-x',
        projectId: 'p1',
        tenantId: 't1',
        environment: 'prod',
        status: 'active',
        createdAt: new Date('2026-04-18T00:00:00Z'),
        // Manifest does not include ShipOrder — cascade should fall through.
        workflowVersionManifest: { SomeOtherFlow: '3.0.0' },
      },
    ];

    const result = await resolveWorkflowDefinition(
      {
        workflow: makeWorkflow(),
        tenantId: 't1',
        projectId: 'p1',
        environment: 'prod',
      },
      {
        workflowVersionModel: makeWorkflowVersionModel(versions),
        deploymentModel: makeDeploymentModel(deployments),
      },
    );

    expect(result.tier).toBe('semver-desc');
    expect(result.workflowVersion).toBe('0.9.0');
  });

  it('does not resolve a soft-deleted version from the deployment manifest', async () => {
    const versions: VersionRow[] = [
      {
        _id: 'ver-deleted',
        workflowId: 'wf-1',
        tenantId: 't1',
        projectId: 'p1',
        version: '1.2.0',
        deleted: true,
      },
    ];
    const deployments: DeploymentRow[] = [
      {
        _id: 'dep-1',
        projectId: 'p1',
        tenantId: 't1',
        environment: 'prod',
        status: 'active',
        createdAt: new Date('2026-04-18T00:00:00Z'),
        workflowVersionManifest: { ShipOrder: '1.2.0' },
      },
    ];

    const result = await resolveWorkflowDefinition(
      {
        workflow: makeWorkflow({
          steps: [{ id: 'legacy-step', type: 'http' }],
        }),
        tenantId: 't1',
        projectId: 'p1',
        environment: 'prod',
      },
      {
        workflowVersionModel: makeWorkflowVersionModel(versions),
        deploymentModel: makeDeploymentModel(deployments),
      },
    );

    expect(result.tier).toBe('working-copy-steps');
    expect(result.workflowVersion).toBeNull();
    expect(result.workflowVersionId).toBeNull();
  });
});

describe('resolveWorkflowDefinition — Tier 3: semver-desc default', () => {
  it('returns the highest semver among active published versions', async () => {
    const versions: VersionRow[] = [
      {
        _id: 'v-099',
        workflowId: 'wf-1',
        tenantId: 't1',
        projectId: 'p1',
        version: '0.9.9',
        state: 'active',
        deleted: false,
      },
      {
        _id: 'v-100',
        workflowId: 'wf-1',
        tenantId: 't1',
        projectId: 'p1',
        version: '1.0.0',
        state: 'active',
        deleted: false,
      },
      {
        _id: 'v-201',
        workflowId: 'wf-1',
        tenantId: 't1',
        projectId: 'p1',
        version: '2.0.1',
        state: 'active',
        deleted: false,
      },
      {
        _id: 'v-110',
        workflowId: 'wf-1',
        tenantId: 't1',
        projectId: 'p1',
        version: '1.1.0',
        state: 'active',
        deleted: false,
      },
    ];

    const result = await resolveWorkflowDefinition(
      { workflow: makeWorkflow(), tenantId: 't1', projectId: 'p1' },
      { workflowVersionModel: makeWorkflowVersionModel(versions) },
    );

    expect(result.tier).toBe('semver-desc');
    expect(result.workflowVersion).toBe('2.0.1');
    expect(result.workflowVersionId).toBe('v-201');
  });

  it('excludes the draft row from the semver comparison', async () => {
    const versions: VersionRow[] = [
      {
        _id: 'v-draft',
        workflowId: 'wf-1',
        tenantId: 't1',
        projectId: 'p1',
        version: 'draft',
        state: 'active',
        deleted: false,
      },
      {
        _id: 'v-010',
        workflowId: 'wf-1',
        tenantId: 't1',
        projectId: 'p1',
        version: '0.1.0',
        state: 'active',
        deleted: false,
      },
    ];

    const result = await resolveWorkflowDefinition(
      { workflow: makeWorkflow(), tenantId: 't1', projectId: 'p1' },
      { workflowVersionModel: makeWorkflowVersionModel(versions) },
    );

    expect(result.tier).toBe('semver-desc');
    expect(result.workflowVersion).toBe('0.1.0');
  });
});

describe('resolveWorkflowDefinition — Tier 4: draft row', () => {
  it('resolves the draft WorkflowVersion when no published versions exist', async () => {
    const versions: VersionRow[] = [
      {
        _id: 'v-draft',
        workflowId: 'wf-1',
        tenantId: 't1',
        projectId: 'p1',
        version: 'draft',
        deleted: false,
      },
    ];

    const result = await resolveWorkflowDefinition(
      { workflow: makeWorkflow(), tenantId: 't1', projectId: 'p1' },
      { workflowVersionModel: makeWorkflowVersionModel(versions) },
    );

    expect(result.tier).toBe('draft');
    expect(result.workflowVersion).toBe('draft');
    expect(result.workflowVersionId).toBe('v-draft');
  });
});

describe('resolveWorkflowDefinition — Tier 5/6: working copy fallback', () => {
  it('tier=working-copy-steps when legacy `.steps` array is populated', async () => {
    const workflow: WorkflowLike = {
      _id: 'wf-1',
      name: 'Legacy',
      steps: [{ id: 's1', type: 'http' }],
    };

    const result = await resolveWorkflowDefinition(
      { workflow, tenantId: 't1', projectId: 'p1' },
      { workflowVersionModel: makeWorkflowVersionModel([]) },
    );

    expect(result.tier).toBe('working-copy-steps');
    expect(result.steps).toEqual([{ id: 's1', type: 'http' }]);
    expect(result.workflowVersion).toBeNull();
    expect(result.workflowVersionId).toBeNull();
  });

  it('tier=working-copy-canvas when no version rows and no legacy steps exist', async () => {
    const result = await resolveWorkflowDefinition(
      { workflow: makeWorkflow(), tenantId: 't1', projectId: 'p1' },
      { workflowVersionModel: makeWorkflowVersionModel([]) },
    );

    expect(result.tier).toBe('working-copy-canvas');
    expect(result.steps).toEqual([]);
    expect(result.workflowVersion).toBeNull();
  });

  it('returns working-copy fallback even with no version/deployment models injected', async () => {
    // Defensive: cron/webhook callers that bypass the version model entirely
    // must still get a resolved result (empty) rather than crashing.
    const result = await resolveWorkflowDefinition(
      { workflow: makeWorkflow(), tenantId: 't1', projectId: 'p1' },
      {},
    );

    expect(result.tier).toBe('working-copy-canvas');
  });
});

describe('resolveWorkflowDefinition — cascade priority', () => {
  // Guards the "first hit wins" contract. Populate data at every tier and
  // verify pinned still wins. If the cascade order accidentally changed, this
  // test would fail loudly.
  it('pinned (Tier 1) wins over deployment/semver/draft/working-copy', async () => {
    const versions: VersionRow[] = [
      {
        _id: 'pinned-id',
        workflowId: 'wf-1',
        tenantId: 't1',
        projectId: 'p1',
        version: '0.0.1',
      },
      // Plus a semver-desc candidate and a draft — pinned should short-circuit.
      {
        _id: 'sem-id',
        workflowId: 'wf-1',
        tenantId: 't1',
        projectId: 'p1',
        version: '99.99.99',
        state: 'active',
        deleted: false,
      },
      {
        _id: 'draft-id',
        workflowId: 'wf-1',
        tenantId: 't1',
        projectId: 'p1',
        version: 'draft',
        deleted: false,
      },
    ];

    const result = await resolveWorkflowDefinition(
      {
        workflow: makeWorkflow({ steps: [{ id: 's', type: 'http' }] }),
        tenantId: 't1',
        projectId: 'p1',
        pinnedVersionId: 'pinned-id',
      },
      { workflowVersionModel: makeWorkflowVersionModel(versions) },
    );

    expect(result.tier).toBe('pinned');
    expect(result.workflowVersionId).toBe('pinned-id');
  });
});

describe('resolveWorkflowDefinition — startInputVariables propagation', () => {
  // Regression guard for LLD Phase 2 wiring. A single tier dropping
  // `startInputVariables` would silently revert that fire path to
  // unvalidated execution — the exact GAP-14-class bug that motivated
  // this feature. Every tier's return block MUST propagate the field.
  const declaredVars = [
    { name: 'email', type: 'string' as const, required: true },
    { name: 'amount', type: 'number' as const, required: false },
  ];

  function makeVersionDoc(id: string, version: string, extra: Record<string, unknown> = {}) {
    return {
      _id: id,
      workflowId: 'wf-1',
      tenantId: 't1',
      projectId: 'p1',
      version,
      state: 'active',
      deleted: false,
      definition: {
        nodes: [
          {
            id: 'start-1',
            nodeType: 'start',
            name: 'Start',
            config: { inputVariables: declaredVars },
          },
          { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
        ],
        edges: [{ id: 'e1', source: 'start-1', target: 'end-1' }],
      },
      ...extra,
    };
  }

  it('tier pinned surfaces startInputVariables', async () => {
    const result = await resolveWorkflowDefinition(
      {
        workflow: makeWorkflow({ nodes: [], edges: [] }),
        tenantId: 't1',
        projectId: 'p1',
        pinnedVersionId: 'v-1',
      },
      { workflowVersionModel: makeWorkflowVersionModel([makeVersionDoc('v-1', '1.0.0')]) },
    );
    expect(result.tier).toBe('pinned');
    expect(result.startInputVariables).toEqual(declaredVars);
  });

  it('tier semver-desc surfaces startInputVariables', async () => {
    const result = await resolveWorkflowDefinition(
      {
        workflow: makeWorkflow({ nodes: [], edges: [] }),
        tenantId: 't1',
        projectId: 'p1',
      },
      { workflowVersionModel: makeWorkflowVersionModel([makeVersionDoc('v-sem', '2.0.0')]) },
    );
    expect(result.tier).toBe('semver-desc');
    expect(result.startInputVariables).toEqual(declaredVars);
  });

  it('tier draft surfaces startInputVariables', async () => {
    // Only a draft row exists (no active published versions); draft tier fires.
    const result = await resolveWorkflowDefinition(
      {
        workflow: makeWorkflow({ nodes: [], edges: [] }),
        tenantId: 't1',
        projectId: 'p1',
      },
      {
        workflowVersionModel: makeWorkflowVersionModel([
          makeVersionDoc('v-draft', 'draft', { state: undefined }),
        ]),
      },
    );
    expect(result.tier).toBe('draft');
    expect(result.startInputVariables).toEqual(declaredVars);
  });

  it('tier working-copy-steps surfaces startInputVariables from canvas conversion', async () => {
    // Legacy workflow with `.steps` + canvas nodes on the same doc.
    const workflow = makeWorkflow({
      steps: [{ id: 'legacy-s', type: 'http' }],
      nodes: [
        {
          id: 'start-1',
          nodeType: 'start',
          name: 'Start',
          config: { inputVariables: declaredVars },
        },
      ],
      edges: [],
    });
    const result = await resolveWorkflowDefinition(
      { workflow, tenantId: 't1', projectId: 'p1' },
      {},
    );
    expect(result.tier).toBe('working-copy-steps');
    expect(result.startInputVariables).toEqual(declaredVars);
  });

  it('tier working-copy-canvas surfaces startInputVariables', async () => {
    const workflow = makeWorkflow({
      nodes: [
        {
          id: 'start-1',
          nodeType: 'start',
          name: 'Start',
          config: { inputVariables: declaredVars },
        },
        { id: 'end-1', nodeType: 'end', name: 'End', config: {} },
      ],
      edges: [{ id: 'e1', source: 'start-1', target: 'end-1' }],
    });
    const result = await resolveWorkflowDefinition(
      { workflow, tenantId: 't1', projectId: 'p1' },
      {},
    );
    expect(result.tier).toBe('working-copy-canvas');
    expect(result.startInputVariables).toEqual(declaredVars);
  });

  // Tier 2 (deployment) exercises the same propagation code path as tier 1;
  // covered implicitly by tier 1's assertion on the shared `conversion.startInputVariables`
  // read. The other 5 tiers are each covered above.
});
