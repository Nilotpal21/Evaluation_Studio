import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveCodexBinaryPath } from '../models/codex-cli-executor.js';
import {
  generateReadinessReport,
  loadReadinessContracts,
  runHelixDoctor,
} from '../readiness/doctor.js';

describe('helix-doctor', () => {
  let workDir: string | null = null;

  afterEach(async () => {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
      workDir = null;
    }
  });

  it('loads committed readiness contracts and writes a readiness report', async () => {
    workDir = await createFixtureRepo({
      runtimeEnvContract: 'example',
      includeProjectIoModule: false,
    });

    const contracts = await loadReadinessContracts(workDir);
    expect(contracts.config.repo.id).toBe('example-platform');
    expect(contracts.verification.modulePolicies?.map((entry) => entry.id)).toEqual(['runtime']);

    const result = await runHelixDoctor(workDir);
    expect(result.report.summary.readinessLevel).toBe('L1');
    expect(result.report.commands.build.status).toBe('pass');
    expect(result.report.environment.rootExamples).toEqual(['.env.example']);
    expect(result.report.environment.applicationExamples).toEqual(['apps/runtime/.env.example']);

    const persisted = JSON.parse(
      await readFile(join(workDir, '.helix', 'readiness-report.json'), 'utf-8'),
    ) as {
      summary: { readinessLevel: string };
      repo: { id: string };
    };
    expect(persisted.repo.id).toBe('example-platform');
    expect(persisted.summary.readinessLevel).toBe('L1');
  });

  it('warns when an app env example is missing and a module still requires characterize-first evidence', async () => {
    workDir = await createFixtureRepo({
      runtimeEnvContract: 'missing',
      includeProjectIoModule: true,
    });

    const result = await runHelixDoctor(workDir, { writeReport: false });
    const runtimeEnvChecklist = result.report.checklists.find(
      (item) => item.id === 'environment.runtime.examples',
    );
    const projectIoModule = result.report.modules.find((item) => item.id === 'project-io');

    expect(runtimeEnvChecklist).toEqual(
      expect.objectContaining({
        status: 'warn',
      }),
    );
    expect(projectIoModule).toEqual(
      expect.objectContaining({
        status: 'warn',
        coverageSignal: 'partial',
      }),
    );
    expect(result.report.summary.readinessLevel).toBe('L1');
    expect(result.report.summary.autonomyRecommendation).toBe('characterize-first');
    expect(result.report.environment.missingExamples).toContain('apps/runtime/.env.example');
  });

  it('reads required env keys from committed JSON schema files', async () => {
    workDir = await createFixtureRepo({
      runtimeEnvContract: 'schema',
      includeProjectIoModule: false,
    });

    const result = await runHelixDoctor(workDir, { writeReport: false });
    const runtimeRequiredKeys = result.report.checklists.find(
      (item) => item.id === 'environment.runtime.required-keys',
    );
    const runtimeProviders = result.report.checklists.find(
      (item) => item.id === 'environment.runtime.provider-groups',
    );

    expect(result.report.environment.applicationExamples).toContain('apps/runtime/env.schema.json');
    expect(runtimeRequiredKeys).toEqual(
      expect.objectContaining({
        status: 'pass',
      }),
    );
    expect(runtimeProviders).toEqual(
      expect.objectContaining({
        status: 'pass',
      }),
    );
  });
});

// ── FR-2: OPENAI_API_KEY readiness check for cross-provider features ──

