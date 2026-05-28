#!/usr/bin/env tsx
/**
 * Environment Variable Migration Checker
 *
 * Scans apps/ for direct process.env reads and reports migration status.
 *
 * Usage: pnpm tsx scripts/check-env-migration.ts
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = join(__dirname, '..');

// Known variables already in BASE_ENV_MAPPING
const BASE_MAPPED = new Set([
  'NODE_ENV',
  'MONGODB_URL',
  'MONGODB_DATABASE',
  'MONGODB_AUTH_SOURCE',
  'CLICKHOUSE_URL',
  'CLICKHOUSE_REPLICATED',
  'JWT_SECRET',
  'JWT_ACCESS_EXPIRY',
  'JWT_REFRESH_EXPIRY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'PORT',
  'HOST',
  'API_URL',
  'FRONTEND_URL',
  'OPENAI_API_KEY',
  'LLM_MODEL',
  'LLM_FAST_MODEL',
  'LLM_VOICE_MODEL',
  'LLM_MAX_TOKENS',
  'LLM_TEMPERATURE',
  'LLM_TIMEOUT_MS',
  'LLM_PROVIDER',
  'ENCRYPTION_MASTER_KEY',
  'RATE_LIMIT_WINDOW_MS',
  'RATE_LIMIT_MAX_REQUESTS',
  'RATE_LIMIT_ENABLED',
  'RATE_LIMIT_SKIP_SUCCESSFUL',
  'CORS_ORIGINS',
  'CORS_METHODS',
  'CORS_CREDENTIALS',
  'CORS_MAX_AGE',
  'SCHEDULER_ENABLED',
  'SCHEDULER_RETENTION_CRON',
  'SCHEDULER_CLEANUP_CRON',
  'ARCHIVE_ENABLED',
  'ARCHIVE_PROVIDER',
  'ARCHIVE_BUCKET',
  'ARCHIVE_REGION',
  'ARCHIVE_PATH_PREFIX',
  'OTEL_ENABLED',
  'OTEL_SERVICE_NAME',
  'OTEL_EXPORTER_TYPE',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_SAMPLING_RATE',
  'OTEL_LOG_LEVEL',
  'OTEL_METRICS_ENABLED',
  'PII_DETECTION',
  'PII_REDACTION',
  'AWS_REGION',
  'REGION_PRIMARY',
  'REGION_FAILOVER',
]);

// Runtime-specific mapped vars
const RUNTIME_MAPPED = new Set([
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER',
  'DEEPGRAM_API_KEY',
  'DEEPGRAM_MODEL',
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_VOICE_ID',
  'ELEVENLABS_MODEL',
  'VOICE_LATENCY_TARGET_MS',
  'VOICE_MAX_CONCURRENT_CALLS',
  'FEATURE_VOICE_ENABLED',
  'WS_HEARTBEAT_INTERVAL_MS',
  'WS_MAX_CONNECTIONS',
  'CHECKPOINT_STORE',
  'CHECKPOINT_ENABLED',
  'FEATURE_STREAMING_ENABLED',
  'FEATURE_TOOL_SANDBOXING',
  'FEATURE_MULTI_AGENT',
  'FEATURE_DEBUG_TRACES',
]);

// Studio-specific mapped vars
const STUDIO_MAPPED = new Set(['RUNTIME_URL', 'NEXTAUTH_SECRET', 'NEXTAUTH_URL']);

interface EnvReference {
  file: string;
  line: number;
  variable: string;
  status: 'DONE' | 'TRIVIAL' | 'NEEDS_SCHEMA' | 'CLIENT_SIDE' | 'EXCEPTION';
}

function scanDir(dir: string, results: EnvReference[]): void {
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (['node_modules', '.next', 'dist', '.git'].includes(entry.name)) continue;
      scanDir(fullPath, results);
      continue;
    }

    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;

    const content = readFileSync(fullPath, 'utf-8');
    const lines = content.split('\n');
    const relPath = relative(ROOT, fullPath);

    for (let i = 0; i < lines.length; i++) {
      const matches = lines[i].matchAll(/process\.env\.(\w+)/g);
      for (const match of matches) {
        const variable = match[1];

        // Skip NEXT_PUBLIC_ — client-side build-time substitution
        if (variable.startsWith('NEXT_PUBLIC_')) {
          results.push({ file: relPath, line: i + 1, variable, status: 'CLIENT_SIDE' });
          continue;
        }

        // Check if already mapped
        const allMapped = new Set([...BASE_MAPPED, ...RUNTIME_MAPPED, ...STUDIO_MAPPED]);
        if (allMapped.has(variable)) {
          // Check if this file actually uses the centralized config
          const usesConfig = content.includes('getConfig') || content.includes('getStudioConfig');
          results.push({
            file: relPath,
            line: i + 1,
            variable,
            status: usesConfig ? 'DONE' : 'TRIVIAL',
          });
          continue;
        }

        // Known exceptions (Edge Runtime, etc.)
        if (relPath.includes('admin/src/middleware.ts') || relPath.includes('otel-setup.ts')) {
          results.push({ file: relPath, line: i + 1, variable, status: 'EXCEPTION' });
          continue;
        }

        results.push({ file: relPath, line: i + 1, variable, status: 'NEEDS_SCHEMA' });
      }
    }
  }
}

// Run scan
const results: EnvReference[] = [];
scanDir(join(ROOT, 'apps'), results);

// Report
const byStatus = {
  DONE: results.filter((r) => r.status === 'DONE'),
  TRIVIAL: results.filter((r) => r.status === 'TRIVIAL'),
  NEEDS_SCHEMA: results.filter((r) => r.status === 'NEEDS_SCHEMA'),
  CLIENT_SIDE: results.filter((r) => r.status === 'CLIENT_SIDE'),
  EXCEPTION: results.filter((r) => r.status === 'EXCEPTION'),
};

console.log(`\n📊 Environment Variable Migration Report\n`);
console.log(`   Total references: ${results.length}`);
console.log(`   ✅ DONE (uses config):     ${byStatus.DONE.length}`);
console.log(`   🔧 TRIVIAL (mapped, not using config): ${byStatus.TRIVIAL.length}`);
console.log(`   ⚠️  NEEDS_SCHEMA:          ${byStatus.NEEDS_SCHEMA.length}`);
console.log(`   📦 CLIENT_SIDE (NEXT_PUBLIC): ${byStatus.CLIENT_SIDE.length}`);
console.log(`   🔒 EXCEPTION (intentional): ${byStatus.EXCEPTION.length}`);

if (byStatus.TRIVIAL.length > 0) {
  console.log(`\n🔧 TRIVIAL — already mapped, just switch to getConfig():\n`);
  for (const r of byStatus.TRIVIAL) {
    console.log(`   ${r.file}:${r.line} — ${r.variable}`);
  }
}

if (byStatus.NEEDS_SCHEMA.length > 0) {
  console.log(`\n⚠️  NEEDS_SCHEMA — need config schema + env mapping:\n`);
  for (const r of byStatus.NEEDS_SCHEMA) {
    console.log(`   ${r.file}:${r.line} — ${r.variable}`);
  }
}

if (byStatus.EXCEPTION.length > 0) {
  console.log(`\n🔒 EXCEPTION — intentional direct reads:\n`);
  for (const r of byStatus.EXCEPTION) {
    console.log(`   ${r.file}:${r.line} — ${r.variable}`);
  }
}

console.log('');
