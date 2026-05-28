'use client';

import { SWRConfig } from 'swr';
import { swrConfig } from '@/lib/swr-config';
import { TooltipProvider } from '@/components/ui/Tooltip';

/**
 * Client-side Providers
 *
 * Wraps the app with providers that require client-side rendering.
 * Currently provides:
 * - SWR for server state management
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig value={swrConfig}>
      <TooltipProvider>{children}</TooltipProvider>
    </SWRConfig>
  );
}
