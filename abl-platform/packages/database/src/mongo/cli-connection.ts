export const DEFAULT_MONGODB_CLI_URL =
  'mongodb://abl_admin:abl_dev_password@localhost:27018/?authSource=admin&directConnection=true';
export const DEFAULT_MONGODB_CLI_DATABASE = 'abl_platform';

export interface MongoCliConnectionResolution {
  url: string;
  options: {
    dbName?: string;
  };
  database: string;
  databaseSource: 'explicit-env' | 'uri' | 'default';
  redactedTarget: string;
}

function getExplicitDatabase(env: Record<string, string | undefined>): string | undefined {
  return env.MONGODB_DATABASE || env.MONGODB_DB_NAME;
}

function getDatabaseFromUrl(mongoUrl: string): string | undefined {
  try {
    const parsed = new URL(mongoUrl);
    const database = parsed.pathname.replace(/^\/+/, '').split('/')[0];
    return database ? decodeURIComponent(database) : undefined;
  } catch {
    const match = mongoUrl.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]+@)?[^/?#]+\/([^?#]+)/i);
    return match?.[1] ? decodeURIComponent(match[1].split('/')[0]) : undefined;
  }
}

export function redactMongoUrlCredentials(mongoUrl: string): string {
  return mongoUrl.replace(/\/\/([^@/?#]+)@/, '//<redacted>@');
}

export function resolveMongoCliConnection(
  env: Record<string, string | undefined> = process.env,
): MongoCliConnectionResolution {
  const url = env.MONGODB_URL || env.MONGODB_URI || DEFAULT_MONGODB_CLI_URL;
  const explicitDatabase = getExplicitDatabase(env);
  const uriDatabase = getDatabaseFromUrl(url);

  if (explicitDatabase) {
    return {
      url,
      options: { dbName: explicitDatabase },
      database: explicitDatabase,
      databaseSource: 'explicit-env',
      redactedTarget: `${redactMongoUrlCredentials(url)} (dbName: ${explicitDatabase})`,
    };
  }

  if (uriDatabase) {
    return {
      url,
      options: {},
      database: uriDatabase,
      databaseSource: 'uri',
      redactedTarget: redactMongoUrlCredentials(url),
    };
  }

  return {
    url,
    options: { dbName: DEFAULT_MONGODB_CLI_DATABASE },
    database: DEFAULT_MONGODB_CLI_DATABASE,
    databaseSource: 'default',
    redactedTarget: `${redactMongoUrlCredentials(url)} (dbName: ${DEFAULT_MONGODB_CLI_DATABASE})`,
  };
}
