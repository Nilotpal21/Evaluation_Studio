/**
 * Pure statistical functions for experiment analysis.
 * Zero dependencies — safe to import in tests without any mocks.
 */

/** Standard normal CDF approximation (Abramowitz & Stegun formula 7.1.26). */
export function normalCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const xAbs = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * xAbs);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-xAbs * xAbs);
  return 0.5 * (1.0 + sign * y);
}

/** Two-sample t-test for independent groups (large-sample approximation). */
export function tTest(
  mean1: number,
  mean2: number,
  std1: number,
  std2: number,
  n1: number,
  n2: number,
): { tStat: number; pValue: number } {
  const se = Math.sqrt((std1 * std1) / n1 + (std2 * std2) / n2);
  if (se === 0) return { tStat: 0, pValue: 1 };
  const tStat = (mean1 - mean2) / se;
  const pValue = 2 * (1 - normalCDF(Math.abs(tStat)));
  return { tStat, pValue };
}

/** Chi-squared test for proportions (2×2 contingency table, two-tailed). */
export function chiSquared(
  successControl: number,
  totalControl: number,
  successExperiment: number,
  totalExperiment: number,
): { chiSq: number; pValue: number } {
  const total = totalControl + totalExperiment;
  const totalSuccess = successControl + successExperiment;
  const totalFailure = total - totalSuccess;

  const eCS = (totalControl * totalSuccess) / total;
  const eCF = (totalControl * totalFailure) / total;
  const eES = (totalExperiment * totalSuccess) / total;
  const eEF = (totalExperiment * totalFailure) / total;

  if (eCS === 0 || eCF === 0 || eES === 0 || eEF === 0) {
    return { chiSq: 0, pValue: 1 };
  }

  const chiSq =
    Math.pow(successControl - eCS, 2) / eCS +
    Math.pow(totalControl - successControl - eCF, 2) / eCF +
    Math.pow(successExperiment - eES, 2) / eES +
    Math.pow(totalExperiment - successExperiment - eEF, 2) / eEF;

  const pValue = (1 - normalCDF(Math.sqrt(chiSq))) * 2;
  return { chiSq, pValue };
}

/** Minimum sample size per group for detecting a given effect (power analysis). */
export function minSampleSizeForEffect(
  baseline: number,
  mde: number,
  _alpha: number = 0.05,
  _power: number = 0.8,
): number {
  const zAlpha = 1.96;
  const zBeta = 0.84;
  const variance = baseline * (1 - baseline);
  if (variance === 0) return 100;
  return Math.ceil((2 * variance * Math.pow(zAlpha + zBeta, 2)) / Math.pow(mde, 2));
}

/** Confidence interval for the difference of two means (mean2 - mean1). */
export function confidenceInterval(
  mean1: number,
  mean2: number,
  std1: number,
  std2: number,
  n1: number,
  n2: number,
  _alpha: number = 0.05,
): [number, number] {
  const diff = mean2 - mean1;
  const se = Math.sqrt((std1 * std1) / n1 + (std2 * std2) / n2);
  const zAlpha = 1.96;
  return [
    Math.round((diff - zAlpha * se) * 10000) / 10000,
    Math.round((diff + zAlpha * se) * 10000) / 10000,
  ];
}
