/**
 * Builds the structured summary attached to a slice commit checkpoint:
 * autonomy disposition, per-finding severity/title/status, and upstream
 * slice dependencies. Pure formatter over session state.
 *
 * Extracted verbatim from `pipeline-engine.ts`. Behavior is unchanged.
 */
import type { Session, Slice } from '../../types.js';
import { formatSliceAutonomySummary } from '../autonomy-policy.js';

export function buildSliceCommitCheckpointSummary(
  session: Session,
  slice: Slice,
): Record<string, unknown> {
  const findings = slice.findings
    .map((findingId) => session.findings.find((finding) => finding.id === findingId))
    .filter((finding): finding is NonNullable<typeof finding> => Boolean(finding))
    .map((finding) => ({
      severity: finding.severity,
      title: finding.title,
      status: finding.status,
    }));

  const dependencies = slice.dependencies.map((dependencyIndex) => {
    const dependency = session.slices[dependencyIndex];
    return dependency
      ? `Slice ${dependencyIndex + 1}: ${dependency.title}`
      : `Slice ${dependencyIndex + 1}`;
  });

  return {
    autonomy: formatSliceAutonomySummary(slice),
    findings,
    dependencies,
  };
}
