import { describe, expect, it } from 'vitest';

import {
  applyDriftSyncOutcomesToSession,
  buildDriftTicketDescription,
  buildDriftTicketSummary,
  computeDriftKey,
  computeDriftSyncUpdates,
  driftKeyLabel,
  extractPackageFromPath,
  groupFindingsByDriftKey,
  previewDriftSync,
} from '../integrations/drift-jira-adapter.js';
import type {
  DriftCreateTicketParams,
  DriftJiraClient,
  DriftSyncOutcome,
  DriftSyncRow,
  DriftUpdateTicketParams,
  JiraIssueSummary,
} from '../integrations/drift-jira-adapter.js';
import type { Finding, FindingSeverity, Session } from '../types.js';

function buildFinding(
  overrides: Partial<Finding> & { file: string } & { concernId?: string },
): Finding {
  const {
    file,
    concernId = 'tenant-isolation',
    severity = 'high',
    ...rest
  } = overrides as Partial<Finding> & {
    file: string;
    concernId?: string;
    severity?: FindingSeverity;
  };
  return {
    id: rest.id ?? 'f-' + file,
    category: rest.category ?? 'concern-drift',
    severity,
    status: rest.status ?? 'open',
    title: rest.title ?? 'Tenant Isolation: no-find-by-id',
    description: rest.description ?? 'details',
    files: rest.files ?? [{ path: file, lines: [10, 10] }],
    discoveredBy: rest.discoveredBy ?? 'drift-audit-stage',
    source: rest.source ?? {
      concernId,
      concernTitle: 'Tenant Isolation',
      detectorId: 'no-find-by-id',
    },
    createdAt: rest.createdAt ?? '2026-04-18T00:00:00Z',
    updatedAt: rest.updatedAt ?? '2026-04-18T00:00:00Z',
  };
}

describe('extractPackageFromPath', () => {
  it('returns apps/<pkg> for a deeply nested apps path', () => {
    expect(extractPackageFromPath('apps/runtime/src/index.ts')).toBe('apps/runtime');
  });

  it('returns packages/<pkg> for a deeply nested packages path', () => {
    expect(extractPackageFromPath('packages/helix/src/pipeline/pipeline-engine.ts')).toBe(
      'packages/helix',
    );
  });

  it('falls back to root for top-level files', () => {
    expect(extractPackageFromPath('docker-compose.yml')).toBe('root');
    expect(extractPackageFromPath('CLAUDE.md')).toBe('root');
  });

  it('falls back to root for non-apps/packages top-level dirs', () => {
    expect(extractPackageFromPath('tools/test-capture.ts')).toBe('root');
    expect(extractPackageFromPath('docs/features/helix.md')).toBe('root');
  });

  it('treats empty path as root', () => {
    expect(extractPackageFromPath('')).toBe('root');
  });

  it('tolerates leading slash', () => {
    expect(extractPackageFromPath('/packages/helix/src/types.ts')).toBe('packages/helix');
  });
});

describe('computeDriftKey', () => {
  it('is a 16-char lowercase hex string', () => {
    const k = computeDriftKey('packages/helix', 'tenant-isolation');
    expect(k).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is stable across invocations', () => {
    const a = computeDriftKey('apps/runtime', 'centralized-auth');
    const b = computeDriftKey('apps/runtime', 'centralized-auth');
    expect(a).toBe(b);
  });

  it('differs when package differs', () => {
    const a = computeDriftKey('apps/runtime', 'centralized-auth');
    const b = computeDriftKey('apps/studio', 'centralized-auth');
    expect(a).not.toBe(b);
  });

  it('differs when concern differs', () => {
    const a = computeDriftKey('apps/runtime', 'centralized-auth');
    const b = computeDriftKey('apps/runtime', 'tenant-isolation');
    expect(a).not.toBe(b);
  });
});

describe('driftKeyLabel', () => {
  it('prefixes the drift key with helix-drift-', () => {
    expect(driftKeyLabel('abcdef0123456789')).toBe('helix-drift-abcdef0123456789');
  });
});

