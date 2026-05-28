/**
 * ErrorBoundary — Crash protection for Interactions tab.
 *
 * Catches errors in event processing or rendering and shows
 * a friendly fallback UI instead of crashing the entire debug panel.
 */

import { Component, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class InteractionsErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // H1: Only log in dev mode to comply with project rules (no console.* in production)
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.error('[InteractionsTab] Error boundary caught:', error, errorInfo);
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-full p-6 text-center">
          <AlertTriangle className="w-12 h-12 text-error mb-4" />
          <h3 className="text-lg font-semibold text-foreground mb-2">Error Loading Interactions</h3>
          <p className="text-sm text-foreground-muted mb-4 max-w-md">
            An error occurred while processing trace events. This may be due to malformed data or an
            unexpected event structure.
          </p>
          <details className="text-left bg-background-elevated rounded-md p-3 max-w-2xl w-full">
            <summary className="text-xs font-mono text-foreground-muted cursor-pointer">
              Error details
            </summary>
            <pre className="text-[10px] text-error mt-2 whitespace-pre-wrap break-words">
              {this.state.error?.message}
              {'\n'}
              {this.state.error?.stack}
            </pre>
          </details>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="mt-4 px-4 py-2 bg-background-elevated hover:bg-background-muted rounded-md text-sm text-foreground transition-colors"
          >
            Try Again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
