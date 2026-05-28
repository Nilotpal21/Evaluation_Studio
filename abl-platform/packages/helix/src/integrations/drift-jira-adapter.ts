/**
 * Pure, deterministic helpers that convert concerns-audit findings on a helix
 * session into grouped JIRA work. No side effects, no network, no filesystem.
 *
 * Grouping rule: one JIRA ticket per `(package, concernId)` pair. A ticket
 * stays attached across re-runs via a stable `driftKey` label —
 * `sha1("helix-drift::{package}::{concernId}").slice(0,16)` — that the JIRA
 * adapter searches by instead of title/text matching.
 */

import { createHash } from 'node:crypto';

import type { Finding, FindingSeverity, JiraTicketLedgerEntry, Session } from '../types.js';
import {
  buildAdfDescription,
  createTicket as jiraCreateTicket,
  searchByLabel as jiraSearchByLabel,
  updateTicket as jiraUpdateTicket,
} from './jira-client.js';

const DRIFT_KEY_LABEL_PREFIX = 'helix-drift-';
const ROOT_PACKAGE = 'root';

/**
 * Parse the owning package from a repo-relative path. Returns the
 * monorepo-style folder name (`apps/runtime`, `packages/helix`, etc.) when the
 * path starts with `apps/` or `packages/`; otherwise `root`.
 *
 * Parsing the first two segments lets us survive deeply nested files (a
 * finding in `packages/helix/src/pipeline/concerns-audit-stage.ts` still
 * groups under `packages/helix`).
 */
export function extractPackageFromPath(repoRelativePath: string): string {
  if (!repoRelativePath) {
    return ROOT_PACKAGE;
  }
  const segments = repoRelativePath.split('/').filter(Boolean);
  if (segments.length >= 2 && (segments[0] === 'apps' || segments[0] === 'packages')) {
    return `${segments[0]}/${segments[1]}`;
  }
  return ROOT_PACKAGE;
}

/**
 * Deterministic short identifier used both as a JIRA label (for search-based
 * dedup) and as the ledger key on the session. Same package + same concern
 * always collapses to the same key across reruns and across sessions.
 */
export function computeDriftKey(packageName: string, concernId: string): string {
  const key = `helix-drift::${packageName}::${concernId}`;
  return createHash('sha1').update(key).digest('hex').slice(0, 16);
}

export function driftKeyLabel(driftKey: string): string {
  return `${DRIFT_KEY_LABEL_PREFIX}${driftKey}`;
}

export interface DriftBatch {
  readonly driftKey: string;
  readonly packageName: string;
  readonly concernId: string;
  readonly concernTitle: string;
  readonly highestSeverity: FindingSeverity;
  readonly findings: readonly Finding[];
}

/**
 * Group findings that carry `source.concernId` by (package, concernId). A
 * finding without `source` (non-drift origin) is dropped — those don't belong
 * in drift tickets.
 *
 * Batches are returned in a stable order: `packageName` asc, then `concernId`
 * asc, so preview tables and ledger writes stay deterministic across reruns.
 */
export function groupFindingsByDriftKey(findings: readonly Finding[]): DriftBatch[] {
  const acc = new Map<string, MutableBatch>();
  for (const finding of findings) {
    if (!finding.source) {
      continue;
    }
    const filePath = finding.files[0]?.path ?? '';
    const packageName = extractPackageFromPath(filePath);
    const concernId = finding.source.concernId;
    const driftKey = computeDriftKey(packageName, concernId);
    const existing = acc.get(driftKey);
    if (existing) {
      existing.findings.push(finding);
      if (severityRank(finding.severity) > severityRank(existing.highestSeverity)) {
        existing.highestSeverity = finding.severity;
      }
    } else {
      acc.set(driftKey, {
        driftKey,
        packageName,
        concernId,
        concernTitle: finding.source.concernTitle,
        highestSeverity: finding.severity,
        findings: [finding],
      });
    }
  }

  const batches: DriftBatch[] = Array.from(acc.values())
    .map((batch) => ({
      ...batch,
      findings: sortFindingsForDisplay(batch.findings),
    }))
    .sort((a, b) => {
      if (a.packageName !== b.packageName) {
        return a.packageName.localeCompare(b.packageName);
      }
      return a.concernId.localeCompare(b.concernId);
    });

  return batches;
}

