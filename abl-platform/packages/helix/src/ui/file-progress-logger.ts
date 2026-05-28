import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { Decision, ProgressEvent, ProgressReporter } from '../types.js';

/**
 * Writes progress events to a plain-text log file alongside a session.
 *
 * Path: <sessionDir>/<sessionId>/progress.log
 *
 * The log is append-only, one line per event, human-readable, no ANSI codes.
 * Designed to be tailed with `helix logs <id> --follow` or plain `tail -f`.
 */
export class FileProgressLogger implements ProgressReporter {
  private readonly logPath: string;
  private ready: Promise<void>;

  constructor(sessionDir: string, sessionId: string) {
    const dir = join(sessionDir, sessionId);
    this.logPath = join(dir, 'progress.log');
    this.ready = mkdir(dir, { recursive: true }).then(() => {});
  }

  emit(event: ProgressEvent): void {
    const line = formatLogLine(event);
    // Fire-and-forget — don't block the pipeline on log writes
    void this.writeLine(line);
  }

  async onQuestion(decision: Decision): Promise<string> {
    void this.writeLine(`[QUESTION] ${decision.question}`);
    if (decision.context?.trim()) {
      void this.writeLine(`[QUESTION_DATA] context: ${decision.context.trim()}`);
    }
    // File logger can't answer questions — this is handled by the terminal reporter
    return '';
  }

  async onCheckpoint(message: string, data?: unknown): Promise<boolean> {
    void this.writeLine(`[CHECKPOINT] ${message}`);
    for (const line of formatCheckpointData(data)) {
      void this.writeLine(`[CHECKPOINT_DATA] ${line}`);
    }
    // File logger can't approve — this is handled by the terminal reporter
    return true;
  }

  private async writeLine(line: string): Promise<void> {
    try {
      await this.ready;
      await appendFile(this.logPath, line + '\n');
    } catch {
      // Swallow write errors — logging should never break the pipeline
    }
  }
}

function formatLogLine(event: ProgressEvent): string {
  const ts = shortTime(event.timestamp);
  const stage = event.stage ? `[${event.stage}]` : '';
  const slice = event.slice != null ? `[slice ${event.slice + 1}]` : '';
  const prefix = [ts, event.type, stage, slice].filter(Boolean).join(' ');

  switch (event.type) {
    case 'session-start':
      return `${prefix} ━━━ ${event.message} ━━━`;
    case 'stage-enter':
      return `${prefix} ▸ ${event.message}`;
    case 'stage-exit': {
      const cost = event.details?.['costUsd'] as number | undefined;
      const costStr = cost != null && cost > 0 ? ` | $${cost.toFixed(2)}` : '';
      return `${prefix} ✓ ${event.message}${costStr}`;
    }
    case 'error':
      return `${prefix} ❌ ${event.message}`;
    case 'session-complete': {
      const totalCost = event.details?.['totalCostUsd'] as number | undefined;
      const costStr = totalCost != null && totalCost > 0 ? ` | $${totalCost.toFixed(2)}` : '';
      const sessionId = normalizeCheckpointField(event.details?.['sessionId']);
      const resumeCommand = normalizeCheckpointField(event.details?.['resumeCommand']);
      const detailBits = [
        sessionId ? `session=${sessionId}` : null,
        resumeCommand ? `resume=${resumeCommand}` : null,
      ].filter(Boolean);
      const detailStr = detailBits.length > 0 ? ` | ${detailBits.join(' | ')}` : '';
      return `${prefix} ━━━ ${event.message}${detailStr}${costStr} ━━━`;
    }
    case 'finding-new':
      return `${prefix} ${event.message}`;
    case 'stage-progress': {
      const cost = event.details?.['costUsd'] as number | undefined;
      const costStr = cost != null && cost > 0 ? ` | $${cost.toFixed(2)} spent` : '';
      return `${prefix} ${event.message}${costStr}`;
    }
    case 'quality-gate-result': {
      const passed = event.details?.['passed'] as boolean | undefined;
      const icon = passed ? '✓' : '✗';
      return `${prefix} ${icon} ${event.message}`;
    }
    default:
      return `${prefix} ${event.message}`;
  }
}

function shortTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', { hour12: false });
  } catch {
    return '';
  }
}

function formatCheckpointData(data: unknown): string[] {
  if (!data || typeof data !== 'object') {
    return [];
  }

  const record = data as Record<string, unknown>;
  const lines: string[] = [];

  const autonomy = normalizeCheckpointField(record['autonomy']);
  if (autonomy) {
    lines.push(`autonomy: ${autonomy}`);
  }

  const findings = record['findings'];
  if (typeof findings === 'number') {
    lines.push(`findings: ${findings}`);
  } else if (Array.isArray(findings) && findings.length > 0) {
    const preview = findings
      .map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return null;
        }
        const record = entry as Record<string, unknown>;
        const title = normalizeCheckpointField(record['title']);
        if (!title) {
          return null;
        }
        const severity = normalizeCheckpointField(record['severity']);
        return severity ? `[${severity}] ${title}` : title;
      })
      .filter((entry): entry is string => Boolean(entry));
    lines.push(`findings: ${preview.length > 0 ? previewList(preview, 4) : findings.length}`);
  }

  const files = Array.isArray(record['files'])
    ? record['files'].filter(
        (value): value is string => typeof value === 'string' && value.trim().length > 0,
      )
    : [];
  if (files.length > 0) {
    const preview = files.slice(0, 6).join(', ');
    const suffix = files.length > 6 ? `, ... (+${files.length - 6} more)` : '';
    lines.push(`files: ${preview}${suffix}`);
  }

  const testLock = normalizeCheckpointField(record['testLock']);
  if (testLock) {
    lines.push(`test lock: ${testLock}`);
  }

  const sliceDescription = normalizeCheckpointField(record['sliceDescription']);
  if (sliceDescription) {
    lines.push(`scope: ${sliceDescription}`);
  }

  const dependencies = normalizeStringList(record['dependencies']);
  if (dependencies.length > 0) {
    lines.push(`dependencies: ${previewList(dependencies, 4)}`);
  }

  const requiredTests = normalizeRequiredTests(record['requiredTests']);
  if (requiredTests.length > 0) {
    lines.push(`required tests: ${previewList(requiredTests, 4)}`);
  }

  const regressionTests = normalizeStringList(record['regressionTests']);
  if (regressionTests.length > 0) {
    lines.push(`regression tests: ${previewList(regressionTests, 4)}`);
  }

  const exitCriteria = normalizeCheckpointField(record['exitCriteria']);
  if (exitCriteria) {
    lines.push(`exit criteria: ${exitCriteria}`);
  }

  const exitCriteriaItems = normalizeExitCriteriaItems(record['exitCriteriaItems']);
  if (exitCriteriaItems.length > 0) {
    lines.push(`exit criteria detail: ${previewList(exitCriteriaItems, 6)}`);
  }

  return lines;
}

function normalizeCheckpointField(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return null;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
  );
}

function normalizeRequiredTests(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (typeof entry === 'string' && entry.trim().length > 0) {
        return entry.trim();
      }
      if (!entry || typeof entry !== 'object') {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const path = normalizeCheckpointField(record['path']);
      if (!path) {
        return null;
      }
      const status = normalizeCheckpointField(record['status']);
      return status ? `${path} [${status}]` : path;
    })
    .filter((entry): entry is string => Boolean(entry));
}

function normalizeExitCriteriaItems(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const id = normalizeCheckpointField(record['id']);
      if (!id) {
        return null;
      }
      return `${Boolean(record['passed']) ? '✓' : '✗'} ${id}`;
    })
    .filter((entry): entry is string => Boolean(entry));
}

function previewList(values: string[], limit: number): string {
  const preview = values.slice(0, limit).join(', ');
  const suffix = values.length > limit ? `, ... (+${values.length - limit} more)` : '';
  return `${preview}${suffix}`;
}
