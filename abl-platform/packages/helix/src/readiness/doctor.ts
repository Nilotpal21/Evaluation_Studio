import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';
import { resolveCodexBinaryPath } from '../models/codex-cli-executor.js';
import type { HelixMcpServerDefinition, HelixStageModelPolicy } from '../types.js';

const DEFAULT_CONFIG_FILE = 'helix.config.yaml';
const DEFAULT_VERIFICATION_FILE = 'helix.verification.yaml';
const DEFAULT_REPORT_FILE = '.helix/readiness-report.json';
const MAX_PACKAGE_SCAN_DEPTH = 4;
const MAX_NEXT_ACTIONS = 10;
const MAX_ENV_SCHEMA_NODE_VISITS = 1000;
const READINESS_LEVELS = ['L0', 'L1', 'L2', 'L3'] as const;
const DIRECTORY_SKIP_NAMES = [
  '.git',
  '.turbo',
  '.helix',
  '.apdas',
  'node_modules',
  'dist',
  'build',
  'coverage',
];
const WORKSPACE_ROOTS = ['apps', 'packages', 'services'];
const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export type HelixDoctorStatus = 'pass' | 'warn' | 'fail' | 'skip';
export type HelixDoctorSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type HelixReadinessLevel = (typeof READINESS_LEVELS)[number];
export type HelixCoverageSignal = 'good' | 'partial' | 'missing';
export type HelixAutonomyRecommendation =
  | 'audit-only'
  | 'characterize-first'
  | 'targeted-autonomy'
  | 'high-confidence-autonomy';

export interface HelixDoctorOptions {
  configPath?: string;
  verificationPath?: string;
  reportPath?: string;
  writeReport?: boolean;
  useOpenAiArchitectureOracle?: boolean;
  enableDuelingPlanners?: boolean;
}

export interface HelixDoctorChecklistItem {
  id: string;
  category: string;
  title: string;
  status: HelixDoctorStatus;
  severity: HelixDoctorSeverity;
  evidence: string[];
  remediation: string;
}

export interface HelixDoctorCommandResult {
  command: string;
  status: HelixDoctorStatus;
  evidence: string[];
  remediation: string;
}

export interface HelixDoctorEnvironmentReport {
  rootExamples: string[];
  applicationExamples: string[];
  missingExamples: string[];
}

export interface HelixDoctorServiceReport {
  id: string;
  status: HelixDoctorStatus;
  port?: number;
  startHint: string;
  evidence: string[];
  remediation: string;
}

export interface HelixDoctorModuleReport {
  id: string;
  criticality: string;
  status: HelixDoctorStatus;
  maxAutonomyLevel: HelixReadinessLevel;
  requiredRegressionSuites: string[];
  requiredE2ESuites: string[];
  coverageSignal: HelixCoverageSignal;
  remediation: string;
  evidence: string[];
}

export interface HelixDoctorReport {
  formatVersion: number;
  generatedAt: string;
  repo: {
    id: string;
    displayName: string;
    path: string;
  };
  summary: {
    readinessLevel: HelixReadinessLevel;
    autonomyRecommendation: HelixAutonomyRecommendation;
    counts: Record<HelixDoctorStatus, number>;
  };
  commands: Record<string, HelixDoctorCommandResult>;
  environment: HelixDoctorEnvironmentReport;
  services: HelixDoctorServiceReport[];
  checklists: HelixDoctorChecklistItem[];
  modules: HelixDoctorModuleReport[];
  nextActions: string[];
}

export interface HelixDoctorRunResult {
  contracts: HelixReadinessContracts;
  reportPath: string;
  report: HelixDoctorReport;
}

export interface HelixReadinessContracts {
  configPath: string;
  verificationPath: string;
  config: HelixRepoContract;
  verification: HelixVerificationContract;
}

export interface HelixRepoContract {
  version: number;
  repo: {
    id: string;
    displayName: string;
    kind: string;
    packageManager: string;
    taskRunner?: string;
    defaultBranch?: string;
    engines?: Record<string, string>;
    canonicalCommands?: Record<string, string>;
    operationalRules?: {
      buildBeforeTest?: boolean;
      preferScopedCommands?: boolean;
      requireFormatWriteBeforeCommit?: boolean;
      neverReadSecretsFromRealDotEnvByDefault?: boolean;
    };
    instructionFiles?: {
      required?: string[];
      scopedPatterns?: string[];
    };
    discovery?: {
      roots?: string[];
      ignorePaths?: string[];
      sourceExtensions?: string[];
    };
    environment?: {
      policy?: {
        preferExamplesOrSchemas?: boolean;
        requireExampleOrSchemaPerRunnableApp?: boolean;
        allowDoctorToInspectSecretNamesOnly?: boolean;
      };
      root?: HelixEnvironmentScope;
      applications?: HelixEnvironmentApplication[];
    };
    serviceMap?: HelixServiceDefinition[];
    doctor?: {
      outputPath?: string;
      checklistCategories?: string[];
      failOn?: string[];
      warnOn?: string[];
    };
    autonomy?: {
      defaultLevel?: HelixReadinessLevel;
      levels?: Record<string, string>;
    };
    runtime?: {
      stageModelPolicy?: HelixStageModelPolicy;
      mcpServers?: Record<string, HelixMcpServerDefinition>;
    };
  };
}