describe('groupFindingsByDriftKey', () => {
  it('groups two findings in the same package/concern into one batch', () => {
    const findings: Finding[] = [
      buildFinding({ file: 'packages/helix/src/a.ts', id: 'f1' }),
      buildFinding({ file: 'packages/helix/src/b.ts', id: 'f2' }),
    ];
    const batches = groupFindingsByDriftKey(findings);
    expect(batches).toHaveLength(1);
    expect(batches[0].packageName).toBe('packages/helix');
    expect(batches[0].concernId).toBe('tenant-isolation');
    expect(batches[0].findings).toHaveLength(2);
    expect(batches[0].driftKey).toMatch(/^[0-9a-f]{16}$/);
  });

  it('splits on package boundaries', () => {
    const findings: Finding[] = [
      buildFinding({ file: 'packages/helix/src/a.ts', id: 'f1' }),
      buildFinding({ file: 'apps/runtime/src/a.ts', id: 'f2' }),
    ];
    const batches = groupFindingsByDriftKey(findings);
    expect(batches).toHaveLength(2);
    const pkgs = batches.map((b) => b.packageName);
    expect(pkgs).toEqual(['apps/runtime', 'packages/helix']);
  });

  it('splits on concern boundaries', () => {
    const findings: Finding[] = [
      buildFinding({
        file: 'packages/helix/src/a.ts',
        id: 'f1',
        concernId: 'tenant-isolation',
        source: {
          concernId: 'tenant-isolation',
          concernTitle: 'Tenant Isolation',
          detectorId: 'd1',
        },
      }),
      buildFinding({
        file: 'packages/helix/src/b.ts',
        id: 'f2',
        concernId: 'centralized-auth',
        source: {
          concernId: 'centralized-auth',
          concernTitle: 'Centralized Auth',
          detectorId: 'd1',
        },
      }),
    ];
    const batches = groupFindingsByDriftKey(findings);
    expect(batches).toHaveLength(2);
    expect(batches.map((b) => b.concernId)).toEqual(['centralized-auth', 'tenant-isolation']);
  });

  it('drops findings without source (non-drift findings are not JIRA-routable)', () => {
    const drift = buildFinding({ file: 'packages/helix/src/a.ts', id: 'f1' });
    const nonDrift: Finding = {
      id: 'f2',
      category: 'bug',
      severity: 'high',
      status: 'open',
      title: 'Runtime review finding',
      description: '—',
      files: [{ path: 'apps/runtime/src/x.ts', lines: [1, 1] }],
      discoveredBy: 'review',
      createdAt: '2026-04-18T00:00:00Z',
      updatedAt: '2026-04-18T00:00:00Z',
    };
    const batches = groupFindingsByDriftKey([drift, nonDrift]);
    expect(batches).toHaveLength(1);
    expect(batches[0].findings.map((f) => f.id)).toEqual(['f1']);
  });

  it('returns batches sorted by package then concernId for deterministic preview', () => {
    const findings: Finding[] = [
      buildFinding({
        file: 'packages/helix/src/a.ts',
        id: 'f1',
        concernId: 'zulu',
        source: { concernId: 'zulu', concernTitle: 'Zulu', detectorId: 'd' },
      }),
      buildFinding({
        file: 'apps/studio/src/b.ts',
        id: 'f2',
        concernId: 'alpha',
        source: { concernId: 'alpha', concernTitle: 'Alpha', detectorId: 'd' },
      }),
      buildFinding({
        file: 'apps/runtime/src/c.ts',
        id: 'f3',
        concernId: 'alpha',
        source: { concernId: 'alpha', concernTitle: 'Alpha', detectorId: 'd' },
      }),
    ];
    const batches = groupFindingsByDriftKey(findings);
    expect(batches.map((b) => `${b.packageName}#${b.concernId}`)).toEqual([
      'apps/runtime#alpha',
      'apps/studio#alpha',
      'packages/helix#zulu',
    ]);
  });

  it('tracks highest severity across the batch', () => {
    const findings: Finding[] = [
      buildFinding({ file: 'packages/helix/src/a.ts', id: 'f1', severity: 'low' }),
      buildFinding({ file: 'packages/helix/src/b.ts', id: 'f2', severity: 'critical' }),
      buildFinding({ file: 'packages/helix/src/c.ts', id: 'f3', severity: 'medium' }),
    ];
    const [batch] = groupFindingsByDriftKey(findings);
    expect(batch.highestSeverity).toBe('critical');
  });

  it('sorts findings within a batch by severity desc then by path then by line', () => {
    const findings: Finding[] = [
      buildFinding({
        file: 'packages/helix/src/b.ts',
        id: 'f-low',
        severity: 'low',
      }),
      buildFinding({
        file: 'packages/helix/src/a.ts',
        id: 'f-crit-1',
        severity: 'critical',
        files: [{ path: 'packages/helix/src/a.ts', lines: [20, 20] }],
      }),
      buildFinding({
        file: 'packages/helix/src/a.ts',
        id: 'f-crit-2',
        severity: 'critical',
        files: [{ path: 'packages/helix/src/a.ts', lines: [5, 5] }],
      }),
    ];
    const [batch] = groupFindingsByDriftKey(findings);
    expect(batch.findings.map((f) => f.id)).toEqual(['f-crit-2', 'f-crit-1', 'f-low']);
  });

  it('produces an empty list when there are no drift findings', () => {
    expect(groupFindingsByDriftKey([])).toEqual([]);
  });
});

