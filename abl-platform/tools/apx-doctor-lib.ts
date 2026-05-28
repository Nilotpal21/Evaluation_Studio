import { access, readFile } from 'node:fs/promises';
import net from 'node:net';
import { resolve } from 'node:path';
import {
  DEFAULT_CLICKHOUSE_PORT,
  DEFAULT_MONGODB_PORT,
  DEFAULT_REDIS_PORT,
  DEFAULT_RUNTIME_PORT,
  DEFAULT_STUDIO_PORT,
  DEFAULT_WORKFLOW_ENGINE_PORT,
  validateCrossServiceConfig,
  validateEncryptionKey,
} from '@agent-platform/config';

export type ApxDoctorCategory = 'configuration' | 'deployment' | 'integration' | 'health';
export type ApxDoctorStatus = 'pass' | 'warn' | 'fail' | 'skip';
export type ApxDoctorSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface ApxDoctorCheck {
  id: string;
  category: ApxDoctorCategory;
  title: string;
  status: ApxDoctorStatus;
  severity: ApxDoctorSeverity;
  evidence: string[];
  remediation: string;
}

export interface ApxDoctorSummary {
  status: ApxDoctorStatus;
  counts: Record<ApxDoctorStatus, number>;
  byCategory: Record<ApxDoctorCategory, Record<ApxDoctorStatus, number>>;
}

export interface ApxDoctorReport {
  generatedAt: string;
  repoPath: string;
  summary: ApxDoctorSummary;
  checks: ApxDoctorCheck[];
  nextActions: string[];
}

export type ApxDoctorProgressEvent =
  | {
      type: 'phase-start';
      category: ApxDoctorCategory;
      label: string;
    }
  | {
      type: 'phase-complete';
      category: ApxDoctorCategory;
      label: string;
      counts: Record<ApxDoctorStatus, number>;
    }
  | {
      type: 'probe-progress';
      category: 'integration' | 'health';
      label: string;
      completed: number;
      total: number;
      status: ApxDoctorStatus;
    };

export interface ApxDoctorOptions {
  rootDir?: string;
  live?: boolean;
  onProgress?: (event: ApxDoctorProgressEvent) => void;
  timeoutMs?: number;
}

interface ServiceEnvSpec {
  id: string;
  name: string;
  required: boolean;
  contractFiles: string[];
  actualFiles: string[];
  requiredKeys: string[];
}

interface ProbeSpec {
  id: string;
  name: string;
  category: 'integration' | 'health';
  required: boolean;
  method: 'http' | 'tcp';
  target: string;
  timeoutMs?: number;
}

interface DeploymentProbeExpectation {
  block: string;
  required: boolean;
  requireProbes: boolean;
}

interface ResolvedServiceEnv {
  spec: ServiceEnvSpec;
  contractFilesFound: string[];
  contractFilesMissing: string[];
  actualFilesFound: string[];
  values: Record<string, string>;
}

interface SharedValueSpec {
  id: string;
  title: string;
  category: ApxDoctorCategory;
  severity: ApxDoctorSeverity;
  services: string[];
  key: string;
  remediation: string;
}

interface ApxDoctorContext {
  rootDir: string;
  live: boolean;
  onProgress?: (event: ApxDoctorProgressEvent) => void;
  timeoutMs: number;
  resolvedEnvs: ResolvedServiceEnv[];
  resolvedById: Map<string, ResolvedServiceEnv>;
}

const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_ADMIN_PORT = 3003;
const DEFAULT_SEARCH_AI_PORT = 3005;
const DEFAULT_SEARCH_AI_RUNTIME_PORT = 3004;
const DEFAULT_RESTATE_HEALTH_PORT = 9070;
const DEFAULT_DOCLING_PORT = 8080;
const DEFAULT_BGE_M3_PORT = 8000;
const DEFAULT_PREPROCESSING_PORT = 8003;
const DEFAULT_MULTIMODAL_PORT = 3006;
const ENCRYPTION_GATED_SERVICE_IDS = ['runtime', 'studio', 'workflow-engine'] as const;

const STATUS_ORDER: Record<ApxDoctorStatus, number> = {
  pass: 0,
  skip: 1,
  warn: 2,
  fail: 3,
};

const SEVERITY_ORDER: Record<ApxDoctorSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const GLOBAL_ACTUAL_ENV_FILES = ['.env.local', '.env'];

const SERVICE_ENV_SPECS: ServiceEnvSpec[] = [
  {
    id: 'runtime',
    name: 'Runtime',
    required: true,
    contractFiles: ['apps/runtime/.env.example'],
    actualFiles: ['apps/runtime/.env.local', 'apps/runtime/.env'],
    requiredKeys: [
      'MONGODB_URL',
      'JWT_SECRET',
      'AUTH_SDK_SESSION_SIGNING_SECRET',
      'AUTH_SDK_BOOTSTRAP_SIGNING_SECRET',
      'WORKFLOW_ENGINE_URL',
      'RUNTIME_URL',
    ],
  },
  {
    id: 'studio',
    name: 'Studio',
    required: true,
    contractFiles: ['apps/studio/.env.example'],
    actualFiles: ['apps/studio/.env.local', 'apps/studio/.env'],
    requiredKeys: [
      'NEXT_PUBLIC_RUNTIME_URL',
      'RUNTIME_URL',
      'NEXT_PUBLIC_APP_URL',
      'JWT_SECRET',
      'AUTH_SDK_BOOTSTRAP_SIGNING_SECRET',
      'NEXTAUTH_SECRET',
    ],
  },
  {
    id: 'admin',
    name: 'Admin',
    required: true,
    contractFiles: ['apps/admin/.env.example'],
    actualFiles: ['apps/admin/.env.local', 'apps/admin/.env'],
    requiredKeys: ['STUDIO_API_URL', 'NEXT_PUBLIC_BASE_URL', 'JWT_SECRET'],
  },
  {
    id: 'workflow-engine',
    name: 'Workflow Engine',
    required: true,
    contractFiles: ['apps/workflow-engine/.env.example'],
    actualFiles: ['apps/workflow-engine/.env.local', 'apps/workflow-engine/.env'],
    requiredKeys: [
      'MONGODB_URL',
      'REDIS_URL',
      'RESTATE_INGRESS_URL',
      'JWT_SECRET',
      'ENCRYPTION_MASTER_KEY',
      'RUNTIME_URL',
    ],
  },
  {
    id: 'search-ai',
    name: 'SearchAI',
    required: false,
    contractFiles: ['apps/search-ai/.env.example'],
    actualFiles: ['apps/search-ai/.env.local', 'apps/search-ai/.env'],
    requiredKeys: [],
  },
  {
    id: 'search-ai-runtime',
    name: 'SearchAI Runtime',
    required: false,
    contractFiles: ['apps/search-ai-runtime/.env.example'],
    actualFiles: ['apps/search-ai-runtime/.env.local', 'apps/search-ai-runtime/.env'],
    requiredKeys: [],
  },
];

const MODULE_SURFACE_FILES = [
  {
    path: 'apps/runtime/src/change-management/readiness.ts',
    label: 'Runtime readiness handler',
  },
  {
    path: 'apps/search-ai/src/change-management/readiness.ts',
    label: 'SearchAI readiness handler',
  },
  {
    path: 'apps/runtime/src/routes/platform-admin-health.ts',
    label: 'Runtime system-health route',
  },
  {
    path: 'apps/admin/src/app/api/system-health/route.ts',
    label: 'Admin system-health proxy route',
  },
  {
    path: 'apps/admin/src/app/(dashboard)/health/page.tsx',
    label: 'Admin cluster health UI',
  },
  {
    path: 'apps/runtime/src/services/preflight-validation-service.ts',
    label: 'Runtime deployment preflight service',
  },
  {
    path: 'apps/search-ai/src/routes/connector-config-mgmt.ts',
    label: 'SearchAI config-management route',
  },
  {
    path: 'apps/search-ai/src/services/connector-config-mgmt.service.ts',
    label: 'SearchAI config-management service',
  },
  {
    path: 'packages/config/src/validation/cross-service.ts',
    label: 'Shared cross-service validator',
  },
  {
    path: 'packages/config/src/validation/production-checks.ts',
    label: 'Shared production config validator',
  },
];

const DOCKERFILES = [
  { path: 'apps/runtime/Dockerfile', label: 'Runtime Dockerfile', required: true },
  { path: 'apps/studio/Dockerfile', label: 'Studio Dockerfile', required: true },
  { path: 'apps/admin/Dockerfile', label: 'Admin Dockerfile', required: true },
  { path: 'apps/workflow-engine/Dockerfile', label: 'Workflow Engine Dockerfile', required: true },
  { path: 'apps/search-ai/Dockerfile', label: 'SearchAI Dockerfile', required: false },
  {
    path: 'apps/search-ai-runtime/Dockerfile',
    label: 'SearchAI Runtime Dockerfile',
    required: false,
  },
  {
    path: 'apps/multimodal-service/Dockerfile',
    label: 'Multimodal Service Dockerfile',
    required: false,
  },
];

const HELM_TIER_FILES = [
  'deploy/helm-values/tier-s/values.yaml',
  'deploy/helm-values/tier-m/values.yaml',
  'deploy/helm-values/tier-l/values.yaml',
  'deploy/helm-values/tier-xl/values.yaml',
] as const;

const DEPLOYMENT_PROBE_EXPECTATIONS: DeploymentProbeExpectation[] = [
  { block: 'runtime', required: true, requireProbes: true },
  { block: 'workflowEngine', required: true, requireProbes: true },
  { block: 'studio', required: true, requireProbes: false },
  { block: 'admin', required: true, requireProbes: false },
  { block: 'searchAi', required: false, requireProbes: true },
  { block: 'searchAiRuntime', required: false, requireProbes: true },
];

