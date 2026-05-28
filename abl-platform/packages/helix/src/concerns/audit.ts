/**
 * Concerns audit runner.
 *
 * Loads the concerns registry, walks the repo once, resolves the applicable
 * files per concern via scope globs, and runs each concern's deterministic
 * detectors. Emits JSONL findings and a JSON summary to
 * `docs/sdlc-logs/concerns-audit/` and returns a structured `AuditResult`
 * for the CLI or a caller to render.
 *
 * Only the `grep` detector kind is implemented today. Other deterministic
 * kinds (`ast`, `route`, `symbol-ref`, `schema`, `impacted-test`, `script`)
 * are recorded as skipped with a human-readable reason — they will plug in
 * later via the detector switch.
 *
 * `model-review` detectors are intentionally NOT run here. They require the
 * model layer and belong in the oracle-analysis stage, not the deterministic
 * audit surface.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { scopeMatches } from './applicability.js';
import { runGrepDetector } from './detectors/grep.js';
import { walkRepoFiles } from './file-walker.js';
import { loadConcernsRegistry } from './loader.js';
import type {
  AuditOptions,
  AuditResult,
  AuditSummary,
  DetectorFinding,
  DetectorSkip,
} from './audit-types.js';
import type { Concern, ConcernEnforcement, ConcernsRegistry } from './types.js';

export type {
  AuditOptions,
  AuditResult,
  AuditSummary,
  DetectorFinding,
  DetectorSkip,
} from './audit-types.js';

/** Bound on the number of detector kinds this runner supports. Bumped as kinds land. */
export const MAX_SUPPORTED_DETECTOR_KINDS = 8;

const SUPPORTED_DETECTOR_KINDS: readonly string[] = Object.freeze(['grep']);

function isSupportedDetectorKind(kind: string): boolean {
  return SUPPORTED_DETECTOR_KINDS.includes(kind);
}

export async function runConcernsAudit(options: AuditOptions = {}): Promise<AuditResult> {
  const start = Date.now();
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const { registry, errors: loadErrors } = await loadConcernsRegistry({
    repoRoot,
    rootDir: options.concernsDir,
  });

  const filteredConcerns = filterConcerns(registry, options);
  const allFiles = await walkRepoFiles({ repoRoot });

  const findings: DetectorFinding[] = [];
  const skipped: DetectorSkip[] = [];
  const byConcern: Record<string, number> = {};
  let concernsScanned = 0;
  let detectorsRun = 0;
  let detectorsSkipped = 0;

  for (const concern of filteredConcerns) {
    const applicableFiles = allFiles.filter((f) => scopeMatches(concern.scope, f));
    const hasRunnable = concern.detectors.some((d) => isSupportedDetectorKind(d.kind));
    if (!hasRunnable) {
      for (const detector of concern.detectors) {
        detectorsSkipped++;
        skipped.push({
          concernId: concern.id,
          detectorId: detector.id,
          kind: detector.kind,
          reason: skipReasonFor(detector.kind),
        });
      }
      continue;
    }
    if (applicableFiles.length === 0) {
      for (const detector of concern.detectors) {
        if (!isSupportedDetectorKind(detector.kind)) {
          detectorsSkipped++;
          skipped.push({
            concernId: concern.id,
            detectorId: detector.id,
            kind: detector.kind,
            reason: skipReasonFor(detector.kind),
          });
        }
      }
      continue;
    }

    concernsScanned++;
    for (const detector of concern.detectors) {
      if (!isSupportedDetectorKind(detector.kind)) {
        detectorsSkipped++;
        skipped.push({
          concernId: concern.id,
          detectorId: detector.id,
          kind: detector.kind,
          reason: skipReasonFor(detector.kind),
        });
        continue;
      }

      detectorsRun++;
      if (detector.kind === 'grep') {
        const detectorFindings = await runGrepDetector(
          detector,
          concern,
          applicableFiles,
          repoRoot,
        );
        for (const finding of detectorFindings) {
          findings.push(finding);
          byConcern[concern.id] = (byConcern[concern.id] ?? 0) + 1;
        }
      }
    }
  }

  const summary = buildSummary({
    registry,
    allFilesCount: allFiles.length,
    concernsScanned,
    detectorsRun,
    detectorsSkipped,
    findings,
    byConcern,
    durationMs: Date.now() - start,
  });

  let findingsPath: string | undefined;
  let summaryPath: string | undefined;

  if (options.write !== false) {
    const outDir = resolve(options.outputDir ?? join(repoRoot, 'docs/sdlc-logs/concerns-audit'));
    await mkdir(outDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    findingsPath = join(outDir, `findings-${timestamp}.jsonl`);
    summaryPath = join(outDir, `summary-${timestamp}.json`);
    const latestFindingsPath = join(outDir, 'findings-latest.jsonl');
    const latestSummaryPath = join(outDir, 'summary-latest.json');

    const jsonl =
      findings.length === 0 ? '' : findings.map((f) => JSON.stringify(f)).join('\n') + '\n';
    const summaryJson =
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          repoRoot,
          summary,
          skipped,
          loadErrors,
        },
        null,
        2,
      ) + '\n';

    await writeFile(findingsPath, jsonl, 'utf8');
    await writeFile(latestFindingsPath, jsonl, 'utf8');
    await writeFile(summaryPath, summaryJson, 'utf8');
    await writeFile(latestSummaryPath, summaryJson, 'utf8');
  }

  return {
    findings,
    skipped,
    summary,
    loadErrors,
    findingsPath,
    summaryPath,
  };
}