describe('FR-2: OPENAI_API_KEY readiness when cross-provider flags are set', () => {
  let workDir: string | null = null;
  let savedOpenAiKey: string | undefined;

  beforeEach(() => {
    savedOpenAiKey = process.env.OPENAI_API_KEY;
  });

  afterEach(async () => {
    if (savedOpenAiKey !== undefined) {
      process.env.OPENAI_API_KEY = savedOpenAiKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
      workDir = null;
    }
  });

  it('reports fail-severity check when useOpenAiArchitectureOracle is true and OPENAI_API_KEY is missing', async () => {
    delete process.env.OPENAI_API_KEY;
    workDir = await createFixtureRepo({
      runtimeEnvContract: 'example',
      includeProjectIoModule: false,
    });

    const contracts = await loadReadinessContracts(workDir);
    const report = await generateReadinessReport(workDir, contracts, {
      useOpenAiArchitectureOracle: true,
      writeReport: false,
    });

    const openAiKeyCheck = report.checklists.find(
      (item) => item.id === 'environment.openai-api-key',
    );
    expect(openAiKeyCheck).toBeDefined();
    expect(openAiKeyCheck?.status).toBe('fail');
    expect(openAiKeyCheck?.severity).toBe('critical');
    expect(openAiKeyCheck?.remediation).toBe(
      'OPENAI_API_KEY is required when --enable-dueling-planners or --use-openai-architecture-oracle is set.',
    );
  });

  it('reports fail-severity check when enableDuelingPlanners is true and OPENAI_API_KEY is missing', async () => {
    delete process.env.OPENAI_API_KEY;
    workDir = await createFixtureRepo({
      runtimeEnvContract: 'example',
      includeProjectIoModule: false,
    });

    const contracts = await loadReadinessContracts(workDir);
    const report = await generateReadinessReport(workDir, contracts, {
      enableDuelingPlanners: true,
      writeReport: false,
    });

    const openAiKeyCheck = report.checklists.find(
      (item) => item.id === 'environment.openai-api-key',
    );
    expect(openAiKeyCheck).toBeDefined();
    expect(openAiKeyCheck?.status).toBe('fail');
    expect(openAiKeyCheck?.remediation).toBe(
      'OPENAI_API_KEY is required when --enable-dueling-planners or --use-openai-architecture-oracle is set.',
    );
  });

  it('reports pass when useOpenAiArchitectureOracle is true and OPENAI_API_KEY is set', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-fr2-pass';
    workDir = await createFixtureRepo({
      runtimeEnvContract: 'example',
      includeProjectIoModule: false,
    });

    const contracts = await loadReadinessContracts(workDir);
    const report = await generateReadinessReport(workDir, contracts, {
      useOpenAiArchitectureOracle: true,
      writeReport: false,
    });

    const openAiKeyCheck = report.checklists.find(
      (item) => item.id === 'environment.openai-api-key',
    );
    expect(openAiKeyCheck).toBeDefined();
    expect(openAiKeyCheck?.status).toBe('pass');
  });

  it('does not emit OPENAI_API_KEY check when neither cross-provider flag is set', async () => {
    workDir = await createFixtureRepo({
      runtimeEnvContract: 'example',
      includeProjectIoModule: false,
    });

    const contracts = await loadReadinessContracts(workDir);
    const report = await generateReadinessReport(workDir, contracts, {
      writeReport: false,
    });

    const openAiKeyCheck = report.checklists.find(
      (item) => item.id === 'environment.openai-api-key',
    );
    expect(openAiKeyCheck).toBeUndefined();
  });
});

// ── Codex binary readiness check for dueling planners ──

describe('Codex binary readiness when enableDuelingPlanners is set', () => {
  let workDir: string | null = null;

  afterEach(async () => {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
      workDir = null;
    }
  });

  it('emits codex-binary checklist item when enableDuelingPlanners is true', async () => {
    workDir = await createFixtureRepo({
      runtimeEnvContract: 'example',
      includeProjectIoModule: false,
    });

    const contracts = await loadReadinessContracts(workDir);
    const report = await generateReadinessReport(workDir, contracts, {
      enableDuelingPlanners: true,
      writeReport: false,
    });

    const codexCheck = report.checklists.find((item) => item.id === 'environment.codex-binary');
    expect(codexCheck).toBeDefined();
    expect(codexCheck?.severity).toBe('critical');
    expect(codexCheck?.category).toBe('environment');
    // Status depends on whether codex is installed on the machine; verify shape
    expect(['pass', 'fail']).toContain(codexCheck?.status);
    if (codexCheck?.status === 'fail') {
      expect(codexCheck.remediation).toContain('--enable-dueling-planners');
      expect(codexCheck.remediation).toContain('HELIX_ENABLE_DUELING_PLANNERS');
      expect(codexCheck.remediation).toContain('https://github.com/openai/codex');
    }
    if (codexCheck?.status === 'pass') {
      expect(codexCheck.evidence[0]).toMatch(/Codex CLI found at /);
    }
  });

  it('does not emit codex-binary check when enableDuelingPlanners is not set', async () => {
    workDir = await createFixtureRepo({
      runtimeEnvContract: 'example',
      includeProjectIoModule: false,
    });

    const contracts = await loadReadinessContracts(workDir);
    const report = await generateReadinessReport(workDir, contracts, {
      writeReport: false,
    });

    const codexCheck = report.checklists.find((item) => item.id === 'environment.codex-binary');
    expect(codexCheck).toBeUndefined();
  });
});