interface MutableBatch {
  driftKey: string;
  packageName: string;
  concernId: string;
  concernTitle: string;
  highestSeverity: FindingSeverity;
  findings: Finding[];
}

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function severityRank(severity: FindingSeverity): number {
  return SEVERITY_RANK[severity] ?? 0;
}

function sortFindingsForDisplay(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const sevCmp = severityRank(b.severity) - severityRank(a.severity);
    if (sevCmp !== 0) {
      return sevCmp;
    }
    const pathA = a.files[0]?.path ?? '';
    const pathB = b.files[0]?.path ?? '';
    if (pathA !== pathB) {
      return pathA.localeCompare(pathB);
    }
    const lineA = a.files[0]?.lines?.[0] ?? 0;
    const lineB = b.files[0]?.lines?.[0] ?? 0;
    return lineA - lineB;
  });
}

// ─── Preview (dry-run) ───────────────────────────────────────────

/**
 * JIRA operations needed by the drift-sync preview & apply pipeline. A narrow
 * port — independent of the real REST client — so tests can inject an
 * in-memory fake and we avoid `vi.mock()` of platform modules.
 *
 * `searchByLabel` must query JIRA by the exact drift-key label (`labels = "…"`)
 * and return up to a handful of recent matches. The real implementation lives
 * in `jira-client.ts`; the test double implements just these three methods.
 */
export interface DriftJiraClient {
  searchByLabel(label: string, projectKey?: string): Promise<JiraIssueSummary[]>;
  createTicket(params: DriftCreateTicketParams): Promise<JiraIssueSummary>;
  updateTicket(key: string, params: DriftUpdateTicketParams): Promise<void>;
}

export interface JiraIssueSummary {
  readonly key: string;
  readonly summary: string;
  readonly status: string;
  readonly labels: readonly string[];
}

export interface DriftCreateTicketParams {
  readonly projectKey: string;
  readonly summary: string;
  readonly descriptionSections: readonly DriftDescriptionSection[];
  readonly labels: readonly string[];
}

export interface DriftUpdateTicketParams {
  readonly commentSections?: readonly DriftDescriptionSection[];
  readonly labels?: readonly string[];
}

export interface DriftDescriptionSection {
  readonly heading: string;
  readonly content: string;
}

export type DriftSyncAction = 'create' | 'update' | 'skip';

export interface DriftSyncRow {
  readonly batch: DriftBatch;
  readonly action: DriftSyncAction;
  readonly existingKey?: string;
  readonly existingStatus?: string;
  /** One-line explanation for the preview table — why this action was chosen. */
  readonly reason: string;
}

export interface PreviewDriftSyncOptions {
  readonly client: DriftJiraClient;
  readonly projectKey: string;
}

/**
 * JIRA statuses that mean "this ticket is closed, don't reopen it silently".
 * Lower-cased before comparison. Open statuses (To Do, In Progress, …) get
 * an UPDATE action; closed statuses get SKIP so a human can decide whether
 * to reopen or create a fresh ticket.
 */
const CLOSED_STATUSES = new Set<string>([
  'done',
  'closed',
  'resolved',
  'cancelled',
  'canceled',
  "won't do",
  'wont do',
  'completed',
]);

function isClosedStatus(status: string): boolean {
  return CLOSED_STATUSES.has(status.trim().toLowerCase());
}

/**
 * Dry-run: classify every batch as CREATE / UPDATE / SKIP by searching JIRA
 * for the drift-key label. Never writes — safe to run without confirmation.
 *
 * - CREATE: no ticket carries the drift-key label yet.
 * - UPDATE: exactly one open ticket carries the label.
 * - SKIP (closed): the matching ticket(s) are all closed — a human should
 *   decide whether to reopen or recreate. SKIP protects against re-opening a
 *   "Won't Do" ticket on every daemon poll.
 * - SKIP (ambiguous): multiple open tickets share the label — data anomaly;
 *   caller should investigate before we pick one arbitrarily.
 */