interface RecordedCreate {
  params: DriftCreateTicketParams;
}
interface RecordedUpdate {
  key: string;
  params: DriftUpdateTicketParams;
}

class FakeJiraClient implements DriftJiraClient {
  readonly searches: Array<{ label: string; projectKey?: string }> = [];
  readonly creates: RecordedCreate[] = [];
  readonly updates: RecordedUpdate[] = [];
  readonly byLabel: Map<string, JiraIssueSummary[]> = new Map();
  createCounter = 0;

  prime(label: string, issues: JiraIssueSummary[]): void {
    this.byLabel.set(label, issues);
  }

  async searchByLabel(label: string, projectKey?: string): Promise<JiraIssueSummary[]> {
    this.searches.push({ label, projectKey });
    return this.byLabel.get(label) ?? [];
  }

  async createTicket(params: DriftCreateTicketParams): Promise<JiraIssueSummary> {
    this.creates.push({ params });
    this.createCounter += 1;
    return {
      key: `ABLP-${1000 + this.createCounter}`,
      summary: params.summary,
      status: 'To Do',
      labels: [...params.labels],
    };
  }

  async updateTicket(key: string, params: DriftUpdateTicketParams): Promise<void> {
    this.updates.push({ key, params });
  }
}

function batchWith(packageName: string, concernId: string, severity: FindingSeverity = 'high') {
  const finding: Finding = {
    id: 'f1',
    category: 'concern-drift',
    severity,
    status: 'open',
    title: `${concernId} detector`,
    description: 'problem',
    files: [{ path: `${packageName}/src/x.ts`, lines: [10, 10] }],
    discoveredBy: 'drift-audit-stage',
    source: {
      concernId,
      concernTitle: concernId,
      detectorId: 'det',
    },
    createdAt: '2026-04-18T00:00:00Z',
    updatedAt: '2026-04-18T00:00:00Z',
  };
  const [batch] = groupFindingsByDriftKey([finding]);
  return batch;
}

