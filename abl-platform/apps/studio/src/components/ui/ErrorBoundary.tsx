'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { sanitizeError } from '../../lib/sanitize-error';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

function ErrorBoundaryFallback({ error, onRetry }: { error: Error | null; onRetry: () => void }) {
  const t = useTranslations('common');

  return (
    <div className="flex flex-col items-center justify-center p-8 text-center">
      <AlertTriangle className="w-10 h-10 text-warning mb-3" />
      <h3 className="text-lg font-semibold text-foreground mb-1">{t('error_generic_title')}</h3>
      <p className="text-sm text-muted mb-4 max-w-md">{sanitizeError(error, t('error_generic'))}</p>
      <button
        onClick={onRetry}
        className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-accent-foreground bg-accent rounded-lg hover:bg-accent/90 transition-default"
      >
        <RefreshCw className="w-4 h-4" />
        {t('retry')}
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
        />
      );
    }

    return this.props.children;
  }
}
