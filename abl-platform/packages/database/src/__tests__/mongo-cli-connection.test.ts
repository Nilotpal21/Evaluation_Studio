import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MONGODB_CLI_DATABASE,
  redactMongoUrlCredentials,
  resolveMongoCliConnection,
} from '../mongo/cli-connection.js';

describe('resolveMongoCliConnection', () => {
  it('uses the database from MONGODB_URL when no explicit DB override is set', () => {
    const resolved = resolveMongoCliConnection({
      MONGODB_URL:
        'mongodb://user:secret@mongo-0:27017,mongo-1:27017/abl-platform?replicaSet=rs0&authSource=admin',
    });

    expect(resolved.url).toContain('/abl-platform?');
    expect(resolved.options).toEqual({});
    expect(resolved.database).toBe('abl-platform');
    expect(resolved.databaseSource).toBe('uri');
    expect(resolved.redactedTarget).toContain('mongodb://<redacted>@mongo-0:27017');
    expect(resolved.redactedTarget).not.toContain('secret');
  });

  it('uses MONGODB_DATABASE as an explicit dbName override', () => {
    const resolved = resolveMongoCliConnection({
      MONGODB_URL: 'mongodb://user:secret@mongo-0:27017/abl-platform?authSource=admin',
      MONGODB_DATABASE: 'override-db',
    });

    expect(resolved.options).toEqual({ dbName: 'override-db' });
    expect(resolved.database).toBe('override-db');
    expect(resolved.databaseSource).toBe('explicit-env');
    expect(resolved.redactedTarget).toContain('(dbName: override-db)');
    expect(resolved.redactedTarget).not.toContain('secret');
  });

  it('falls back to the default database only when the URL has no database path', () => {
    const resolved = resolveMongoCliConnection({
      MONGODB_URL: 'mongodb://user:secret@localhost:27017/?authSource=admin',
    });

    expect(resolved.options).toEqual({ dbName: DEFAULT_MONGODB_CLI_DATABASE });
    expect(resolved.database).toBe(DEFAULT_MONGODB_CLI_DATABASE);
    expect(resolved.databaseSource).toBe('default');
    expect(resolved.redactedTarget).toContain(`(dbName: ${DEFAULT_MONGODB_CLI_DATABASE})`);
  });
});

describe('redactMongoUrlCredentials', () => {
  it('redacts credentials without changing the database path', () => {
    expect(
      redactMongoUrlCredentials(
        'mongodb://user:secret@mongo-0:27017/abl-platform?authSource=admin',
      ),
    ).toBe('mongodb://<redacted>@mongo-0:27017/abl-platform?authSource=admin');
  });
});
