import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  BootstrapMeta,
  HelixConfig,
  CommitRecord,
  Decision,
  Finding,
  JournalEntry,
  PipelineTemplate,
  Session,
  SessionHeartbeat,
  SessionState,
  Slice,
  WorkItem,
} from '../types.js';
import {
  applyDriftSyncOutcomesToSession,
  type DriftSyncOutcome,
} from '../integrations/drift-jira-adapter.js';
import { getEmbeddingShardPathsForSession } from '../intelligence/embedding-config.js';
import { readJsonFileWithBackup, writeFileAtomic } from '../io/atomic-file.js';
import { hydrateSliceProofPackets } from '../pipeline/proof-packets.js';
import { captureWorkspaceGitSnapshot } from '../workspace-baseline.js';
import { listWorktreeLaunchRecords } from '../worktree-manager.js';

/**
 * Manages HELIX sessions — create, persist, resume, list.
 *
 * Session state is persisted to `.helix/sessions/<id>/session.json`.
 * Journal entries are also written to `docs/sdlc-logs/<feature>/helix/journal.md`
 * for human readability and cross-session learning.
 */
export class SessionManager {
  private readonly sessionsDir: string;
  private readonly legacySessionsDir: string | null;
  private readonly journalBaseDir: string;
  private readonly persistQueue = new Map<string, Promise<void>>();

  constructor(private readonly config: HelixConfig) {
    this.sessionsDir = config.sessionDir;
    this.legacySessionsDir = deriveLegacySessionsDir(config.sessionDir);
    this.journalBaseDir = config.journalDir;
  }

