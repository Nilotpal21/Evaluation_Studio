'use client';

import { Component, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { SWRConfig } from 'swr';
import { swrConfig } from '@/lib/swr-config';
const App = dynamic(() => import('@/App'), { ssr: false });

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      const isDev = process.env.NODE_ENV === 'development';
      return (
        <div
          style={{
            padding: 40,
            color: 'hsl(0, 72.2%, 50.6%)',
            background: 'hsl(220, 3%, 7%)',
            height: '100vh',
            fontFamily: 'monospace',
          }}
        >
          <h1 style={{ fontSize: 20, marginBottom: 16 }}>Something went wrong</h1>
          <p style={{ fontSize: 14, color: 'hsl(220, 2%, 64%)', marginBottom: 16 }}>
            An unexpected error occurred. Please try refreshing the page.
          </p>
          {isDev && (
            <>
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 14 }}>{this.state.error.message}</pre>
              <pre
                style={{
                  whiteSpace: 'pre-wrap',
                  fontSize: 12,
                  color: 'hsl(220, 2%, 45%)',
                  marginTop: 16,
                }}
              >
                {this.state.error.stack}
              </pre>
            </>
          )}
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: 16,
              padding: '8px 16px',
              background: 'hsl(0, 72.2%, 50.6%)',
              color: 'hsl(0, 0%, 100%)',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            Reload page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function HomePage() {
  return (
    <ErrorBoundary>
      <SWRConfig value={swrConfig}>
        <App />
      </SWRConfig>
    </ErrorBoundary>
  );
}