const SHARED_VALUE_SPECS: SharedValueSpec[] = [
  {
    id: 'shared.jwt-secret',
    title: 'JWT_SECRET is coherent across runtime-facing services',
    category: 'configuration',
    severity: 'critical',
    services: ['runtime', 'studio', 'admin', 'workflow-engine'],
    key: 'JWT_SECRET',
    remediation:
      'Use the same JWT_SECRET across Runtime, Studio, Admin, and Workflow Engine for token interoperability.',
  },
  {
    id: 'shared.bootstrap-secret',
    title: 'AUTH_SDK_BOOTSTRAP_SIGNING_SECRET matches between runtime and studio',
    category: 'configuration',
    severity: 'critical',
    services: ['runtime', 'studio'],
    key: 'AUTH_SDK_BOOTSTRAP_SIGNING_SECRET',
    remediation: 'Provision the same AUTH_SDK_BOOTSTRAP_SIGNING_SECRET for Runtime and Studio.',
  },
  {
    id: 'shared.encryption-key',
    title: 'ENCRYPTION_MASTER_KEY matches between workflow and platform services',
    category: 'configuration',
    severity: 'high',
    services: ['runtime', 'workflow-engine'],
    key: 'ENCRYPTION_MASTER_KEY',
    remediation:
      'Provision the same ENCRYPTION_MASTER_KEY anywhere encrypted credentials are read or written.',
  },
  {
    id: 'shared.workflow-callback-secret',
    title: 'INTERNAL_CALLBACK_SECRET matches between runtime and workflow engine',
    category: 'integration',
    severity: 'high',
    services: ['runtime', 'workflow-engine'],
    key: 'INTERNAL_CALLBACK_SECRET',
    remediation:
      'Provision the same INTERNAL_CALLBACK_SECRET in Runtime and Workflow Engine to secure workflow completion callbacks.',
  },
];

export async function runApxDoctor(options: ApxDoctorOptions = {}): Promise<ApxDoctorReport> {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const live = options.live ?? true;
  const onProgress = options.onProgress;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const resolvedEnvs = await resolveAllServiceEnvs(rootDir);
  const context: ApxDoctorContext = {
    rootDir,
    live,
    onProgress,
    timeoutMs,
    resolvedEnvs,
    resolvedById: new Map(resolvedEnvs.map((entry) => [entry.spec.id, entry])),
  };
  const checks: ApxDoctorCheck[] = [];

  onProgress?.({ type: 'phase-start', category: 'configuration', label: 'Configuration' });
  const configurationChecks = await buildConfigurationChecks(context);
  checks.push(...configurationChecks);
  onProgress?.({
    type: 'phase-complete',
    category: 'configuration',
    label: 'Configuration',
    counts: summarizeStatusCounts(configurationChecks),
  });

  onProgress?.({ type: 'phase-start', category: 'deployment', label: 'Deployment' });
  const deploymentChecks = await buildDeploymentChecks(context);
  checks.push(...deploymentChecks);
  onProgress?.({
    type: 'phase-complete',
    category: 'deployment',
    label: 'Deployment',
    counts: summarizeStatusCounts(deploymentChecks),
  });

  onProgress?.({ type: 'phase-start', category: 'integration', label: 'Integration' });
  const integrationChecks = await buildIntegrationChecks(context);
  checks.push(...integrationChecks);
  onProgress?.({
    type: 'phase-complete',
    category: 'integration',
    label: 'Integration',
    counts: summarizeStatusCounts(integrationChecks),
  });

  onProgress?.({ type: 'phase-start', category: 'health', label: 'Health' });
  const healthChecks = await buildHealthChecks(context);
  checks.push(...healthChecks);
  onProgress?.({
    type: 'phase-complete',
    category: 'health',
    label: 'Health',
    counts: summarizeStatusCounts(healthChecks),
  });

  const summary = buildSummary(checks);
  return {
    generatedAt: new Date().toISOString(),
    repoPath: rootDir,
    summary,
    checks,
    nextActions: collectNextActions(checks),
  };
}

export function formatApxDoctorReport(report: ApxDoctorReport): string[] {
  const displayRemediations = collectDisplayRemediations(report.checks);
  const remediationLookup = new Map(
    displayRemediations.map((action, index) => [action, index + 1] as const),
  );
  const lines = [
    'APX Doctor',
    `Repo: ${report.repoPath}`,
    `Overall: ${report.summary.status.toUpperCase()} (${report.summary.counts.pass} pass, ${report.summary.counts.warn} warn, ${report.summary.counts.fail} fail, ${report.summary.counts.skip} skip)`,
  ];

  const failedChecks = sortChecksForDisplay(
    report.checks.filter((check) => check.status === 'fail'),
  );
  const warnedChecks = sortChecksForDisplay(
    report.checks.filter((check) => check.status === 'warn'),
  );
  const skippedChecks = sortChecksForDisplay(
    report.checks.filter((check) => check.status === 'skip'),
  );

  if (failedChecks.length > 0) {
    lines.push('');
    lines.push(`Failures To Fix Now (${failedChecks.length}):`);
    failedChecks.forEach((check, index) => {
      pushFormattedCheck(lines, check, index + 1, remediationLookup);
    });
  }

  if (warnedChecks.length > 0) {
    lines.push('');
    lines.push(`Warnings To Review (${warnedChecks.length}):`);
    warnedChecks.forEach((check, index) => {
      pushFormattedCheck(lines, check, index + 1, remediationLookup);
    });
  }

  if (displayRemediations.length > 0) {
    lines.push('');
    lines.push('Fix Checklist:');
    displayRemediations.forEach((action, index) => {
      lines.push(`  ${index + 1}. ${action}`);
    });
  }

  if (skippedChecks.length > 0) {
    lines.push('');
    lines.push(`Skipped Checks (${skippedChecks.length}):`);
    lines.push(
      '  - Live probes were skipped. Re-run without --no-live to verify health and readiness endpoints.',
    );
  }

  lines.push('');
  lines.push('Category Summary:');
  for (const category of categoryOrder()) {
    const counts = report.summary.byCategory[category];
    const hasAnyChecks = Object.values(counts).some((count) => count > 0);
    if (!hasAnyChecks) {
      continue;
    }
    lines.push(
      `  - ${capitalize(category)}: ${deriveStatusLabel(counts)} (${counts.pass} pass, ${counts.warn} warn, ${counts.fail} fail, ${counts.skip} skip)`,
    );
  }

  return lines;
}

async function buildConfigurationChecks(context: ApxDoctorContext): Promise<ApxDoctorCheck[]> {
  const checks: ApxDoctorCheck[] = [];
  const { rootDir, resolvedEnvs, resolvedById } = context;

  const rootEnvExampleExists = await pathExists(rootDir, '.env.example');
  checks.push({
    id: 'configuration.root-env-contract',
    category: 'configuration',
    title: 'Root environment contract is committed',
    status: rootEnvExampleExists ? 'pass' : 'fail',
    severity: 'critical',
    evidence: rootEnvExampleExists ? ['Found .env.example'] : ['Missing .env.example'],
    remediation:
      'Commit a root .env.example so platform-wide shared keys remain visible across environments.',
  });

  for (const resolved of resolvedEnvs) {
    checks.push(buildEnvContractCheck(resolved));
    checks.push(buildEnvProvisioningCheck(resolved));
  }

  checks.push(...buildSharedValueChecks(resolvedById));
  checks.push(...buildCrossServiceChecks(resolvedById));
  checks.push(...buildUrlCoherenceChecks(resolvedById));
  checks.push(...buildConnectionEndpointChecks(resolvedById));

  return checks;
}

async function buildDeploymentChecks(context: ApxDoctorContext): Promise<ApxDoctorCheck[]> {
  const checks: ApxDoctorCheck[] = [];
  const { rootDir } = context;

  const requiredRepoFiles = ['docker-compose.yml', 'ecosystem.config.js', 'package.json'];
  const missingRepoFiles = await collectMissingPaths(rootDir, requiredRepoFiles);
  checks.push({
    id: 'deployment.repo-artifacts',
    category: 'deployment',
    title: 'Core deployment artifacts are present',
    status: missingRepoFiles.length === 0 ? 'pass' : 'fail',
    severity: 'critical',
    evidence:
      missingRepoFiles.length === 0
        ? requiredRepoFiles.map((entry) => `Found ${entry}`)
        : missingRepoFiles.map((entry) => `Missing ${entry}`),
    remediation:
      'Keep docker-compose.yml, ecosystem.config.js, and package.json aligned so apx can reason about deployable services.',
  });

  const missingDockerfiles = await collectMissingPaths(
    rootDir,
    DOCKERFILES.filter((entry) => entry.required).map((entry) => entry.path),
  );
  const optionalDockerfilesMissing = await collectMissingPaths(
    rootDir,
    DOCKERFILES.filter((entry) => !entry.required).map((entry) => entry.path),
  );
  checks.push({
    id: 'deployment.dockerfiles',
    category: 'deployment',
    title: 'Deployable services have Dockerfiles',
    status:
      missingDockerfiles.length > 0
        ? 'fail'
        : optionalDockerfilesMissing.length > 0
          ? 'warn'
          : 'pass',
    severity: missingDockerfiles.length > 0 ? 'high' : 'medium',
    evidence: [
      ...DOCKERFILES.filter((entry) => entry.required)
        .filter((entry) => !missingDockerfiles.includes(entry.path))
        .map((entry) => `Found ${entry.path}`),
      ...missingDockerfiles.map((entry) => `Missing required Dockerfile ${entry}`),
      ...optionalDockerfilesMissing.map((entry) => `Missing optional Dockerfile ${entry}`),
    ],
    remediation:
      'Add Dockerfiles for deployable app services so environment promotion and release packaging stay consistent.',
  });

  for (const tierFile of HELM_TIER_FILES) {
    checks.push(await buildHelmTierCheck(rootDir, tierFile));
  }

  return checks;
}

