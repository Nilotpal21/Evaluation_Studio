'use client';

import { useEffect } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { sanitizeError } from '@/lib/sanitize-error';

/**
 * Next.js App Router error boundary.
 *
 * Catches unhandled errors in any route segment under the root layout and
 * renders a user-friendly fallback instead of a blank or broken page.
 * The root layout (providers, <html>, <body>) stays mounted so the user
 * can recover without a full page reload.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Route error boundary caught:', error);
  }, [error]);

  const message = sanitizeError(error, 'Something went wrong. Please try again.');

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex flex-col items-center text-center p-8 max-w-md">
        <AlertTriangle className="w-12 h-12 text-warning mb-4" />
        <h2 className="text-xl font-semibold text-foreground mb-2">Something went wrong</h2>
        <p className="text-sm text-muted mb-6">{message}</p>
        <button
          onClick={reset}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-accent-foreground bg-accent rounded-lg hover:bg-accent/90 transition-default"
        >
          <RefreshCw className="w-4 h-4" />
          Try again
        </button>
      </div>
    </div>
  );
}