// ── resolveCodexBinaryPath standalone resolution ──

describe('resolveCodexBinaryPath', () => {
  let fakeCodexDir: string | null = null;
  let savedCodexPath: string | undefined;

  beforeEach(() => {
    savedCodexPath = process.env.HELIX_CODEX_PATH;
  });

  afterEach(async () => {
    if (savedCodexPath !== undefined) {
      process.env.HELIX_CODEX_PATH = savedCodexPath;
    } else {
      delete process.env.HELIX_CODEX_PATH;
    }
    if (fakeCodexDir) {
      await rm(fakeCodexDir, { recursive: true, force: true });
      fakeCodexDir = null;
    }
  });

  it('returns null for a binary name that does not exist anywhere', async () => {
    // Use a unique nonsensical name that will never appear in PATH or common locations
    const result = await resolveCodexBinaryPath(
      'helix-doctor-test-nonexistent-binary-2026-04-19-xyz',
    );
    expect(result).toBeNull();
  });

  it('resolves a binary via HELIX_CODEX_PATH when set to an executable file', async () => {
    fakeCodexDir = await mkdtemp(join(tmpdir(), 'helix-fake-codex-'));
    const fakeCodexPath = join(fakeCodexDir, 'codex');
    await writeFile(fakeCodexPath, '#!/bin/sh\necho codex\n', 'utf-8');
    await chmod(fakeCodexPath, 0o755);
    process.env.HELIX_CODEX_PATH = fakeCodexPath;

    // Default codex name triggers env var fallback
    const result = await resolveCodexBinaryPath();
    // Either finds the real codex first or finds our fake one — both are valid
    expect(result).not.toBeNull();
  });
});