interface HelixEnvironmentScope {
  examples?: string[];
  requiredKeys?: string[];
  optionalKeys?: string[];
  anyOf?: HelixEnvironmentAnyOfGroup[];
}

interface HelixEnvironmentApplication extends HelixEnvironmentScope {
  id: string;
  path: string;
}

interface HelixEnvironmentAnyOfGroup {
  description?: string;
  keys?: string[];
}

interface HelixServiceDefinition {
  id: string;
  path: string;
  kind?: string;
  devCommand?: string;
  containerManaged?: boolean;
  startHint?: string;
  ports?: {
    http?: number;
  };
}

export interface HelixVerificationContract {
  version: number;
  defaults?: {
    policyWhenNoModuleMatches?: {
      maxAutonomyLevel?: HelixReadinessLevel;
      requireHumanCheckpoint?: boolean;
      requiredCommands?: string[];
      regressionSuites?: string[];
      missingE2EAction?: string;
    };
    buildBeforeTest?: boolean;
    characterizeFirstWhen?: string[];
    rejectEvidence?: string[];
    escalateWhen?: string[];
  };
  suites?: HelixVerificationSuite[];
  modulePolicies?: HelixModuleVerificationPolicy[];
}

export interface HelixVerificationSuite {
  id: string;
  kind: string;
  command: string;
  scope: string | string[];
}

export interface HelixModuleVerificationPolicy {
  id: string;
  criticality: string;
  paths: string[];
  maxAutonomyLevel: HelixReadinessLevel;
  requiredCommands?: string[];
  requiredSuites?: {
    regression?: string[];
    e2e?: string[];
  };
  requiredSignals?: string[];
  missingE2EAction?: string;
  characterizeFirstWhen?: string[];
}

