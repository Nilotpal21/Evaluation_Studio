export type StartupProbeStatus = 'pass' | 'warn' | 'fail';

export interface StartupProbe {
  dependency: string;
  status: StartupProbeStatus;
  detail: string;
  metadata?: Record<string, unknown>;
}

export interface StartupProbeSummary {
  overall: StartupProbeStatus;
  failingDependencies: string[];
  warningDependencies: string[];
  checks: StartupProbe[];
}

export interface KafkaSubscriptionAudit {
  expectedSources: string[];
  existingSources: string[];
  missingSources: string[];
  totalExpected: number;
  totalExisting: number;
  isComplete: boolean;
}

export function buildKafkaSubscriptionSources(topics: readonly string[]): string[] {
  return topics.map((topic) => `kafka://local/${topic}`);
}

export function auditKafkaSubscriptions(
  expectedSources: readonly string[],
  existingSources: Iterable<string>,
): KafkaSubscriptionAudit {
  const dedupedExisting = [...new Set(existingSources)].sort();
  const dedupedExpected = [...new Set(expectedSources)].sort();
  const existingSet = new Set(dedupedExisting);
  const missingSources = dedupedExpected.filter((source) => !existingSet.has(source));

  return {
    expectedSources: dedupedExpected,
    existingSources: dedupedExisting,
    missingSources,
    totalExpected: dedupedExpected.length,
    totalExisting: dedupedExisting.length,
    isComplete: missingSources.length === 0,
  };
}

export function summarizeStartupProbes(checks: readonly StartupProbe[]): StartupProbeSummary {
  const failingDependencies = checks
    .filter((check) => check.status === 'fail')
    .map((check) => check.dependency);
  const warningDependencies = checks
    .filter((check) => check.status === 'warn')
    .map((check) => check.dependency);

  let overall: StartupProbeStatus = 'pass';
  if (failingDependencies.length > 0) {
    overall = 'fail';
  } else if (warningDependencies.length > 0) {
    overall = 'warn';
  }

  return {
    overall,
    failingDependencies,
    warningDependencies,
    checks: [...checks],
  };
}
