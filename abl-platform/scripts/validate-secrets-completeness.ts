#!/usr/bin/env tsx
/**
 * Secrets Completeness Validator
 *
 * Cross-references ESO ExternalSecret YAML templates against the manifest.
 * Usage: pnpm tsx scripts/validate-secrets-completeness.ts [--check-live --env dev --region us-east-1]
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, join } from 'path';

const args = process.argv.slice(2);
function getArg(name: string, defaultValue?: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return defaultValue;
  return args[idx + 1];
}
const hasFlag = (name: string) => args.includes(`--${name}`);

const checkLive = hasFlag('check-live');
const env = getArg('env', 'dev')!;
const region = getArg('region', 'us-east-1')!;

// Load manifest
const manifestPath = resolve(__dirname, 'secrets-manifest.json');
if (!existsSync(manifestPath)) {
  console.error('secrets-manifest.json not found');
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

// Collect all manifest keys
const manifestKeys = new Set<string>();
for (const [scope, scopeData] of Object.entries(manifest.scopes)) {
  for (const secret of (scopeData as any).secrets) {
    manifestKeys.add(`${scope}/${secret.key}`);
  }
}

// Scan ESO templates
const templatesDir = resolve(__dirname, '../deploy/helm/abl-platform/templates/secrets');
const esoKeys = new Set<string>();

if (existsSync(templatesDir)) {
  const files = readdirSync(templatesDir).filter(
    (f) => f.startsWith('external-secret') && f.endsWith('.yaml'),
  );

  for (const file of files) {
    const content = readFileSync(join(templatesDir, file), 'utf-8');
    // Extract remoteRef.key patterns like /abl-platform/{{ .Values.env }}/shared/JWT_SECRET
    const matches = content.matchAll(/remoteRef:\s*\n\s*key:\s*(.+)/g);
    for (const match of matches) {
      let key = match[1].trim();
      // Normalize template expressions
      key = key.replace(/\{\{[^}]+\}\}/g, '').replace(/^\/abl-platform\/\//, '');
      // Extract scope/KEY from path
      const parts = key.split('/').filter(Boolean);
      if (parts.length >= 2) {
        esoKeys.add(`${parts[0]}/${parts[1]}`);
      }
    }
  }

  console.log(`\n🔍 Secrets Completeness Report\n`);
  console.log(`   Manifest keys: ${manifestKeys.size}`);
  console.log(`   ESO template keys: ${esoKeys.size}\n`);

  // Check for gaps: referenced in ESO but not in manifest
  const gaps: string[] = [];
  for (const key of esoKeys) {
    if (!manifestKeys.has(key)) {
      gaps.push(key);
    }
  }

  if (gaps.length > 0) {
    console.log(`⚠️  ${gaps.length} keys referenced in ESO templates but missing from manifest:`);
    for (const gap of gaps) {
      console.log(`   - ${gap}`);
    }
  } else {
    console.log(`✅ All ESO template keys are present in the manifest`);
  }

  // Check for unused manifest keys
  const unused: string[] = [];
  for (const key of manifestKeys) {
    if (!esoKeys.has(key)) {
      unused.push(key);
    }
  }

  if (unused.length > 0) {
    console.log(`\nℹ️  ${unused.length} manifest keys not referenced in ESO templates:`);
    for (const u of unused) {
      console.log(`   - ${u}`);
    }
  }
} else {
  console.log(`\n⚠️  ESO templates directory not found at ${templatesDir}`);
  console.log(`   Listing manifest keys only:\n`);
  for (const key of manifestKeys) {
    console.log(`   - ${key}`);
  }
}

// Optional: check live AWS
if (checkLive) {
  console.log(`\n🌐 Checking live secrets in AWS (${region}, env: ${env})...\n`);

  import('@aws-sdk/client-secrets-manager')
    .then(async (sdk) => {
      const client = new sdk.SecretsManagerClient({ region });

      let found = 0;
      let missing = 0;

      for (const key of manifestKeys) {
        const [scope, secretKey] = key.split('/');
        const secretPath = `/abl-platform/${env}/${scope}/${secretKey}`;

        try {
          await client.send(new sdk.GetSecretValueCommand({ SecretId: secretPath }));
          found++;
        } catch (err: any) {
          if (err.name === 'ResourceNotFoundException') {
            console.log(`   ❌ Missing: ${secretPath}`);
            missing++;
          } else {
            console.log(`   ⚠️  Error checking ${secretPath}: ${err.message}`);
          }
        }
      }

      console.log(
        `\n📊 Live check: ${found} found, ${missing} missing out of ${manifestKeys.size} total\n`,
      );
    })
    .catch(() => {
      console.error('Failed to load @aws-sdk/client-secrets-manager');
      process.exit(1);
    });
}
