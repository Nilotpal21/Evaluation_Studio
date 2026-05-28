#!/usr/bin/env tsx
/**
 * Secret Seeder
 *
 * Seeds required secrets into AWS Secrets Manager based on the manifest.
 * Usage: pnpm tsx scripts/seed-secrets.ts --env dev [--region us-east-1] [--dry-run] [--manual-values path.json]
 */

import { randomBytes } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// Parse CLI args
const args = process.argv.slice(2);
function getArg(name: string, defaultValue?: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return defaultValue;
  return args[idx + 1];
}
const hasFlag = (name: string) => args.includes(`--${name}`);

const env = getArg('env');
const region = getArg('region', 'us-east-1')!;
const dryRun = hasFlag('dry-run');
const skipExisting = !hasFlag('overwrite');
const manualValuesPath = getArg('manual-values');

if (!env) {
  console.error(
    'Usage: pnpm tsx scripts/seed-secrets.ts --env <dev|staging|prod> [--region us-east-1] [--dry-run] [--manual-values path.json]',
  );
  process.exit(1);
}

// Load manifest
const manifestPath = resolve(__dirname, 'secrets-manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

// Load manual values if provided
let manualValues: Record<string, string> = {};
if (manualValuesPath) {
  const absPath = resolve(manualValuesPath);
  if (!existsSync(absPath)) {
    console.error(`Manual values file not found: ${absPath}`);
    process.exit(1);
  }
  manualValues = JSON.parse(readFileSync(absPath, 'utf-8'));
}

interface SecretEntry {
  key: string;
  generator: string;
  description: string;
  required: boolean;
}

function generateValue(generator: string): string {
  const match = generator.match(/^random:(\d+)$/);
  if (match) {
    const bytes = parseInt(match[1], 10);
    return randomBytes(bytes).toString('hex');
  }
  return '';
}

async function main() {
  console.log(`\n🔐 Agent Platform Secret Seeder`);
  console.log(`   Environment: ${env}`);
  console.log(`   Region:      ${region}`);
  console.log(`   Dry run:     ${dryRun}`);
  console.log(`   Skip existing: ${skipExisting}\n`);

  let client: any = null;
  let CreateSecretCommand: any = null;
  let GetSecretValueCommand: any = null;
  let ResourceNotFoundException: any = null;

  if (!dryRun) {
    try {
      const sdk = await import('@aws-sdk/client-secrets-manager');
      client = new sdk.SecretsManagerClient({ region });
      CreateSecretCommand = sdk.CreateSecretCommand;
      GetSecretValueCommand = sdk.GetSecretValueCommand;
      // Use the error name for catching instead
    } catch {
      console.error(
        'Failed to load @aws-sdk/client-secrets-manager. Install it with: pnpm add -w @aws-sdk/client-secrets-manager',
      );
      process.exit(1);
    }
  }

  let created = 0;
  let skipped = 0;
  let warnings = 0;

  for (const [scope, scopeData] of Object.entries(manifest.scopes)) {
    const { secrets } = scopeData as { description: string; secrets: SecretEntry[] };
    console.log(`\n📂 Scope: ${scope} (${(scopeData as any).description})`);

    for (const secret of secrets) {
      const secretPath = `/abl-platform/${env}/${scope}/${secret.key}`;

      // Determine value
      let value: string | undefined;
      const manualKey = `${scope}/${secret.key}`;

      if (secret.generator === 'manual') {
        value = manualValues[manualKey] || manualValues[secret.key];
        if (!value) {
          if (secret.required) {
            console.log(`   ⚠️  ${secret.key} — MANUAL, no value provided (required)`);
            warnings++;
          } else {
            console.log(`   ⏭️  ${secret.key} — MANUAL, no value provided (optional, skipping)`);
            skipped++;
          }
          continue;
        }
      } else {
        value = generateValue(secret.generator);
      }

      if (dryRun) {
        console.log(`   📝 ${secret.key} → ${secretPath} [${secret.generator}]`);
        created++;
        continue;
      }

      // Check if secret already exists
      if (skipExisting) {
        try {
          await client.send(new GetSecretValueCommand({ SecretId: secretPath }));
          console.log(`   ⏭️  ${secret.key} — already exists, skipping`);
          skipped++;
          continue;
        } catch (err: any) {
          if (err.name !== 'ResourceNotFoundException') {
            throw err;
          }
          // Secret doesn't exist, proceed to create
        }
      }

      // Create the secret
      try {
        await client.send(
          new CreateSecretCommand({
            Name: secretPath,
            SecretString: value,
            Description: secret.description,
            Tags: [
              { Key: 'Environment', Value: env },
              { Key: 'Scope', Value: scope },
              { Key: 'ManagedBy', Value: 'abl-platform-seed' },
            ],
          }),
        );
        console.log(`   ✅ ${secret.key} → created`);
        created++;
      } catch (err: any) {
        if (err.name === 'ResourceExistsException') {
          console.log(`   ⏭️  ${secret.key} — already exists`);
          skipped++;
        } else {
          console.error(`   ❌ ${secret.key} — failed: ${err.message}`);
        }
      }
    }
  }

  console.log(`\n📊 Summary: ${created} created, ${skipped} skipped, ${warnings} warnings\n`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
