/**
 * VU Scaling Utility
 *
 * Allows k6 scripts to scale their hardcoded VU counts via the MAX_VUS
 * environment variable. Each script defines a "baseline" total VU count
 * (the sum of all scenario VUs at default), and this utility computes
 * a scaling factor from MAX_VUS / baseline.
 *
 * Usage in a k6 script:
 *
 *   import { vuScale } from '../lib/vu-scaling.ts';
 *
 *   // Baseline VUs for this script (sum of all scenario VUs at defaults)
 *   const scale = vuScale(20); // default total is 20 VUs
 *
 *   export const options = {
 *     scenarios: {
 *       my_scenario: {
 *         executor: 'constant-vus',
 *         vus: scale(10),  // 10 at default, scales with MAX_VUS
 *         ...
 *       },
 *     },
 *   };
 *
 * When MAX_VUS is not set, all VU counts remain at their defaults.
 * When MAX_VUS=40 and baseline=20, scale(10) returns 20 (2x).
 * Minimum returned value is always 1.
 */

/**
 * Create a VU scaling function for a script with a known baseline VU total.
 *
 * @param baselineTotal - The sum of all default VU counts in the script.
 *                        Used to compute the scaling factor.
 * @returns A function that takes a default VU count and returns the scaled value.
 */
export function vuScale(baselineTotal: number): (defaultVUs: number) => number {
  const maxVUs = __ENV.MAX_VUS ? parseInt(__ENV.MAX_VUS, 10) : 0;
  if (!maxVUs || maxVUs <= 0) {
    // No override — return identity (defaults unchanged)
    return (defaultVUs: number) => defaultVUs;
  }
  const factor = maxVUs / baselineTotal;
  return (defaultVUs: number) => Math.max(1, Math.round(defaultVUs * factor));
}

/**
 * Scale ramping-vus stage targets by MAX_VUS / baseline.
 *
 * @param stages - Array of { duration, target } stages
 * @param baselineTotal - The baseline total VU count for this script
 * @returns New stages array with scaled targets
 */
export function scaleStages(
  stages: Array<{ duration: string; target: number }>,
  baselineTotal: number,
): Array<{ duration: string; target: number }> {
  const scale = vuScale(baselineTotal);
  return stages.map((s) => ({
    duration: s.duration,
    target: scale(s.target),
  }));
}

/**
 * Scale constant-arrival-rate parameters by MAX_VUS / baseline.
 *
 * @param baselineTotal - The baseline total VU count for this script
 * @param params - The scenario parameters to scale
 * @returns Scaled parameters
 */
export function scaleArrivalRate(
  baselineTotal: number,
  params: { rate: number; preAllocatedVUs: number; maxVUs: number },
): { rate: number; preAllocatedVUs: number; maxVUs: number } {
  const scale = vuScale(baselineTotal);
  return {
    rate: scale(params.rate),
    preAllocatedVUs: scale(params.preAllocatedVUs),
    maxVUs: scale(params.maxVUs),
  };
}