interface PackageJsonManifest {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface WorkspacePackageRecord {
  name: string;
  path: string;
  scripts: Record<string, string>;
}

interface CommandValidationResult {
  status: HelixDoctorStatus;
  evidence: string[];
  remediation: string;
}

export async function loadReadinessContracts(
  workDir: string,
  options: HelixDoctorOptions = {},
): Promise<HelixReadinessContracts> {
  const configPath = resolve(workDir, options.configPath ?? DEFAULT_CONFIG_FILE);
  const verificationPath = resolve(workDir, options.verificationPath ?? DEFAULT_VERIFICATION_FILE);

  const configText = await readRequiredText(configPath, 'HELIX config');
  const verificationText = await readRequiredText(verificationPath, 'HELIX verification policy');

  const config = parseContract<HelixRepoContract>(configText, configPath, 'repo');
  const verification = parseContract<HelixVerificationContract>(
    verificationText,
    verificationPath,
    'verification',
  );

  if (!config.repo?.id || !config.repo.displayName) {
    throw new Error(
      `Invalid HELIX config at ${configPath}: repo.id and repo.displayName are required`,
    );
  }

  return {
    configPath,
    verificationPath,
    config,
    verification,
  };
}

export async function generateReadinessReport(
  workDir: string,
  contracts: HelixReadinessContracts,
  options: HelixDoctorOptions = {},
): Promise<HelixDoctorReport> {
  const generatedAt = new Date().toISOString();
  const rootPackage = await readPackageJson(resolve(workDir, 'package.json'));
  const workspacePackages = await discoverWorkspacePackages(workDir);
  const canonicalCommands = contracts.config.repo.canonicalCommands ?? {};
  const doctorConfig = contracts.config.repo.doctor;
  const checklistItems: HelixDoctorChecklistItem[] = [];
  const commands: Record<string, HelixDoctorCommandResult> = {};

  const requiredRootInstructions = contracts.config.repo.instructionFiles?.required ?? [];
  const missingRootInstructions = await collectMissingPaths(workDir, requiredRootInstructions);
  checklistItems.push({
    id: 'bootstrap.root-instructions',
    category: 'bootstrap',
    title: 'Required root instruction files are committed',
    status:
      missingRootInstructions.length === 0
        ? 'pass'
        : getConfiguredStatus(doctorConfig, 'missing-root-instruction-file', 'fail'),
    severity: 'critical',
    evidence:
      missingRootInstructions.length === 0
        ? requiredRootInstructions.map((entry) => `Found ${entry}`)
        : missingRootInstructions.map((entry) => `Missing ${entry}`),
    remediation:
      missingRootInstructions.length === 0
        ? ''
        : `Add the missing root instruction file(s): ${missingRootInstructions.join(', ')}`,
  });

  const canonicalCommandNames = uniqueStrings([
    'build',
    'test',
    'formatWrite',
    ...Object.keys(canonicalCommands),
  ]);

  for (const commandName of canonicalCommandNames) {
    const command = canonicalCommands[commandName] ?? '';
    const validation = command
      ? await validateCommand(workDir, command, rootPackage, workspacePackages)
      : {
          status: getConfiguredStatusForCommand(commandName, doctorConfig),
          evidence: [`No command configured for ${commandName}`],
          remediation: `Declare repo.canonicalCommands.${commandName} in helix.config.yaml.`,
        };

    checklistItems.push({
      id: `commands.${commandName}`,
      category: 'commands',
      title: `Canonical command "${commandName}" is declared and resolvable`,
      status: validation.status,
      severity: commandName === 'build' || commandName === 'test' ? 'critical' : 'high',
      evidence: validation.evidence,
      remediation: validation.remediation,
    });

    commands[commandName] = {
      command,
      status: validation.status,
      evidence: validation.evidence,
      remediation: validation.remediation,
    };
  }

  const rootEnvironment = contracts.config.repo.environment?.root;
  const rootExamples = rootEnvironment?.examples ?? [];
  const existingRootExamples = await collectExistingPaths(workDir, rootExamples);
  const missingRootExamples = subtractStrings(rootExamples, existingRootExamples);
  checklistItems.push({
    id: 'environment.root-examples',
    category: 'environment',
    title: 'Root environment example or schema is present',
    status:
      existingRootExamples.length > 0
        ? 'pass'
        : getConfiguredStatus(doctorConfig, 'missing-root-env-example', 'fail'),
    severity: 'critical',
    evidence:
      existingRootExamples.length > 0
        ? existingRootExamples.map((entry) => `Found ${entry}`)
        : missingRootExamples.map((entry) => `Missing ${entry}`),
    remediation:
      existingRootExamples.length > 0
        ? ''
        : 'Add a root .env.example or env schema so HELIX can inspect key names safely.',
  });

  const rootEnvKeys = await collectEnvKeys(workDir, existingRootExamples);
  const missingRootKeys = subtractStrings(rootEnvironment?.requiredKeys ?? [], rootEnvKeys);
  checklistItems.push({
    id: 'environment.root-required-keys',
    category: 'environment',
    title: 'Root environment contract documents required keys',
    status: missingRootKeys.length === 0 ? 'pass' : 'fail',
    severity: 'high',
    evidence:
      missingRootKeys.length === 0
        ? (rootEnvironment?.requiredKeys ?? []).map((entry) => `Documented ${entry}`)
        : missingRootKeys.map((entry) => `Missing required key ${entry}`),
    remediation:
      missingRootKeys.length === 0
        ? ''
        : `Document the missing root env key(s) in a committed example or schema: ${missingRootKeys.join(', ')}`,
  });

  const environmentReport: HelixDoctorEnvironmentReport = {
    rootExamples: existingRootExamples,
    applicationExamples: [],
    missingExamples: [...missingRootExamples],
  };

  const applications = contracts.config.repo.environment?.applications ?? [];
  for (const application of applications) {
    const existingExamples = await collectExistingPaths(workDir, application.examples ?? []);
    const missingExamples = subtractStrings(application.examples ?? [], existingExamples);
    const appEnvKeys = await collectEnvKeys(workDir, existingExamples);
    environmentReport.applicationExamples.push(...existingExamples);
    environmentReport.missingExamples.push(...missingExamples);

    checklistItems.push({
      id: `environment.${application.id}.examples`,
      category: 'environment',
      title: `${application.id} has a committed env example or schema`,
      status:
        existingExamples.length > 0
          ? 'pass'
          : getConfiguredStatus(doctorConfig, 'missing-runnable-app-env-example', 'warn'),
      severity: 'medium',
      evidence:
        existingExamples.length > 0
          ? existingExamples.map((entry) => `Found ${entry}`)
          : missingExamples.map((entry) => `Missing ${entry}`),
      remediation:
        existingExamples.length > 0
          ? ''
          : `Add a committed env example or schema for ${application.id}.`,
    });

    const requiredKeys = application.requiredKeys ?? [];
    if (requiredKeys.length > 0) {
      const missingKeys = subtractStrings(requiredKeys, appEnvKeys);
      checklistItems.push({
        id: `environment.${application.id}.required-keys`,
        category: 'environment',
        title: `${application.id} env example documents required keys`,
        status: existingExamples.length === 0 ? 'skip' : missingKeys.length === 0 ? 'pass' : 'fail',
        severity: 'high',
        evidence:
          existingExamples.length === 0
            ? ['Skipped because no committed env example or schema exists yet.']
            : missingKeys.length === 0
              ? requiredKeys.map((entry) => `Documented ${entry}`)
              : missingKeys.map((entry) => `Missing required key ${entry}`),
        remediation:
          existingExamples.length === 0 || missingKeys.length === 0
            ? ''
            : `Document the missing env key(s) for ${application.id}: ${missingKeys.join(', ')}`,
      });
    }

    const anyOfGroups = application.anyOf ?? [];
    if (anyOfGroups.length > 0) {
      const documentedGroup = anyOfGroups.find((group) =>
        (group.keys ?? []).every((key) => appEnvKeys.includes(key)),
      );
      checklistItems.push({
        id: `environment.${application.id}.provider-groups`,
        category: 'environment',
        title: `${application.id} documents at least one complete provider key group`,
        status:
          existingExamples.length === 0
            ? 'skip'
            : documentedGroup
              ? 'pass'
              : getConfiguredStatus(doctorConfig, 'missing-runnable-app-env-example', 'warn'),
        severity: 'medium',
        evidence:
          existingExamples.length === 0
            ? ['Skipped because no committed env example or schema exists yet.']
            : documentedGroup
              ? [`Documented provider group: ${documentedGroup.description ?? 'unnamed group'}`]
              : anyOfGroups.map((group) => {
                  const keys = (group.keys ?? []).join(', ');
                  return `Incomplete provider group: ${group.description ?? 'unnamed group'} (${keys})`;
                }),
        remediation:
          existingExamples.length === 0 || documentedGroup
            ? ''
            : `Document one complete provider key group for ${application.id}.`,
      });
    }
  }

  const verificationSuites = contracts.verification.suites ?? [];
  const modulePolicies = contracts.verification.modulePolicies ?? [];
  checklistItems.push({
    id: 'verification.module-policies',
    category: 'verification',
    title: 'Module-specific verification policies are defined',
    status:
      modulePolicies.length > 0
        ? 'pass'
        : getConfiguredStatus(doctorConfig, 'no-module-verification-policy', 'warn'),
    severity: 'high',
    evidence:
      modulePolicies.length > 0
        ? [`Found ${modulePolicies.length} module verification policy entries.`]
        : ['No modulePolicies entries found in helix.verification.yaml.'],
    remediation:
      modulePolicies.length > 0
        ? ''
        : 'Add at least one module policy so HELIX can reason about evidence by area, not just repo-wide.',
  });

  const hasScopedSuite = verificationSuites.some((suite) => suite.scope !== 'repo');
  checklistItems.push({
    id: 'verification.scoped-suites',
    category: 'verification',
    title: 'Verification policy includes non-repo-wide suites',
    status: hasScopedSuite
      ? 'pass'
      : getConfiguredStatus(doctorConfig, 'only-repo-wide-regression-suite', 'warn'),
    severity: 'medium',
    evidence: hasScopedSuite
      ? verificationSuites
          .filter((suite) => suite.scope !== 'repo')
          .map((suite) => `Scoped suite ${suite.id}`)
      : ['Only repo-wide suites are defined.'],
    remediation: hasScopedSuite
      ? ''
      : 'Add package- or module-scoped verification suites so HELIX can prove changes locally.',
  });

  const services: HelixDoctorServiceReport[] = [];
  for (const service of contracts.config.repo.serviceMap ?? []) {
    const pathExists = await repoPathExists(workDir, service.path);
    const launchCommand = service.containerManaged
      ? (service.startHint ?? '')
      : (service.devCommand ?? '');
    const commandValidation = launchCommand
      ? await validateCommand(workDir, launchCommand, rootPackage, workspacePackages)
      : {
          status: getConfiguredStatus(doctorConfig, 'missing-service-start-hint', 'warn'),
          evidence: [`No start command or hint declared for ${service.id}`],
          remediation: `Add devCommand or startHint for ${service.id} in helix.config.yaml.`,
        };
    const serviceStatus = !pathExists
      ? 'fail'
      : commandValidation.status === 'fail'
        ? 'fail'
        : commandValidation.status === 'warn'
          ? 'warn'
          : 'pass';
    const serviceEvidence = [
      pathExists ? `Found ${service.path}` : `Missing ${service.path}`,
      ...commandValidation.evidence,
    ];
    const remediation = !pathExists
      ? `Fix the path for service ${service.id} in helix.config.yaml.`
      : commandValidation.remediation;

    services.push({
      id: service.id,
      status: serviceStatus,
      port: service.ports?.http,
      startHint: launchCommand,
      evidence: serviceEvidence,
      remediation,
    });

    checklistItems.push({
      id: `health.service.${service.id}`,
      category: 'health',
      title: `${service.id} has a valid local start contract`,
      status: serviceStatus,
      severity: pathExists ? 'medium' : 'high',
      evidence: serviceEvidence,
      remediation,
    });
  }

  const suiteIds = verificationSuites.map((suite) => suite.id);
  const modules: HelixDoctorModuleReport[] = [];
  for (const modulePolicy of modulePolicies) {
    const missingPaths = await collectMissingPaths(workDir, modulePolicy.paths);
    const requiredCommands = modulePolicy.requiredCommands ?? [];
    const failingCommands: string[] = [];
    for (const command of requiredCommands) {
      const validation = await validateCommand(workDir, command, rootPackage, workspacePackages);
      if (validation.status !== 'pass') {
        failingCommands.push(command);
      }
    }

    const requiredRegressionSuites = modulePolicy.requiredSuites?.regression ?? [];
    const requiredE2ESuites = modulePolicy.requiredSuites?.e2e ?? [];
    const missingRegressionSuites = subtractStrings(requiredRegressionSuites, suiteIds);
    const missingE2ESuites = subtractStrings(requiredE2ESuites, suiteIds);
    const coverageSignal = determineCoverageSignal(
      requiredRegressionSuites,
      requiredE2ESuites,
      missingRegressionSuites,
      missingE2ESuites,
      modulePolicy.missingE2EAction,
    );
    const status =
      missingPaths.length > 0 ||
      failingCommands.length > 0 ||
      missingRegressionSuites.length > 0 ||
      missingE2ESuites.length > 0
        ? 'fail'
        : coverageSignal === 'partial'
          ? 'warn'
          : 'pass';
    const remediation =
      missingPaths.length > 0
        ? `Fix missing path mappings for module ${modulePolicy.id}.`
        : failingCommands.length > 0
          ? `Repair the required command mapping(s) for module ${modulePolicy.id}.`
          : missingRegressionSuites.length > 0 || missingE2ESuites.length > 0
            ? `Define the missing verification suite(s) for module ${modulePolicy.id}.`
            : coverageSignal === 'partial'
              ? 'Add or map real end-to-end or characterization evidence before allowing higher autonomy.'
              : '';
    const evidence = [
      ...missingPaths.map((entry) => `Missing path ${entry}`),
      ...failingCommands.map((entry) => `Unresolvable command ${entry}`),
      ...missingRegressionSuites.map((entry) => `Missing regression suite ${entry}`),
      ...missingE2ESuites.map((entry) => `Missing e2e suite ${entry}`),
    ];
    if (evidence.length === 0) {
      evidence.push(
        `Regression suites: ${requiredRegressionSuites.join(', ') || '(none)'}`,
        `E2E suites: ${requiredE2ESuites.join(', ') || '(none)'}`,
      );
      if (coverageSignal === 'partial') {
        evidence.push(
          'Coverage remains partial because this module still relies on characterize-first evidence.',
        );
      }
    }

    modules.push({
      id: modulePolicy.id,
      criticality: modulePolicy.criticality,
      status,
      maxAutonomyLevel: modulePolicy.maxAutonomyLevel,
      requiredRegressionSuites,
      requiredE2ESuites,
      coverageSignal,
      remediation,
      evidence,
    });
  }

  // Cross-provider quorum feature: OPENAI_API_KEY readiness check
  if (options.useOpenAiArchitectureOracle || options.enableDuelingPlanners) {
    const hasOpenAiKey =
      typeof process.env.OPENAI_API_KEY === 'string' &&
      process.env.OPENAI_API_KEY.trim().length > 0;
    checklistItems.push({
      id: 'environment.openai-api-key',
      category: 'environment',
      title: 'OPENAI_API_KEY is available for cross-provider features',
      status: hasOpenAiKey ? 'pass' : 'fail',
      severity: 'critical',
      evidence: hasOpenAiKey
        ? ['OPENAI_API_KEY is set and non-empty.']
        : ['OPENAI_API_KEY is missing or empty.'],
      remediation: hasOpenAiKey
        ? ''
        : 'OPENAI_API_KEY is required when --enable-dueling-planners or --use-openai-architecture-oracle is set.',
    });
  }

  // Dueling planners feature: codex binary readiness check
  if (options.enableDuelingPlanners) {
    const codexBinaryPath = await resolveCodexBinaryPath();
    const hasCodex = codexBinaryPath !== null;
    checklistItems.push({
      id: 'environment.codex-binary',
      category: 'environment',
      title: 'Codex CLI binary is installed for dueling planners synthesis',
      status: hasCodex ? 'pass' : 'fail',
      severity: 'critical',
      evidence: hasCodex
        ? [`Codex CLI found at ${codexBinaryPath}.`]
        : [
            'Codex CLI binary could not be found in PATH, HELIX_CODEX_PATH, CODEX_CLI_PATH, CODEX_PATH, or common install locations.',
          ],
      remediation: hasCodex
        ? ''
        : 'Codex CLI is required when --enable-dueling-planners (HELIX_ENABLE_DUELING_PLANNERS) is set. The Plan-C synthesis step invokes Codex after both planners succeed. Install from https://github.com/openai/codex and ensure the binary is on PATH.',
    });
  }

  const counts = countStatuses([
    ...checklistItems.map((item) => item.status),
    ...modules.map((item) => item.status),
  ]);
  const analyzedLevel = determineAnalyzedReadinessLevel(checklistItems, modules, counts);
  const configuredDefaultLevel = contracts.config.repo.autonomy?.defaultLevel ?? analyzedLevel;
  const readinessLevel = minReadinessLevel(analyzedLevel, configuredDefaultLevel);
  const nextActions = collectNextActions(checklistItems, modules);

  return {
    formatVersion: 1,
    generatedAt,
    repo: {
      id: contracts.config.repo.id,
      displayName: contracts.config.repo.displayName,
      path: workDir,
    },
    summary: {
      readinessLevel,
      autonomyRecommendation: mapLevelToRecommendation(readinessLevel),
      counts,
    },
    commands,
    environment: {
      rootExamples: uniqueStrings(environmentReport.rootExamples),
      applicationExamples: uniqueStrings(environmentReport.applicationExamples),
      missingExamples: uniqueStrings(environmentReport.missingExamples),
    },
    services,
    checklists: checklistItems,
    modules,
    nextActions,
  };
}

export async function runHelixDoctor(
  workDir: string,
  options: HelixDoctorOptions = {},
): Promise<HelixDoctorRunResult> {
  const contracts = await loadReadinessContracts(workDir, options);
  const report = await generateReadinessReport(workDir, contracts, options);
  const reportPath = resolve(
    workDir,
    options.reportPath ?? contracts.config.repo.doctor?.outputPath ?? DEFAULT_REPORT_FILE,
  );

  if (options.writeReport !== false) {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  }

  return {
    contracts,
    reportPath,
    report,
  };
}

export function formatReadinessSummary(report: HelixDoctorReport): string[] {
  const lines = [
    'HELIX Doctor',
    `Repo: ${report.repo.displayName} (${report.repo.id})`,
    `Readiness: ${report.summary.readinessLevel} (${report.summary.autonomyRecommendation})`,
    `Checks: ${report.summary.counts.pass} pass, ${report.summary.counts.warn} warn, ${report.summary.counts.fail} fail, ${report.summary.counts.skip} skip`,
  ];

  const canonicalOrder = ['build', 'test', 'formatWrite'];
  for (const commandName of canonicalOrder) {
    const command = report.commands[commandName];
    if (!command) {
      continue;
    }
    lines.push(`Command ${commandName}: ${command.status} — ${command.command || '(missing)'}`);
  }

  const warnings = [
    ...report.checklists.filter((item) => item.status === 'warn' || item.status === 'fail'),
    ...report.modules.filter((item) => item.status === 'warn' || item.status === 'fail'),
  ].slice(0, 5);

  if (warnings.length > 0) {
    lines.push('Top Issues:');
    for (const item of warnings) {
      const title = 'title' in item ? item.title : item.id;
      lines.push(`- [${item.status}] ${title}`);
    }
  }

  if (report.nextActions.length > 0) {
    lines.push('Next Actions:');
    for (const action of report.nextActions.slice(0, 5)) {
      lines.push(`- ${action}`);
    }
  }

  return lines;
}

async function readRequiredText(path: string, label: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read ${label} at ${path}: ${message}`);
  }
}

function parseContract<T>(text: string, path: string, label: string): T {
  const parsed = parseYaml(text) as T | null;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid HELIX ${label} file at ${path}: expected a YAML object`);
  }
  return parsed;
}

