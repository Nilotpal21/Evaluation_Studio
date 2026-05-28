import { createLogger } from '@abl/compiler/platform';
import { createDedicatedClickHouseClient } from '@agent-platform/database/clickhouse';
import {
  PLATFORM_EVENTS_VOICE_HOURLY_DEST_DDL,
  PLATFORM_EVENTS_VOICE_HOURLY_MV_DDL,
  PLATFORM_EVENTS_VOICE_HOURLY_SELECT,
} from '@agent-platform/database/clickhouse-schemas/init';
import type { ClickHouseClient } from '@clickhouse/client';

const log = createLogger('voice-analytics-mv-repair');

const DATABASE = 'abl_platform';
const DEST_TABLE = 'platform_events_voice_hourly_dest';
const MV_TABLE = 'platform_events_voice_hourly';
const REQUIRED_MV_MARKERS = [
  "JSONHas(data, 'inboundNetworkMos')",
  "JSONHas(data, 'avgE2eLatencyMs')",
  "JSONHas(data, 'homerAvailable')",
];

interface ClickHouseTableRow {
  createTableQuery?: string;
  rowCount?: string;
}

export interface VoiceAnalyticsMvRepairConfig {
  url: string;
  username?: string;
  password?: string;
}

async function chQuery<T>(client: ClickHouseClient, query: string): Promise<T[]> {
  const result = await client.query({ query, format: 'JSONEachRow' });
  return result.json<T>();
}

async function tableExists(client: ClickHouseClient, tableName: string): Promise<boolean> {
  const rows = await chQuery<ClickHouseTableRow>(
    client,
    `
      SELECT '1' AS rowCount
      FROM system.tables
      WHERE database = '${DATABASE}' AND name = '${tableName}'
      LIMIT 1
    `,
  );

  return rows.length > 0;
}

async function getCreateTableQuery(
  client: ClickHouseClient,
  tableName: string,
): Promise<string | null> {
  const rows = await chQuery<ClickHouseTableRow>(
    client,
    `
      SELECT create_table_query AS createTableQuery
      FROM system.tables
      WHERE database = '${DATABASE}' AND name = '${tableName}'
      LIMIT 1
    `,
  );

  return rows[0]?.createTableQuery ?? null;
}

async function getTableRowCount(client: ClickHouseClient, tableName: string): Promise<number> {
  const rows = await chQuery<ClickHouseTableRow>(
    client,
    `SELECT toString(count()) AS rowCount FROM ${DATABASE}.${tableName}`,
  );

  return parseInt(rows[0]?.rowCount ?? '0', 10);
}

function isMvDefinitionCurrent(createTableQuery: string): boolean {
  return REQUIRED_MV_MARKERS.every((marker) => createTableQuery.includes(marker));
}

async function createMissingObjects(client: ClickHouseClient, destExists: boolean): Promise<void> {
  if (!destExists) {
    await client.command({ query: PLATFORM_EVENTS_VOICE_HOURLY_DEST_DDL });
  }

  await client.command({ query: PLATFORM_EVENTS_VOICE_HOURLY_MV_DDL });

  const shouldBackfill = !destExists || (await getTableRowCount(client, DEST_TABLE)) === 0;
  if (shouldBackfill) {
    await client.command({
      query: `INSERT INTO ${DATABASE}.${DEST_TABLE} ${PLATFORM_EVENTS_VOICE_HOURLY_SELECT}`,
    });
  }
}

export async function ensureVoiceAnalyticsMvUpToDate(client: ClickHouseClient): Promise<void> {
  const destExists = await tableExists(client, DEST_TABLE);
  const createTableQuery = await getCreateTableQuery(client, MV_TABLE);
  const mvExists = createTableQuery !== null;
  const definitionCurrent = createTableQuery ? isMvDefinitionCurrent(createTableQuery) : false;

  log.info('Voice analytics ClickHouse object state evaluated', {
    destExists,
    mvExists,
    definitionCurrent,
  });

  if (!mvExists) {
    await createMissingObjects(client, destExists);
    log.info('Created missing voice analytics ClickHouse objects', { destExists });
    return;
  }

  if (destExists && definitionCurrent) {
    log.info('Voice analytics ClickHouse objects already up to date', {
      destExists,
      mvExists,
    });
    return;
  }

  if (!destExists) {
    await createMissingObjects(client, destExists);
    log.warn('Created missing voice analytics destination table for existing materialized view', {
      mvExists,
      definitionCurrent,
    });
    return;
  }

  log.warn('Voice analytics materialized view definition is stale; explicit migration required', {
    destExists,
    mvExists,
    definitionCurrent,
  });
}

export async function ensureVoiceAnalyticsMvUpToDateWithDedicatedClient(
  config: VoiceAnalyticsMvRepairConfig,
): Promise<void> {
  const client = createDedicatedClickHouseClient(config);

  try {
    await ensureVoiceAnalyticsMvUpToDate(client);
  } finally {
    await client.close();
  }
}
