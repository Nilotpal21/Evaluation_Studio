import { useState, useCallback } from 'react';
import { useSessionStore } from '../store/session-store';
import { useObservatoryStore } from '../store/observatory-store';
import {
  fetchAppStaticGraph,
  fetchAvailableAppsList,
  type AvailableAppInfo as AppInfo,
} from '../lib/app-graph-loader';

export function useAvailableApps() {
  const [availableApps, setAvailableApps] = useState<AppInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingApp, setLoadingApp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setSessionError = useSessionStore((s) => s.setError);
  const setAppStaticGraph = useObservatoryStore((s) => s.setAppStaticGraph);
  const setGraphViewMode = useObservatoryStore((s) => s.setGraphViewMode);

  const fetchApps = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const apps = await fetchAvailableAppsList();
      setAvailableApps(apps);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      if (process.env.NODE_ENV === 'development') {
        console.error('[API] Failed to fetch apps:', err);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const loadApp = useCallback(
    async (domain: string): Promise<boolean> => {
      setLoadingApp(true);
      try {
        const appStaticGraph = await fetchAppStaticGraph(domain);
        setAppStaticGraph(appStaticGraph);
        setGraphViewMode('app');
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setSessionError(message);
        return false;
      } finally {
        setLoadingApp(false);
      }
    },
    [setAppStaticGraph, setGraphViewMode, setSessionError],
  );

  return { availableApps, fetchApps, loadApp, loading, loadingApp, error };
}