export async function previewDriftSync(
  batches: readonly DriftBatch[],
  options: PreviewDriftSyncOptions,
): Promise<DriftSyncRow[]> {
  const { client, projectKey } = options;
  const rows: DriftSyncRow[] = [];
  for (const batch of batches) {
    const label = driftKeyLabel(batch.driftKey);
    const existing = await client.searchByLabel(label, projectKey);

    if (existing.length === 0) {
      rows.push({
        batch,
        action: 'create',
        reason: `no JIRA ticket carries label ${label}`,
      });
      continue;
    }

    const openTickets = existing.filter((t) => !isClosedStatus(t.status));

    if (openTickets.length === 0) {
      const closest = existing[0];
      rows.push({
        batch,
        action: 'skip',
        existingKey: closest.key,
        existingStatus: closest.status,
        reason: `existing ticket ${closest.key} is closed (${closest.status}); reopen manually if still relevant`,
      });
      continue;
    }

    if (openTickets.length > 1) {
      const keys = openTickets.map((t) => t.key).join(', ');
      rows.push({
        batch,
        action: 'skip',
        existingKey: openTickets[0].key,
        existingStatus: openTickets[0].status,
        reason: `${openTickets.length} open tickets share label ${label} (${keys}); investigate before syncing`,
      });
      continue;
    }

    const [ticket] = openTickets;
    rows.push({
      batch,
      action: 'update',
      existingKey: ticket.key,
      existingStatus: ticket.status,
      reason: `attach to open ticket ${ticket.key} (${ticket.status})`,
    });
  }
  return rows;
}

/**
 * Build the JIRA summary line for a drift ticket. Format is stable so it
 * stays consistent across reruns (no timestamps, no finding counts).
 */
export function buildDriftTicketSummary(batch: DriftBatch): string {
  return `[Drift] ${batch.concernTitle} in ${batch.packageName}`;
}

const MAX_FINDINGS_IN_DESCRIPTION = 50;

/**
 * Compose the ADF-ready sections for a drift ticket. The adapter is a pure
 * string builder; the real JIRA client wraps this with `buildAdfDescription`
 * in the update/create path.
 */
