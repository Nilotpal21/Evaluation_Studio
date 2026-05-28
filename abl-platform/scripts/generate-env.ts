#!/usr/bin/env tsx
/**
 * Generate .env files from .env.example with secure random values.
 *
 * Usage:
 *   pnpm tsx scripts/generate-env.ts [--app runtime|studio|admin] [--force]
 *
 * Without --app, generates for all apps.
 * Without --force, skips apps that already have .env files.
 */

import { randomBytes } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const APPS: Record<string, { example: string; output: string }> = {
  runtime: {
    example: 'apps/runtime/.env.example',
    output: 'apps/runtime/.env',
  },
  studio: {
    example: 'apps/studio/.env.example',
    output: 'apps/studio/.env.local',
  },
  admin: {
    example: 'apps/admin/.env.example',
    output: 'apps/admin/.env.local',
  },
};

/** Generate a secure random value for known secret patterns */
function generateSecret(line: string): string | null {
  const key = line.split('=')[0].trim();

  if (key === 'JWT_SECRET' || key === 'NEXTAUTH_SECRET' || key === 'PREVIEW_TOKEN_SECRET') {
    return randomBytes(48).toString('base64');
  }
  if (key === 'ENCRYPTION_MASTER_KEY') {
    return randomBytes(32).toString('hex');
  }
  return null;
}

function processEnvExample(examplePath: string): string {
  const content = readFileSync(examplePath, 'utf-8');
  const lines = content.split('\n');

  return lines
    .map((line) => {
      // Skip comments and empty lines
      if (line.startsWith('#') || line.trim() === '') return line;

      // Skip commented-out vars
      if (line.trimStart().startsWith('#')) return line;

      const eqIndex = line.indexOf('=');
      if (eqIndex === -1) return line;

      const key = line.substring(0, eqIndex);
      const value = line.substring(eqIndex + 1);

      // Check if this is a secret with a default/placeholder value
      const generated = generateSecret(line);
      if (generated && (value === '' || value.includes('development-') || /^0+$/.test(value))) {
        return `${key}=${generated}`;
      }

      return line;
    })
    .join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const appFlagIdx = args.indexOf('--app');
  const targetApp = appFlagIdx >= 0 ? args[appFlagIdx + 1] : null;

  const apps = targetApp ? { [targetApp]: APPS[targetApp] } : APPS;

  if (targetApp && !APPS[targetApp]) {
    console.error(`Unknown app: ${targetApp}. Valid apps: ${Object.keys(APPS).join(', ')}`);
    process.exit(1);
  }

  for (const [name, paths] of Object.entries(apps)) {
    const examplePath = resolve(ROOT, paths.example);
    const outputPath = resolve(ROOT, paths.output);

    if (!existsSync(examplePath)) {
      console.warn(`  ⚠ ${name}: ${paths.example} not found, skipping`);
      continue;
    }

    if (existsSync(outputPath) && !force) {
      console.log(`  ✓ ${name}: ${paths.output} already exists (use --force to overwrite)`);
      continue;
    }

    const generated = processEnvExample(examplePath);
    writeFileSync(outputPath, generated, 'utf-8');
    console.log(`  ✓ ${name}: Generated ${paths.output} with secure random secrets`);
  }

  console.log('\nDone. Review generated files before starting services.');
}

main();
