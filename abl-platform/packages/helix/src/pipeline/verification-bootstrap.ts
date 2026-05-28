import { exec } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import type { QualityGateResult, Session, VerificationBootstrapRecord } from '../types.js';
import { buildScopedTypecheckCmd } from './quality-gate.js';
import { listChangedWorkspacePaths } from './workspace-status.js';

const execAsync = promisify(exec);
const WORKSPACE_ROOTS = ['apps', 'packages'] as const;
const GENERATED_TYPE_ARTIFACT_DIR = '.next/types';
const MAX_BUILD_TARGETS = 24;
const MAX_FAILURE_SIGNATURES = 24;
const MAX_OUTPUT_EXCERPT_CHARS = 4000;
const DEFAULT_BUILD_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_TYPECHECK_TIMEOUT_MS = 2 * 60_000;
const VERIFICATION_BOOTSTRAP_CACHE_PATH = '.helix/cache/verification-bootstrap.json';

interface WorkspacePackageRecord {
  name: string;
  dir: string;
  dependencies: string[];
  hasBuildScript: boolean;
}

interface VerificationBootstrapOptions {
  scopeEntries?: string[];
  timeoutMs?: number;
  emitProgress?: (message: string, details?: Record<string, unknown>) => void;
  force?: boolean;
}

interface VerificationBootstrapCache {
  version: 1;
  lockHash: string;
  scopeKey: string;
  record: VerificationBootstrapRecord;
}