describe('previewDriftSync', () => {
  it('classifies a batch with no matching JIRA ticket as CREATE', async () => {
    const client = new FakeJiraClient();
    const batch = batchWith('packages/helix', 'tenant-isolation');

    const rows = await previewDriftSync([batch], { client, projectKey: 'ABLP' });

    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('create');
    expect(rows[0].existingKey).toBeUndefined();
    expect(rows[0].reason).toContain(driftKeyLabel(batch.driftKey));
    expect(client.searches).toEqual([{ label: driftKeyLabel(batch.driftKey), projectKey: 'ABLP' }]);
    expect(client.creates).toEqual([]);
    expect(client.updates).toEqual([]);
  });

  it('classifies a batch with an open matching ticket as UPDATE', async () => {
    const client = new FakeJiraClient();
    const batch = batchWith('apps/runtime', 'centralized-auth');
    client.prime(driftKeyLabel(batch.driftKey), [
      {
        key: 'ABLP-777',
        summary: '[Drift] Centralized Auth in apps/runtime',
        status: 'In Progress',
        labels: [driftKeyLabel(batch.driftKey), 'helix'],
      },
    ]);

    const [row] = await previewDriftSync([batch], { client, projectKey: 'ABLP' });

    expect(row.action).toBe('update');
    expect(row.existingKey).toBe('ABLP-777');
    expect(row.existingStatus).toBe('In Progress');
    expect(row.reason).toContain('ABLP-777');
    expect(client.creates).toEqual([]);
    expect(client.updates).toEqual([]); // preview is read-only
  });

  it('classifies a batch with a closed matching ticket as SKIP (closed)', async () => {
    const client = new FakeJiraClient();
    const batch = batchWith('packages/helix', 'test-integrity');
    client.prime(driftKeyLabel(batch.driftKey), [
      {
        key: 'ABLP-500',
        summary: '[Drift] …',
        status: 'Done',
        labels: [driftKeyLabel(batch.driftKey)],
      },
    ]);

    const [row] = await previewDriftSync([batch], { client, projectKey: 'ABLP' });

    expect(row.action).toBe('skip');
    expect(row.existingKey).toBe('ABLP-500');
    expect(row.existingStatus).toBe('Done');
    expect(row.reason.toLowerCase()).toContain('closed');
  });

  it('treats Won\u2019t Do, Cancelled, Resolved as closed', async () => {
    const client = new FakeJiraClient();
    const batch = batchWith('apps/runtime', 'docs-drift');

    for (const status of ['Resolved', 'Cancelled', "Won't Do"]) {
      client.byLabel.clear();
      client.prime(driftKeyLabel(batch.driftKey), [
        {
          key: 'ABLP-9',
          summary: '…',
          status,
          labels: [driftKeyLabel(batch.driftKey)],
        },
      ]);
      const [row] = await previewDriftSync([batch], { client, projectKey: 'ABLP' });
      expect(row.action).toBe('skip');
      expect(row.existingStatus).toBe(status);
    }
  });

  it('classifies ambiguous matches (multiple open tickets) as SKIP', async () => {
    const client = new FakeJiraClient();
    const batch = batchWith('apps/studio', 'missing-test');
    client.prime(driftKeyLabel(batch.driftKey), [
      { key: 'ABLP-1', summary: 'a', status: 'In Progress', labels: [] },
      { key: 'ABLP-2', summary: 'b', status: 'To Do', labels: [] },
    ]);

    const [row] = await previewDriftSync([batch], { client, projectKey: 'ABLP' });

    expect(row.action).toBe('skip');
    expect(row.reason).toContain('ABLP-1');
    expect(row.reason).toContain('ABLP-2');
  });

  it('uses the open ticket when a closed and an open ticket share the label', async () => {
    const client = new FakeJiraClient();
    const batch = batchWith('packages/compiler', 'performance');
    client.prime(driftKeyLabel(batch.driftKey), [
      { key: 'ABLP-OLD', summary: 'old', status: 'Done', labels: [] },
      { key: 'ABLP-NEW', summary: 'new', status: 'To Do', labels: [] },
    ]);

    const [row] = await previewDriftSync([batch], { client, projectKey: 'ABLP' });

    expect(row.action).toBe('update');
    expect(row.existingKey).toBe('ABLP-NEW');
  });

  it('processes a mix of batches in input order', async () => {
    const client = new FakeJiraClient();
    const batchCreate = batchWith('packages/helix', 'concern-a');
    const batchUpdate = batchWith('packages/helix', 'concern-b');
    client.prime(driftKeyLabel(batchUpdate.driftKey), [
      { key: 'ABLP-42', summary: '…', status: 'To Do', labels: [] },
    ]);

    const rows = await previewDriftSync([batchCreate, batchUpdate], {
      client,
      projectKey: 'ABLP',
    });

    expect(rows.map((r) => r.action)).toEqual(['create', 'update']);
    expect(rows[1].existingKey).toBe('ABLP-42');
  });

  it('is read-only — preview never calls createTicket or updateTicket', async () => {
    const client = new FakeJiraClient();
    const batches = [
      batchWith('packages/helix', 'a'),
      batchWith('apps/runtime', 'b'),
      batchWith('apps/studio', 'c'),
    ];
    await previewDriftSync(batches, { client, projectKey: 'ABLP' });
    expect(client.creates).toEqual([]);
    expect(client.updates).toEqual([]);
  });
});

describe('buildDriftTicketSummary', () => {
  it('formats as [Drift] <concernTitle> in <packageName>', () => {
    const batch = batchWith('packages/helix', 'tenant-isolation');
    expect(buildDriftTicketSummary(batch)).toBe('[Drift] tenant-isolation in packages/helix');
  });
});