function filterConcerns(registry: ConcernsRegistry, options: AuditOptions): readonly Concern[] {
  let concerns: readonly Concern[] = registry.all;
  if (options.filterTiers && options.filterTiers.length > 0) {
    const tiers = options.filterTiers;
    concerns = concerns.filter((c) => tiers.includes(c.enforcement));
  }
  if (options.filterConcernIds && options.filterConcernIds.length > 0) {
    const ids = options.filterConcernIds;
    concerns = concerns.filter((c) => ids.includes(c.id));
  }
  return concerns;
}

function skipReasonFor(kind: string): string {
  if (kind === 'model-review') {
    return 'model-review detectors run in the oracle-analysis stage, not the deterministic audit';
  }
  return `detector kind "${kind}" is not yet implemented in the audit runner`;
}

interface SummaryInputs {
  readonly registry: ConcernsRegistry;
  readonly allFilesCount: number;
  readonly concernsScanned: number;
  readonly detectorsRun: number;
  readonly detectorsSkipped: number;
  readonly findings: readonly DetectorFinding[];
  readonly byConcern: Record<string, number>;
  readonly durationMs: number;
}

function buildSummary(inputs: SummaryInputs): AuditSummary {
  const blocking = inputs.findings.filter((f) => f.enforcement === 'blocking').length;
  const advisory = inputs.findings.filter((f) => f.enforcement === 'advisory').length;
  return {
    concernsTotal: inputs.registry.all.length,
    concernsScanned: inputs.concernsScanned,
    detectorsRun: inputs.detectorsRun,
    detectorsSkipped: inputs.detectorsSkipped,
    findings: inputs.findings.length,
    blockingFindings: blocking,
    advisoryFindings: advisory,
    byEnforcement: { blocking, advisory },
    bySeverity: {
      critical: inputs.findings.filter((f) => f.severity === 'critical').length,
      high: inputs.findings.filter((f) => f.severity === 'high').length,
      medium: inputs.findings.filter((f) => f.severity === 'medium').length,
      low: inputs.findings.filter((f) => f.severity === 'low').length,
    },
    byConcern: inputs.byConcern,
    filesScanned: inputs.allFilesCount,
    durationMs: inputs.durationMs,
  };
}