export async function ensureVerificationBootstrap(
  workDir: string,
  session: Session,
  options: VerificationBootstrapOptions = {},
): Promise<VerificationBootstrapRecord> {
  if (session.verificationBootstrap && !options.force) {
    return session.verificationBootstrap;
  }

  const scopeEntries = dedupeStrings(
    (options.scopeEntries?.length ? options.scopeEntries : session.workItem.scope).map((entry) =>
      entry.trim(),
    ),
  );
  const scopedPackageDirs = dedupeStrings(
    scopeEntries.map(resolveWorkspacePackageDir).filter((entry): entry is string => Boolean(entry)),
  );
  const notes: string[] = [];

  if (scopedPackageDirs.length === 0) {
    const dirtyWorkspaceFiles = await listChangedWorkspacePaths(workDir);
    const record: VerificationBootstrapRecord = {
      version: 1,
      generatedAt: new Date().toISOString(),
      trustLevel: dirtyWorkspaceFiles.length === 0 ? 'clean-worktree' : 'dirty-worktree',
      scopeEntries,
      scopedPackageDirs,
      dirtyWorkspaceFiles,
      cleanedPaths: [],
      builtPackages: [],
      notes: ['Skipped verification bootstrap because no scoped workspace packages were resolved.'],
    };
    session.verificationBootstrap = record;
    return record;
  }

  const cleanedPaths = await cleanGeneratedTypeArtifacts(
    workDir,
    scopedPackageDirs,
    options.emitProgress,
  );
  const dirtyWorkspaceFiles = await listChangedWorkspacePaths(workDir);
  const trustLevel = dirtyWorkspaceFiles.length === 0 ? 'clean-worktree' : 'dirty-worktree';
  const cacheContext = {
    lockHash: await computeVerificationBootstrapLockHash(workDir),
    scopeKey: buildVerificationBootstrapScopeKey(scopeEntries, scopedPackageDirs),
  };

  if (!options.force && trustLevel === 'clean-worktree') {
    const cached = await readVerificationBootstrapCache(workDir);
    const cacheArtifactsAvailable = cached
      ? await hasVerificationBootstrapArtifacts(workDir, cached.record.builtPackages)
      : false;
    if (
      cached &&
      cached.lockHash === cacheContext.lockHash &&
      cached.scopeKey === cacheContext.scopeKey &&
      cacheArtifactsAvailable
    ) {
      const record: VerificationBootstrapRecord = {
        ...cached.record,
        dirtyWorkspaceFiles,
        cleanedPaths,
        notes: dedupeStrings([
          ...cached.record.notes,
          'Reused cached verification bootstrap state.',
        ]),
      };
      options.emitProgress?.(
        'Verification bootstrap: reusing cached clean-worktree bootstrap record',
        {
          builtPackages: record.builtPackages,
          cleanedPaths,
          typecheckBaseline: record.typecheckBaseline?.passed ?? null,
        },
      );
      session.verificationBootstrap = record;
      return record;
    }

    if (
      cached &&
      cached.lockHash === cacheContext.lockHash &&
      cached.scopeKey === cacheContext.scopeKey &&
      !cacheArtifactsAvailable
    ) {
      notes.push(
        'Discarded cached verification bootstrap because one or more built package artifacts were missing from the replay worktree.',
      );
    }
  }

  const workspacePackages = await loadWorkspacePackageRecords(workDir);
  const buildTargets = resolveBootstrapBuildTargets(scopedPackageDirs, workspacePackages);
  const builtPackages: string[] = [];

  if (buildTargets.length > 0) {
    const command = buildBootstrapBuildCommand(buildTargets);
    options.emitProgress?.(
      `Verification bootstrap: prebuilding ${buildTargets.length} scoped dependency package(s)`,
      { command, buildTargets },
    );
    try {
      await execAsync(command, {
        cwd: workDir,
        timeout: clampTimeout(options.timeoutMs, DEFAULT_BUILD_TIMEOUT_MS),
        maxBuffer: 20 * 1024 * 1024,
      });
      builtPackages.push(...buildTargets);
    } catch (error) {
      notes.push(
        `Scoped dependency bootstrap build failed: ${clipOutput(formatExecFailure(error))}`,
      );
    }
  } else {
    notes.push('No scoped workspace dependency packages required bootstrap builds.');
  }

  let typecheckBaseline = undefined;
  if (trustLevel === 'clean-worktree' && scopeEntries.length > 0) {
    const command = await buildScopedTypecheckCmd(workDir, session, scopeEntries);
    options.emitProgress?.(
      'Verification bootstrap: capturing clean-worktree scoped typecheck baseline',
      {
        command,
      },
    );
    try {
      await execAsync(command, {
        cwd: workDir,
        timeout: clampTimeout(options.timeoutMs, DEFAULT_TYPECHECK_TIMEOUT_MS),
        maxBuffer: 20 * 1024 * 1024,
      });
      typecheckBaseline = {
        criterionType: 'typecheck' as const,
        command,
        passed: true,
        signatures: [],
      };
    } catch (error) {
      const output = formatExecFailure(error);
      typecheckBaseline = {
        criterionType: 'typecheck' as const,
        command,
        passed: false,
        signatures: extractVerificationFailureSignatures(output),
        outputExcerpt: clipOutput(output),
      };
      notes.push(
        `Captured scoped baseline typecheck noise (${typecheckBaseline.signatures.length} signature${typecheckBaseline.signatures.length === 1 ? '' : 's'}).`,
      );
    }
  } else if (trustLevel === 'dirty-worktree') {
    notes.push(
      'Skipped trusted baseline capture because the worktree already contained modified files before verification bootstrap ran.',
    );
  }

  const record: VerificationBootstrapRecord = {
    version: 1,
    generatedAt: new Date().toISOString(),
    trustLevel,
    scopeEntries,
    scopedPackageDirs,
    dirtyWorkspaceFiles,
    cleanedPaths,
    builtPackages,
    notes,
    typecheckBaseline,
  };
  if (trustLevel === 'clean-worktree') {
    await writeVerificationBootstrapCache(workDir, {
      version: 1,
      lockHash: cacheContext.lockHash,
      scopeKey: cacheContext.scopeKey,
      record,
    });
  }
  session.verificationBootstrap = record;
  return record;
}

export function matchVerificationBootstrapBaseline(
  bootstrap: VerificationBootstrapRecord | undefined,
  criterionType: 'typecheck',
  gate: QualityGateResult,
): { matches: boolean; matchedSignatures: string[] } {
  if (!bootstrap || bootstrap.trustLevel !== 'clean-worktree') {
    return { matches: false, matchedSignatures: [] };
  }

  const baseline = bootstrap.typecheckBaseline;
  if (!baseline || baseline.criterionType !== criterionType || baseline.passed) {
    return { matches: false, matchedSignatures: [] };
  }

  const currentSignatures = extractVerificationFailureSignatures(
    [gate.feedback, ...gate.checks.map((check) => check.output ?? '')].join('\n\n'),
  );

  if (currentSignatures.length === 0) {
    return { matches: false, matchedSignatures: [] };
  }

  const baselineSignatures = new Set(baseline.signatures);
  const matches = currentSignatures.every((signature) => baselineSignatures.has(signature));
  return {
    matches,
    matchedSignatures: matches ? currentSignatures : [],
  };
}

