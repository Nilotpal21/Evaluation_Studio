import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IsolatedErrorBoundary } from '@/components/ui/IsolatedErrorBoundary';

function ExplodingWidget({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error('boom');
  }

  return <div>Recovered widget</div>;
}

describe('IsolatedErrorBoundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('contains render errors without unmounting sibling UI', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <div>
        <span>Stable shell</span>
        <IsolatedErrorBoundary name="Risky section" resetKey="a">
          <ExplodingWidget shouldThrow />
        </IsolatedErrorBoundary>
      </div>,
    );

    expect(screen.getByText('Stable shell')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Risky section could not load');
  });

  it('resets when the owning route key changes', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { rerender } = render(
      <IsolatedErrorBoundary name="Route content" resetKey="broken">
        <ExplodingWidget shouldThrow />
      </IsolatedErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();

    rerender(
      <IsolatedErrorBoundary name="Route content" resetKey="healthy">
        <ExplodingWidget shouldThrow={false} />
      </IsolatedErrorBoundary>,
    );

    expect(screen.getByText('Recovered widget')).toBeInTheDocument();
  });

  it('allows retrying the isolated section', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();

    const { rerender } = render(
      <IsolatedErrorBoundary name="Retry section" resetKey="same-route">
        <ExplodingWidget shouldThrow />
      </IsolatedErrorBoundary>,
    );

    rerender(
      <IsolatedErrorBoundary name="Retry section" resetKey="same-route">
        <ExplodingWidget shouldThrow={false} />
      </IsolatedErrorBoundary>,
    );

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(screen.getByText('Recovered widget')).toBeInTheDocument();
  });
});
