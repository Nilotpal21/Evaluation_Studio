#!/usr/bin/env tsx
/**
 * CI config policy validator.
 *
 * Runs two checks against environment JSON files:
 * 1. JSON layer guardrails — secrets/infra values must not leak into JSON defaults
 * 2. Production policy — operational boundaries for production.json
 *
 * Usage:
 *   npx tsx scripts/validate-config-policies.ts
 *
 * Exit codes:
 *   0 — all checks pass
 *   1 — one or more policy violations found
 */

import { readFileSync, readdirSync } from 'fs';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  validateJsonLayerFields,
  type JsonLayerIssue,
} from '../packages/config/dist/validation/json-layer-checks.js';
import {
  validateProductionPolicy,
  type PolicyIssue,
} from '../packages/config/dist/validation/production-policy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ENV_DIR = join(__dirname, '..', 'packages', 'config', 'environments');

function loadJsonFiles(dir: string): Array<{ name: string; content: Record<string, unknown> }> {
  const files: Array<{ name: string; content: Record<string, unknown> }> = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      files.push(...loadJsonFiles(join(dir, entry.name)));
    } else if (entry.name.endsWith('.json')) {
      const filePath = join(dir, entry.name);
      const raw = readFileSync(filePath, 'utf-8');
      files.push({ name: filePath.replace(ENV_DIR + '/', ''), content: JSON.parse(raw) });
    }
  }

  return files;
}

let exitCode = 0;
const jsonFiles = loadJsonFiles(ENV_DIR);

// ── Check 1: JSON layer guardrails (all files) ──────────────────────────
console.log('=== JSON Layer Guardrails ===\n');

const jsonIssues: JsonLayerIssue[] = [];
for (const file of jsonFiles) {
  jsonIssues.push(...validateJsonLayerFields(file.content, file.name));
}

if (jsonIssues.length > 0) {
  exitCode = 1;
  for (const issue of jsonIssues) {
    console.error(`  ERROR: ${issue.message}`);
  }
} else {
  console.log('  OK: No restricted fields in environment JSON files.\n');
}

// ── Check 2: Production policy (production.json only) ───────────────────
console.log('=== Production Policy ===\n');

const prodFile = jsonFiles.find((f) => basename(f.name) === 'production.json');
if (!prodFile) {
  console.log('  SKIP: No production.json found.\n');
} else {
  const policyIssues: PolicyIssue[] = validateProductionPolicy(
    prodFile.content as Parameters<typeof validateProductionPolicy>[0],
  );

  if (policyIssues.length > 0) {
    exitCode = 1;
    for (const issue of policyIssues) {
      console.error(
        `  ERROR [${issue.field}]: ${issue.message} (got: ${issue.actual}, allowed: ${issue.allowed})`,
      );
    }
  } else {
    console.log('  OK: production.json passes all policy checks.\n');
  }
}

// ── Summary ─────────────────────────────────────────────────────────────
if (exitCode === 0) {
  console.log(`\nAll config policy checks passed (${jsonFiles.length} files scanned).`);
} else {
  console.error(`\nConfig policy validation FAILED.`);
}

process.exit(exitCode);
