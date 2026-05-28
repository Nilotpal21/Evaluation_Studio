import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const HELIX_ENV_KEYS = [
  'JIRA_BASE_URL',
  'ATLASSIAN_BASE_URL',
  'JIRA_EMAIL',
  'JIRA_API_TOKEN',
  'ATLASSIAN_API_KEY',
  'JIRA_PROJECT_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'HELIX_EMBEDDINGS_ENABLED',
  'HELIX_EMBEDDING_BASE_URL',
  'HELIX_EMBEDDING_AUTH_TOKEN',
  'HELIX_EMBEDDING_TIMEOUT_MS',
  'HELIX_EMBEDDING_MAX_BATCH_SIZE',
  'HELIX_EMBEDDING_REQUEST_BUDGET',
  'HELIX_EMBEDDING_SHARD_BASE_PATH',
  'HELIX_EMBEDDING_DISABLED',
  'SHARD_BASE_PATH',
] as const;

export function loadHelixEnvFromDotEnv(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  allowedKeys: readonly string[] = HELIX_ENV_KEYS,
): void {
  try {
    const envContent = readFileSync(resolve(cwd, '.env'), 'utf-8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const eqIndex = trimmed.indexOf('=');
      if (eqIndex < 0) {
        continue;
      }

      const key = trimmed.slice(0, eqIndex).trim();
      if (!allowedKeys.includes(key) || env[key]) {
        continue;
      }

      let value = trimmed.slice(eqIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      env[key] = value;
    }
  } catch {
    // .env not found — credentials may already be in the environment.
  }
}