async function readPackageJson(path: string): Promise<PackageJsonManifest | null> {
  try {
    const text = await readFile(path, 'utf-8');
    return JSON.parse(text) as PackageJsonManifest;
  } catch {
    return null;
  }
}

async function discoverWorkspacePackages(workDir: string): Promise<WorkspacePackageRecord[]> {
  const discovered: WorkspacePackageRecord[] = [];

  for (const root of WORKSPACE_ROOTS) {
    const absoluteRoot = resolve(workDir, root);
    if (!(await repoPathExists(workDir, root))) {
      continue;
    }
    await scanWorkspacePackages(workDir, absoluteRoot, 0, discovered);
  }

  return discovered;
}

async function scanWorkspacePackages(
  workDir: string,
  directory: string,
  depth: number,
  discovered: WorkspacePackageRecord[],
): Promise<void> {
  if (depth > MAX_PACKAGE_SCAN_DEPTH) {
    return;
  }

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  const hasPackageJson = entries.some((entry) => entry.isFile() && entry.name === 'package.json');
  if (hasPackageJson) {
    const manifest = await readPackageJson(join(directory, 'package.json'));
    if (manifest?.name) {
      discovered.push({
        name: manifest.name,
        path: normalizeRepoPath(relative(workDir, directory)),
        scripts: manifest.scripts ?? {},
      });
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || DIRECTORY_SKIP_NAMES.includes(entry.name)) {
      continue;
    }
    await scanWorkspacePackages(workDir, join(directory, entry.name), depth + 1, discovered);
  }
}

