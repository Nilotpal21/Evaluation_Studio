'use client';

import { useEffect } from 'react';

/**
 * Next.js global error boundary.
 *
 * Catches errors in the ROOT LAYOUT itself (providers, i18n, runtime config).
 * Because the root layout is broken, this component must supply its own
 * <html> and <body> tags and cannot rely on design-system CSS variables,
 * i18n, or any provider context — so it uses inline styles.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Global error boundary caught:', error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <div
          style={{
            display: 'flex',
            minHeight: '100vh',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#0f0f1a',
            color: '#e2e2e8',
            fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          }}
        >
          <div style={{ textAlign: 'center', padding: 32, maxWidth: 420 }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>&#x26A0;</div>
            <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>Something went wrong</h2>
            <p style={{ fontSize: 14, color: '#9898a6', marginBottom: 24 }}>
              An unexpected error occurred. Please try again or refresh the page.
            </p>
            <button
              onClick={reset}
              style={{
                padding: '10px 20px',
                fontSize: 14,
                fontWeight: 500,
                color: '#fff',
                background: '#1a1a1a',
                border: 'none',
                borderRadius: 8,
                cursor: 'pointer',
                marginRight: 8,
              }}
            >
              Try again
            </button>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: '10px 20px',
                fontSize: 14,
                fontWeight: 500,
                color: '#9898a6',
                background: 'transparent',
                border: '1px solid #2a2a3a',
                borderRadius: 8,
                cursor: 'pointer',
              }}
            >
              Reload page
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