export function buildDriftTicketDescription(
  batch: DriftBatch,
  sessionId: string,
): DriftDescriptionSection[] {
  const sections: DriftDescriptionSection[] = [];

  sections.push({
    heading: 'Drift summary',
    content: [
      `Concern: ${batch.concernTitle} (${batch.concernId})`,
      `Package: ${batch.packageName}`,
      `Findings: ${batch.findings.length} (highest severity: ${batch.highestSeverity})`,
      `Source session: ${sessionId}`,
      `Drift key: ${batch.driftKey}`,
    ].join('\n'),
  });

  const shown = batch.findings.slice(0, MAX_FINDINGS_IN_DESCRIPTION);
  const findingLines = shown.map((f) => {
    const file = f.files[0];
    const loc = file?.lines ? `${file.path}:${file.lines[0]}` : (file?.path ?? '');
    return `[${f.severity.toUpperCase()}] ${loc} — ${f.description}`;
  });
  if (batch.findings.length > MAX_FINDINGS_IN_DESCRIPTION) {
    findingLines.push(
      `… ${batch.findings.length - MAX_FINDINGS_IN_DESCRIPTION} more findings truncated`,
    );
  }
  sections.push({
    heading: 'Findings',
    content: findingLines.length > 0 ? findingLines.join('\n') : '(no findings)',
  });

  const hints = dedupe(
    batch.findings
      .map((f) => f.suggestedFix)
      .filter((s): s is string => typeof s === 'string' && s.length > 0),
  );
  if (hints.length > 0) {
    sections.push({
      heading: 'Suggested fixes',
      content: hints.map((h) => `- ${h}`).join('\n'),
    });
  }

  return sections;
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

// ─── Apply outcomes to session (ledger + jiraKey backfill) ──────────────

/**
 * One preview row paired with the apply result. `createdKey` is set when the
 * adapter actually called `createTicket` and got a new JIRA key back; for
 * update/skip rows it stays undefined (the existing key already lives on the
 * row).
 */
export interface DriftSyncOutcome {
  readonly row: DriftSyncRow;
  readonly createdKey?: string;
}

/**
 * Pure computation: given outcomes, return the `finding.id → jiraKey` map and
 * the append-only ledger entries to tack onto the session. Deterministic — no
 * `Date.now()` inside — so tests can assert exact output for a known input.
 *
 * Only `create` / `update` rows attach `finding.jiraKey`; `skip` rows record
 * the decision in the ledger but do not mark findings as tracked in JIRA.
 */
export function computeDriftSyncUpdates(
  outcomes: readonly DriftSyncOutcome[],
  syncedAt: string,
): { findingJiraKeys: Map<string, string>; ledgerEntries: JiraTicketLedgerEntry[] } {
  const findingJiraKeys = new Map<string, string>();
  const ledgerEntries: JiraTicketLedgerEntry[] = [];

  for (const outcome of outcomes) {
    const { row, createdKey } = outcome;
    const { batch } = row;
    const findingIds = batch.findings.map((f) => f.id);

    let action: JiraTicketLedgerEntry['action'];
    let ticketKey: string | undefined;

    switch (row.action) {
      case 'create':
        action = 'created';
        ticketKey = createdKey;
        break;
      case 'update':
        action = 'updated';
        ticketKey = row.existingKey;
        break;
      case 'skip':
        action = 'skipped';
        ticketKey = row.existingKey;
        break;
    }

    if ((action === 'created' || action === 'updated') && ticketKey) {
      for (const id of findingIds) {
        findingJiraKeys.set(id, ticketKey);
      }
    }

    ledgerEntries.push({
      driftKey: batch.driftKey,
      packageName: batch.packageName,
      concernId: batch.concernId,
      action,
      ticketKey,
      existingStatus: row.existingStatus,
      findingIds,
      reason: row.reason,
      syncedAt,
    });
  }

  return { findingJiraKeys, ledgerEntries };
}

/**
 * Apply outcomes to a session in-place: backfill `finding.jiraKey` for matched
 * findings and append to `session.jiraTickets`. The caller is responsible for
 * persisting (see `SessionManager.recordDriftSyncOutcomes`).
 */
export function applyDriftSyncOutcomesToSession(
  session: Session,
  outcomes: readonly DriftSyncOutcome[],
  syncedAt: string,
): void {
  const { findingJiraKeys, ledgerEntries } = computeDriftSyncUpdates(outcomes, syncedAt);

  if (findingJiraKeys.size > 0) {
    for (const finding of session.findings) {
      const key = findingJiraKeys.get(finding.id);
      if (key) {
        finding.jiraKey = key;
      }
    }
  }

  if (ledgerEntries.length > 0) {
    session.jiraTickets = [...(session.jiraTickets ?? []), ...ledgerEntries];
  }
}

// ─── Real JIRA-backed DriftJiraClient ────────────────────────────────────

/**
 * Build a DriftJiraClient that talks to real JIRA via the existing jira-client
 * functions. The port kept tests mock-free (they pass a FakeJiraClient); this
 * factory wires the production path on top of the same shape.
 */
export function createRealDriftJiraClient(): DriftJiraClient {
  return {
    async searchByLabel(label, projectKey) {
      const issues = await jiraSearchByLabel(label, projectKey);
      return issues.map((issue) => ({
        key: issue.key,
        summary: issue.summary,
        status: issue.status,
        labels: issue.labels ?? [],
      }));
    },
    async createTicket(params) {
      const issue = await jiraCreateTicket({
        projectKey: params.projectKey,
        summary: params.summary,
        description: buildAdfDescription([...params.descriptionSections]),
        labels: [...params.labels],
      });
      return {
        key: issue.key,
        summary: issue.summary,
        status: issue.status,
        labels: issue.labels ?? [...params.labels],
      };
    },
    async updateTicket(key, params) {
      await jiraUpdateTicket(key, {
        comment: params.commentSections
          ? buildAdfDescription([...params.commentSections])
          : undefined,
        labels: params.labels ? [...params.labels] : undefined,
      });
    },
  };
}