async function validateCommand(
  workDir: string,
  command: string,
  rootPackage: PackageJsonManifest | null,
  workspacePackages: WorkspacePackageRecord[],
): Promise<CommandValidationResult> {
  const trimmed = command.trim();
  const filteredMatch = trimmed.match(/^pnpm\s+--filter\s+(\S+)\s+([A-Za-z0-9:_-]+)(?:\s|$)/);
  if (filteredMatch) {
    const packageName = filteredMatch[1];
    const scriptName = filteredMatch[2];
    const workspacePackage = workspacePackages.find((entry) => entry.name === packageName);
    if (!workspacePackage) {
      return {
        status: 'fail',
        evidence: [`Workspace package ${packageName} was not found.`],
        remediation: `Fix the --filter target in command: ${command}`,
      };
    }
    if (scriptName === 'install') {
      return {
        status: 'pass',
        evidence: [`Resolved workspace package ${packageName} at ${workspacePackage.path}`],
        remediation: '',
      };
    }
    if (!workspacePackage.scripts[scriptName]) {
      return {
        status: 'fail',
        evidence: [`Package ${packageName} does not declare script "${scriptName}".`],
        remediation: `Add script "${scriptName}" to ${workspacePackage.path}/package.json or update the command.`,
      };
    }
    return {
      status: 'pass',
      evidence: [`Resolved ${packageName} -> ${workspacePackage.path} (${scriptName})`],
      remediation: '',
    };
  }

  const pnpmMatch = trimmed.match(/^pnpm\s+([A-Za-z0-9:_-]+)(?:\s|$)/);
  if (pnpmMatch) {
    const scriptName = pnpmMatch[1];
    if (scriptName === 'install') {
      return {
        status: 'pass',
        evidence: ['pnpm install is a built-in pnpm command.'],
        remediation: '',
      };
    }
    if (rootPackage?.scripts?.[scriptName]) {
      return {
        status: 'pass',
        evidence: [`Resolved root package script "${scriptName}".`],
        remediation: '',
      };
    }
    return {
      status: 'fail',
      evidence: [`Root package does not declare script "${scriptName}".`],
      remediation: `Add script "${scriptName}" to the root package.json or update the command.`,
    };
  }

  if (trimmed.startsWith('npx prettier')) {
    const hasPrettier = Boolean(
      rootPackage?.dependencies?.prettier || rootPackage?.devDependencies?.prettier,
    );
    return hasPrettier
      ? {
          status: 'pass',
          evidence: ['Resolved prettier from the root package manifest.'],
          remediation: '',
        }
      : {
          status: 'fail',
          evidence: ['Prettier is not declared in the root package manifest.'],
          remediation: 'Add prettier to the root package dependencies or devDependencies.',
        };
  }

  if (trimmed.startsWith('docker compose')) {
    const composeExists = await repoPathExists(workDir, 'docker-compose.yml');
    return composeExists
      ? {
          status: 'pass',
          evidence: ['Found docker-compose.yml in the repo root.'],
          remediation: '',
        }
      : {
          status: 'fail',
          evidence: ['docker-compose.yml is missing from the repo root.'],
          remediation: 'Add docker-compose.yml or update the docker compose command.',
        };
  }

  if (trimmed.startsWith('./')) {
    const executablePath = trimmed.split(/\s+/)[0];
    const exists = await repoPathExists(workDir, executablePath);
    return exists
      ? {
          status: 'pass',
          evidence: [`Found ${executablePath}.`],
          remediation: '',
        }
      : {
          status: 'fail',
          evidence: [`Missing executable ${executablePath}.`],
          remediation: `Add ${executablePath} or update the command.`,
        };
  }

  return {
    status: 'warn',
    evidence: [`Static validation is not implemented for command: ${command}`],
    remediation:
      'Use a canonical pnpm, docker compose, npx prettier, or repo-local executable command for best doctor coverage.',
  };
}