describe('buildDriftTicketDescription', () => {
  it('includes a summary section with concern, package, counts, session id, and drift key', () => {
    const batch = batchWith('packages/helix', 'tenant-isolation', 'critical');
    const sections = buildDriftTicketDescription(batch, 'sess-abc123');
    const summary = sections.find((s) => s.heading === 'Drift summary');
    expect(summary).toBeDefined();
    expect(summary?.content).toContain('tenant-isolation');
    expect(summary?.content).toContain('packages/helix');
    expect(summary?.content).toContain('critical');
    expect(summary?.content).toContain('sess-abc123');
    expect(summary?.content).toContain(batch.driftKey);
  });

  it('lists each finding with severity + file:line', () => {
    const batch = batchWith('packages/helix', 'tenant-isolation');
    const sections = buildDriftTicketDescription(batch, 'sess-1');
    const findings = sections.find((s) => s.heading === 'Findings');
    expect(findings).toBeDefined();
    expect(findings?.content).toContain('[HIGH]');
    expect(findings?.content).toContain('packages/helix/src/x.ts:10');
  });

  it('truncates at 50 findings with a "… N more" tail', () => {
    const findings: Finding[] = Array.from({ length: 75 }, (_, i) => ({
      id: `f${i}`,
      category: 'concern-drift',
      severity: 'high',
      status: 'open',
      title: 't',
      description: `finding ${i}`,
      files: [{ path: `packages/helix/src/f${i}.ts`, lines: [i + 1, i + 1] }],
      discoveredBy: 'drift-audit-stage',
      source: { concernId: 'c', concernTitle: 'C', detectorId: 'd' },
      createdAt: '2026-04-18T00:00:00Z',
      updatedAt: '2026-04-18T00:00:00Z',
    }));
    const [batch] = groupFindingsByDriftKey(findings);
    const sections = buildDriftTicketDescription(batch, 'sess-1');
    const findingsSection = sections.find((s) => s.heading === 'Findings')!;
    expect(findingsSection.content).toContain('… 25 more findings truncated');
    const lineCount = findingsSection.content.split('\n').length;
    expect(lineCount).toBe(51); // 50 findings + 1 truncation line
  });

  it('adds a "Suggested fixes" section with deduplicated hints', () => {
    const f1 = {
      id: 'a',
      category: 'concern-drift',
      severity: 'high',
      status: 'open',
      title: 't',
      description: 'd',
      files: [{ path: 'packages/helix/src/a.ts', lines: [1, 1] }],
      discoveredBy: 'drift-audit-stage',
      suggestedFix: 'remove the marker',
      source: { concernId: 'c', concernTitle: 'C', detectorId: 'd' },
      createdAt: 't',
      updatedAt: 't',
    } as const as Finding;
    const f2: Finding = { ...f1, id: 'b', suggestedFix: 'remove the marker' };
    const f3: Finding = { ...f1, id: 'c', suggestedFix: 'use findOne({_id, tenantId})' };
    const [batch] = groupFindingsByDriftKey([f1, f2, f3]);
    const sections = buildDriftTicketDescription(batch, 'sess-1');
    const hints = sections.find((s) => s.heading === 'Suggested fixes')!;
    const lines = hints.content.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines).toContain('- remove the marker');
    expect(lines).toContain('- use findOne({_id, tenantId})');
  });

  it('omits the "Suggested fixes" section when no finding has a fix hint', () => {
    const batch = batchWith('packages/helix', 'tenant-isolation');
    const sections = buildDriftTicketDescription(batch, 'sess-1');
    expect(sections.find((s) => s.heading === 'Suggested fixes')).toBeUndefined();
  });
});

// ─── P3: apply outcomes (ledger + jiraKey backfill) ──────────────────────

function outcome(
  action: 'create' | 'update' | 'skip',
  opts: {
    findings: Finding[];
    concernId?: string;
    existingKey?: string;
    existingStatus?: string;
    createdKey?: string;
    reason?: string;
  },
): DriftSyncOutcome {
  const [batch] = groupFindingsByDriftKey(opts.findings);
  const row: DriftSyncRow = {
    batch,
    action,
    existingKey: opts.existingKey,
    existingStatus: opts.existingStatus,
    reason: opts.reason ?? `${action} batch`,
  };
  return { row, createdKey: opts.createdKey };
}