async function buildIntegrationChecks(context: ApxDoctorContext): Promise<ApxDoctorCheck[]> {
  const checks: ApxDoctorCheck[] = [];
  const { rootDir, live, onProgress, timeoutMs, resolvedById } = context;

  const missingSurfaceFiles = await collectMissingPaths(
    rootDir,
    MODULE_SURFACE_FILES.map((entry) => entry.path),
  );
  checks.push({
    id: 'integration.readiness-surfaces',
    category: 'integration',
    title: 'Environment-readiness and configuration-management surfaces are implemented',
    status: missingSurfaceFiles.length === 0 ? 'pass' : 'fail',
    severity: 'high',
    evidence:
      missingSurfaceFiles.length === 0
        ? MODULE_SURFACE_FILES.map((entry) => `Found ${entry.label} at ${entry.path}`)
        : MODULE_SURFACE_FILES.filter((entry) => missingSurfaceFiles.includes(entry.path)).map(
            (entry) => `Missing ${entry.label} at ${entry.path}`,
          ),
    remediation:
      'Keep admin health, readiness handlers, deployment preflight, config-management, and shared config validators wired together as doctor inputs.',
  });

  const probeSpecs = buildLiveProbes(resolvedById).filter(
    (probe) => probe.category === 'integration',
  );
  checks.push(...(await buildProbeChecks(probeSpecs, live, timeoutMs, onProgress)));

  return checks;
}

async function buildHealthChecks(context: ApxDoctorContext): Promise<ApxDoctorCheck[]> {
  const { live, onProgress, timeoutMs, resolvedById } = context;
  const checks = await buildProbeChecks(
    buildLiveProbes(resolvedById).filter((probe) => probe.category === 'health'),
    live,
    timeoutMs,
    onProgress,
  );
  return checks;
}

async function buildProbeChecks(
  probes: ProbeSpec[],
  live: boolean,
  timeoutMs: number,
  onProgress?: (event: ApxDoctorProgressEvent) => void,
): Promise<ApxDoctorCheck[]> {
  let completed = 0;
  return await Promise.all(
    probes.map(async (probe) => {
      const check = await buildProbeCheck(probe, live, timeoutMs);
      completed += 1;
      onProgress?.({
        type: 'probe-progress',
        category: probe.category,
        label: probe.name,
        completed,
        total: probes.length,
        status: check.status,
      });
      return check;
    }),
  );
}

async function buildHelmTierCheck(rootDir: string, tierFile: string): Promise<ApxDoctorCheck> {
  const exists = await pathExists(rootDir, tierFile);
  if (!exists) {
    return {
      id: `deployment.${tierFile}.exists`,
      category: 'deployment',
      title: `${tierFile} is present`,
      status: 'fail',
      severity: 'high',
      evidence: [`Missing ${tierFile}`],
      remediation: 'Keep Helm tier values in-repo so doctor can validate deployment readiness.',
    };
  }

  const contents = await readFile(resolve(rootDir, tierFile), 'utf-8');
  const missingBlocks: string[] = [];
  const missingProbes: string[] = [];

  for (const expectation of DEPLOYMENT_PROBE_EXPECTATIONS) {
    const block = extractTopLevelYamlBlock(contents, expectation.block);
    if (!block) {
      if (expectation.required) {
        missingBlocks.push(expectation.block);
      }
      continue;
    }

    if (!expectation.requireProbes) {
      continue;
    }

    if (
      !blockHasPath(block, ['probes']) ||
      !blockHasPath(block, ['probes', 'liveness']) ||
      !blockHasPath(block, ['probes', 'readiness'])
    ) {
      missingProbes.push(expectation.block);
    }
  }

  const status = missingBlocks.length > 0 ? 'fail' : missingProbes.length > 0 ? 'warn' : 'pass';

  return {
    id: `deployment.${tierFile}.probe-coverage`,
    category: 'deployment',
    title: `${tierFile} covers deployable service probes`,
    status,
    severity: missingBlocks.length > 0 ? 'high' : 'medium',
    evidence: [
      `Validated ${tierFile}`,
      ...missingBlocks.map((entry) => `Missing required service block "${entry}"`),
      ...missingProbes.map((entry) => `Missing liveness/readiness probes for "${entry}"`),
    ],
    remediation:
      'Add missing service blocks and liveness/readiness probes to Helm tier values so promotion checks can validate deploy health consistently.',
  };
}

function buildEnvContractCheck(resolved: ResolvedServiceEnv): ApxDoctorCheck {
  const missingContracts = resolved.contractFilesMissing;
  const status = missingContracts.length === 0 ? 'pass' : resolved.spec.required ? 'fail' : 'warn';

  return {
    id: `configuration.${resolved.spec.id}.env-contract`,
    category: 'configuration',
    title: `${resolved.spec.name} has a committed env contract`,
    status,
    severity: resolved.spec.required ? 'high' : 'medium',
    evidence:
      missingContracts.length === 0
        ? resolved.contractFilesFound.map((entry) => `Found ${entry}`)
        : missingContracts.map((entry) => `Missing ${entry}`),
    remediation:
      'Commit an .env.example or equivalent contract file for every service that moves across environments.',
  };
}

function buildEnvProvisioningCheck(resolved: ResolvedServiceEnv): ApxDoctorCheck {
  const requiredKeys = resolveRequiredKeys(resolved);
  const missingKeys = requiredKeys.filter((key) => isBlank(resolved.values[key]));

  let status: ApxDoctorStatus = 'pass';
  if (missingKeys.length > 0) {
    status = resolved.spec.required ? 'fail' : 'warn';
  }

  const evidence: string[] = [];
  if (resolved.actualFilesFound.length > 0) {
    evidence.push(...resolved.actualFilesFound.map((entry) => `Provisioned file ${entry}`));
  } else {
    evidence.push('No local env file detected; falling back to current process environment only.');
  }
  if (missingKeys.length > 0) {
    evidence.push(...missingKeys.map((key) => `Missing required key ${key}`));
  } else if (requiredKeys.length > 0) {
    evidence.push(...requiredKeys.map((key) => `Resolved required key ${key} (value redacted)`));
  }
  if (
    resolved.spec.requiredKeys.includes('ENCRYPTION_MASTER_KEY') &&
    isEncryptionDisabled(resolved.values) &&
    !requiredKeys.includes('ENCRYPTION_MASTER_KEY')
  ) {
    evidence.push('ENCRYPTION_MASTER_KEY not required because ENCRYPTION_ENABLED=false.');
  }

  return {
    id: `configuration.${resolved.spec.id}.env-provisioning`,
    category: 'configuration',
    title: `${resolved.spec.name} environment is provisioned`,
    status,
    severity: resolved.spec.required ? 'critical' : 'medium',
    evidence,
    remediation:
      'Populate the required environment variables for this service in local env files or process-level environment.',
  };
}

function buildSharedValueChecks(resolvedById: Map<string, ResolvedServiceEnv>): ApxDoctorCheck[] {
  return SHARED_VALUE_SPECS.map((spec) => {
    const applicableServices = resolveSharedValueServices(spec, resolvedById);
    const disabledServices = spec.services.filter(
      (serviceId) => !applicableServices.includes(serviceId),
    );
    const presentValues = applicableServices
      .map((serviceId) => ({
        serviceId,
        value: resolvedById.get(serviceId)?.values[spec.key]?.trim() ?? '',
      }))
      .filter((entry) => entry.value.length > 0);
    const uniqueValues = uniqueStrings(presentValues.map((entry) => entry.value));
    const missingServices = applicableServices.filter((serviceId) =>
      isBlank(resolvedById.get(serviceId)?.values[spec.key]),
    );

    let status: ApxDoctorStatus = 'pass';
    if (applicableServices.length === 0) {
      status = 'pass';
    } else if (uniqueValues.length > 1) {
      status = 'fail';
    } else if (missingServices.length > 0) {
      status = 'warn';
    }

    const evidence =
      applicableServices.length === 0
        ? [
            `${spec.key} is not required because encryption is disabled for ${disabledServices.join(', ')}.`,
          ]
        : status === 'fail'
          ? [
              ...presentValues.map(
                (entry) =>
                  `${entry.serviceId} defines ${spec.key} (value redacted, fingerprint differs)`,
              ),
              ...disabledServices.map(
                (entry) => `${entry} has encryption disabled; ${spec.key} is not required there`,
              ),
            ]
          : status === 'warn'
            ? [
                ...missingServices.map((entry) => `${entry} does not resolve ${spec.key}`),
                ...disabledServices.map(
                  (entry) => `${entry} has encryption disabled; ${spec.key} is not required there`,
                ),
              ]
            : [
                `${spec.key} resolves consistently across ${applicableServices.join(', ')}`,
                ...disabledServices.map(
                  (entry) => `${entry} has encryption disabled; ${spec.key} is not required there`,
                ),
              ];

    return {
      id: spec.id,
      category: spec.category,
      title: spec.title,
      status,
      severity: spec.severity,
      evidence,
      remediation: spec.remediation,
    };
  });
}

function buildCrossServiceChecks(resolvedById: Map<string, ResolvedServiceEnv>): ApxDoctorCheck[] {
  const serviceConfigs = [
    buildCrossServiceConfig('runtime', resolvedById),
    buildCrossServiceConfig('studio', resolvedById),
    buildCrossServiceConfig('admin', resolvedById),
    buildCrossServiceConfig('workflow-engine', resolvedById),
  ];
  const issues = validateCrossServiceConfig(serviceConfigs);
  if (issues.length === 0) {
    return [
      {
        id: 'configuration.cross-service-consistency',
        category: 'configuration',
        title: 'Cross-service config invariants pass shared validation',
        status: 'pass',
        severity: 'medium',
        evidence: ['Shared config validator found no cross-service issues.'],
        remediation:
          'Keep shared config validation green when adding new environment variables or service boundaries.',
      },
    ];
  }

  return issues.map((issue, index) => ({
    id: `configuration.cross-service-consistency.${index + 1}`,
    category: 'configuration',
    title: `Cross-service config issue: ${issue.field}`,
    status: issue.level === 'error' ? 'fail' : 'warn',
    severity: issue.level === 'error' ? 'high' : 'medium',
    evidence: [issue.message, `Services: ${issue.services.join(', ')}`],
    remediation:
      'Align shared URLs, JWT secrets, database endpoints, and Redis endpoints before promoting this environment.',
  }));
}

