import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { writeFileAtomic } from '../io/atomic-file.js';
import type { LiveContextEntry } from './types.js';

/**
 * Mutable context accumulator for mid-execution user input.
 *
 * Users inject guidance via the interactive REPL; entries are rendered
 * into the next stage prompt, then marked as consumed. The full log
 * is persisted to `.helix/sessions/<id>/live-context.json` so
 * running models can also read it via file-based communication.
 */
export class LiveContext {
  private entries: LiveContextEntry[] = [];
  private persistPath: string | null = null;

  /**
   * Bind this LiveContext to a session directory for file persistence.
   */
  bindToSession(sessionDir: string, sessionId: string): void {
    this.persistPath = join(sessionDir, sessionId, 'live-context.json');
  }

  /**
   * Add user-injected context. Returns the entry ID.
   */
  async add(content: string): Promise<string> {
    const entry: LiveContextEntry = {
      id: randomUUID().slice(0, 8),
      timestamp: new Date().toISOString(),
      content,
      consumedByStage: null,
      consumedAt: null,
    };
    this.entries.push(entry);
    await this.persist();
    return entry.id;
  }

  /**
   * Get all entries not yet consumed by a stage.
   */
  getPending(): LiveContextEntry[] {
    return this.entries.filter((e) => e.consumedByStage === null);
  }

  /**
   * Mark all pending entries as consumed by the given stage.
   */
  async markConsumed(stageName: string): Promise<void> {
    const now = new Date().toISOString();
    for (const entry of this.entries) {
      if (entry.consumedByStage === null) {
        entry.consumedByStage = stageName;
        entry.consumedAt = now;
      }
    }
    await this.persist();
  }

  /**
   * Render pending context entries as a prompt section.
   * Returns empty string if no pending entries.
   */
  renderForPrompt(): string {
    const pending = this.getPending();
    if (pending.length === 0) return '';

    const prioritized = [...pending].sort((left, right) => {
      const leftFailureAdvisory = left.content.startsWith('Failure advisory for ');
      const rightFailureAdvisory = right.content.startsWith('Failure advisory for ');
      if (leftFailureAdvisory === rightFailureAdvisory) {
        return left.timestamp.localeCompare(right.timestamp);
      }
      return leftFailureAdvisory ? -1 : 1;
    });

    const lines = [
      '## Live Context (User Guidance)',
      'The user injected the following guidance during this session. Incorporate it into your work:',
      '',
    ];

    for (const entry of prioritized) {
      lines.push(`- [${entry.timestamp}] ${entry.content}`);
    }

    return lines.join('\n');
  }

  /**
   * Get all entries (consumed and pending).
   */
  getAll(): LiveContextEntry[] {
    return [...this.entries];
  }

  /**
   * Total number of entries.
   */
  get size(): number {
    return this.entries.length;
  }

  /**
   * Number of pending (unconsumed) entries.
   */
  get pendingCount(): number {
    return this.getPending().length;
  }

  /**
   * Persist the full context log to disk.
   */
  private async persist(): Promise<void> {
    if (!this.persistPath) return;

    try {
      await writeFileAtomic(this.persistPath, JSON.stringify(this.entries, null, 2));
    } catch {
      // Best-effort persistence — don't crash the pipeline
    }
  }

  /**
   * Load previously persisted context (for session resume).
   */
  async loadFromFile(sessionDir: string, sessionId: string): Promise<void> {
    this.bindToSession(sessionDir, sessionId);
    if (!this.persistPath) return;

    try {
      const raw = await readFile(this.persistPath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.entries = parsed as LiveContextEntry[];
      }
    } catch {
      // No prior context — start fresh
    }
  }
}
