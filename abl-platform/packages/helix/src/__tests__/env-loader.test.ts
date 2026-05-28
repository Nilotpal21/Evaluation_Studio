import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadHelixEnvFromDotEnv } from '../env-loader.js';

describe('env-loader', () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('loads HELIX-allowed provider keys from .env without overwriting existing env', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-env-loader-'));
    await writeFile(
      join(tempDir, '.env'),
      [
        'ANTHROPIC_API_KEY="anthropic-from-dotenv"',
        'OPENAI_API_KEY=openai-from-dotenv',
        'JIRA_PROJECT_KEY=ABLP',
        'UNRELATED_SECRET=should-not-load',
      ].join('\n'),
      'utf-8',
    );

    const env: NodeJS.ProcessEnv = {
      OPENAI_API_KEY: 'already-set-openai',
    };

    loadHelixEnvFromDotEnv(tempDir, env);

    expect(env.ANTHROPIC_API_KEY).toBe('anthropic-from-dotenv');
    expect(env.OPENAI_API_KEY).toBe('already-set-openai');
    expect(env.JIRA_PROJECT_KEY).toBe('ABLP');
    expect(env.UNRELATED_SECRET).toBeUndefined();
  });

  it('loads embedding provider keys from .env without loading unrelated secrets', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-env-loader-'));
    await writeFile(
      join(tempDir, '.env'),
      [
        'HELIX_EMBEDDINGS_ENABLED=true',
        'HELIX_EMBEDDING_BASE_URL=http://127.0.0.1:8000',
        'HELIX_EMBEDDING_AUTH_TOKEN="embedding-token"',
        'SHARD_BASE_PATH=.helix/cache/embeddings/bge-m3-1024/findings.jsonl',
        'UNRELATED_SECRET=should-not-load',
      ].join('\n'),
      'utf-8',
    );

    const env: NodeJS.ProcessEnv = {};

    loadHelixEnvFromDotEnv(tempDir, env);

    expect(env.HELIX_EMBEDDINGS_ENABLED).toBe('true');
    expect(env.HELIX_EMBEDDING_BASE_URL).toBe('http://127.0.0.1:8000');
    expect(env.HELIX_EMBEDDING_AUTH_TOKEN).toBe('embedding-token');
    expect(env.SHARD_BASE_PATH).toBe('.helix/cache/embeddings/bge-m3-1024/findings.jsonl');
    expect(env.UNRELATED_SECRET).toBeUndefined();
  });
});
