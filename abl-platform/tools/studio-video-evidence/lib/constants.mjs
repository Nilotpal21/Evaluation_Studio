import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFilePath = fileURLToPath(import.meta.url);
const toolRoot = path.resolve(path.dirname(thisFilePath), '..');
const repoRoot = path.resolve(toolRoot, '..', '..');
const studioRoot = path.join(repoRoot, 'apps', 'studio');

export const TOOL_ROOT = toolRoot;
export const REPO_ROOT = repoRoot;
export const STUDIO_ROOT = studioRoot;
export const DEFAULT_OUTPUT_ROOT = path.join(repoRoot, '.codex-artifacts', 'studio-video-evidence');
export const DEFAULT_VIEWPORT = { width: 1440, height: 980 };
export const IDLE_TIMEOUT_MS = 5_000;
export const STARTUP_TIMEOUT_MS = 300_000;
export const REQUEST_TIMEOUT_MS = 60_000;
export const SDK_BROWSER_STACK_SCRIPT = path.join(
  repoRoot,
  'apps',
  'studio',
  'e2e',
  'helpers',
  'sdk-browser-stack.ts',
);
export const PLAYWRIGHT_ENTRY = path.join(
  studioRoot,
  'node_modules',
  '@playwright',
  'test',
  'index.mjs',
);
export const REQUIRED_ISOLATED_ARTIFACTS = [
  {
    path: path.join(repoRoot, 'apps', 'runtime', 'dist', 'index.js'),
    label: 'Runtime build output',
  },
  {
    path: path.join(repoRoot, 'packages', 'web-sdk', 'dist', 'agent-sdk.umd.js'),
    label: 'Web SDK bundle',
  },
  {
    path: path.join(repoRoot, 'apps', 'studio', '.next', 'BUILD_ID'),
    label: 'Studio production build',
  },
];
