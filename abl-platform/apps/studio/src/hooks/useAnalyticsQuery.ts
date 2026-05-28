/**
 * useAnalyticsQuery Hook
 *
 * Manual (non-SWR) hook for executing developer SQL queries against ClickHouse.
 * Sends queries through the Studio proxy to the runtime analytics endpoint.
 */

import { useState, useCallback, useEffect } from 'react';
import { apiFetch } from '../lib/api-client';
import type { TimeRange } from './useAnalytics';

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
}

export interface AnalyticsQueryState {
  result: QueryResult | null;
  isLoading: boolean;
  error: string | null;
  executionTimeMs: number | null;
  executeQuery: (sql: string) => Promise<void>;
  clear: () => void;
}

export interface AnalyticsQueryOptions {
  sessionId?: string;
}

export interface AnalyticsTableDescriptor {
  name: string;
  description: string;
}

export interface AnalyticsTablesState {
  tables: AnalyticsTableDescriptor[];
  maxRows: number | null;
  isLoading: boolean;
  error: string | null;
}

function getAnalyticsQueryErrorMessage(error: unknown): string {
  if (typeof error === 'string' && error.trim().length > 0) {
    return error;
  }

  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim().length > 0) {
      return message;
    }
  }

  return 'Query failed';
}

export function useAnalyticsQuery(
  projectId: string | null,
  timeRange?: TimeRange,
  options: AnalyticsQueryOptions = {},
): AnalyticsQueryState {
  const [result, setResult] = useState<QueryResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [executionTimeMs, setExecutionTimeMs] = useState<number | null>(null);

  const executeQuery = useCallback(
    async (sql: string) => {
      if (!projectId) {
        setError('No project selected');
        return;
      }

      setIsLoading(true);
      setError(null);
      setResult(null);
      setExecutionTimeMs(null);

      try {
        const params = new URLSearchParams({
          projectId,
          endpoint: 'sql-query',
        });

        const body: Record<string, unknown> = { sql };
        if (options.sessionId?.trim()) body.sessionId = options.sessionId.trim();
        if (timeRange) body.timeRange = timeRange;

        const response = await apiFetch(`/api/runtime/analytics?${params.toString()}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        const data = await response.json();

        if (!data.success) {
          setError(getAnalyticsQueryErrorMessage(data.error));
          return;
        }

        setResult(data.data || null);
        setExecutionTimeMs(data.executionTimeMs || null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsLoading(false);
      }
    },
    [projectId, timeRange, options.sessionId],
  );

  const clear = useCallback(() => {
    setResult(null);
    setError(null);
    setExecutionTimeMs(null);
  }, []);

  return { result, isLoading, error, executionTimeMs, executeQuery, clear };
}

/**
 * Fetches the allowlist of analytics tables (and the per-query row cap) that
 * the runtime will accept in POST /sql-query. Called once per project so the
 * Query tab picker and the in-tab guide always mirror the server-side
 * allowlist instead of hardcoding table names.
 */
export function useAnalyticsTables(projectId: string | null): AnalyticsTablesState {
  const [tables, setTables] = useState<AnalyticsTableDescriptor[]>([]);
  const [maxRows, setMaxRows] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) {
      setTables([]);
      setMaxRows(null);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    const load = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ projectId, endpoint: 'tables' });
        const response = await apiFetch(`/api/runtime/analytics?${params.toString()}`, {
          signal: controller.signal,
        });
        const data = await response.json();
        if (cancelled) return;
        if (!data?.success || !data.data) {
          setError(typeof data?.error === 'string' ? data.error : 'Failed to load tables');
          return;
        }
        setTables(Array.isArray(data.data.tables) ? data.data.tables : []);
        setMaxRows(typeof data.data.maxRows === 'number' ? data.data.maxRows : null);
      } catch (err) {
        if (cancelled || (err instanceof Error && err.name === 'AbortError')) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [projectId]);

  return { tables, maxRows, isLoading, error };
}

// ---------------------------------------------------------------------------
// useMongoCollections — fetches the db-query MongoDB collection allowlist
// ---------------------------------------------------------------------------

export interface MongoCollectionDescriptor {
  name: string;
  description: string;
  defaultQuery: string;
}

interface MongoCollectionsState {
  collections: MongoCollectionDescriptor[];
  isLoading: boolean;
  error: string | null;
}

/**
 * Fetches the allowlist of MongoDB collections that the db-query pipeline node
 * will accept. Called once per project so the config form dropdown always
 * mirrors the server-side allowlist.
 */
export function useMongoCollections(projectId: string | null): MongoCollectionsState {
  const [collections, setCollections] = useState<MongoCollectionDescriptor[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) {
      setCollections([]);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    const load = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ projectId, endpoint: 'mongo-collections' });
        const response = await apiFetch(`/api/runtime/analytics?${params.toString()}`, {
          signal: controller.signal,
        });
        const data = await response.json();
        if (cancelled) return;
        if (!data?.success || !data.data) {
          setError(typeof data?.error === 'string' ? data.error : 'Failed to load collections');
          return;
        }
        setCollections(Array.isArray(data.data.collections) ? data.data.collections : []);
      } catch (err) {
        if (cancelled || (err instanceof Error && err.name === 'AbortError')) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [projectId]);

  return { collections, isLoading, error };
}

// ---------------------------------------------------------------------------
// useClickHouseTables — fetches the db-query ClickHouse table allowlist
// ---------------------------------------------------------------------------

export interface ClickHouseTableDescriptor {
  name: string;
  description: string;
  defaultQuery: string;
}

interface ClickHouseTablesState {
  tables: ClickHouseTableDescriptor[];
  isLoading: boolean;
  error: string | null;
}

/**
 * Fetches the allowlist of ClickHouse tables that the db-query pipeline node
 * will accept. Only tables with a session_id column are included.
 */
export function useClickHouseTables(projectId: string | null): ClickHouseTablesState {
  const [tables, setTables] = useState<ClickHouseTableDescriptor[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) {
      setTables([]);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    const load = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ projectId, endpoint: 'clickhouse-tables' });
        const response = await apiFetch(`/api/runtime/analytics?${params.toString()}`, {
          signal: controller.signal,
        });
        const data = await response.json();
        if (cancelled) return;
        if (!data?.success || !data.data) {
          setError(typeof data?.error === 'string' ? data.error : 'Failed to load tables');
          return;
        }
        setTables(Array.isArray(data.data.tables) ? data.data.tables : []);
      } catch (err) {
        if (cancelled || (err instanceof Error && err.name === 'AbortError')) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [projectId]);

  return { tables, isLoading, error };
}
