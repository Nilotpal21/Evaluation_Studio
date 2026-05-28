import { describe, expect, it } from 'vitest';

import type { DetectorFinding } from '../concerns/audit-types.js';
import { concernsAuditFindingId, mapDetectorFindingToFinding } from '../concerns/finding-mapper.js';

function baseDetectorFinding(overrides: Partial<DetectorFinding> = {}): DetectorFinding {
  return {
    concernId: 'tenant-isolation',
    concernTitle: 'Tenant Isolation',
    enforcement: 'blocking',
    rubricConcern: 1,
    detectorId: 'no-find-by-id',
    detectorKind: 'grep',
    severity: 'critical',
    file: 'apps/runtime/src/routes/user.ts',
    line: 42,
    message: 'use findOne with tenantId filter',
    fixHint: 'use findOne({_id, tenantId})',
    matchedText: '.sample(',
    ...overrides,
  };
}

describe('concernsAuditFindingId', () => {
  it('produces a stable 16-char hex id for the same input', () => {
    const df = baseDetectorFinding();
    const first = concernsAuditFindingId(df);
    const second = concernsAuditFindingId(df);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
  });

  it('produces different ids when any identity field changes', () => {
    const baseId = concernsAuditFindingId(baseDetectorFinding());
    expect(concernsAuditFindingId(baseDetectorFinding({ concernId: 'other' }))).not.toBe(baseId);
    expect(concernsAuditFindingId(baseDetectorFinding({ detectorId: 'other' }))).not.toBe(baseId);
    expect(concernsAuditFindingId(baseDetectorFinding({ file: 'other.ts' }))).not.toBe(baseId);
    expect(concernsAuditFindingId(baseDetectorFinding({ line: 43 }))).not.toBe(baseId);
    expect(concernsAuditFindingId(baseDetectorFinding({ matchedText: 'other' }))).not.toBe(baseId);
  });

  it('treats missing matchedText as empty string (same as explicit empty)', () => {
    const withEmpty = concernsAuditFindingId(baseDetectorFinding({ matchedText: '' }));
    const withMissing = concernsAuditFindingId(baseDetectorFinding({ matchedText: undefined }));
    expect(withEmpty).toBe(withMissing);
  });

  it('is insensitive to non-identity fields (severity, message, fixHint)', () => {
    const baseId = concernsAuditFindingId(baseDetectorFinding());
    expect(
      concernsAuditFindingId(baseDetectorFinding({ severity: 'low', message: 'different' })),
    ).toBe(baseId);
  });
});

describe('mapDetectorFindingToFinding', () => {
  it('copies severity, message, and fix hint verbatim', () => {
    const df = baseDetectorFinding();
    const f = mapDetectorFindingToFinding(df, {
      discoveredBy: 'drift-audit-stage',
      timestamp: '2026-04-18T00:00:00Z',
    });
    expect(f.severity).toBe('critical');
    expect(f.description).toBe('use findOne with tenantId filter');
    expect(f.suggestedFix).toBe('use findOne({_id, tenantId})');
    expect(f.discoveredBy).toBe('drift-audit-stage');
    expect(f.createdAt).toBe('2026-04-18T00:00:00Z');
    expect(f.updatedAt).toBe('2026-04-18T00:00:00Z');
    expect(f.status).toBe('open');
  });

  it('preserves structured provenance in source so the JIRA adapter can group without parsing the title', () => {
    const f = mapDetectorFindingToFinding(
      baseDetectorFinding({
        concernId: 'tenant-isolation',
        concernTitle: 'Tenant Isolation',
        detectorId: 'no-find-by-id',
      }),
      { discoveredBy: 'drift-audit-stage', timestamp: '2026-04-18T00:00:00Z' },
    );
    expect(f.source).toEqual({
      concernId: 'tenant-isolation',
      concernTitle: 'Tenant Isolation',
      detectorId: 'no-find-by-id',
    });
  });

  it('builds a single file reference with line range and snippet', () => {
    const f = mapDetectorFindingToFinding(baseDetectorFinding({ matchedText: 'x'.repeat(300) }), {
      discoveredBy: 'x',
      timestamp: 't',
    });
    expect(f.files).toHaveLength(1);
    expect(f.files[0].path).toBe('apps/runtime/src/routes/user.ts');
    expect(f.files[0].lines).toEqual([42, 42]);
    expect(f.files[0].snippet?.length).toBe(200);
  });

  it('maps tenant-isolation concerns to the isolation category', () => {
    const f = mapDetectorFindingToFinding(baseDetectorFinding({ concernId: 'tenant-isolation' }), {
      discoveredBy: 'x',
      timestamp: 't',
    });
    expect(f.category).toBe('isolation');
  });

  it('maps security/auth concerns to the security category', () => {
    expect(
      mapDetectorFindingToFinding(baseDetectorFinding({ concernId: 'centralized-auth' }), {
        discoveredBy: 'x',
        timestamp: 't',
      }).category,
    ).toBe('security');
    expect(
      mapDetectorFindingToFinding(baseDetectorFinding({ concernId: 'secret-handling' }), {
        discoveredBy: 'x',
        timestamp: 't',
      }).category,
    ).toBe('security');
  });

  it('maps performance-like concerns to the performance category', () => {
    expect(
      mapDetectorFindingToFinding(baseDetectorFinding({ concernId: 'unbounded-collections' }), {
        discoveredBy: 'x',
        timestamp: 't',
      }).category,
    ).toBe('performance');
  });

  it('maps test-integrity concerns to missing-test', () => {
    expect(
      mapDetectorFindingToFinding(baseDetectorFinding({ concernId: 'test-integrity' }), {
        discoveredBy: 'x',
        timestamp: 't',
      }).category,
    ).toBe('missing-test');
  });

  it('maps docs-drift concerns to missing-doc', () => {
    expect(
      mapDetectorFindingToFinding(baseDetectorFinding({ concernId: 'docs-drift' }), {
        discoveredBy: 'x',
        timestamp: 't',
      }).category,
    ).toBe('missing-doc');
  });

  it('falls back to concern-drift for concerns without a direct category mapping', () => {
    expect(
      mapDetectorFindingToFinding(baseDetectorFinding({ concernId: 'custom-registry-concern' }), {
        discoveredBy: 'x',
        timestamp: 't',
      }).category,
    ).toBe('concern-drift');
  });

  it('titles include the concern title and detector id so operators can filter', () => {
    const f = mapDetectorFindingToFinding(
      baseDetectorFinding({ concernTitle: 'Tenant Isolation', detectorId: 'no-find-by-id' }),
      { discoveredBy: 'x', timestamp: 't' },
    );
    expect(f.title).toBe('Tenant Isolation: no-find-by-id');
  });
});
