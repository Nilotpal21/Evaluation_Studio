/**
 * Bug report module — JSONL-based crash-safe bug logging.
 *
 * Each `logBug()` call appends one JSON line to `e2e/.bugs-wip.json`.
 * No in-memory list — every read re-parses the file. Survives process
 * crashes because each line is independently valid JSON (D12).
 *
 * @e2e-real — No mocks, no stubs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './env';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BUGS_WIP_PATH = path.resolve(__dirname, '../.bugs-wip.json');
const REPORTS_DIR = path.resolve(__dirname, '../../../../docs/testing/reports');

export interface Bug {
  id: string; // Auto-generated: BUG-001, BUG-002
  severity: 'critical' | 'high' | 'medium' | 'low';
  spec: string; // Which spec found it
  step: string; // Which test step
  title: string; // One-line summary
  expected: string;
  actual: string;
  screenshot?: string; // Path to screenshot
  url?: string; // Page URL when found
  apiResponse?: { status: number; body: string }; // If API-related
}

/** Read all bugs from the JSONL file. Returns empty array if file doesn't exist. */
function readBugs(): Bug[] {
  if (!fs.existsSync(BUGS_WIP_PATH)) {
    return [];
  }
  const content = fs.readFileSync(BUGS_WIP_PATH, 'utf-8').trim();
  if (!content) {
    return [];
  }
  return content.split('\n').map((line) => JSON.parse(line) as Bug);
}

/**
 * Log a bug to the JSONL file. Returns the auto-assigned bug ID.
 *
 * Append-only — each call writes one JSON line. Crash-safe because
 * each line is independently valid JSON.
 */
export function logBug(bug: Omit<Bug, 'id'>): string {
  const existing = readBugs();
  const nextNum = existing.length + 1;
  const id = `BUG-${String(nextNum).padStart(3, '0')}`;

  const fullBug: Bug = { id, ...bug };
  fs.appendFileSync(BUGS_WIP_PATH, JSON.stringify(fullBug) + '\n', 'utf-8');

  return id;
}

/** Count bugs by severity from the JSONL file. */
export function getBugCount(): {
  critical: number;
  high: number;
  medium: number;
  low: number;
} {
  const bugs = readBugs();
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const bug of bugs) {
    counts[bug.severity]++;
  }
  return counts;
}

/** Generate a full markdown bug report from the JSONL file. */
export function getBugReport(): string {
  const bugs = readBugs();
  const counts = getBugCount();
  const total = bugs.length;
  const date = new Date().toISOString().slice(0, 10);

  // Detect flow from test state if available
  let flow = 'unknown';
  const statePath = path.resolve(__dirname, '../.test-state.json');
  if (fs.existsSync(statePath)) {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      if (state.flow) {
        flow = state.flow;
      }
    } catch {
      // State file may be corrupted — ignore
    }
  }

  const lines: string[] = [
    `# E2E Bug Report — ${date}`,
    '',
    `**Environment**: ${env.baseUrl}`,
    `**Flow**: ${flow}`,
    `**Total bugs**: ${total} (${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low)`,
    '',
  ];

  for (const bug of bugs) {
    lines.push(
      `## ${bug.id} [${bug.severity.toUpperCase()}] — ${bug.title}`,
      `- **Spec**: ${bug.spec}`,
      `- **Step**: ${bug.step}`,
      `- **Expected**: ${bug.expected}`,
      `- **Actual**: ${bug.actual}`,
    );
    if (bug.screenshot) {
      lines.push(`- **Screenshot**: ${bug.screenshot}`);
    }
    if (bug.url) {
      lines.push(`- **URL**: ${bug.url}`);
    }
    if (bug.apiResponse) {
      lines.push(`- **API Response**: ${bug.apiResponse.status} — ${bug.apiResponse.body}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Write the bug report markdown to `docs/testing/reports/e2e-bugs-{date}.md`.
 * Creates the output directory if it doesn't exist.
 */
export function writeBugReport(): void {
  const report = getBugReport();
  const date = new Date().toISOString().slice(0, 10);
  const outputPath = path.join(REPORTS_DIR, `e2e-bugs-${date}.md`);

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(outputPath, report, 'utf-8');
}
