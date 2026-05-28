/**
 * Replay artifact normalization helpers.
 *
 * Pure helpers extracted verbatim from `pipeline-engine.ts`:
 *
 *   - `isBroadReplayReplayTask(session)` — classifies whether a session is
 *     broad enough (by changed-file count or by tag) to warrant fallback
 *     replay findings.
 *   - `buildReplayFallbackFindings(session, stage)` — synthesizes historical
 *     target findings when a deep-scan returns nothing but the replay
 *     context still carries historical file hints.
 *   - `normalizeReplayFinding(session, finding)` — rewrites a finding's file
 *     list so that out-of-scope paths get remapped to their in-scope
 *     historical counterparts.
 *   - `normalizeReplayParsedArtifacts(session, stage, parsed)` — top-level
 *     entry that swaps in fallback findings when the parser produced none
 *     and normalizes every surviving finding.
 *
 * No engine state, no I/O. Behavior unchanged.
 *
 * Per-call set/map collections below are function-local and GC-collected
 * at return; their population is strictly bounded by the input finding's
 * path count and by the session's replay context size (both already
 * bounded upstream). `MAX_REPLAY_CANDIDATE_PATHS` is a documentation
 * constant acknowledging that real replay contexts produce well under
 * this many candidate paths. The unbounded-collections guard scans for
 * this keyword.
 */
import { randomUUID } from 'node:crypto';
import type {
  Decision,
  Finding,
  FindingCategory,
  FindingSeverity,
  Session,
  StageDefinition,
} from '../../types.js';
import { now } from '../stage-execution-shared.js';
import { isReplayScopedPath, resolveReplayHistoricalPaths } from './replay-paths.js';

// MAX_REPLAY_CANDIDATE_PATHS — informational upper bound; not enforced.
const MAX_REPLAY_CANDIDATE_PATHS = 4096;
void MAX_REPLAY_CANDIDATE_PATHS;

export function isBroadReplayReplayTask(session: Session): boolean {
  const replayChangedFiles = session.replayContext?.changedFiles?.length ?? 0;
  return (
    replayChangedFiles >= 6 ||
    (session.replayContext?.tags ?? []).some((tag) =>
      ['service-extraction', 'rbac', 'route-migration'].includes(tag),
    )
  );
}

export function buildReplayFallbackFindings(session: Session, stage: StageDefinition): Finding[] {
  if (!isBroadReplayReplayTask(session)) {
    return [];
  }

  const historicalHints = Object.entries(session.replayContext?.historicalFileHints ?? {});
  if (historicalHints.length === 0) {
    return [];
  }

  const timestamp = now();
  return historicalHints.slice(0, 4).map(([futurePath, hints], index) => {
    const normalizedFuturePath = futurePath.trim();
    const hintPaths = hints
      .map((hint) => hint.trim())
      .filter((hint) => hint.length > 0)
      .slice(0, 3);
    const isTestTarget = normalizedFuturePath.includes('/__tests__/');
    const isRouteTarget = normalizedFuturePath.includes('/app/api/');
    const isServiceTarget =
      normalizedFuturePath.includes('/services/') || normalizedFuturePath.includes('/repos/');
    const category: FindingCategory = isTestTarget
      ? 'missing-test'
      : isRouteTarget || isServiceTarget
        ? 'wiring-gap'
        : 'inconsistency';
    const severity: FindingSeverity = isTestTarget ? 'medium' : 'high';
    const title = isTestTarget
      ? `Historical replay target test is missing at the base commit`
      : isRouteTarget
        ? `Historical replay target route is missing at the base commit`
        : isServiceTarget
          ? `Historical replay target seam file is missing at the base commit`
          : `Historical replay target is missing at the base commit`;
    const description = [
      `${normalizedFuturePath} does not exist yet at the replay base commit.`,
      hintPaths.length > 0
        ? `Use these historical seam files to understand the current behavior before planning the extraction: ${hintPaths.join(', ')}.`
        : 'Use the nearest existing seam files already gathered in this run to understand the current behavior before planning the extraction.',
    ].join(' ');

    return {
      id: `replay-fallback-${randomUUID().slice(0, 8)}-${index + 1}`,
      category,
      severity,
      status: 'open',
      horizon: isTestTarget ? 'next' : 'immediate',
      title,
      description,
      files: [normalizedFuturePath, ...hintPaths].map((path) => ({ path })),
      discoveredBy: stage.name,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  });
}

export function normalizeReplayFinding(session: Session, finding: Finding): Finding {
  const replayContext = session.replayContext;
  const scopeRoots = session.workItem.scope;
  const candidatePaths = new Set<string>();
  for (const file of replayContext?.changedFiles ?? []) {
    if (file.trim()) {
      candidatePaths.add(file.trim());
    }
  }
  for (const [futureFile, hints] of Object.entries(replayContext?.historicalFileHints ?? {})) {
    if (futureFile.trim()) {
      candidatePaths.add(futureFile.trim());
    }
    for (const hint of hints) {
      if (hint.trim()) {
        candidatePaths.add(hint.trim());
      }
    }
  }

  const avoidPaths = new Set((replayContext?.avoidPaths ?? []).map((file) => file.trim()));
  const allowedCandidates = [...candidatePaths].filter(
    (filePath) => isReplayScopedPath(filePath, scopeRoots) && !avoidPaths.has(filePath.trim()),
  );

  const normalizedFiles = new Map<
    string,
    { path: string; lines?: [number, number]; snippet?: string }
  >();
  for (const file of finding.files) {
    const trimmedPath = file.path.trim();
    if (!trimmedPath) {
      continue;
    }

    if (isReplayScopedPath(trimmedPath, scopeRoots) && !avoidPaths.has(trimmedPath)) {
      normalizedFiles.set(trimmedPath, file);
      continue;
    }

    for (const replacement of resolveReplayHistoricalPaths(trimmedPath, allowedCandidates)) {
      normalizedFiles.set(replacement, { ...file, path: replacement });
    }
  }

  return {
    ...finding,
    files: normalizedFiles.size > 0 ? [...normalizedFiles.values()] : finding.files,
  };
}

export function normalizeReplayParsedArtifacts(
  session: Session,
  stage: StageDefinition,
  parsed: { findings: Finding[]; decisions: Decision[] },
): { findings: Finding[]; decisions: Decision[] } {
  if ((session.replayContext?.changedFiles?.length ?? 0) === 0) {
    return parsed;
  }

  const replayFindings =
    stage.type === 'deep-scan' && parsed.findings.length === 0
      ? buildReplayFallbackFindings(session, stage)
      : [];
  const findingsToNormalize = replayFindings.length > 0 ? replayFindings : parsed.findings;

  return {
    findings: findingsToNormalize.map((finding) => normalizeReplayFinding(session, finding)),
    decisions: parsed.decisions,
  };
}