function buildUrlCoherenceChecks(resolvedById: Map<string, ResolvedServiceEnv>): ApxDoctorCheck[] {
  return [
    buildConsistentUrlCheck({
      id: 'configuration.runtime-url-coherence',
      title: 'Runtime base URL is coherent across runtime, studio, and workflow engine',
      severity: 'high',
      minimumDefined: 3,
      entries: [
        { label: 'runtime.RUNTIME_URL', value: resolvedById.get('runtime')?.values.RUNTIME_URL },
        { label: 'studio.RUNTIME_URL', value: resolvedById.get('studio')?.values.RUNTIME_URL },
        {
          label: 'studio.NEXT_PUBLIC_RUNTIME_URL',
          value: resolvedById.get('studio')?.values.NEXT_PUBLIC_RUNTIME_URL,
        },
        {
          label: 'workflow-engine.RUNTIME_URL',
          value: resolvedById.get('workflow-engine')?.values.RUNTIME_URL,
        },
      ],
      remediation:
        'Keep Runtime, Studio, and Workflow Engine aligned on the same Runtime base URL so proxying, callbacks, and WebSocket-derived surfaces stay coherent across environments.',
    }),
    buildConsistentUrlCheck({
      id: 'configuration.workflow-url-coherence',
      title: 'Workflow Engine base URL is coherent across runtime, studio, and workflow engine',
      severity: 'high',
      minimumDefined: 2,
      entries: [
        {
          label: 'runtime.WORKFLOW_ENGINE_URL',
          value: resolvedById.get('runtime')?.values.WORKFLOW_ENGINE_URL,
        },
        {
          label: 'studio.WORKFLOW_ENGINE_URL',
          value: resolvedById.get('studio')?.values.WORKFLOW_ENGINE_URL,
        },
        {
          label: 'workflow-engine.WORKFLOW_ENGINE_PUBLIC_URL',
          value: resolvedById.get('workflow-engine')?.values.WORKFLOW_ENGINE_PUBLIC_URL,
        },
      ],
      remediation:
        'Keep Runtime, Studio, and Workflow Engine aligned on the same Workflow Engine base URL for tool execution, operator actions, and external callback generation.',
    }),
    buildConsistentUrlCheck({
      id: 'configuration.studio-url-coherence',
      title: 'Studio base URL is coherent across studio and admin',
      severity: 'medium',
      minimumDefined: 2,
      entries: [
        {
          label: 'studio.NEXT_PUBLIC_APP_URL',
          value: resolvedById.get('studio')?.values.NEXT_PUBLIC_APP_URL,
        },
        { label: 'admin.STUDIO_API_URL', value: resolvedById.get('admin')?.values.STUDIO_API_URL },
        { label: 'admin.FRONTEND_URL', value: resolvedById.get('admin')?.values.FRONTEND_URL },
        {
          label: 'admin.NEXT_PUBLIC_APP_URL',
          value: resolvedById.get('admin')?.values.NEXT_PUBLIC_APP_URL,
        },
        {
          label: 'admin.NEXT_PUBLIC_STUDIO_URL',
          value: resolvedById.get('admin')?.values.NEXT_PUBLIC_STUDIO_URL,
        },
      ],
      remediation:
        'Keep Admin and Studio aligned on the Studio origin so proxying, redirects, and login handoffs remain stable across environments.',
    }),
  ];
}

function buildConnectionEndpointChecks(
  resolvedById: Map<string, ResolvedServiceEnv>,
): ApxDoctorCheck[] {
  const checks: ApxDoctorCheck[] = [];
  const encryptionEnabledServices = resolveEncryptionServiceIds(resolvedById);
  const encryptionDisabledServices = ENCRYPTION_GATED_SERVICE_IDS.filter(
    (serviceId) => !encryptionEnabledServices.includes(serviceId),
  );

  const mongoCheck = buildEndpointParityCheck({
    id: 'configuration.mongodb-endpoint-parity',
    title: 'MongoDB endpoint is coherent across core services',
    category: 'configuration',
    values: [
      ['runtime', resolvedById.get('runtime')?.values.MONGODB_URL],
      ['studio', resolvedById.get('studio')?.values.MONGODB_URL],
      ['workflow-engine', resolvedById.get('workflow-engine')?.values.MONGODB_URL],
    ],
    parser: parseMongoEndpoint,
    remediation:
      'Point Runtime, Studio, and Workflow Engine at the same MongoDB host and port for environment consistency.',
  });
  if (mongoCheck) {
    checks.push(mongoCheck);
  }

  const redisCheck = buildEndpointParityCheck({
    id: 'configuration.redis-endpoint-parity',
    title: 'Redis endpoint is coherent across services that depend on it',
    category: 'configuration',
    values: [
      ['runtime', resolvedById.get('runtime')?.values.REDIS_URL],
      ['workflow-engine', resolvedById.get('workflow-engine')?.values.REDIS_URL],
    ],
    parser: parseRedisEndpoint,
    remediation:
      'Point Runtime and Workflow Engine at the same Redis host and port when Redis-backed coordination is enabled.',
  });
  if (redisCheck) {
    checks.push(redisCheck);
  }

  const encryptionValue = firstNonEmpty(
    encryptionEnabledServices.map(
      (serviceId) => resolvedById.get(serviceId)?.values.ENCRYPTION_MASTER_KEY,
    ),
  );
  checks.push(
    buildEncryptionKeyCheck({
      value: encryptionValue,
      enabledServices: [...encryptionEnabledServices],
      disabledServices: [...encryptionDisabledServices],
    }),
  );

  return checks;
}

function buildEncryptionKeyCheck(params: {
  value: string | undefined;
  enabledServices: string[];
  disabledServices: string[];
}): ApxDoctorCheck {
  const { value, enabledServices, disabledServices } = params;
  if (enabledServices.length === 0) {
    return {
      id: 'configuration.encryption-key-quality',
      category: 'configuration',
      title: 'ENCRYPTION_MASTER_KEY readiness matches encryption mode',
      status: 'pass',
      severity: 'high',
      evidence: [
        `ENCRYPTION_MASTER_KEY is not required because encryption is disabled for ${disabledServices.join(', ')}.`,
      ],
      remediation:
        'Enable encryption and provision a high-entropy 64-character hex ENCRYPTION_MASTER_KEY before relying on encrypted credentials.',
    };
  }

  if (isBlank(value)) {
    return {
      id: 'configuration.encryption-key-quality',
      category: 'configuration',
      title: 'ENCRYPTION_MASTER_KEY readiness matches encryption mode',
      status: 'warn',
      severity: 'high',
      evidence: [
        `ENCRYPTION_MASTER_KEY is unresolved for encryption-enabled services: ${enabledServices.join(', ')}.`,
        ...disabledServices.map(
          (serviceId) =>
            `${serviceId} has encryption disabled; ENCRYPTION_MASTER_KEY is optional there`,
        ),
      ],
      remediation:
        'Provision ENCRYPTION_MASTER_KEY before moving this environment toward shared or production-like use.',
    };
  }

  const validation = validateEncryptionKey(value!);
  return {
    id: 'configuration.encryption-key-quality',
    category: 'configuration',
    title: 'ENCRYPTION_MASTER_KEY readiness matches encryption mode',
    status: validation.valid ? 'pass' : 'fail',
    severity: 'high',
    evidence: validation.valid
      ? [
          `ENCRYPTION_MASTER_KEY resolved and passed format validation for ${enabledServices.join(', ')}.`,
          ...disabledServices.map(
            (serviceId) =>
              `${serviceId} has encryption disabled; ENCRYPTION_MASTER_KEY is optional there`,
          ),
        ]
      : [
          `ENCRYPTION_MASTER_KEY failed validation: ${validation.reason}`,
          `Applies to encryption-enabled services: ${enabledServices.join(', ')}`,
        ],
    remediation:
      'Use a high-entropy 64-character hex ENCRYPTION_MASTER_KEY generated for this environment.',
  };
}

