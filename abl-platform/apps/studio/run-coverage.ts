import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { readdir, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { createVitest, type Vitest } from 'vitest/node';
import {
  buildCoverageExecutionPlan,
  SPLIT_COVERAGE_ROOT,
  type VitestCoveragePhaseCommand,
} from './run-tests-plan';

type CoverageProvider = Exclude<Awaited<ReturnType<Vitest['createCoverageProvider']>>, null>;
type VitestProject = ReturnType<Vitest['getRootProject']>;

interface CoverageMapLike {
  files(): string[];
  filter(predicate: (filename: string) => boolean): void;
  merge(data: unknown): void;
}

interface SplitCoverageProvider {
  convertCoverage(
    rawCoverage: unknown,
    project: VitestProject,
    environment: 'client' | 'ssr',
  ): Promise<CoverageMapLike>;
  createCoverageMap(): CoverageMapLike;
  generateReports(coverageMap: CoverageMapLike, allTestsRun: boolean): Promise<void>;
  getCoverageMapForUncoveredFiles(testedFiles: string[]): Promise<CoverageMapLike>;
  isIncluded(filename: string): boolean;
  resolveOptions(): { excludeAfterRemap?: boolean };
}

let failed = false;

function markFailed(message?: string): void {
  failed = true;
  if (message) {
    console.error(message);
  }
}

function wasTimedOut(result: ReturnType<typeof spawnSync>): boolean {
  return (
    result.error instanceof Error && 'code' in result.error && result.error.code === 'ETIMEDOUT'
  );
}

function run(label: string, args: string[], timeoutMs?: number): void {
  console.log(`\n── ${label} ──\n`);

  const result = spawnSync('npx', args, {
    stdio: 'inherit',
    shell: true,
    timeout: timeoutMs,
  });

  if (wasTimedOut(result)) {
    markFailed(`Vitest command timed out for "${label}" after ${timeoutMs}ms.`);
    return;
  }

  if (result.error) {
    markFailed(
      `Vitest command failed for "${label}": ${
        result.error instanceof Error ? result.error.message : String(result.error)
      }`,
    );
    return;
  }

  if (result.signal) {
    markFailed(`Vitest command for "${label}" exited via signal ${result.signal}.`);
    return;
  }

  if (result.status !== 0) {
    markFailed();
  }
}

async function cleanPaths(paths: string[]): Promise<void> {
  await Promise.all(paths.map((targetPath) => rm(targetPath, { force: true, recursive: true })));
}

async function collectCoverageFiles(rootDir: string): Promise<string[]> {
  try {
    const entries = await readdir(rootDir, { withFileTypes: true });
    const nestedFiles = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = join(rootDir, entry.name);
        if (entry.isDirectory()) {
          return collectCoverageFiles(entryPath);
        }

        if (entry.isFile() && entry.name.startsWith('coverage-') && entry.name.endsWith('.json')) {
          return [entryPath];
        }

        return [];
      }),
    );

    return nestedFiles.flat();
  } catch {
    return [];
  }
}

async function loadCoverageArtifact(
  command: VitestCoveragePhaseCommand,
  provider: SplitCoverageProvider,
  vitest: Vitest,
): Promise<CoverageMapLike | null> {
  const finalCoveragePath = join(command.reportsDirectory, 'coverage-final.json');

  if (existsSync(finalCoveragePath)) {
    const istanbulCoverage = JSON.parse(await readFile(finalCoveragePath, 'utf8'));
    const coverageMap = provider.createCoverageMap();
    coverageMap.merge(istanbulCoverage);
    return coverageMap;
  }

  const rawCoverageFiles = await collectCoverageFiles(command.reportsDirectory);
  if (rawCoverageFiles.length === 0) {
    return null;
  }

  const coverageMap = provider.createCoverageMap();
  for (const filename of rawCoverageFiles) {
    const rawCoverage = JSON.parse(await readFile(filename, 'utf8'));
    const convertedCoverage = await provider.convertCoverage(
      rawCoverage,
      vitest.getRootProject(),
      command.viteEnvironment,
    );
    coverageMap.merge(convertedCoverage);
  }

  return coverageMap;
}

async function mergeCoverageReports(
  reportConfigPath: string,
  commands: VitestCoveragePhaseCommand[],
): Promise<void> {
  console.log('\n── Merge split coverage reports ──\n');

  const vitest = await createVitest('test', {
    root: process.cwd(),
    config: reportConfigPath,
    coverage: {
      enabled: true,
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      clean: false,
      cleanOnRerun: false,
    },
  });

  try {
    const rawProvider = (await vitest.createCoverageProvider()) as CoverageProvider | null;
    if (!rawProvider) {
      markFailed('Unable to initialize the Studio coverage provider.');
      return;
    }
    const provider = rawProvider as unknown as SplitCoverageProvider;

    const coverageMap = provider.createCoverageMap();
    let artifactCount = 0;

    for (const command of commands) {
      const phaseCoverage = await loadCoverageArtifact(command, provider, vitest);
      if (!phaseCoverage) {
        continue;
      }

      coverageMap.merge(phaseCoverage);
      artifactCount += 1;
    }

    if (artifactCount === 0) {
      markFailed('Split coverage run produced no mergeable coverage artifacts.');
      return;
    }

    const uncoveredCoverage = await provider.getCoverageMapForUncoveredFiles(coverageMap.files());
    coverageMap.merge(uncoveredCoverage);

    const options = provider.resolveOptions();
    coverageMap.filter((filename) => {
      const exists = existsSync(filename);
      if (options.excludeAfterRemap) {
        return exists && provider.isIncluded(filename);
      }

      return exists;
    });

    await provider.generateReports(coverageMap, true);
    await rm(join('coverage', '.tmp'), { force: true, recursive: true });
  } catch (error) {
    markFailed(
      `Split coverage merge failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await vitest.close();
  }
}

async function main(): Promise<void> {
  const plan = buildCoverageExecutionPlan(process.argv.slice(2));

  if (plan.mode === 'delegate') {
    run('Delegated coverage run', plan.args);
    process.exit(failed ? 1 : 0);
  }

  await cleanPaths(plan.cleanupPaths);

  for (const command of plan.commands) {
    run(command.label, command.args, command.timeoutMs);
  }

  await mergeCoverageReports(plan.reportConfigPath, plan.commands);

  if (!failed) {
    await rm(SPLIT_COVERAGE_ROOT, { force: true, recursive: true });
  }

  process.exit(failed ? 1 : 0);
}

await main();
