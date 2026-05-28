/**
 * Slice-autonomy assessment wrapper.
 *
 * Pure wrapper extracted verbatim from `pipeline-engine.ts`. Reads the
 * autonomy policy from the passed `HelixConfig` and composes the final
 * slice autonomy assessment by delegating to
 * `assessSliceAutonomy` from `../autonomy-policy.js`.
 *
 * When thresholded autonomy is disabled, the assessment is forced to a
 * `manual-checkpoint` disposition so HELIX still requires the explicit
 * commit checkpoint.
 *
 *   - `assessSliceAutonomyFromConfig(config, session, slice)` — returns the
 *     resolved `Slice['autonomy']` object; no engine state, no I/O.
 *
 * Behavior unchanged.
 */
import type { HelixConfig, Session, Slice } from '../../types.js';
import {
  assessSliceAutonomy as buildSliceAutonomyAssessment,
  resolveAutonomyPolicy,
} from '../autonomy-policy.js';
import { now } from '../stage-execution-shared.js';

export function assessSliceAutonomyFromConfig(
  config: HelixConfig,
  session: Session,
  slice: Slice,
): NonNullable<Slice['autonomy']> {
  const policy = resolveAutonomyPolicy(config.autonomy);

  if (policy.mode !== 'thresholded') {
    const assessed = buildSliceAutonomyAssessment(session, slice, {
      ...policy,
      mode: 'thresholded',
    });
    return {
      ...assessed,
      disposition: 'manual-checkpoint',
      reasons: [
        ...assessed.reasons,
        'Thresholded autonomy is disabled for this run, so HELIX keeps the explicit commit checkpoint.',
      ],
      assessedAt: now(),
    };
  }

  return buildSliceAutonomyAssessment(session, slice, policy);
}
