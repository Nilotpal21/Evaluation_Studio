/**
 * Minimal repo file walker for the concerns audit.
 *
 * Walks from `repoRoot` and returns repo-relative, forward-slash paths.
 * Skips a conservative set of noise directories (node_modules, .git, build
 * output, local .helix state). Honors `MAX_WALK_FILES` so a misconfigured
 * concerns registry never fans out across a runaway repo.
 *
 * This is deliberately simpler than a full .gitignore engine — it's meant
 * to feed deterministic detectors, not to replace `git ls-files`. When the
 * repo root is a git worktree, callers can pass their own `ignoreDirs` set.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Hard cap on returned files to bound memory use on pathological walks. */
export const MAX_WALK_FILES = 200_000;

const DEFAULT_IGNORE_LIST: readonly string[] = Object.freeze([
  '.git',
  '.helix',
  '.claude',
  '.agents',
  '.claire',
  '.abl-dev-pids',
  '.husky',
  '.next',
  '.nuxt',
  '.turbo',
  '.vercel',
  '.cache',
  '.yarn',
  '.pnpm-store',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'playwright-report',
  'test-reports',
]);

export function defaultIgnoreDirs(): ReadonlySet<string> {
  return new Set(DEFAULT_IGNORE_LIST);
}

export interface WalkOptions {
  readonly repoRoot: string;
  readonly ignoreDirs?: ReadonlySet<string>;
  /** Override the default `MAX_WALK_FILES` cap. */
  readonly maxFiles?: number;
}

export async function walkRepoFiles(options: WalkOptions): Promise<string[]> {
  const { repoRoot } = options;
  const ignoreDirs = options.ignoreDirs ?? defaultIgnoreDirs();
  const maxFiles = options.maxFiles ?? MAX_WALK_FILES;
  const results: string[] = [];

  async function walk(relDir: string): Promise<void> {
    if (results.length >= maxFiles) {
      return;
    }
    const absDir = relDir ? join(repoRoot, relDir) : repoRoot;
    let dirents;
    try {
      dirents = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const dirent of dirents) {
      if (results.length >= maxFiles) {
        return;
      }
      const name = dirent.name;
      if (dirent.isDirectory()) {
        if (ignoreDirs.has(name)) continue;
        await walk(relDir ? `${relDir}/${name}` : name);
      } else if (dirent.isFile()) {
        results.push(relDir ? `${relDir}/${name}` : name);
      }
    }
  }

  await walk('');
  return results;
}