function buildLiveProbes(resolvedById: Map<string, ResolvedServiceEnv>): ProbeSpec[] {
  const runtimeBase = resolveBaseUrl(
    [
      resolvedById.get('runtime')?.values.RUNTIME_URL,
      resolvedById.get('studio')?.values.RUNTIME_URL,
      resolvedById.get('studio')?.values.NEXT_PUBLIC_RUNTIME_URL,
      process.env.RUNTIME_URL,
    ],
    `http://localhost:${DEFAULT_RUNTIME_PORT}`,
  );
  const studioBase = resolveBaseUrl(
    [
      resolvedById.get('studio')?.values.NEXT_PUBLIC_APP_URL,
      resolvedById.get('admin')?.values.STUDIO_API_URL,
      process.env.STUDIO_URL,
    ],
    `http://localhost:${DEFAULT_STUDIO_PORT}`,
  );
  const adminBase = resolveBaseUrl(
    [resolvedById.get('admin')?.values.NEXT_PUBLIC_BASE_URL, process.env.ADMIN_URL],
    `http://localhost:${DEFAULT_ADMIN_PORT}`,
  );
  const workflowBase = resolveBaseUrl(
    [
      resolvedById.get('workflow-engine')?.values.WORKFLOW_ENGINE_PUBLIC_URL,
      resolvedById.get('studio')?.values.WORKFLOW_ENGINE_URL,
      resolvedById.get('runtime')?.values.WORKFLOW_ENGINE_URL,
      process.env.WORKFLOW_ENGINE_URL,
    ],
    `http://localhost:${DEFAULT_WORKFLOW_ENGINE_PORT}`,
  );
  const clickhouseBase = resolveBaseUrl(
    [resolvedById.get('runtime')?.values.CLICKHOUSE_URL, process.env.CLICKHOUSE_URL],
    `http://localhost:${DEFAULT_CLICKHOUSE_PORT}`,
  );
  const searchAiBase = resolveBaseUrl(
    [resolvedById.get('search-ai')?.values.SEARCH_AI_URL, process.env.SEARCH_AI_URL],
    `http://localhost:${DEFAULT_SEARCH_AI_PORT}`,
  );
  const searchAiRuntimeBase = resolveBaseUrl(
    [
      resolvedById.get('search-ai-runtime')?.values.SEARCH_AI_RUNTIME_URL,
      process.env.SEARCH_AI_RUNTIME_URL,
    ],
    `http://localhost:${DEFAULT_SEARCH_AI_RUNTIME_PORT}`,
  );
  const restateBase = resolveBaseUrl(
    [
      resolvedById.get('workflow-engine')?.values.RESTATE_ADMIN_URL,
      process.env.RESTATE_ADMIN_URL,
      resolvedById.get('workflow-engine')?.values.RESTATE_INGRESS_URL,
      process.env.RESTATE_INGRESS_URL,
      process.env.RESTATE_URL,
    ],
    `http://localhost:${DEFAULT_RESTATE_HEALTH_PORT}`,
  );
  const doclingBase = resolveBaseUrl(
    [resolvedById.get('search-ai')?.values.DOCLING_URL, process.env.DOCLING_URL],
    `http://localhost:${DEFAULT_DOCLING_PORT}`,
  );
  const bgeBase = resolveBaseUrl(
    [resolvedById.get('search-ai')?.values.BGE_M3_URL, process.env.BGE_M3_URL],
    `http://localhost:${DEFAULT_BGE_M3_PORT}`,
  );
  const preprocessingBase = resolveBaseUrl(
    [resolvedById.get('search-ai')?.values.PREPROCESSING_URL, process.env.PREPROCESSING_URL],
    `http://localhost:${DEFAULT_PREPROCESSING_PORT}`,
  );
  const multimodalBase = resolveBaseUrl(
    [process.env.MULTIMODAL_URL],
    `http://localhost:${DEFAULT_MULTIMODAL_PORT}`,
  );
  const mongoTarget = resolveTcpTarget(
    [
      resolvedById.get('runtime')?.values.MONGODB_URL,
      resolvedById.get('workflow-engine')?.values.MONGODB_URL,
      resolvedById.get('studio')?.values.MONGODB_URL,
      process.env.MONGODB_URL,
    ],
    parseMongoEndpoint,
    DEFAULT_MONGODB_PORT,
  );
  const redisTarget = resolveTcpTarget(
    [
      resolvedById.get('workflow-engine')?.values.REDIS_URL,
      resolvedById.get('runtime')?.values.REDIS_URL,
      resolvedById.get('studio')?.values.REDIS_URL,
      process.env.REDIS_URL,
    ],
    parseRedisEndpoint,
    DEFAULT_REDIS_PORT,
  );

  return [
    {
      id: 'runtime-health',
      name: 'Runtime /health',
      category: 'health',
      required: true,
      method: 'http',
      target: appendUrlPath(runtimeBase, '/health'),
    },
    {
      id: 'runtime-ready',
      name: 'Runtime /health/ready',
      category: 'integration',
      required: true,
      method: 'http',
      target: appendUrlPath(runtimeBase, '/health/ready'),
    },
    {
      id: 'studio-health',
      name: 'Studio /api/health',
      category: 'health',
      required: true,
      method: 'http',
      target: appendUrlPath(studioBase, '/api/health'),
    },
    {
      id: 'studio-ready',
      name: 'Studio /health/ready',
      category: 'integration',
      required: true,
      method: 'http',
      target: appendUrlPath(studioBase, '/health/ready'),
    },
    {
      id: 'studio-e2e-ready',
      name: 'Studio /api/health/e2e-ready',
      category: 'integration',
      required: false,
      method: 'http',
      target: appendUrlPath(studioBase, '/api/health/e2e-ready'),
    },
    {
      id: 'admin-health',
      name: 'Admin /api/health',
      category: 'health',
      required: true,
      method: 'http',
      target: appendUrlPath(adminBase, '/api/health'),
    },
    {
      id: 'workflow-health',
      name: 'Workflow Engine /health',
      category: 'health',
      required: true,
      method: 'http',
      target: appendUrlPath(workflowBase, '/health'),
    },
    {
      id: 'workflow-ready',
      name: 'Workflow Engine /health/ready',
      category: 'integration',
      required: true,
      method: 'http',
      target: appendUrlPath(workflowBase, '/health/ready'),
    },
    {
      id: 'restate-health',
      name: 'Restate /health',
      category: 'health',
      required: true,
      method: 'http',
      target: appendUrlPath(restateBase, '/health'),
    },
    {
      id: 'mongo-port',
      name: `MongoDB port ${DEFAULT_MONGODB_PORT}`,
      category: 'health',
      required: true,
      method: 'tcp',
      target: mongoTarget,
    },
    {
      id: 'redis-port',
      name: `Redis port ${DEFAULT_REDIS_PORT}`,
      category: 'health',
      required: true,
      method: 'tcp',
      target: redisTarget,
    },
    {
      id: 'clickhouse-ping',
      name: 'ClickHouse /ping',
      category: 'health',
      required: true,
      method: 'http',
      target: appendUrlPath(clickhouseBase, '/ping'),
    },
    {
      id: 'search-ai-health',
      name: 'SearchAI /health',
      category: 'health',
      required: false,
      method: 'http',
      target: appendUrlPath(searchAiBase, '/health'),
    },
    {
      id: 'search-ai-ready',
      name: 'SearchAI /health/ready',
      category: 'integration',
      required: false,
      method: 'http',
      target: appendUrlPath(searchAiBase, '/health/ready'),
    },
    {
      id: 'search-ai-runtime-health',
      name: 'SearchAI Runtime /health',
      category: 'health',
      required: false,
      method: 'http',
      target: appendUrlPath(searchAiRuntimeBase, '/health'),
    },
    {
      id: 'search-ai-runtime-ready',
      name: 'SearchAI Runtime /health/ready',
      category: 'integration',
      required: false,
      method: 'http',
      target: appendUrlPath(searchAiRuntimeBase, '/health/ready'),
    },
    {
      id: 'docling-health',
      name: 'Docling /health',
      category: 'health',
      required: false,
      method: 'http',
      target: appendUrlPath(doclingBase, '/health'),
    },
    {
      id: 'bge-health',
      name: 'BGE-M3 /health',
      category: 'health',
      required: false,
      method: 'http',
      target: appendUrlPath(bgeBase, '/health'),
    },
    {
      id: 'preprocessing-health',
      name: 'Preprocessing /health',
      category: 'health',
      required: false,
      method: 'http',
      target: appendUrlPath(preprocessingBase, '/health'),
    },
    {
      id: 'multimodal-health',
      name: 'Multimodal /health',
      category: 'health',
      required: false,
      method: 'http',
      target: appendUrlPath(multimodalBase, '/health'),
    },
    {
      id: 'multimodal-ready',
      name: 'Multimodal /health/ready',
      category: 'integration',
      required: false,
      method: 'http',
      target: appendUrlPath(multimodalBase, '/health/ready'),
    },
  ];
}

async function buildProbeCheck(
  probe: ProbeSpec,
  live: boolean,
  timeoutMs: number,
): Promise<ApxDoctorCheck> {
  if (!live) {
    return {
      id: `${probe.category}.${probe.id}`,
      category: probe.category,
      title: `${probe.name} is reachable`,
      status: 'skip',
      severity: probe.required ? 'medium' : 'low',
      evidence: ['Live probing disabled via --no-live.'],
      remediation: 'Re-run apx doctor without --no-live to validate live health and readiness.',
    };
  }

  const result =
    probe.method === 'http'
      ? await probeHttp(probe.target, probe.timeoutMs ?? timeoutMs)
      : await probeTcp(probe.target, probe.timeoutMs ?? timeoutMs);

  let status: ApxDoctorStatus = 'pass';
  if (!result.ok) {
    status = probe.required ? 'fail' : 'warn';
  }

  return {
    id: `${probe.category}.${probe.id}`,
    category: probe.category,
    title: `${probe.name} is reachable`,
    status,
    severity: probe.required ? 'high' : 'medium',
    evidence: result.evidence,
    remediation:
      probe.method === 'http'
        ? `Ensure ${probe.target} is up and returns a healthy response before relying on this environment.`
        : `Ensure ${probe.target} is listening before relying on this environment.`,
  };
}

async function resolveAllServiceEnvs(rootDir: string): Promise<ResolvedServiceEnv[]> {
  return await Promise.all(SERVICE_ENV_SPECS.map((spec) => resolveServiceEnv(rootDir, spec)));
}

async function resolveServiceEnv(
  rootDir: string,
  spec: ServiceEnvSpec,
): Promise<ResolvedServiceEnv> {
  const contractFilesFound: string[] = [];
  const contractFilesMissing: string[] = [];

  for (const relPath of spec.contractFiles) {
    if (await pathExists(rootDir, relPath)) {
      contractFilesFound.push(relPath);
    } else {
      contractFilesMissing.push(relPath);
    }
  }

  const values: Record<string, string> = {};
  const actualFilesFound: string[] = [];

  for (const relPath of [...GLOBAL_ACTUAL_ENV_FILES, ...spec.actualFiles]) {
    if (!(await pathExists(rootDir, relPath))) {
      continue;
    }
    actualFilesFound.push(relPath);
    Object.assign(values, parseEnvText(await readFile(resolve(rootDir, relPath), 'utf-8')));
  }

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      values[key] = value;
    }
  }

  return {
    spec,
    contractFilesFound,
    contractFilesMissing,
    actualFilesFound: uniqueStrings(actualFilesFound),
    values,
  };
}

