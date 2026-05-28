/**
 * Grep detector — the baseline deterministic rule for most seed concerns.
 *
 * Given a concern's grep detector and the set of repo files already resolved
 * to that concern's scope, scans file bodies for regex matches and emits a
 * `DetectorFinding` per match. Honors the detector's optional per-detector
 * `glob` (a narrower filter inside the concern scope) and `multiline` flag.
 *
 * Each finding records the exact file, 1-based line number, the matched
 * substring (truncated), and the concern/detector metadata needed downstream
 * for triage cards, JIRA promotion, and rubric reconciliation.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { globToRegExp } from '../applicability.js';
import type { Concern, ConcernSeverity, GrepDetector } from '../types.js';
import type { DetectorFinding } from '../audit-types.js';

const MAX_MATCH_PREVIEW_CHARS = 200;

export async function runGrepDetector(
  detector: GrepDetector,
  concern: Concern,
  applicableFiles: readonly string[],
  repoRoot: string,
): Promise<DetectorFinding[]> {
  const regex = buildRegex(detector);
  const detectorGlobRegex = detector.glob ? globToRegExp(detector.glob) : null;
  const files = detectorGlobRegex
    ? applicableFiles.filter((f) => detectorGlobRegex.test(f))
    : applicableFiles;

  const severity: ConcernSeverity = detector.severity ?? concern.severityDefault;
  const findings: DetectorFinding[] = [];

  for (const relFile of files) {
    const absFile = join(repoRoot, relFile);
    let body: string;
    try {
      body = await readFile(absFile, 'utf8');
    } catch {
      continue;
    }

    if (detector.multiline) {
      for (const match of body.matchAll(regex)) {
        const offset = match.index ?? 0;
        const line = lineForOffset(body, offset);
        findings.push(buildFinding(concern, detector, severity, relFile, line, match[0]));
      }
    } else {
      const lines = body.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i];
        for (const match of lineText.matchAll(regex)) {
          findings.push(
            buildFinding(concern, detector, severity, relFile, i + 1, match[0], match.index),
          );
        }
      }
    }
  }

  return findings;
}

function buildRegex(detector: GrepDetector): RegExp {
  const flags = detector.multiline ? 'gm' : 'g';
  return new RegExp(detector.pattern, flags);
}

function lineForOffset(body: string, offset: number): number {
  let line = 1;
  const limit = Math.min(offset, body.length);
  for (let i = 0; i < limit; i++) {
    if (body.charCodeAt(i) === 10) line++;
  }
  return line;
}

function buildFinding(
  concern: Concern,
  detector: GrepDetector,
  severity: ConcernSeverity,
  file: string,
  line: number,
  matchedText: string,
  column?: number,
): DetectorFinding {
  return {
    concernId: concern.id,
    concernTitle: concern.title,
    enforcement: concern.enforcement,
    rubricConcern: concern.rubricConcern,
    detectorId: detector.id,
    detectorKind: 'grep',
    severity,
    file,
    line,
    column,
    message: detector.message,
    fixHint: detector.fixHint,
    matchedText: truncate(matchedText, MAX_MATCH_PREVIEW_CHARS),
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}