async function repoPathExists(workDir: string, repoPath: string): Promise<boolean> {
  try {
    await readFile(resolve(workDir, repoPath));
    return true;
  } catch {
    try {
      await readdir(resolve(workDir, repoPath));
      return true;
    } catch {
      return false;
    }
  }
}

async function collectExistingPaths(workDir: string, entries: string[]): Promise<string[]> {
  const existing: string[] = [];
  for (const entry of entries) {
    if (await repoPathExists(workDir, entry)) {
      existing.push(normalizeRepoPath(entry));
    }
  }
  return existing;
}

async function collectMissingPaths(workDir: string, entries: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const entry of entries) {
    if (!(await repoPathExists(workDir, entry))) {
      missing.push(normalizeRepoPath(entry));
    }
  }
  return missing;
}

async function collectEnvKeys(workDir: string, files: string[]): Promise<string[]> {
  const keys: string[] = [];
  for (const file of files) {
    const content = await readFile(resolve(workDir, file), 'utf-8');
    collectEnvKeysFromDocument(file, content, keys);
  }
  return keys;
}

function collectEnvKeysFromDocument(file: string, content: string, keys: string[]): void {
  if (file.endsWith('.json') && collectEnvKeysFromJsonSchema(content, keys)) {
    return;
  }

  collectEnvKeysFromEnvText(content, keys);
}

