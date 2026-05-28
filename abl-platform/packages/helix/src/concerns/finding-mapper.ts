/**
 * Deterministic mapping from `DetectorFinding` (concerns audit runner) to
 * `Finding` (helix session model).
 *
 * Re-runs of the same audit must produce stable IDs so that slice-packet
 * assignments and JIRA ticket links stay attached across runs. The ID recipe
 * is sha1 over a canonical join of the identifying fields, truncated to 16
 * hex chars — short enough to read, long enough to avoid collisions inside
 * a single session.
 */

import { createHash } from 'node:crypto';

import type { Finding, FindingCategory } from '../types.js';
import type { DetectorFinding } from './audit-types.js';

const FINDING_ID_LENGTH = 16;

export function concernsAuditFindingId(df: DetectorFinding): string {
  const key = [df.concernId, df.detectorId, df.file, String(df.line), df.matchedText ?? ''].join(
    '::',
  );
  return createHash('sha1').update(key).digest('hex').slice(0, FINDING_ID_LENGTH);
}

export interface MapDetectorFindingOptions {
  readonly discoveredBy: string;
  readonly timestamp: string;
}

export function mapDetectorFindingToFinding(
  df: DetectorFinding,
  options: MapDetectorFindingOptions,
): Finding {
  const title = `${df.concernTitle}: ${df.detectorId}`;
  const snippet = df.matchedText ? df.matchedText.slice(0, 200) : undefined;
  return {
    id: concernsAuditFindingId(df),
    category: resolveFindingCategory(df),
    severity: df.severity,
    status: 'open',
    title,
    description: df.message,
    files: [
      {
        path: df.file,
        lines: [df.line, df.line],
        snippet,
      },
    ],
    suggestedFix: df.fixHint,
    discoveredBy: options.discoveredBy,
    source: {
      concernId: df.concernId,
      concernTitle: df.concernTitle,
      detectorId: df.detectorId,
    },
    createdAt: options.timestamp,
    updatedAt: options.timestamp,
  };
}

/**
 * A handful of registry concerns map cleanly onto existing finding categories
 * (isolation, security, performance, missing-test, missing-doc). Everything
 * else rolls up under the catch-all `concern-drift` category so operators can
 * filter registry-sourced findings as a single group without losing the
 * concern id (which remains available via `discoveredBy` and the title).
 */
function resolveFindingCategory(df: DetectorFinding): FindingCategory {
  const id = df.concernId.toLowerCase();
  if (
    id.includes('tenant-isolation') ||
    id.includes('project-isolation') ||
    id.includes('user-isolation')
  ) {
    return 'isolation';
  }
  if (id.includes('auth') || id.includes('security') || id.includes('secret')) {
    return 'security';
  }
  if (id.includes('performance') || id.includes('unbounded') || id.includes('n-plus-one')) {
    return 'performance';
  }
  if (id.includes('test-integrity') || id.includes('missing-test') || id.includes('mock')) {
    return 'missing-test';
  }
  if (id.includes('docs-drift') || id.includes('missing-doc')) {
    return 'missing-doc';
  }
  return 'concern-drift';
}
