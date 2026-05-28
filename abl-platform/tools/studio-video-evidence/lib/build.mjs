import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { REPO_ROOT, REQUIRED_ISOLATED_ARTIFACTS, STUDIO_ROOT } from './constants.mjs';
import { delay } from './utils.mjs';

function resolvePnpmBinary() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

export function findMissingIsolatedArtifacts() {
  return REQUIRED_ISOLATED_ARTIFACTS.filter((artifact) => !fs.existsSync(artifact.path));
}

function listActiveStudioBuildProcesses() {
  const result = spawnSync('ps', ['-Ao', 'command'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0 || !result.stdout) {
    return [];
  }

  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.includes(path.join(STUDIO_ROOT, 'node_modules')) &&
        line.includes('next build') &&
        !line.includes('rg ') &&
        !line.includes('ps -Ao'),
    );
}

async function waitForConcurrentStudioBuild({ timeoutMs = 300_000, log } = {}) {
  const activeBuilds = listActiveStudioBuildProcesses();
  if (activeBuilds.length === 0) {
    return false;
  }

  log?.('Detected an active Studio build from another thread; waiting to reuse its artifacts.');

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const missing = findMissingIsolatedArtifacts();
    if (!missing.some((artifact) => artifact.label === 'Studio production build')) {
      return true;
    }

    if (listActiveStudioBuildProcesses().length === 0) {
      break;
    }

    await delay(1_000);
  }

  const missingAfterWait = findMissingIsolatedArtifacts();
  return !missingAfterWait.some((artifact) => artifact.label === 'Studio production build');
}

export async function ensureIsolatedBuildArtifacts({ autoBuild = true, log } = {}) {
  const missing = findMissingIsolatedArtifacts();
  if (missing.length === 0) {
    return;
  }

  if (
    missing.some((artifact) => artifact.label === 'Studio production build') &&
    (await waitForConcurrentStudioBuild({ log }))
  ) {
    if (findMissingIsolatedArtifacts().length === 0) {
      return;
    }
  }

  if (!autoBuild) {
    throw new Error(
      `Missing isolated Studio build artifacts: ${missing.map((artifact) => artifact.label).join(', ')}.`,
    );
  }

  log?.(
    `Missing build artifacts (${missing.map((artifact) => artifact.label).join(', ')}). Running pnpm build once for Studio video evidence...`,
  );

  const result = spawnSync(
    resolvePnpmBinary(),
    [
      'build',
      '--filter=@agent-platform/runtime',
      '--filter=@agent-platform/web-sdk',
      '--filter=@agent-platform/studio',
    ],
    {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: process.env,
    },
  );

  const missingAfterBuild = findMissingIsolatedArtifacts();
  if (missingAfterBuild.length === 0) {
    return;
  }

  if (
    missingAfterBuild.some((artifact) => artifact.label === 'Studio production build') &&
    (await waitForConcurrentStudioBuild({ log }))
  ) {
    if (findMissingIsolatedArtifacts().length === 0) {
      return;
    }
  }

  if (result.status !== 0) {
    throw new Error('Automatic build preparation failed for Studio video evidence.');
  }

  if (missingAfterBuild.length > 0) {
    throw new Error(
      `Build finished but required artifacts are still missing: ${missingAfterBuild
        .map((artifact) => artifact.label)
        .join(', ')}.`,
    );
  }
}