describe('computeDriftSyncUpdates', () => {
  const syncedAt = '2026-04-18T12:00:00Z';

  it('backfills jiraKey for create outcomes with a new ticket key', () => {
    const findings = [
      buildFinding({ file: 'packages/helix/src/a.ts', id: 'f1' }),
      buildFinding({ file: 'packages/helix/src/b.ts', id: 'f2' }),
    ];
    const out = outcome('create', { findings, createdKey: 'ABLP-1001' });
    const result = computeDriftSyncUpdates([out], syncedAt);
    expect(result.findingJiraKeys.get('f1')).toBe('ABLP-1001');
    expect(result.findingJiraKeys.get('f2')).toBe('ABLP-1001');
    expect(result.ledgerEntries).toHaveLength(1);
    expect(result.ledgerEntries[0]).toMatchObject({
      action: 'created',
      ticketKey: 'ABLP-1001',
      packageName: 'packages/helix',
      concernId: 'tenant-isolation',
      findingIds: ['f1', 'f2'],
      syncedAt,
    });
  });

  it('backfills jiraKey for update outcomes using the existing key', () => {
    const findings = [buildFinding({ file: 'apps/runtime/src/x.ts', id: 'f3' })];
    const out = outcome('update', {
      findings,
      existingKey: 'ABLP-500',
      existingStatus: 'In Progress',
    });
    const result = computeDriftSyncUpdates([out], syncedAt);
    expect(result.findingJiraKeys.get('f3')).toBe('ABLP-500');
    expect(result.ledgerEntries[0]).toMatchObject({
      action: 'updated',
      ticketKey: 'ABLP-500',
      existingStatus: 'In Progress',
    });
  });

  it('does NOT backfill jiraKey for skip outcomes, but records the ledger entry', () => {
    const findings = [buildFinding({ file: 'apps/studio/src/x.ts', id: 'f4' })];
    const out = outcome('skip', {
      findings,
      existingKey: 'ABLP-200',
      existingStatus: 'Done',
      reason: 'existing ticket ABLP-200 is closed (Done)',
    });
    const result = computeDriftSyncUpdates([out], syncedAt);
    expect(result.findingJiraKeys.size).toBe(0);
    expect(result.ledgerEntries[0]).toMatchObject({
      action: 'skipped',
      ticketKey: 'ABLP-200',
      existingStatus: 'Done',
      reason: 'existing ticket ABLP-200 is closed (Done)',
    });
  });

  it('omits jiraKey backfill when a create outcome has no createdKey (dry-run dispatch error)', () => {
    const findings = [buildFinding({ file: 'packages/helix/src/a.ts', id: 'f5' })];
    const out = outcome('create', { findings });
    const result = computeDriftSyncUpdates([out], syncedAt);
    expect(result.findingJiraKeys.size).toBe(0);
    expect(result.ledgerEntries[0]).toMatchObject({
      action: 'created',
      ticketKey: undefined,
    });
  });

  it('handles mixed outcomes in one call in stable order', () => {
    const f1 = buildFinding({ file: 'apps/runtime/src/a.ts', id: 'f1' });
    const f2 = buildFinding({
      file: 'packages/helix/src/b.ts',
      id: 'f2',
      concernId: 'observability',
      source: {
        concernId: 'observability',
        concernTitle: 'Observability',
        detectorId: 'no-console-log',
      },
    });
    const create = outcome('create', { findings: [f1], createdKey: 'ABLP-900' });
    const update = outcome('update', { findings: [f2], existingKey: 'ABLP-800' });
    const result = computeDriftSyncUpdates([create, update], syncedAt);
    expect(result.ledgerEntries).toHaveLength(2);
    expect(result.ledgerEntries[0].action).toBe('created');
    expect(result.ledgerEntries[1].action).toBe('updated');
    expect(result.findingJiraKeys.get('f1')).toBe('ABLP-900');
    expect(result.findingJiraKeys.get('f2')).toBe('ABLP-800');
  });
});

