/**
 * `helix drift sync <sessionId>` — preview drift findings as JIRA work, then
 * (with confirmation) create/update tickets and append the outcomes to the
 * session ledger.
 *
 * Split out of cli.ts to keep the top-level dispatch shallow and to make the
 * command body unit-testable via a `DriftJiraClient` / `DriftSyncIo` pair.
 */

import type { Session } from '../types.js';
import type { SessionManager } from '../session/session-manager.js';
import {
  applyDriftSyncOutcomesToSession,
  buildDriftTicketDescription,
  buildDriftTicketSummary,
  driftKeyLabel,
  groupFindingsByDriftKey,
  previewDriftSync,
  type DriftBatch,
  type DriftJiraClient,
  type DriftSyncOutcome,
  type DriftSyncRow,
} from './drift-jira-adapter.js';

export interface DriftSyncIo {
  out(line: string): void;
  err(line: string): void;
  /** Return the user's reply to a yes/no prompt. Implementations strip trailing newlines. */
  promptYesNo(question: string): Promise<string>;
  /** Wall-clock source — injectable so tests assert exact syncedAt values. */
  now(): Date;
}

export interface DriftSyncOptions {
  readonly sessionId: string;
  readonly projectKey: string;
  readonly autoApprove: boolean;
  readonly dryRun: boolean;
}

export interface DriftSyncResult {
  readonly preview: readonly DriftSyncRow[];
  readonly outcomes: readonly DriftSyncOutcome[];
  readonly createdCount: number;
  readonly updatedCount: number;
  readonly skippedCount: number;
  readonly aborted: boolean;
}

/** Exit value for CLI callers that want a stable return code per outcome. */
export type DriftSyncExitReason =
  | 'no-drift-findings'
  | 'dry-run'
  | 'user-aborted'
  | 'applied'
  | 'nothing-to-apply';

export async function runDriftSync(params: {
  sessionManager: SessionManager;
  jira: DriftJiraClient;
  io: DriftSyncIo;
  options: DriftSyncOptions;
}): Promise<{ result: DriftSyncResult; reason: DriftSyncExitReason }> {
  const { sessionManager, jira, io, options } = params;

  const session = await sessionManager.load(options.sessionId);
  io.out(`Session ${session.id} — ${session.workItem.title}`);
  io.out(`State:    ${session.state}`);
  io.out(`Findings: ${session.findings.length} total`);

  const batches = groupFindingsByDriftKey(session.findings);

  if (batches.length === 0) {
    io.out('');
    io.out('No drift-sourced findings on this session. Nothing to sync.');
    return {
      result: {
        preview: [],
        outcomes: [],
        createdCount: 0,
        updatedCount: 0,
        skippedCount: 0,
        aborted: false,
      },
      reason: 'no-drift-findings',
    };
  }

  io.out('');
  io.out(
    `Grouping into ${batches.length} drift batch${batches.length === 1 ? '' : 'es'} (one JIRA ticket each).`,
  );
  io.out(`JIRA project: ${options.projectKey}`);
  io.out('');

  const preview = await previewDriftSync(batches, { client: jira, projectKey: options.projectKey });
  renderPreviewTable(preview, io);

  const createRows = preview.filter((r) => r.action === 'create');
  const updateRows = preview.filter((r) => r.action === 'update');
  const skipRows = preview.filter((r) => r.action === 'skip');

  io.out('');
  io.out(
    `Plan: ${createRows.length} create, ${updateRows.length} update, ${skipRows.length} skip.`,
  );

  if (options.dryRun) {
    io.out('');
    io.out('--dry-run: preview only, no JIRA writes.');
    return {
      result: summarizeNoApply(preview, true),
      reason: 'dry-run',
    };
  }

  if (createRows.length === 0 && updateRows.length === 0) {
    io.out('');
    io.out('Nothing to apply (all batches are skip).');
    return {
      result: summarizeNoApply(preview, false),
      reason: 'nothing-to-apply',
    };
  }

  if (!options.autoApprove) {
    const reply = await io.promptYesNo(
      `Apply ${createRows.length + updateRows.length} JIRA operation(s)? [y/N] `,
    );
    const normalized = reply.trim().toLowerCase();
    if (normalized !== 'y' && normalized !== 'yes') {
      io.out('Aborted — no JIRA writes performed.');
      return {
        result: summarizeNoApply(preview, true),
        reason: 'user-aborted',
      };
    }
  }

  const syncedAt = io.now().toISOString();
  const outcomes = await dispatchOutcomes(preview, jira, io, session.id, options.projectKey);

  applyDriftSyncOutcomesToSession(session, outcomes, syncedAt);
  await sessionManager.persist(session);

  const createdCount = outcomes.filter((o) => o.row.action === 'create' && o.createdKey).length;
  const updatedCount = outcomes.filter((o) => o.row.action === 'update').length;
  const skippedCount = outcomes.filter((o) => o.row.action === 'skip').length;

  io.out('');
  io.out(`Applied: ${createdCount} created, ${updatedCount} updated, ${skippedCount} skipped.`);
  io.out(`Session ledger: +${outcomes.length} entries (session ${session.id}).`);

  return {
    result: { preview, outcomes, createdCount, updatedCount, skippedCount, aborted: false },
    reason: 'applied',
  };
}

