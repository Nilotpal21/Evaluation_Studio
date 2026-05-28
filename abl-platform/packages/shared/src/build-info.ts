export type BuildEnvironment = string;
export type BuildVersionSource = 'git_sha' | 'package_version' | 'unknown';

export interface ServiceBuildInfo {
  environment: BuildEnvironment;
  deployId: string;
  codeVersion: string;
  commitSha: string | null;
  packageVersion: string | null;
  versionSource: BuildVersionSource;
}

const ENV_ALIASES: Record<string, BuildEnvironment> = {
  dev: 'dev',
  development: 'dev',
  test: 'dev',
  qa: 'qa',
  staging: 'staging',
  stg: 'staging',
  production: 'production',
  prod: 'production',
};

function normalizeNonEmptyString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function normalizeBuildEnvironment(raw: string | undefined): BuildEnvironment {
  const normalized = normalizeNonEmptyString(raw)?.toLowerCase();
  if (!normalized) {
    return 'dev';
  }

  return ENV_ALIASES[normalized] ?? normalized;
}

export function getServiceBuildInfo(
  env: Record<string, string | undefined> = process.env,
): ServiceBuildInfo {
  const commitSha = normalizeNonEmptyString(env.GIT_SHA);
  const packageVersion = normalizeNonEmptyString(env.npm_package_version);
  const codeVersion = commitSha ?? packageVersion ?? 'unknown';
  const rawEnvironment =
    normalizeNonEmptyString(env.DEPLOYMENT_ENVIRONMENT) ??
    normalizeNonEmptyString(env.NODE_ENV) ??
    'dev';

  return {
    environment: normalizeBuildEnvironment(rawEnvironment),
    deployId: normalizeNonEmptyString(env.DEPLOY_ID) ?? 'local',
    codeVersion,
    commitSha,
    packageVersion,
    versionSource: commitSha ? 'git_sha' : packageVersion ? 'package_version' : 'unknown',
  };
}

export function parseServiceBuildInfo(value: unknown): ServiceBuildInfo | null {
  if (!isRecord(value)) {
    return null;
  }

  const codeVersion = normalizeNonEmptyString(
    typeof value.codeVersion === 'string' ? value.codeVersion : null,
  );
  if (!codeVersion) {
    return null;
  }

  const commitSha = normalizeNonEmptyString(
    typeof value.commitSha === 'string' ? value.commitSha : null,
  );
  const packageVersion = normalizeNonEmptyString(
    typeof value.packageVersion === 'string' ? value.packageVersion : null,
  );

  const rawVersionSource =
    typeof value.versionSource === 'string' ? value.versionSource : undefined;
  const versionSource: BuildVersionSource =
    rawVersionSource === 'git_sha' ||
    rawVersionSource === 'package_version' ||
    rawVersionSource === 'unknown'
      ? rawVersionSource
      : commitSha
        ? 'git_sha'
        : packageVersion
          ? 'package_version'
          : 'unknown';

  return {
    environment: normalizeBuildEnvironment(
      typeof value.environment === 'string' ? value.environment : undefined,
    ),
    deployId:
      normalizeNonEmptyString(typeof value.deployId === 'string' ? value.deployId : null) ??
      'local',
    codeVersion,
    commitSha,
    packageVersion,
    versionSource,
  };
}

export function extractServiceBuildInfo(payload: unknown): ServiceBuildInfo | null {
  if (!isRecord(payload) || !('build' in payload)) {
    return null;
  }

  return parseServiceBuildInfo(payload.build);
}

export const PIPELINE_OBSERVABILITY_SUPPORTED_SURFACES = [
  'runs',
  'run_health',
  'data_preview',
  'output_schema',
] as const;

export type PipelineObservabilitySupportedSurface =
  (typeof PIPELINE_OBSERVABILITY_SUPPORTED_SURFACES)[number];

export const PIPELINE_OBSERVABILITY_DEFERRED_CAPABILITIES = [
  'manual_rerun',
  'historical_totals',
  'external_contact_center_metrics',
] as const;

export type PipelineObservabilityDeferredCapability =
  (typeof PIPELINE_OBSERVABILITY_DEFERRED_CAPABILITIES)[number];

export type PipelineObservabilityContract = {
  version: 1;
  supportLevel: 'alpha';
  metricOwnership: 'abl_owned_only';
  supportedSurfaces: readonly PipelineObservabilitySupportedSurface[];
  deferredCapabilities: readonly PipelineObservabilityDeferredCapability[];
};

export type PipelineObservabilityResponseMeta = { contract: PipelineObservabilityContract };

export const PIPELINE_OBSERVABILITY_CONTRACT: PipelineObservabilityContract = {
  version: 1,
  supportLevel: 'alpha',
  metricOwnership: 'abl_owned_only',
  supportedSurfaces: [...PIPELINE_OBSERVABILITY_SUPPORTED_SURFACES],
  deferredCapabilities: [...PIPELINE_OBSERVABILITY_DEFERRED_CAPABILITIES],
};
