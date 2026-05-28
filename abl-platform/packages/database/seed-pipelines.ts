import {
  seedBuiltinPipelineDefinitions,
  seedTenantPipelineConfigs,
} from '../pipeline-engine/src/pipeline/seed-defaults.js';

export async function seedPipelines(
  tenantId?: string,
  createdBy: string = 'platform',
): Promise<number> {
  let count = 0;

  const clickhouseUrl = process.env.CLICKHOUSE_URL;
  if (clickhouseUrl) {
    console.log('  Initializing ClickHouse analytics tables...');
    const { createClient } = await import('@clickhouse/client');
    const ch = createClient({ url: clickhouseUrl });
    try {
      const { initAllClickHouseSchemas } = await import('./src/clickhouse-schemas/init-all.js');
      await initAllClickHouseSchemas(ch);
      console.log('  ClickHouse analytics tables ready.');
    } finally {
      await ch.close();
    }
  } else {
    console.log('  CLICKHOUSE_URL not set - skipping analytics DDL.');
  }

  console.log('  Seeding pipeline definitions...');
  count += await seedBuiltinPipelineDefinitions();

  if (!tenantId) {
    console.log('  No tenant target provided - skipping tenant pipeline configs.');
    return count;
  }

  console.log(`  Seeding default pipeline configs for tenant ${tenantId}...`);
  count += await seedTenantPipelineConfigs({ tenantId, createdBy });

  return count;
}