function collectEnvKeysFromEnvText(content: string, keys: string[]): void {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    const match = trimmed.match(/^(?:export\s+)?#?\s*([A-Z][A-Z0-9_]*)\s*=/);
    const key = match?.[1];
    if (key) {
      pushUniqueString(keys, key);
    }
  }
}

function collectEnvKeysFromJsonSchema(content: string, keys: string[]): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return false;
  }

  const pending: unknown[] = [parsed];
  let visitedNodes = 0;
  while (pending.length > 0 && visitedNodes < MAX_ENV_SCHEMA_NODE_VISITS) {
    const current = pending.pop();
    visitedNodes += 1;

    if (Array.isArray(current)) {
      for (const item of current) {
        if (item && typeof item === 'object') {
          pending.push(item);
        }
      }
      continue;
    }

    if (!current || typeof current !== 'object') {
      continue;
    }

    const record = current as Record<string, unknown>;

    const required = record['required'];
    if (Array.isArray(required)) {
      for (const item of required) {
        if (typeof item === 'string' && ENV_KEY_PATTERN.test(item)) {
          pushUniqueString(keys, item);
        }
      }
    }

    const properties = record['properties'];
    if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
      for (const propertyName of Object.keys(properties as Record<string, unknown>)) {
        if (ENV_KEY_PATTERN.test(propertyName)) {
          pushUniqueString(keys, propertyName);
        }
      }
    }

    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') {
        pending.push(value);
      }
    }
  }

  return true;
}

