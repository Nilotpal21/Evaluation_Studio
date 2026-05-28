#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { access, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const helixDir = path.join(rootDir, 'packages', 'helix');
const helixBuildStampPath = path.join(helixDir, '.helix-build-stamp');
const requireFromRoot = createRequire(import.meta.url);

const criticalDeps = [
  'ts-morph',
  'openai',
  '@anthropic-ai/sdk',
  'tree-sitter',
  'tree-sitter-typescript',
];

function parseArgs(argv) {
  const normalizedArgv = argv[0] === '--' ? argv.slice(1) : argv;
  const isMcp = normalizedArgv[0] === '--mcp';
  return {
    entryFile: isMcp ? 'mcp-cli.js' : 'cli.js',
    forwardedArgs: isMcp ? normalizedArgv.slice(1) : normalizedArgv,
  };
}

function runOrExit(command, args, cwd, description) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  return result;
}

function canResolveDependency(dep) {
  try {
    requireFromRoot.resolve(dep, { paths: [helixDir] });
    return true;
  } catch {
    return false;
  }
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function latestMtimeMs(targetPath) {
  const targetStat = await stat(targetPath);
  if (!targetStat.isDirectory()) {
    return targetStat.mtimeMs;
  }

  let latest = targetStat.mtimeMs;
  const entries = await readdir(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    const childPath = path.join(targetPath, entry.name);
    const childLatest = entry.isDirectory()
      ? await latestMtimeMs(childPath)
      : (await stat(childPath)).mtimeMs;
    if (childLatest > latest) {
      latest = childLatest;
    }
  }

  return latest;
}

async function isHelixBuildStale() {
  if (!(await pathExists(helixBuildStampPath))) {
    return true;
  }

  const stampMtimeMs = (await stat(helixBuildStampPath)).mtimeMs;
  const watchedPaths = [
    path.join(helixDir, 'src'),
    path.join(helixDir, 'package.json'),
    path.join(helixDir, 'tsconfig.json'),
  ];

  for (const watchedPath of watchedPaths) {
    if (!(await pathExists(watchedPath))) {
      continue;
    }
    if ((await latestMtimeMs(watchedPath)) > stampMtimeMs) {
      return true;
    }
  }

  return false;
}

async function ensureHelixInstall() {
  const missingDeps = criticalDeps.filter((dep) => !canResolveDependency(dep));
  if (missingDeps.length === 0) {
    return;
  }

  console.log(
    `[helix] Bootstrapping standalone HELIX install (missing: ${missingDeps.join(', ')})...`,
  );
  runOrExit('pnpm', ['install', '--frozen-lockfile'], helixDir, 'bootstrap install');

  const stillMissingDeps = criticalDeps.filter((dep) => !canResolveDependency(dep));
  if (stillMissingDeps.length > 0) {
    console.error(
      `[helix] Failed to resolve HELIX dependencies after bootstrap: ${stillMissingDeps.join(', ')}`,
    );
    process.exit(1);
  }
}

async function ensureHelixBuild(entryFile) {
  const entryPath = path.join(helixDir, 'dist', entryFile);
  if ((await pathExists(entryPath)) && !(await isHelixBuildStale())) {
    return entryPath;
  }

  console.log('[helix] Building standalone HELIX package...');
  runOrExit('pnpm', ['build'], helixDir, 'build');
  await writeFile(helixBuildStampPath, `${Date.now()}\n`);

  if (!(await pathExists(entryPath))) {
    console.error(`[helix] Expected build output missing: ${entryPath}`);
    process.exit(1);
  }

  return entryPath;
}

async function main() {
  const { entryFile, forwardedArgs } = parseArgs(process.argv.slice(2));

  await ensureHelixInstall();
  const entryPath = await ensureHelixBuild(entryFile);

  const result = spawnSync(process.execPath, [entryPath, ...forwardedArgs], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  process.exit(result.status ?? 0);
}

await main();