function buildCrossServiceConfig(
  serviceId: string,
  resolvedById: Map<string, ResolvedServiceEnv>,
): {
  name: string;
  server?: { apiUrl?: string };
  jwt?: { secret?: string };
  database?: { url?: string };
  redis?: { url?: string };
} {
  const values = resolvedById.get(serviceId)?.values ?? {};
  switch (serviceId) {
    case 'runtime':
      return {
        name: 'runtime',
        server: { apiUrl: values.RUNTIME_URL },
        jwt: { secret: values.JWT_SECRET },
        database: { url: values.MONGODB_URL },
        redis: { url: values.REDIS_URL },
      };
    case 'studio':
      return {
        name: 'studio',
        server: { apiUrl: values.RUNTIME_URL },
        jwt: { secret: values.JWT_SECRET },
        database: { url: values.MONGODB_URL },
        redis: { url: values.REDIS_URL },
      };
    case 'admin':
      return {
        name: 'admin',
        server: { apiUrl: values.STUDIO_API_URL },
        jwt: { secret: values.JWT_SECRET },
      };
    case 'workflow-engine':
      return {
        name: 'workflow-engine',
        server: { apiUrl: values.RUNTIME_URL },
        jwt: { secret: values.JWT_SECRET },
        database: { url: values.MONGODB_URL },
        redis: { url: values.REDIS_URL },
      };
    default:
      return { name: serviceId };
  }
}

function buildConsistentUrlCheck(params: {
  id: string;
  title: string;
  severity: ApxDoctorSeverity;
  minimumDefined: number;
  entries: Array<{ label: string; value: string | undefined }>;
  remediation: string;
}): ApxDoctorCheck {
  const normalizedEntries = params.entries.map((entry) => ({
    label: entry.label,
    rawValue: entry.value?.trim() ?? '',
    normalizedValue: normalizeUrl(entry.value?.trim() ?? ''),
  }));
  const definedEntries = normalizedEntries.filter((entry) => !isBlank(entry.normalizedValue));
  const missingEntries = normalizedEntries
    .filter((entry) => isBlank(entry.normalizedValue))
    .map((entry) => entry.label);
  const uniqueUrls = uniqueStrings(definedEntries.map((entry) => entry.normalizedValue));

  let status: ApxDoctorStatus = 'pass';
  if (definedEntries.length === 0) {
    status = 'warn';
  } else if (uniqueUrls.length > 1) {
    status = 'fail';
  } else if (definedEntries.length < params.minimumDefined || missingEntries.length > 0) {
    status = 'warn';
  }

  const evidence: string[] = [];
  if (definedEntries.length === 0) {
    evidence.push('No configured URL values were resolved for this relationship.');
  } else {
    evidence.push(
      ...definedEntries.map(
        (entry) => `${entry.label} -> ${entry.normalizedValue || entry.rawValue}`,
      ),
    );
  }
  if (missingEntries.length > 0) {
    evidence.push(...missingEntries.map((entry) => `${entry} is not defined`));
  }

  return {
    id: params.id,
    category: 'configuration',
    title: params.title,
    status,
    severity: params.severity,
    evidence,
    remediation: params.remediation,
  };
}

function buildEndpointParityCheck(params: {
  id: string;
  title: string;
  category: ApxDoctorCategory;
  values: Array<[string, string | undefined]>;
  parser: (value: string) => string | null;
  remediation: string;
}): ApxDoctorCheck | null {
  const parsed = params.values
    .map(([service, value]) => ({
      service,
      endpoint: value && !isBlank(value) ? params.parser(value) : null,
    }))
    .filter((entry) => entry.endpoint !== null) as Array<{ service: string; endpoint: string }>;

  if (parsed.length === 0) {
    return null;
  }

  const endpoints = uniqueStrings(parsed.map((entry) => entry.endpoint));
  return {
    id: params.id,
    category: params.category,
    title: params.title,
    status: endpoints.length > 1 ? 'fail' : 'pass',
    severity: 'high',
    evidence:
      endpoints.length > 1
        ? parsed.map((entry) => `${entry.service} -> ${entry.endpoint}`)
        : [`Shared endpoint ${endpoints[0]}`],
    remediation: params.remediation,
  };
}

async function probeHttp(
  target: string,
  timeoutMs: number,
): Promise<{ ok: boolean; evidence: string[] }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(target, {
      signal: controller.signal,
      headers: { Accept: 'application/json, text/plain;q=0.9, */*;q=0.8' },
    });
    const contentType = response.headers.get('content-type') ?? '';
    const payload =
      contentType.includes('application/json') || contentType.includes('+json')
        ? await response.json().catch(() => null)
        : await response.text().catch(() => '');
    const snippet =
      typeof payload === 'string'
        ? payload.trim().slice(0, 120)
        : payload && typeof payload === 'object'
          ? JSON.stringify(payload).slice(0, 160)
          : '';
    return {
      ok: response.ok,
      evidence: [
        `${target} -> HTTP ${response.status}`,
        ...summarizeProbePayload(payload, snippet),
      ],
    };
  } catch (error) {
    const message =
      error instanceof Error && error.name === 'AbortError'
        ? `Timed out after ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error);
    return {
      ok: false,
      evidence: [`${target} unreachable`, `Error: ${message}`],
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function probeTcp(
  target: string,
  timeoutMs: number,
): Promise<{ ok: boolean; evidence: string[] }> {
  const parsed = new URL(target);
  const port = Number(parsed.port);
  const host = parsed.hostname;

  return await new Promise((resolveProbe) => {
    const socket = new net.Socket();
    let settled = false;

    const finalize = (ok: boolean, evidence: string[]) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolveProbe({ ok, evidence });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finalize(true, [`${host}:${port} accepted TCP connection`]));
    socket.once('timeout', () =>
      finalize(false, [`${host}:${port} did not respond within ${timeoutMs}ms`]),
    );
    socket.once('error', (error) =>
      finalize(false, [`${host}:${port} rejected connection`, `Error: ${error.message}`]),
    );

    socket.connect(port, host);
  });
}

async function pathExists(rootDir: string, relPath: string): Promise<boolean> {
  try {
    await access(resolve(rootDir, relPath));
    return true;
  } catch {
    return false;
  }
}

async function collectMissingPaths(
  rootDir: string,
  relPaths: readonly string[],
): Promise<string[]> {
  const missing: string[] = [];
  for (const relPath of relPaths) {
    if (!(await pathExists(rootDir, relPath))) {
      missing.push(relPath);
    }
  }
  return missing;
}

export function parseEnvText(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const exportPrefix = line.startsWith('export ') ? line.slice('export '.length) : line;
    const eqIndex = exportPrefix.indexOf('=');
    if (eqIndex < 0) {
      continue;
    }
    const key = exportPrefix.slice(0, eqIndex).trim();
    if (!key) {
      continue;
    }
    let value = stripInlineComment(exportPrefix.slice(eqIndex + 1));
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function extractTopLevelYamlBlock(text: string, blockName: string): string | null {
  const pattern = new RegExp(
    `(^|\\n)${escapeRegExp(blockName)}:\\n([\\s\\S]*?)(?=\\n[A-Za-z][A-Za-z0-9]*:|$)`,
  );
  const match = text.match(pattern);
  if (!match) {
    return null;
  }
  return `${blockName}:\n${match[2]}`;
}

export function blockHasPath(block: string, path: string[]): boolean {
  let indent = 2;
  for (const key of path) {
    const regex = new RegExp(`^\\s{${indent}}${escapeRegExp(key)}:\\s*(?:$|[^\\n]+$)`, 'm');
    if (!regex.test(block)) {
      return false;
    }
    indent += 2;
  }
  return true;
}

function buildSummary(checks: ApxDoctorCheck[]): ApxDoctorSummary {
  const counts = emptyStatusCounts();
  const byCategory = Object.fromEntries(
    categoryOrder().map((category) => [category, emptyStatusCounts()]),
  ) as Record<ApxDoctorCategory, Record<ApxDoctorStatus, number>>;

  for (const check of checks) {
    counts[check.status] += 1;
    byCategory[check.category][check.status] += 1;
  }

  let status: ApxDoctorStatus = 'pass';
  if (counts.fail > 0) {
    status = 'fail';
  } else if (counts.warn > 0) {
    status = 'warn';
  } else if (counts.pass === 0 && counts.skip > 0) {
    status = 'skip';
  }

  return { status, counts, byCategory };
}

function summarizeStatusCounts(checks: ApxDoctorCheck[]): Record<ApxDoctorStatus, number> {
  const counts = emptyStatusCounts();
  for (const check of checks) {
    counts[check.status] += 1;
  }
  return counts;
}

function collectNextActions(checks: ApxDoctorCheck[]): string[] {
  const actions: string[] = [];
  const seen = new Set<string>();
  const sorted = sortChecksForDisplay(
    checks.filter((check) => check.status === 'fail' || check.status === 'warn'),
  );

  for (const check of sorted) {
    if (!check.remediation || seen.has(check.remediation)) {
      continue;
    }
    seen.add(check.remediation);
    actions.push(check.remediation);
  }

  return actions;
}

function deriveStatusLabel(counts: Record<ApxDoctorStatus, number>): string {
  if (counts.fail > 0) {
    return 'FAIL';
  }
  if (counts.warn > 0) {
    return 'WARN';
  }
  if (counts.pass > 0) {
    return 'PASS';
  }
  return 'SKIP';
}

function pushFormattedCheck(
  lines: string[],
  check: ApxDoctorCheck,
  index: number,
  remediationLookup: ReadonlyMap<string, number>,
): void {
  lines.push(`  ${index}. ${capitalize(check.category)} / ${compactCheckTitle(check.title)}`);
  for (const detail of summarizeCheckEvidence(check)) {
    lines.push(`     ${detail}`);
  }
  const remediationIndex = remediationLookup.get(displayRemediation(check));
  if (remediationIndex) {
    lines.push(`     Fix #${remediationIndex}`);
  } else if (check.remediation) {
    lines.push(`     Fix: ${check.remediation}`);
  }
}