// ─── Helpers (exported for unit tests) ───────────────────────────────────

export function renderPreviewTable(preview: readonly DriftSyncRow[], io: DriftSyncIo): void {
  const header = `  ${'ACTION'.padEnd(7)}  ${'PACKAGE'.padEnd(22)}  ${'CONCERN'.padEnd(22)}  ${'SEV'.padEnd(5)}  ${'N'.padEnd(3)}  ${'TICKET'.padEnd(12)}  WHY`;
  io.out(header);
  io.out('  ' + '─'.repeat(header.length - 2));
  for (const row of preview) {
    const action = row.action.toUpperCase().padEnd(7);
    const pkg = truncate(row.batch.packageName, 22).padEnd(22);
    const concern = truncate(row.batch.concernId, 22).padEnd(22);
    const sev = row.batch.highestSeverity.toUpperCase().padEnd(5);
    const count = String(row.batch.findings.length).padEnd(3);
    const ticket = (row.existingKey ?? '—').padEnd(12);
    io.out(`  ${action}  ${pkg}  ${concern}  ${sev}  ${count}  ${ticket}  ${row.reason}`);
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function summarizeNoApply(preview: readonly DriftSyncRow[], aborted: boolean): DriftSyncResult {
  return {
    preview,
    outcomes: [],
    createdCount: 0,
    updatedCount: 0,
    skippedCount: preview.filter((r) => r.action === 'skip').length,
    aborted,
  };
}

async function dispatchOutcomes(
  preview: readonly DriftSyncRow[],
  jira: DriftJiraClient,
  io: DriftSyncIo,
  sessionId: string,
  projectKey: string,
): Promise<DriftSyncOutcome[]> {
  const outcomes: DriftSyncOutcome[] = [];
  for (const row of preview) {
    if (row.action === 'skip') {
      outcomes.push({ row });
      continue;
    }

    if (row.action === 'create') {
      const batch = row.batch;
      try {
        const summary = buildDriftTicketSummary(batch);
        const sections = buildDriftTicketDescription(batch, sessionId);
        const issue = await jira.createTicket({
          projectKey,
          summary,
          descriptionSections: sections,
          labels: labelsFor(batch),
        });
        io.out(`  created ${issue.key} — ${summary}`);
        outcomes.push({ row, createdKey: issue.key });
      } catch (err) {
        io.err(
          `  FAILED to create ticket for ${batch.packageName} / ${batch.concernId}: ${errorMessage(err)}`,
        );
        outcomes.push({ row });
      }
      continue;
    }

    if (row.action === 'update' && row.existingKey) {
      const batch = row.batch;
      try {
        const sections = buildDriftTicketDescription(batch, sessionId);
        await jira.updateTicket(row.existingKey, {
          commentSections: sections,
          labels: labelsFor(batch),
        });
        io.out(`  updated ${row.existingKey} (${row.existingStatus ?? 'open'})`);
        outcomes.push({ row });
      } catch (err) {
        io.err(`  FAILED to update ${row.existingKey}: ${errorMessage(err)}`);
        outcomes.push({ row });
      }
      continue;
    }

    outcomes.push({ row });
  }
  return outcomes;
}

function labelsFor(batch: DriftBatch): string[] {
  return ['helix-drift', driftKeyLabel(batch.driftKey), `concern-${batch.concernId}`];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Re-export Session purely to keep command consumers from crossing the
// session-manager barrel for trivial type access.
export type { Session };
