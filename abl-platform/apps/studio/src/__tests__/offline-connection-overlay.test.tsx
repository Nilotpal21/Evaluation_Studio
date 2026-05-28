import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OfflineConnectionOverlay } from '@/components/OfflineConnectionOverlay';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';

function OnlineStatusHarness() {
  const isOffline = useOnlineStatus();

  return <span>{isOffline ? 'offline' : 'online'}</span>;
}

describe('Offline connection experience', () => {
  beforeEach(() => {
    let online = true;

    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      get: () => online,
      set: (value: boolean) => {
        online = value;
      },
    });
  });

  it('tracks browser online and offline events', () => {
    render(<OnlineStatusHarness />);

    expect(screen.getByText('online')).toBeInTheDocument();

    act(() => {
      Object.defineProperty(window.navigator, 'onLine', {
        configurable: true,
        get: () => false,
      });
      window.dispatchEvent(new Event('offline'));
    });

    expect(screen.getByText('offline')).toBeInTheDocument();

    act(() => {
      Object.defineProperty(window.navigator, 'onLine', {
        configurable: true,
        get: () => true,
      });
      window.dispatchEvent(new Event('online'));
    });

    expect(screen.getByText('online')).toBeInTheDocument();
  });

  it('renders the offline popup copy and retry action', () => {
    const onRetry = vi.fn();

    render(
      <OfflineConnectionOverlay
        title="Agent Platform can't reach the internet"
        description="You are not connected to internet. Please check your internet connection and try again."
        retryLabel="Try again"
        onRetry={onRetry}
      />,
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText("Agent Platform can't reach the internet")).toBeInTheDocument();
    expect(
      screen.getByText(
        'You are not connected to internet. Please check your internet connection and try again.',
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
