'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  title?: string;
  retryLabel?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

function ErrorBoundaryFallback({
  error,
  onRetry,
  title = 'Something went wrong',
  retryLabel = 'Try again',
}: {
  error: Error | null;
  onRetry: () => void;
  title?: string;
  retryLabel?: string;
}) {
  const message = error?.message || 'An unexpected error occurred.';

  return (
    <div className="flex flex-col items-center justify-center p-8 text-center">
      <AlertTriangle className="w-10 h-10 text-warning mb-3" />
      <h3 className="text-lg font-semibold text-foreground mb-1">{title}</h3>
      <p className="text-sm text-muted mb-4 max-w-md">{message}</p>
      <button
        onClick={onRetry}
        className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-accent-foreground bg-accent rounded-lg hover:bg-accent/90 transition-default"
      >
        <RefreshCw className="w-4 h-4" />
        {retryLabel}
      </button>
    </div>
  );
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
    this.props.onError?.(error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <ErrorBoundaryFallback
          error={this.state.error}
          onRetry={() => this.setState({ hasError: false, error: null })}
          title={this.props.title}
          retryLabel={this.props.retryLabel}
        />
      );
    }

    return this.props.children;
  }
}