function categoryOrder(): ApxDoctorCategory[] {
  return ['configuration', 'deployment', 'integration', 'health'];
}

function emptyStatusCounts(): Record<ApxDoctorStatus, number> {
  return { pass: 0, warn: 0, fail: 0, skip: 0 };
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function normalizeUrl(value: string): string {
  if (!value || !value.trim()) {
    return '';
  }
  try {
    const url = new URL(value);
    const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
    return `${url.protocol}//${url.host}${pathname}`;
  } catch {
    return value.trim();
  }
}

function parseMongoEndpoint(value: string): string | null {
  try {
    const url = new URL(value);
    return `${url.hostname}:${url.port || '27017'}`;
  } catch {
    return null;
  }
}

function parseRedisEndpoint(value: string): string | null {
  try {
    const url = new URL(value);
    return `${url.hostname}:${url.port || '6379'}`;
  } catch {
    return null;
  }
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function sortChecksForDisplay(checks: ApxDoctorCheck[]): ApxDoctorCheck[] {
  return [...checks].sort((left, right) => {
    const statusDelta = STATUS_ORDER[right.status] - STATUS_ORDER[left.status];
    if (statusDelta !== 0) {
      return statusDelta;
    }

    const severityDelta = SEVERITY_ORDER[right.severity] - SEVERITY_ORDER[left.severity];
    if (severityDelta !== 0) {
      return severityDelta;
    }

    const categoryDelta =
      categoryOrder().indexOf(left.category) - categoryOrder().indexOf(right.category);
    if (categoryDelta !== 0) {
      return categoryDelta;
    }

    return left.title.localeCompare(right.title);
  });
}

function collectDisplayRemediations(checks: ApxDoctorCheck[]): string[] {
  const actions: string[] = [];
  const seen = new Set<string>();
  const sorted = sortChecksForDisplay(
    checks.filter((check) => check.status === 'fail' || check.status === 'warn'),
  );

  for (const check of sorted) {
    const action = displayRemediation(check);
    if (!action || seen.has(action)) {
      continue;
    }
    seen.add(action);
    actions.push(action);
  }

  return actions;
}

function displayRemediation(check: ApxDoctorCheck): string {
  if (
    check.remediation.includes('returns a healthy response before relying on this environment.')
  ) {
    return 'Bring the target HTTP health/readiness endpoint up and return a healthy response before relying on this environment.';
  }

  if (check.remediation.includes('is listening before relying on this environment.')) {
    return 'Ensure the target TCP dependency is listening before relying on this environment.';
  }

  return check.remediation;
}

function compactCheckTitle(title: string): string {
  return title
    .replace(/^Deployable services have Dockerfiles$/, 'Deployable service Dockerfiles')
    .replace(/ has a committed env contract$/, ' env contract')
    .replace(/ environment is provisioned$/, ' environment provisioning')
    .replace(/ is coherent across /, ' coherence across ')
    .replace(/ readiness matches encryption mode$/, ' readiness vs encryption mode')
    .replace(/ matches between /, ' match between ')
    .replace(/ is reachable$/, '')
    .replace(/ is committed$/, '')
    .replace(/ are present$/, '')
    .replace(/ are implemented$/, '')
    .replace(/ covers deployable service probes$/, ' deployable service probe coverage')
    .replace(/ pass shared validation$/, '');
}

function summarizeCheckEvidence(check: ApxDoctorCheck): string[] {
  if (/^configuration\..+\.env-provisioning$/.test(check.id)) {
    return summarizeEnvProvisioningEvidence(check.evidence);
  }
  if (/^configuration\..+\.env-contract$/.test(check.id)) {
    return summarizeEnvContractEvidence(check.evidence);
  }
  if (check.id.startsWith('shared.')) {
    return summarizeSharedValueEvidence(check.evidence);
  }
  if (check.id === 'configuration.encryption-key-quality') {
    return summarizeEncryptionKeyEvidence(check.evidence);
  }
  if (check.id.startsWith('configuration.') && check.id.endsWith('-url-coherence')) {
    return summarizeUrlCoherenceEvidence(check.evidence);
  }
  if (check.id.endsWith('.probe-coverage')) {
    return summarizeHelmProbeEvidence(check.evidence);
  }
  if (check.id === 'deployment.repo-artifacts' || check.id === 'deployment.dockerfiles') {
    return summarizeMissingPathEvidence(check.evidence);
  }
  if (check.category === 'integration' || check.category === 'health') {
    return summarizeProbeEvidence(check.evidence);
  }
  return check.evidence;
}

function summarizeEnvProvisioningEvidence(evidence: string[]): string[] {
  const envFiles: string[] = [];
  const missingKeys: string[] = [];
  const resolvedKeys: string[] = [];
  const details: string[] = [];

  for (const line of evidence) {
    if (line.startsWith('Provisioned file ')) {
      envFiles.push(line.slice('Provisioned file '.length));
      continue;
    }
    if (line.startsWith('Missing required key ')) {
      missingKeys.push(line.slice('Missing required key '.length));
      continue;
    }
    if (line.startsWith('Resolved required key ')) {
      resolvedKeys.push(
        line.slice('Resolved required key '.length).replace(/ \(value redacted\)$/, ''),
      );
      continue;
    }
    if (line === 'No local env file detected; falling back to current process environment only.') {
      details.push('Source: process environment only');
      continue;
    }
    details.push(line);
  }

  const lines: string[] = [];
  if (envFiles.length > 0) {
    lines.push(`Env files: ${envFiles.join(', ')}`);
  }
  if (missingKeys.length > 0) {
    lines.push(`Missing keys: ${missingKeys.join(', ')}`);
  } else if (resolvedKeys.length > 0) {
    lines.push(`Resolved keys: ${resolvedKeys.join(', ')}`);
  }
  lines.push(...details);
  return lines.length > 0 ? lines : evidence;
}

function summarizeEnvContractEvidence(evidence: string[]): string[] {
  const found: string[] = [];
  const missing: string[] = [];
  const details: string[] = [];

  for (const line of evidence) {
    if (line.startsWith('Found ')) {
      found.push(line.slice('Found '.length));
      continue;
    }
    if (line.startsWith('Missing ')) {
      missing.push(line.slice('Missing '.length));
      continue;
    }
    details.push(line);
  }

  const lines: string[] = [];
  if (missing.length > 0) {
    lines.push(`Missing contract files: ${missing.join(', ')}`);
  } else if (found.length > 0) {
    lines.push(`Contract files: ${found.join(', ')}`);
  }
  lines.push(...details);
  return lines.length > 0 ? lines : evidence;
}

function summarizeSharedValueEvidence(evidence: string[]): string[] {
  const unresolved = new Map<string, string[]>();
  const mismatched = new Map<string, string[]>();
  const disabled = new Map<string, string[]>();
  const details: string[] = [];

  for (const line of evidence) {
    let match = line.match(/^([a-z0-9-]+) does not resolve ([A-Z0-9_]+)$/i);
    if (match) {
      appendGroupedValue(unresolved, match[2], match[1]);
      continue;
    }

    match = line.match(
      /^([a-z0-9-]+) defines ([A-Z0-9_]+) \(value redacted, fingerprint differs\)$/i,
    );
    if (match) {
      appendGroupedValue(mismatched, match[2], match[1]);
      continue;
    }

    match = line.match(
      /^([a-z0-9-]+) has encryption disabled; ([A-Z0-9_]+) is not required there$/i,
    );
    if (match) {
      appendGroupedValue(disabled, match[2], match[1]);
      continue;
    }

    details.push(line);
  }

  const lines = [
    ...groupedEvidenceLines(unresolved, 'Unresolved'),
    ...groupedEvidenceLines(mismatched, 'Mismatched'),
    ...groupedEvidenceLines(disabled, 'Encryption disabled for'),
    ...details,
  ];
  return lines.length > 0 ? lines : evidence;
}

function summarizeEncryptionKeyEvidence(evidence: string[]): string[] {
  const details: string[] = [];
  let appliesTo: string[] = [];

  for (const line of evidence) {
    if (line.startsWith('Applies to encryption-enabled services: ')) {
      appliesTo = splitCommaList(line.slice('Applies to encryption-enabled services: '.length));
      continue;
    }
    details.push(line);
  }

  if (appliesTo.length > 0) {
    details.push(`Encryption enabled in: ${appliesTo.join(', ')}`);
  }

  return details.length > 0 ? details : evidence;
}

function summarizeUrlCoherenceEvidence(evidence: string[]): string[] {
  const resolved: string[] = [];
  const missing: string[] = [];
  const details: string[] = [];

  for (const line of evidence) {
    if (line.includes(' -> ')) {
      const [label, value] = line.split(' -> ', 2);
      resolved.push(`${label}=${value}`);
      continue;
    }
    if (line.endsWith(' is not defined')) {
      missing.push(line.slice(0, -' is not defined'.length));
      continue;
    }
    details.push(line);
  }

  const lines: string[] = [];
  if (resolved.length > 0) {
    lines.push(`Resolved URLs: ${resolved.join('; ')}`);
  }
  if (missing.length > 0) {
    lines.push(`Missing URLs: ${missing.join(', ')}`);
  }
  lines.push(...details);
  return lines.length > 0 ? lines : evidence;
}

function summarizeHelmProbeEvidence(evidence: string[]): string[] {
  const missingBlocks: string[] = [];
  const missingProbes: string[] = [];
  const details: string[] = [];

  for (const line of evidence) {
    if (line.startsWith('Missing required service block "')) {
      missingBlocks.push(line.slice('Missing required service block "'.length, -1));
      continue;
    }
    if (line.startsWith('Missing liveness/readiness probes for "')) {
      missingProbes.push(line.slice('Missing liveness/readiness probes for "'.length, -1));
      continue;
    }
    if (line.startsWith('Validated ')) {
      continue;
    }
    details.push(line);
  }

  const lines: string[] = [];
  if (missingBlocks.length > 0) {
    lines.push(`Missing service blocks: ${missingBlocks.join(', ')}`);
  }
  if (missingProbes.length > 0) {
    lines.push(`Missing probes: ${missingProbes.join(', ')}`);
  }
  lines.push(...details);
  return lines.length > 0 ? lines : evidence;
}

function summarizeMissingPathEvidence(evidence: string[]): string[] {
  const missingRequiredDockerfiles: string[] = [];
  const missingOptionalDockerfiles: string[] = [];
  const missing: string[] = [];
  const found: string[] = [];
  const details: string[] = [];

  for (const line of evidence) {
    if (line.startsWith('Missing required Dockerfile ')) {
      missingRequiredDockerfiles.push(line.slice('Missing required Dockerfile '.length));
      continue;
    }
    if (line.startsWith('Missing optional Dockerfile ')) {
      missingOptionalDockerfiles.push(line.slice('Missing optional Dockerfile '.length));
      continue;
    }
    if (line.startsWith('Missing ')) {
      missing.push(line.slice('Missing '.length));
      continue;
    }
    if (line.startsWith('Found ')) {
      found.push(line.slice('Found '.length));
      continue;
    }
    details.push(line);
  }

  const lines: string[] = [];
  if (missingRequiredDockerfiles.length > 0) {
    lines.push(`Missing required Dockerfiles: ${missingRequiredDockerfiles.join(', ')}`);
  }
  if (missingOptionalDockerfiles.length > 0) {
    lines.push(`Missing optional Dockerfiles: ${missingOptionalDockerfiles.join(', ')}`);
  }
  if (missing.length > 0) {
    lines.push(`Missing files: ${missing.join(', ')}`);
  } else if (found.length > 0) {
    lines.push(`Found files: ${found.join(', ')}`);
  }
  lines.push(...details);
  return lines.length > 0 ? lines : evidence;
}

function summarizeProbeEvidence(evidence: string[]): string[] {
  const lines: string[] = [];
  const changeBlockers: string[] = [];
  const changeWarnings: string[] = [];

  for (const line of evidence) {
    let match = line.match(/^(https?:\/\/\S+) -> HTTP (\d+)$/);
    if (match) {
      lines.push(`Target: ${match[1]} (HTTP ${match[2]})`);
      continue;
    }

    match = line.match(/^(https?:\/\/\S+) unreachable$/);
    if (match) {
      lines.push(`Target: ${match[1]} (unreachable)`);
      continue;
    }

    match = line.match(/^Change blocker (.+?) \((.+?)\):/);
    if (match) {
      changeBlockers.push(`${match[1]} (${match[2]})`);
      continue;
    }

    match = line.match(/^Change warning (.+?) \((.+?)\):/);
    if (match) {
      changeWarnings.push(`${match[1]} (${match[2]})`);
      continue;
    }

    lines.push(line);
  }

  if (changeBlockers.length > 0) {
    lines.push(`Change blockers: ${changeBlockers.join(', ')}`);
  }
  if (changeWarnings.length > 0) {
    lines.push(`Change warnings: ${changeWarnings.join(', ')}`);
  }

  return lines.length > 0 ? lines : evidence;
}

function appendGroupedValue(grouped: Map<string, string[]>, key: string, value: string): void {
  const existing = grouped.get(key) ?? [];
  existing.push(value);
  grouped.set(key, existing);
}

function groupedEvidenceLines(grouped: Map<string, string[]>, prefix: string): string[] {
  return Array.from(grouped.entries()).map(
    ([key, values]) => `${prefix} ${key}: ${values.join(', ')}`,
  );
}

function splitCommaList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function summarizeProbePayload(payload: unknown, fallbackSnippet: string): string[] {
  if (typeof payload === 'string') {
    return payload.trim().length > 0
      ? [`Response: ${payload.trim().slice(0, 240)}`]
      : ['Response body unavailable.'];
  }

  if (!payload || typeof payload !== 'object') {
    return fallbackSnippet ? [`Response: ${fallbackSnippet}`] : ['Response body unavailable.'];
  }

  const details: string[] = [];
  const record = asRecord(payload);
  if (!record) {
    return fallbackSnippet ? [`Response: ${fallbackSnippet}`] : ['Response body unavailable.'];
  }

  const status = readString(record, 'status');
  if (status) {
    details.push(`Response status: ${status}`);
  }

  const reason = readString(record, 'reason');
  if (reason) {
    details.push(`Reason: ${reason}`);
  }

  const changeManagement = asRecord(record.changeManagement);
  if (changeManagement) {
    const environment = readString(changeManagement, 'environment');
    const enforcementMode = readString(changeManagement, 'enforcementMode');
    const outcome = readString(changeManagement, 'outcome');

    if (environment || enforcementMode || outcome) {
      details.push(
        `Change management: env=${environment ?? 'unknown'}, mode=${enforcementMode ?? 'unknown'}, outcome=${outcome ?? 'unknown'}`,
      );
    }

    const blockers = Array.isArray(changeManagement.blockers) ? changeManagement.blockers : [];
    for (const blocker of blockers) {
      const blockerRecord = asRecord(blocker);
      if (!blockerRecord) {
        continue;
      }
      const blockerId = readString(blockerRecord, 'changeId') ?? 'unknown-change';
      const blockerStatus = readString(blockerRecord, 'status') ?? 'unknown';
      const blockerMessage =
        readString(blockerRecord, 'message') ?? readString(blockerRecord, 'reason') ?? 'No message';
      details.push(`Change blocker ${blockerId} (${blockerStatus}): ${blockerMessage}`);
    }

    const warnings = Array.isArray(changeManagement.warnings) ? changeManagement.warnings : [];
    for (const warning of warnings) {
      const warningRecord = asRecord(warning);
      if (!warningRecord) {
        continue;
      }
      const warningId = readString(warningRecord, 'changeId') ?? 'unknown-change';
      const warningStatus = readString(warningRecord, 'status') ?? 'unknown';
      const warningMessage =
        readString(warningRecord, 'message') ?? readString(warningRecord, 'reason') ?? 'No message';
      details.push(`Change warning ${warningId} (${warningStatus}): ${warningMessage}`);
    }
  }

  return details.length > 0
    ? details
    : fallbackSnippet
      ? [`Response: ${fallbackSnippet}`]
      : ['Response body unavailable.'];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function resolveRequiredKeys(resolved: ResolvedServiceEnv): string[] {
  return resolved.spec.requiredKeys.filter((key) => {
    if (key === 'ENCRYPTION_MASTER_KEY' && isEncryptionDisabled(resolved.values)) {
      return false;
    }
    return true;
  });
}

function resolveSharedValueServices(
  spec: SharedValueSpec,
  resolvedById: Map<string, ResolvedServiceEnv>,
): string[] {
  if (spec.key !== 'ENCRYPTION_MASTER_KEY') {
    return spec.services;
  }

  return spec.services.filter((serviceId) => {
    const resolved = resolvedById.get(serviceId);
    return resolved ? !isEncryptionDisabled(resolved.values) : false;
  });
}

function resolveEncryptionServiceIds(
  resolvedById: Map<string, ResolvedServiceEnv>,
): Array<(typeof ENCRYPTION_GATED_SERVICE_IDS)[number]> {
  return ENCRYPTION_GATED_SERVICE_IDS.filter((serviceId) => {
    const resolved = resolvedById.get(serviceId);
    return resolved ? !isEncryptionDisabled(resolved.values) : false;
  });
}

function resolveBaseUrl(candidates: Array<string | undefined>, fallback: string): string {
  for (const candidate of candidates) {
    if (isBlank(candidate)) {
      continue;
    }
    try {
      const url = new URL(candidate!.trim());
      return url.toString().replace(/\/$/, '');
    } catch {
      continue;
    }
  }
  return fallback;
}

function appendUrlPath(baseUrl: string, pathname: string): string {
  const normalizedPath = pathname.replace(/^\//, '');
  return new URL(normalizedPath, `${baseUrl.replace(/\/$/, '')}/`).toString();
}

function resolveTcpTarget(
  candidates: Array<string | undefined>,
  parser: (value: string) => string | null,
  defaultPort: number,
): string {
  for (const candidate of candidates) {
    if (isBlank(candidate)) {
      continue;
    }
    const parsed = parser(candidate!.trim());
    if (parsed) {
      return `tcp://${parsed}`;
    }
  }
  return `tcp://127.0.0.1:${defaultPort}`;
}

function firstNonEmpty(values: Array<string | undefined>): string | undefined {
  return values.find((value) => !isBlank(value));
}

function isBlank(value: string | undefined): boolean {
  return !value || value.trim().length === 0;
}

function isEncryptionDisabled(values: Record<string, string>): boolean {
  return values.ENCRYPTION_ENABLED?.trim().toLowerCase() === 'false';
}

function stripInlineComment(value: string): string {
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const previous = index > 0 ? value[index - 1] : '';

    if (char === "'" && !inDoubleQuote && previous !== '\\') {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (char === '"' && !inSingleQuote && previous !== '\\') {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (char === '#' && !inSingleQuote && !inDoubleQuote) {
      const previousChar = index > 0 ? value[index - 1] : '';
      if (index === 0 || /\s/.test(previousChar)) {
        return value.slice(0, index).trimEnd();
      }
    }
  }

  return value.trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