function pushUniqueString(values: string[], value: string): void {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function determineCoverageSignal(
  regressionSuites: string[],
  e2eSuites: string[],
  missingRegressionSuites: string[],
  missingE2ESuites: string[],
  missingE2EAction: string | undefined,
): HelixCoverageSignal {
  if (regressionSuites.length === 0 || missingRegressionSuites.length > 0) {
    return 'missing';
  }
  if (e2eSuites.length > 0) {
    return missingE2ESuites.length > 0 ? 'missing' : 'good';
  }
  return missingE2EAction === 'not-required' ? 'good' : 'partial';
}

function determineAnalyzedReadinessLevel(
  checklistItems: HelixDoctorChecklistItem[],
  modules: HelixDoctorModuleReport[],
  counts: Record<HelixDoctorStatus, number>,
): HelixReadinessLevel {
  if (counts.fail > 0) {
    return 'L0';
  }

  const hasHighRiskWarning = modules.some(
    (item) =>
      item.status === 'warn' && (item.criticality === 'critical' || item.criticality === 'high'),
  );
  const hasEnvironmentWarning = checklistItems.some(
    (item) => item.category === 'environment' && item.status === 'warn',
  );

  if (hasHighRiskWarning || hasEnvironmentWarning) {
    return 'L1';
  }

  if (counts.warn > 0) {
    return 'L2';
  }

  return 'L3';
}

function mapLevelToRecommendation(level: HelixReadinessLevel): HelixAutonomyRecommendation {
  switch (level) {
    case 'L0':
      return 'audit-only';
    case 'L1':
      return 'characterize-first';
    case 'L2':
      return 'targeted-autonomy';
    case 'L3':
      return 'high-confidence-autonomy';
    default: {
      const exhaustiveLevel: never = level;
      throw new Error(`Unknown readiness level: ${String(exhaustiveLevel)}`);
    }
  }
}

function minReadinessLevel(
  left: HelixReadinessLevel,
  right: HelixReadinessLevel,
): HelixReadinessLevel {
  return readinessLevelRank(left) <= readinessLevelRank(right) ? left : right;
}

function readinessLevelRank(level: HelixReadinessLevel): number {
  return READINESS_LEVELS.indexOf(level);
}

function countStatuses(statuses: HelixDoctorStatus[]): Record<HelixDoctorStatus, number> {
  return {
    pass: statuses.filter((status) => status === 'pass').length,
    warn: statuses.filter((status) => status === 'warn').length,
    fail: statuses.filter((status) => status === 'fail').length,
    skip: statuses.filter((status) => status === 'skip').length,
  };
}

function collectNextActions(
  checklistItems: HelixDoctorChecklistItem[],
  modules: HelixDoctorModuleReport[],
): string[] {
  const actions = [
    ...checklistItems
      .filter((item) => (item.status === 'warn' || item.status === 'fail') && item.remediation)
      .map((item) => item.remediation),
    ...modules
      .filter((item) => (item.status === 'warn' || item.status === 'fail') && item.remediation)
      .map((item) => item.remediation),
  ];

  return uniqueStrings(actions).slice(0, MAX_NEXT_ACTIONS);
}

function getConfiguredStatus(
  doctorConfig: HelixRepoContract['repo']['doctor'] | undefined,
  issueId: string,
  defaultStatus: Extract<HelixDoctorStatus, 'warn' | 'fail'>,
): Extract<HelixDoctorStatus, 'warn' | 'fail'> {
  if ((doctorConfig?.failOn ?? []).includes(issueId)) {
    return 'fail';
  }
  if ((doctorConfig?.warnOn ?? []).includes(issueId)) {
    return 'warn';
  }
  return defaultStatus;
}

function getConfiguredStatusForCommand(
  commandName: string,
  doctorConfig: HelixRepoContract['repo']['doctor'] | undefined,
): Extract<HelixDoctorStatus, 'warn' | 'fail'> {
  switch (commandName) {
    case 'build':
      return getConfiguredStatus(doctorConfig, 'missing-canonical-build-command', 'fail');
    case 'test':
      return getConfiguredStatus(doctorConfig, 'missing-canonical-test-command', 'fail');
    case 'formatWrite':
      return getConfiguredStatus(doctorConfig, 'missing-format-write-command', 'fail');
    default:
      return 'warn';
  }
}

function normalizeRepoPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function subtractStrings(source: string[], valuesToRemove: string[]): string[] {
  return source
    .filter((entry) => !valuesToRemove.includes(entry))
    .map((entry) => normalizeRepoPath(entry));
}

function uniqueStrings(values: string[]): string[] {
  const unique: string[] = [];
  for (const value of values) {
    if (value && !unique.includes(value)) {
      unique.push(value);
    }
  }
  return unique;
}