  async create(
    workItem: WorkItem,
    pipeline: PipelineTemplate,
    options?: { bootstrapMeta?: BootstrapMeta },
  ): Promise<Session> {
    const pipelineSnapshot = snapshotPipelineTemplate(pipeline);
    const workspaceBaseline = await captureWorkspaceGitSnapshot(this.config.workDir);
    const sessionId = randomUUID().slice(0, 8);
    const session: Session = {
      id: sessionId,
      workItem,
      pipelineName: pipeline.name,
      pipelineVersion: buildPipelineVersion(pipelineSnapshot),
      pipelineSnapshot,
      workspaceContext: this.config.workspaceContext
        ? { ...this.config.workspaceContext }
        : undefined,
      replayContext: this.config.replayContext
        ? {
            changedFiles: this.config.replayContext.changedFiles
              ? [...this.config.replayContext.changedFiles]
              : undefined,
            historicalFileHints: this.config.replayContext.historicalFileHints
              ? Object.fromEntries(
                  Object.entries(this.config.replayContext.historicalFileHints).map(
                    ([futurePath, candidates]) => [futurePath, [...candidates]],
                  ),
                )
              : undefined,
            tags: this.config.replayContext.tags ? [...this.config.replayContext.tags] : undefined,
          }
        : undefined,
      workspaceBaseline,
      bootstrapMeta: options?.bootstrapMeta,
      embeddingShardPaths: getEmbeddingShardPathsForSession(
        this.config.embeddingProvider,
        sessionId,
      ),
      checkpointApprovals: [],
      oracleCheckpoints: [],
      harnessDefects: [],
      failureAdvisories: [],
      state: 'initializing',
      currentStageIndex: 0,
      currentSliceIndex: 0,
      totalSlices: 0,
      slices: [],
      findings: [],
      decisions: [],
      commits: [],
      journal: [],
      stageHistory: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await this.persist(session);
    await this.initJournalDir(session);
    return session;
  }

  async persist(session: Session): Promise<void> {
    const dir = this.sessionPath(session.id);
    await this.enqueuePersist(session.id, async () => {
      session.updatedAt = new Date().toISOString();
      hydrateSliceProofPackets(session);
      const payload = JSON.stringify(session, null, 2);
      await mkdir(dir, { recursive: true });
      await writeFileAtomic(join(dir, 'session.json'), payload, { backup: true });
    });
  }

  async load(sessionId: string): Promise<Session> {
    let lastError: unknown = new Error(`Session ${sessionId} not found.`);

    for (const sessionsDir of this.candidateSessionDirs()) {
      try {
        return await this.loadFromDir(sessionsDir, sessionId);
      } catch (error) {
        lastError = error;
      }
    }

    const launchRecord = await this.loadWorktreeLaunchRecord(sessionId);
    if (launchRecord?.sessionDir) {
      try {
        return await this.loadFromDir(launchRecord.sessionDir, sessionId);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError;
  }

  async list(): Promise<
    Array<{ id: string; title: string; state: SessionState; updatedAt: string }>
  > {
    const sessions = new Map<
      string,
      { id: string; title: string; state: SessionState; updatedAt: string }
    >();

    for (const sessionsDir of this.candidateSessionDirs()) {
      try {
        const entries = await readdir(sessionsDir);

        for (const entry of entries) {
          try {
            const session = await this.loadFromDir(sessionsDir, entry);
            const next = {
              id: session.id,
              title: session.workItem.title,
              state: session.state,
              updatedAt: session.updatedAt,
            };
            const existing = sessions.get(session.id);
            if (!existing || next.updatedAt > existing.updatedAt) {
              sessions.set(session.id, next);
            }
          } catch {
            // Skip corrupted sessions
          }
        }
      } catch {
        // Ignore missing current or legacy session directories.
      }
    }

    for (const record of await this.listWorktreeLaunchRecords()) {
      try {
        const session = await this.loadFromDir(record.sessionDir, record.sessionId);
        const next = {
          id: session.id,
          title: session.workItem.title,
          state: session.state,
          updatedAt: session.updatedAt,
        };
        const existing = sessions.get(session.id);
        if (!existing || next.updatedAt > existing.updatedAt) {
          sessions.set(session.id, next);
        }
      } catch {
        // Skip stale or corrupted worktree launch records.
      }
    }

    return [...sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async updateState(session: Session, state: SessionState): Promise<void> {
    session.state = state;
    await this.persist(session);
  }

  async persistHeartbeat(session: Session, heartbeat: SessionHeartbeat): Promise<void> {
    session.heartbeat = heartbeat;
    await this.persist(session);
  }

  async addFinding(session: Session, finding: Finding): Promise<void> {
    session.findings.push(finding);
    await this.persist(session);
  }

  async addDecision(session: Session, decision: Decision): Promise<void> {
    session.decisions.push(decision);
    await this.persist(session);
  }

  async upsertDecision(session: Session, decision: Decision): Promise<void> {
    const existingIndex = session.decisions.findIndex((entry) => entry.id === decision.id);
    if (existingIndex >= 0) {
      session.decisions[existingIndex] = decision;
    } else {
      session.decisions.push(decision);
    }
    await this.persist(session);
  }

  async addCommit(session: Session, commit: CommitRecord): Promise<void> {
    session.commits.push(commit);
    await this.persist(session);
  }

  async setSlices(session: Session, slices: Slice[]): Promise<void> {
    session.slices = slices;
    session.totalSlices = slices.length;
    await this.persist(session);
  }

  async updateSlice(session: Session, index: number, updates: Partial<Slice>): Promise<void> {
    const slice = session.slices[index];
    if (!slice) return;
    Object.assign(slice, updates);
    await this.persist(session);
  }

  async addJournalEntry(session: Session, entry: JournalEntry): Promise<void> {
    session.journal.push(entry);
    await this.persist(session);
    await this.appendToJournalFile(session, entry);
  }

  /**
   * Record drift-sync outcomes on the session: append ledger entries and
   * backfill `finding.jiraKey` for created/updated tickets. `syncedAt` is
   * injectable so callers can batch outcomes under a single stable timestamp.
   */
  async recordDriftSyncOutcomes(
    session: Session,
    outcomes: readonly DriftSyncOutcome[],
    syncedAt: string = new Date().toISOString(),
  ): Promise<void> {
    if (outcomes.length === 0) {
      return;
    }
    applyDriftSyncOutcomesToSession(session, outcomes, syncedAt);
    await this.persist(session);
  }

  /**
   * Write journal entries to a human-readable markdown file
   * at <journalDir>/<feature>/journal.md
   */
  private async appendToJournalFile(session: Session, entry: JournalEntry): Promise<void> {
    const journalDir = this.journalPath(session);
    await mkdir(journalDir, { recursive: true });

    const filePath = join(journalDir, 'journal.md');
    const icon = journalIcons[entry.type] ?? '  ';
    const line = `${icon} **${entry.timestamp}** [${entry.stage}] ${entry.message}\n`;

    try {
      await readFile(filePath, 'utf-8');
      await appendFile(filePath, line, 'utf-8');
    } catch {
      const header = `# HELIX Journal — ${session.workItem.title}\n\nSession: \`${session.id}\`\nStarted: ${session.startedAt}\nPipeline: ${session.pipelineName}\nPipeline Version: \`${session.pipelineVersion}\`\n\n---\n\n`;
      await writeFileAtomic(filePath, header + line);
    }
  }

  /**
   * Write findings to a structured file for cross-session learning
   */
  async persistFindings(session: Session): Promise<void> {
    const journalDir = this.journalPath(session);
    await mkdir(journalDir, { recursive: true });

    const filePath = join(journalDir, 'findings.md');
    const lines = [`# Findings — ${session.workItem.title}\n`];

    const grouped = groupBy(session.findings, (f) => f.category);
    for (const [category, findings] of Object.entries(grouped)) {
      lines.push(`\n## ${category}\n`);
      for (const f of findings) {
        const status = f.status === 'fixed' ? '~~' : '';
        lines.push(`- [${f.severity.toUpperCase()}] ${status}${f.title}${status}`);
        lines.push(`  - ${f.description}`);
        if (f.files.length > 0) {
          lines.push(`  - Files: ${f.files.map((r) => r.path).join(', ')}`);
        }
        if (f.fixedInCommit) {
          lines.push(`  - Fixed in: ${f.fixedInCommit}`);
        }
      }
    }

    await writeFileAtomic(filePath, lines.join('\n') + '\n');
  }

  /**
   * Write decisions to a structured file for traceability
   */
  async persistDecisions(session: Session): Promise<void> {
    const journalDir = this.journalPath(session);
    await mkdir(journalDir, { recursive: true });

    const filePath = join(journalDir, 'decisions.md');
    const lines = [`# Decisions — ${session.workItem.title}\n`];

    for (const d of session.decisions) {
      lines.push(`\n### ${d.question}`);
      lines.push(`- Classification: **${d.classification}**`);
      lines.push(`- Stage: ${d.stage}`);
      if (d.answer) {
        lines.push(`- Answer: ${d.answer}`);
      }
      if (d.resolvedBy) {
        lines.push(`- Resolved by: ${d.resolvedBy}`);
      }
      if ((d.oracleVotes?.length ?? 0) > 0) {
        lines.push(`- Oracle votes:`);
        for (const v of d.oracleVotes ?? []) {
          lines.push(`  - **${v.oracleName}** (${(v.confidence * 100).toFixed(0)}%): ${v.answer}`);
        }
      }
    }

    await writeFileAtomic(filePath, lines.join('\n') + '\n');
  }

  private sessionPath(sessionId: string): string {
    return join(this.sessionsDir, sessionId);
  }

  private async loadFromDir(sessionsDir: string, sessionId: string): Promise<Session> {
    const filePath = join(sessionsDir, sessionId, 'session.json');
    const loaded = await readJsonFileWithBackup<Session>(filePath);

    if (loaded.sourcePath !== filePath) {
      await writeFileAtomic(filePath, loaded.raw, { backup: true });
    }

    loaded.value.checkpointApprovals ??= [];
    loaded.value.oracleCheckpoints ??= [];
    loaded.value.harnessDefects ??= [];
    loaded.value.failureAdvisories ??= [];
    hydrateSliceProofPackets(loaded.value);
    return loaded.value;
  }

  private async enqueuePersist(sessionId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.persistQueue.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    this.persistQueue.set(sessionId, next);

    try {
      await next;
    } finally {
      if (this.persistQueue.get(sessionId) === next) {
        this.persistQueue.delete(sessionId);
      }
    }
  }

  private candidateSessionDirs(): string[] {
    return this.legacySessionsDir == null
      ? [this.sessionsDir]
      : [this.sessionsDir, this.legacySessionsDir];
  }

  private async loadWorktreeLaunchRecord(sessionId: string) {
    return (
      (await this.listWorktreeLaunchRecords()).find((record) => record.sessionId === sessionId) ??
      null
    );
  }

  private async listWorktreeLaunchRecords() {
    try {
      return await listWorktreeLaunchRecords(this.config.workDir);
    } catch {
      return [];
    }
  }

  private journalPath(session: Session): string {
    const slug = session.workItem.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80);
    return join(this.journalBaseDir, slug);
  }

  private async initJournalDir(session: Session): Promise<void> {
    const dir = this.journalPath(session);
    await mkdir(dir, { recursive: true });
  }
}

const CURRENT_STATE_DIR = '.helix';
const LEGACY_STATE_DIR = '.apdas';

const journalIcons: Record<string, string> = {
  'stage-start': '▸ ',
  'stage-complete': '✓ ',
  finding: '⚠ ',
  decision: '? ',
  'oracle-vote': '🔮',
  'slice-start': '▶ ',
  'slice-complete': '✅',
  commit: '📦',
  review: '👁 ',
  'quality-gate': '🚦',
  error: '❌',
  'user-input': '💬',
  progress: '  ',
};

function groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of items) {
    const key = keyFn(item);
    if (!result[key]) result[key] = [];
    result[key].push(item);
  }
  return result;
}

export function snapshotPipelineTemplate(pipeline: PipelineTemplate): PipelineTemplate {
  return JSON.parse(JSON.stringify(pipeline)) as PipelineTemplate;
}

export function buildPipelineVersion(pipeline: PipelineTemplate): string {
  const digest = createHash('sha256').update(JSON.stringify(pipeline)).digest('hex').slice(0, 12);
  return `${pipeline.name}@${digest}`;
}

function deriveLegacySessionsDir(sessionsDir: string): string | null {
  const posixPath = sessionsDir.replace(`/${CURRENT_STATE_DIR}/`, `/${LEGACY_STATE_DIR}/`);
  if (posixPath !== sessionsDir) {
    return posixPath;
  }

  const windowsPath = sessionsDir.replace(`\\${CURRENT_STATE_DIR}\\`, `\\${LEGACY_STATE_DIR}\\`);
  return windowsPath !== sessionsDir ? windowsPath : null;
}
