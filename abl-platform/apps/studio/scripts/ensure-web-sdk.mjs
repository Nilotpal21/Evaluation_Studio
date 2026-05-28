import { existsSync } from 'fs';
import { resolve } from 'path';
import { spawnSync } from 'child_process';

const studioRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(studioRoot, '../..');
const webSdkDistFiles = [
  resolve(repoRoot, 'packages/web-sdk/dist/agent-sdk.esm.js'),
  resolve(repoRoot, 'packages/web-sdk/dist/agent-sdk.umd.js'),
  resolve(repoRoot, 'packages/web-sdk/dist/index.d.ts'),
  resolve(repoRoot, 'packages/web-sdk/dist/react/index.js'),
  resolve(repoRoot, 'packages/web-sdk/dist/react/index.d.ts'),
];
const configDistFiles = [
  resolve(repoRoot, 'packages/config/dist/index.js'),
  resolve(repoRoot, 'packages/config/dist/index.d.ts'),
  resolve(repoRoot, 'packages/config/dist/constants/voice-providers.js'),
  resolve(repoRoot, 'packages/config/dist/constants/voice-providers.d.ts'),
];

const hasBuiltWebSdk = webSdkDistFiles.every((file) => existsSync(file));
const hasBuiltConfig = configDistFiles.every((file) => existsSync(file));

if (hasBuiltWebSdk && hasBuiltConfig) {
  console.log('web-sdk and config dist already present; skipping nested build');
  process.exit(0);
}

function buildWorkspacePackage(filter) {
  const result = spawnSync('pnpm', ['--dir', '../..', 'build', `--filter=${filter}`], {
    cwd: studioRoot,
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (!hasBuiltWebSdk) {
  buildWorkspacePackage('@agent-platform/web-sdk');
}

if (!hasBuiltConfig) {
  buildWorkspacePackage('@agent-platform/config');
}
