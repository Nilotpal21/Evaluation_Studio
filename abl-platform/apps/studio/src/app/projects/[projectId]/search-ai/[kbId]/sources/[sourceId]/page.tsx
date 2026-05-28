'use client';

/**
 * Source detail route — renders the full SPA shell so the AppShell handles
 * routing with sidebar, header, and navigation intact.
 *
 * Without this file Next.js returns 404 on hard reload / browser back.
 * The previous version rendered UnifiedSourcePage directly (no AppShell),
 * causing a full-window layout without sidebar.
 */

import dynamic from 'next/dynamic';
import { SWRConfig } from 'swr';
import { swrConfig } from '@/lib/swr-config';

const App = dynamic(() => import('@/App'), { ssr: false });

export default function SourceDetailRoute() {
  return (
    <SWRConfig value={swrConfig}>
      <App />
    </SWRConfig>
  );
}