describe('applyDriftSyncOutcomesToSession', () => {
  const syncedAt = '2026-04-18T12:00:00Z';

  function buildSession(findings: Finding[]): Session {
    return {
      id: 'sess-1',
      workItem: { type: 'bug-fix', title: 't', description: 'd' },
      pipelineName: 'drift-audit',
      pipelineVersion: 'drift-audit@abcdef',
      pipelineSnapshot: {
        name: 'drift-audit',
        version: 1,
        stages: [],
      } as unknown as Session['pipelineSnapshot'],
      checkpointApprovals: [],
      oracleCheckpoints: [],
      harnessDefects: [],
      failureAdvisories: [],
      state: 'executing',
      currentStageIndex: 0,
      currentSliceIndex: 0,
      totalSlices: 0,
      slices: [],
      findings,
      decisions: [],
      commits: [],
      journal: [],
      stageHistory: [],
      startedAt: '2026-04-18T00:00:00Z',
      updatedAt: '2026-04-18T00:00:00Z',
    } as Session;
  }

  it('sets jiraKey on matched findings and appends ledger entries', () => {
    const f1 = buildFinding({ file: 'packages/helix/src/a.ts', id: 'f1' });
    const f2 = buildFinding({ file: 'packages/helix/src/b.ts', id: 'f2' });
    const session = buildSession([f1, f2]);
    const out = outcome('create', { findings: [f1, f2], createdKey: 'ABLP-7' });
    applyDriftSyncOutcomesToSession(session, [out], syncedAt);
    expect(session.findings[0].jiraKey).toBe('ABLP-7');
    expect(session.findings[1].jiraKey).toBe('ABLP-7');
    expect(session.jiraTickets).toHaveLength(1);
    expect(session.jiraTickets![0].ticketKey).toBe('ABLP-7');
    expect(session.jiraTickets![0].syncedAt).toBe(syncedAt);
  });

  it('is append-only across reruns (idempotent ledger, no duplicate ticket key)', () => {
    const f1 = buildFinding({ file: 'packages/helix/src/a.ts', id: 'f1' });
    const session = buildSession([f1]);
    const out = outcome('create', { findings: [f1], createdKey: 'ABLP-10' });
    applyDriftSyncOutcomesToSession(session, [out], syncedAt);
    // Simulate rerun: same batch is now UPDATE because the label is found.
    const out2 = outcome('update', {
      findings: [f1],
      existingKey: 'ABLP-10',
      existingStatus: 'To Do',
    });
    applyDriftSyncOutcomesToSession(session, [out2], '2026-04-18T13:00:00Z');
    expect(session.jiraTickets).toHaveLength(2);
    expect(session.jiraTickets![0].action).toBe('created');
    expect(session.jiraTickets![1].action).toBe('updated');
    expect(session.findings[0].jiraKey).toBe('ABLP-10');
  });

  it('leaves findings outside the batch untouched', () => {
    const matched = buildFinding({ file: 'packages/helix/src/a.ts', id: 'in-batch' });
    const unrelated = buildFinding({ file: 'apps/runtime/src/x.ts', id: 'other' });
    const session = buildSession([matched, unrelated]);
    const out = outcome('create', { findings: [matched], createdKey: 'ABLP-42' });
    applyDriftSyncOutcomesToSession(session, [out], syncedAt);
    expect(session.findings.find((f) => f.id === 'in-batch')?.jiraKey).toBe('ABLP-42');
    expect(session.findings.find((f) => f.id === 'other')?.jiraKey).toBeUndefined();
  });

  it('preserves existing jiraTickets on the session (no overwrite)', () => {
    const f1 = buildFinding({ file: 'packages/helix/src/a.ts', id: 'f1' });
    const session = buildSession([f1]);
    session.jiraTickets = [
      {
        driftKey: 'prior000000000000',
        packageName: 'packages/other',
        concernId: 'legacy',
        action: 'created',
        ticketKey: 'ABLP-1',
        findingIds: ['prior'],
        reason: 'prior run',
        syncedAt: '2026-04-17T00:00:00Z',
      },
    ];
    const out = outcome('create', { findings: [f1], createdKey: 'ABLP-99' });
    applyDriftSyncOutcomesToSession(session, [out], syncedAt);
    expect(session.jiraTickets).toHaveLength(2);
    expect(session.jiraTickets![0].ticketKey).toBe('ABLP-1');
    expect(session.jiraTickets![1].ticketKey).toBe('ABLP-99');
  });

  it('no-ops when no outcomes are provided', () => {
    const f1 = buildFinding({ file: 'packages/helix/src/a.ts', id: 'f1' });
    const session = buildSession([f1]);
    applyDriftSyncOutcomesToSession(session, [], syncedAt);
    expect(session.findings[0].jiraKey).toBeUndefined();
    expect(session.jiraTickets).toBeUndefined();
  });
});
