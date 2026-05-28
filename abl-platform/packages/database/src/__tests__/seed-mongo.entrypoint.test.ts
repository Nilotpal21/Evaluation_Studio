import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../../');
const MONGOMS_VERSION = process.env.MONGOMS_VERSION || '7.0.20';
const TEST_MASTER_KEY = 'a'.repeat(64);
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

describe('seed-mongo.ts entrypoint', () => {
  it('completes the dev seed flow and persists encrypted example env vars when DEK is available', async (ctx) => {
    let mongod: MongoMemoryServer | undefined;
    let readConnection: mongoose.Connection | undefined;

    try {
      try {
        mongod = await MongoMemoryServer.create({
          binary: { version: MONGOMS_VERSION },
          instance: { launchTimeout: 60_000 },
        });
      } catch {
        return ctx.skip('MongoMemoryServer unavailable');
      }

      const mongoUri = mongod.getUri('abl_platform');
      const { stdout, stderr } = await execFileAsync(
        pnpmCommand,
        ['tsx', 'packages/database/seed-mongo.ts', '--fresh', '--dev'],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            MONGODB_URL: mongoUri,
            MONGODB_ROOT_URL: mongoUri,
            CLICKHOUSE_URL: '',
            ANTHROPIC_API_KEY: '',
            OPENAI_API_KEY: '',
            ENCRYPTION_MASTER_KEY: TEST_MASTER_KEY,
          },
          maxBuffer: 20 * 1024 * 1024,
          timeout: 120_000,
        },
      );

      expect(`${stdout}\n${stderr}`).toContain('DEK facade initialized.');
      expect(stderr).not.toContain('Seed error:');
      expect(stdout).toContain('Seed complete!');

      readConnection = await mongoose.createConnection(mongoUri).asPromise();
      const envVarCount = await readConnection.db
        .collection('environment_variables')
        .countDocuments({ tenantId: 'tenant-dev-001', projectId: 'proj-saludsa-production' });

      expect(envVarCount).toBe(2);
    } finally {
      if (readConnection) {
        await readConnection.close();
      }
      if (mongod) {
        await mongod.stop();
      }
    }
  }, 180_000);

  it('completes the dev seed flow without persisting provider keys to MongoDB when provider env vars are set', async (ctx) => {
    let mongod: MongoMemoryServer | undefined;
    let readConnection: mongoose.Connection | undefined;

    try {
      try {
        mongod = await MongoMemoryServer.create({
          binary: { version: MONGOMS_VERSION },
          instance: { launchTimeout: 60_000 },
        });
      } catch {
        return ctx.skip('MongoMemoryServer unavailable');
      }

      const mongoUri = mongod.getUri('abl_platform');
      const { stdout, stderr } = await execFileAsync(
        pnpmCommand,
        ['tsx', 'packages/database/seed-mongo.ts', '--fresh', '--dev'],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            MONGODB_URL: mongoUri,
            MONGODB_ROOT_URL: mongoUri,
            CLICKHOUSE_URL: '',
            ANTHROPIC_API_KEY: 'anthropic-test-key',
            OPENAI_API_KEY: 'openai-test-key',
          },
          maxBuffer: 20 * 1024 * 1024,
          timeout: 120_000,
        },
      );

      expect(stdout).toContain('provider keys are vault-managed, not seeded into MongoDB');
      expect(stderr).not.toContain('Seed error:');
      expect(stdout).toContain('Seed complete!');

      readConnection = await mongoose.createConnection(mongoUri).asPromise();
      const llmCredentialCount = await readConnection.db
        .collection('llm_credentials')
        .countDocuments({ tenantId: 'tenant-dev-001' });

      expect(llmCredentialCount).toBe(0);
    } finally {
      if (readConnection) {
        await readConnection.close();
      }
      if (mongod) {
        await mongod.stop();
      }
    }
  }, 180_000);
});
