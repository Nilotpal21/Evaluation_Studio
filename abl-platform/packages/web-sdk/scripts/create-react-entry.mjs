/**
 * Post-build script: bundles dist/react/index.js from src/react/index.ts
 *
 * Uses esbuild (native binary from pnpm store) to create a separate
 * ESM bundle for the `@agent-platform/web-sdk/react` sub-path export.
 *
 * External packages: react, react-dom, voice SDK deps (not needed for chat UI).
 * Not minified — Turbopack/Next.js handles optimization.
 */

import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const pnpmModules = resolve(root, '../../node_modules/.pnpm');

// Find esbuild native binary in the pnpm store
let esbuildBin = null;
const dirs = readdirSync(pnpmModules).filter((d) => d.startsWith('esbuild@'));
if (dirs.length > 0) {
  dirs.sort();
  const candidate = resolve(pnpmModules, dirs[dirs.length - 1], 'node_modules/esbuild/bin/esbuild');
  if (existsSync(candidate)) {
    esbuildBin = candidate;
  }
}

if (!esbuildBin) {
  console.error('Could not find esbuild binary. Skipping react entry creation.');
  process.exit(1);
}

// Ensure dist/react/ directory exists
mkdirSync(resolve(root, 'dist/react'), { recursive: true });

// Run esbuild native binary to bundle the React sub-path
execFileSync(
  esbuildBin,
  [
    resolve(root, 'src/react/index.ts'),
    '--bundle',
    '--format=esm',
    '--platform=browser',
    '--target=es2020',
    '--sourcemap',
    // Don't minify — consumer (Next.js/Turbopack) handles optimization
    // Externalize React (peer dep) and packages with CJS patterns
    '--external:react',
    '--external:react-dom',
    '--external:@twilio/voice-sdk',
    '--external:@ricky0123/vad-web',
    `--outfile=${resolve(root, 'dist/react/index.js')}`,
  ],
  { stdio: 'inherit' },
);

// Copy the declaration file from the tsc output if it exists
const tscDeclSrc = resolve(root, 'dist/web-sdk/src/react/index.d.ts');
const declDest = resolve(root, 'dist/react/index.d.ts');
if (existsSync(tscDeclSrc)) {
  writeFileSync(declDest, readFileSync(tscDeclSrc, 'utf-8'));
}

console.log('Created dist/react/index.js + dist/react/index.d.ts');