export function formatVerificationBootstrapSummary(record: VerificationBootstrapRecord): string {
  const summaryParts = [
    `trust=${record.trustLevel}`,
    `packages=${record.scopedPackageDirs.length}`,
    `cleaned=${record.cleanedPaths.length}`,
    `built=${record.builtPackages.length}`,
  ];

  if (record.typecheckBaseline) {
    summaryParts.push(
      `baseline-typecheck=${record.typecheckBaseline.passed ? 'clean' : `${record.typecheckBaseline.signatures.length} known signatures`}`,
    );
  }

  if (record.notes.length > 0) {
    summaryParts.push(record.notes.join(' | '));
  }

  return summaryParts.join(' | ');
}

function buildBootstrapBuildCommand(packageDirs: string[]): string {
  const filters = packageDirs.map((packageDir) => `--filter ./${packageDir}`).join(' ');
  return `pnpm ${filters} build`;
}

async function cleanGeneratedTypeArtifacts(
  workDir: string,
  scopedPackageDirs: string[],
  emitProgress?: (message: string, details?: Record<string, unknown>) => void,
): Promise<string[]> {
  const cleanedPaths: string[] = [];

  for (const packageDir of scopedPackageDirs) {
    if (!packageDir.startsWith('apps/')) {
      continue;
    }

    const generatedTypesPath = join(workDir, packageDir, GENERATED_TYPE_ARTIFACT_DIR);
    try {
      await access(generatedTypesPath);
      await rm(generatedTypesPath, { recursive: true, force: true });
      cleanedPaths.push(`${packageDir}/${GENERATED_TYPE_ARTIFACT_DIR}`);
    } catch {
      // Ignore missing or already-cleaned generated artifacts.
    }
  }

  if (cleanedPaths.length > 0) {
    emitProgress?.(
      `Verification bootstrap: removed ${cleanedPaths.length} generated typing artifact path(s)`,
      { cleanedPaths },
    );
  }

  return cleanedPaths;
}

async function loadWorkspacePackageRecords(
  workDir: string,
): Promise<Map<string, WorkspacePackageRecord>> {
  const records = new Map<string, WorkspacePackageRecord>();

  for (const root of WORKSPACE_ROOTS) {
    const rootPath = join(workDir, root);
    let entries: string[];
    try {
      entries = await readdir(rootPath);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const packageDir = `${root}/${entry}`;
      try {
        const packageJson = JSON.parse(
          await readFile(join(workDir, packageDir, 'package.json'), 'utf-8'),
        ) as {
          name?: string;
          scripts?: Record<string, string>;
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
          peerDependencies?: Record<string, string>;
        };
        if (!packageJson.name) {
          continue;
        }

        const dependencies = [
          ...Object.keys(packageJson.dependencies ?? {}),
          ...Object.keys(packageJson.devDependencies ?? {}),
          ...Object.keys(packageJson.peerDependencies ?? {}),
        ];

        records.set(packageJson.name, {
          name: packageJson.name,
          dir: packageDir,
          dependencies: dedupeStrings(dependencies),
          hasBuildScript: typeof packageJson.scripts?.build === 'string',
        });
      } catch {
        // Ignore entries that are not workspace packages.
      }
    }
  }

  return records;
}

function resolveBootstrapBuildTargets(
  scopedPackageDirs: string[],
  workspacePackages: Map<string, WorkspacePackageRecord>,
): string[] {
  const queue = [...scopedPackageDirs];
  const visitedDirs = new Set<string>();
  const buildTargets = new Set<string>();
  const byDir = new Map<string, WorkspacePackageRecord>();

  for (const record of workspacePackages.values()) {
    byDir.set(record.dir, record);
  }

  while (queue.length > 0 && visitedDirs.size < MAX_BUILD_TARGETS * 4) {
    const packageDir = queue.shift();
    if (!packageDir || visitedDirs.has(packageDir)) {
      continue;
    }
    visitedDirs.add(packageDir);

    const currentRecord = byDir.get(packageDir);
    if (currentRecord?.dir.startsWith('packages/') && currentRecord.hasBuildScript) {
      buildTargets.add(currentRecord.dir);
    }

    for (const dependencyName of currentRecord?.dependencies ?? []) {
      const dependencyRecord = workspacePackages.get(dependencyName);
      if (!dependencyRecord || visitedDirs.has(dependencyRecord.dir)) {
        continue;
      }
      queue.push(dependencyRecord.dir);
    }
  }

  return [...buildTargets]
    .slice(0, MAX_BUILD_TARGETS)
    .sort((left, right) => left.localeCompare(right));
}

