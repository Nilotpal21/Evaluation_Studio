'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { clsx } from 'clsx';

type BoundaryResetKey = string | number | boolean | null | undefined;

interface IsolatedErrorBoundaryProps {
  name: string;
  children: ReactNode;
  resetKey?: BoundaryResetKey;
  fallbackClassName?: string;
}

interface IsolatedErrorBoundaryState {
  error: Error | null;
  resetKey: BoundaryResetKey;
}

export class IsolatedErrorBoundary extends Component<
  IsolatedErrorBoundaryProps,
  IsolatedErrorBoundaryState
> {
  state: IsolatedErrorBoundaryState = {
    error: null,
    resetKey: this.props.resetKey,
  };

  static getDerivedStateFromError(error: Error): Partial<IsolatedErrorBoundaryState> {
    return { error };
  }

  static getDerivedStateFromProps(
    props: IsolatedErrorBoundaryProps,
    state: IsolatedErrorBoundaryState,
  ): Partial<IsolatedErrorBoundaryState> | null {
    if (props.resetKey !== state.resetKey) {
      return {
        error: null,
        resetKey: props.resetKey,
      };
    }

    return null;
  }

  componentDidCatch(_error: Error, _errorInfo: ErrorInfo) {
    // Intentionally contain the fault without rethrowing. The browser console
    // still receives React's component stack in development, while users keep
    // the rest of the Studio shell available.
  }

  private reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <div
        role="alert"
        className={clsx(
          'flex min-h-0 flex-col items-center justify-center gap-2 overflow-hidden border border-dashed border-border bg-background-muted/40 p-4 text-center',
          this.props.fallbackClassName,
        )}
      >
        <div>
          <p className="text-sm font-medium text-foreground">{this.props.name} could not load</p>
          <p className="mt-1 text-xs text-foreground-muted">
            This section hit a UI error. The rest of Studio is still available.
          </p>
        </div>
        <button
          type="button"
          onClick={this.reset}
          className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground-muted transition-colors hover:border-accent/50 hover:text-foreground"
        >
          Try again
        </button>
      </div>
    );
  }
}
