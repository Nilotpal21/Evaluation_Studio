/**
 * Query Store Singleton
 *
 * Provides global access to the ClickHouseSearchQueryStore instance.
 * Initialized during server startup after ClickHouse connection is established.
 */

import type { ClickHouseClient } from '@clickhouse/client';
import { ClickHouseSearchQueryStore } from './clickhouse-search-query-store.js';

let store: ClickHouseSearchQueryStore | null = null;

/**
 * Initialize the query store singleton with a ClickHouse client.
 * Called once during server startup.
 */
export function initQueryStore(client: ClickHouseClient): void {
  store = new ClickHouseSearchQueryStore(client);
}

/**
 * Get the query store singleton.
 * Returns null if ClickHouse is not available or not yet initialized.
 */
export function getQueryStore(): ClickHouseSearchQueryStore | null {
  return store;
}