async function hasVerificationBootstrapArtifacts(
  workDir: string,
  builtPackages: string[],
): Promise<boolean> {
  for (const packageDir of builtPackages) {
    const artifactPath = await resolveBootstrapArtifactPath(workDir, packageDir);
    try {
      await access(artifactPath);
    } catch {
      return false;
    }
  }

  return true;
}

async function resolveBootstrapArtifactPath(workDir: string, packageDir: string): Promise<string> {
  try {
    const packageJson = JSON.parse(
      await readFile(join(workDir, packageDir, 'package.json'), 'utf-8'),
    ) as { types?: string; main?: string };

    const declaredOutput = packageJson.types ?? packageJson.main;
    if (declaredOutput) {
      return join(workDir, packageDir, dirname(declaredOutput));
    }
  } catch {
    // Fall back to tsconfig/dist resolution below.
  }

  try {
    const tsconfig = JSON.parse(
      await readFile(join(workDir, packageDir, 'tsconfig.json'), 'utf-8'),
    ) as { compilerOptions?: { outDir?: string } };
    if (tsconfig.compilerOptions?.outDir) {
      return join(workDir, packageDir, tsconfig.compilerOptions.outDir);
    }
  } catch {
    // Fall back to the conventional dist directory.
  }

  return join(workDir, packageDir, 'dist');
}

function resolveWorkspacePackageDir(entry: string): string | null {
  const match = entry.match(/^((?:packages|apps)\/[^/]+)/);
  return match?.[1] ?? null;
}

function extractVerificationFailureSignatures(output: string): string[] {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const diagnosticLines = lines.filter((line) => /\berror TS\d+:/i.test(line));
  const sourceLines = diagnosticLines.length > 0 ? diagnosticLines : lines.slice(0, 5);

  return dedupeStrings(
    sourceLines
      .map(normalizeVerificationFailureLine)
      .filter(Boolean)
      .slice(0, MAX_FAILURE_SIGNATURES),
  );
}

function normalizeVerificationFailureLine(value: string): string {
  return value
    .replace(/\/Users\/[^\s:]+/g, '<path>')
    .replace(/\(\d+,\d+\)/g, '(<loc>)')
    .replace(/[A-Fa-f0-9]{12,}/g, '<hash>')
    .replace(/\b\d+\b/g, '<n>')
    .trim()
    .slice(0, 240);
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function buildVerificationBootstrapScopeKey(
  scopeEntries: string[],
  scopedPackageDirs: string[],
): string {
  return `${dedupeStrings(scopeEntries).sort().join('|')}::${dedupeStrings(scopedPackageDirs).sort().join('|')}`;
}

async function computeVerificationBootstrapLockHash(workDir: string): Promise<string> {
  try {
    const lockfile = await readFile(join(workDir, 'pnpm-lock.yaml'));
    return createHash('sha256').update(lockfile).digest('hex');
  } catch {
    return 'no-lockfile';
  }
}

async function readVerificationBootstrapCache(
  workDir: string,
): Promise<VerificationBootstrapCache | null> {
  try {
    const raw = await readFile(join(workDir, VERIFICATION_BOOTSTRAP_CACHE_PATH), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<VerificationBootstrapCache>;
    if (
      parsed.version !== 1 ||
      typeof parsed.lockHash !== 'string' ||
      typeof parsed.scopeKey !== 'string' ||
      typeof parsed.record !== 'object' ||
      parsed.record == null
    ) {
      return null;
    }
    return parsed as VerificationBootstrapCache;
  } catch {
    return null;
  }
}

async function writeVerificationBootstrapCache(
  workDir: string,
  cache: VerificationBootstrapCache,
): Promise<void> {
  const cachePath = join(workDir, VERIFICATION_BOOTSTRAP_CACHE_PATH);
  await mkdir(join(workDir, '.helix', 'cache'), { recursive: true });
  await writeFile(cachePath, JSON.stringify(cache, null, 2));
}

function formatExecFailure(error: unknown): string {
  if (error instanceof Error && 'stdout' in error) {
    const execError = error as Error & { stdout?: string; stderr?: string };
    return `${execError.stdout ?? ''}${execError.stderr ?? ''}`.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

function clipOutput(value: string): string {
  if (value.length <= MAX_OUTPUT_EXCERPT_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_OUTPUT_EXCERPT_CHARS - 14).trimEnd()}\n[truncated]`;
}

function clampTimeout(timeoutMs: number | undefined, fallbackMs: number): number {
  if (timeoutMs == null || timeoutMs <= 0) {
    return fallbackMs;
  }
  return Math.max(1_000, Math.min(timeoutMs, fallbackMs));
}