async function createFixtureRepo(options: {
  runtimeEnvContract: 'example' | 'missing' | 'schema';
  includeProjectIoModule: boolean;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'helix-doctor-'));
  await mkdir(join(dir, 'apps', 'runtime', 'src'), { recursive: true });
  await mkdir(join(dir, 'packages', 'helix', 'src'), { recursive: true });
  await mkdir(join(dir, 'packages', 'project-io', 'src'), { recursive: true });

  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'example-platform',
        private: true,
        scripts: {
          build: 'turbo build',
          test: 'turbo test',
        },
        devDependencies: {
          prettier: '^3.8.1',
        },
      },
      null,
      2,
    ),
    'utf-8',
  );
  await writeFile(join(dir, 'AGENTS.md'), '# root instructions\n', 'utf-8');
  await writeFile(join(dir, '.env.example'), 'ENCRYPTION_MASTER_KEY=\n', 'utf-8');
  await writeFile(join(dir, 'docker-compose.yml'), 'services: {}\n', 'utf-8');

  await writeFile(
    join(dir, 'apps', 'runtime', 'package.json'),
    JSON.stringify(
      {
        name: '@example/runtime',
        scripts: {
          dev: 'tsx watch src/index.ts',
          'test:fast': 'vitest run',
          'test:e2e': 'vitest run --config vitest.e2e.config.ts',
        },
      },
      null,
      2,
    ),
    'utf-8',
  );
  if (options.runtimeEnvContract === 'example') {
    await writeFile(
      join(dir, 'apps', 'runtime', '.env.example'),
      ['JWT_SECRET=', 'AUTH_SDK_BOOTSTRAP_SIGNING_SECRET=', 'ANTHROPIC_API_KEY='].join('\n'),
      'utf-8',
    );
  }
  if (options.runtimeEnvContract === 'schema') {
    await writeFile(
      join(dir, 'apps', 'runtime', 'env.schema.json'),
      JSON.stringify(
        {
          type: 'object',
          required: ['JWT_SECRET', 'AUTH_SDK_BOOTSTRAP_SIGNING_SECRET', 'ANTHROPIC_API_KEY'],
          properties: {
            JWT_SECRET: { type: 'string' },
            AUTH_SDK_BOOTSTRAP_SIGNING_SECRET: { type: 'string' },
            ANTHROPIC_API_KEY: { type: 'string' },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );
  }

  await writeFile(
    join(dir, 'packages', 'helix', 'package.json'),
    JSON.stringify(
      {
        name: '@example/helix',
        scripts: {
          build: 'tsc',
          test: 'vitest run',
        },
      },
      null,
      2,
    ),
    'utf-8',
  );
  await writeFile(
    join(dir, 'packages', 'project-io', 'package.json'),
    JSON.stringify(
      {
        name: '@example/project-io',
        scripts: {
          build: 'tsc',
          'test:fast': 'vitest run',
        },
      },
      null,
      2,
    ),
    'utf-8',
  );

  await writeFile(
    join(dir, 'helix.config.yaml'),
    buildConfigYaml(options.runtimeEnvContract),
    'utf-8',
  );
  await writeFile(
    join(dir, 'helix.verification.yaml'),
    buildVerificationYaml(options.includeProjectIoModule),
    'utf-8',
  );

  return dir;
}

function buildConfigYaml(runtimeEnvContract: 'example' | 'missing' | 'schema'): string {
  const runtimeExamples =
    runtimeEnvContract === 'schema'
      ? ['apps/runtime/env.schema.json']
      : ['apps/runtime/.env.example'];

  return `version: 1
repo:
  id: example-platform
  displayName: Example Platform
  kind: monorepo
  packageManager: pnpm
  canonicalCommands:
    build: pnpm build
    test: pnpm test
    formatWrite: npx prettier --write
  instructionFiles:
    required:
      - AGENTS.md
  environment:
    root:
      examples:
        - .env.example
      requiredKeys:
        - ENCRYPTION_MASTER_KEY
    applications:
      - id: runtime
        path: apps/runtime
        examples:
${runtimeExamples.map((entry) => `          - ${entry}`).join('\n')}
        requiredKeys:
          - JWT_SECRET
          - AUTH_SDK_BOOTSTRAP_SIGNING_SECRET
        anyOf:
          - description: Anthropic
            keys:
              - ANTHROPIC_API_KEY
  serviceMap:
    - id: runtime
      path: apps/runtime
      kind: node-api
      devCommand: pnpm --filter @example/runtime dev
      ports:
        http: 3112
  doctor:
    outputPath: .helix/readiness-report.json
    failOn:
      - missing-canonical-build-command
      - missing-canonical-test-command
      - missing-format-write-command
      - missing-root-env-example
      - missing-root-instruction-file
    warnOn:
      - missing-runnable-app-env-example
      - no-module-verification-policy
      - only-repo-wide-regression-suite
  autonomy:
    defaultLevel: L1
`;
}

function buildVerificationYaml(includeProjectIoModule: boolean): string {
  return `version: 1
suites:
  - id: runtime-fast
    kind: regression
    command: pnpm --filter @example/runtime test:fast
    scope:
      - apps/runtime
  - id: runtime-e2e
    kind: e2e
    command: pnpm --filter @example/runtime test:e2e
    scope:
      - apps/runtime
  - id: project-io-fast
    kind: regression
    command: pnpm --filter @example/project-io test:fast
    scope:
      - packages/project-io
modulePolicies:
  - id: runtime
    criticality: critical
    paths:
      - apps/runtime/src
    maxAutonomyLevel: L1
    requiredCommands:
      - pnpm build
    requiredSuites:
      regression:
        - runtime-fast
      e2e:
        - runtime-e2e
${includeProjectIoModule ? buildProjectIoYamlBlock() : ''}`;
}

function buildProjectIoYamlBlock(): string {
  return `  - id: project-io
    criticality: high
    paths:
      - packages/project-io/src
    maxAutonomyLevel: L2
    requiredCommands:
      - pnpm --filter @example/project-io build
    requiredSuites:
      regression:
        - project-io-fast
      e2e: []
    missingE2EAction: characterize-first
`;
}
