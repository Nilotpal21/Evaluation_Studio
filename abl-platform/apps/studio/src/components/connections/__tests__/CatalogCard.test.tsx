/**
 * CatalogCard tests
 *
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { CatalogCard, type CatalogConnector } from '../CatalogCard';

function buildConnector(overrides: Partial<CatalogConnector> = {}): CatalogConnector {
  return {
    name: 'gmail',
    displayName: 'Gmail',
    description: 'Email service by Google',
    category: 'communication',
    authType: 'oauth2',
    availableAuthTypes: ['oauth2'],
    actions: [{ name: 'send_email', displayName: 'Send Email', description: 'Send an email' }],
    triggers: [{ name: 'on_email', displayName: 'On Email', description: 'New email received' }],
    ...overrides,
  };
}

describe('CatalogCard', () => {
  it('fires onOpenDetails when the card body is clicked', () => {
    const onOpenDetails = vi.fn();
    render(
      <CatalogCard
        connector={buildConnector()}
        isConfigured={false}
        onConnect={vi.fn()}
        onOpenDetails={onOpenDetails}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /view gmail details/i }));
    expect(onOpenDetails).toHaveBeenCalledTimes(1);
  });

  it('fires onOpenDetails on Enter key', () => {
    const onOpenDetails = vi.fn();
    render(
      <CatalogCard
        connector={buildConnector()}
        isConfigured={false}
        onConnect={vi.fn()}
        onOpenDetails={onOpenDetails}
      />,
    );

    const card = screen.getByRole('button', { name: /view gmail details/i });
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(onOpenDetails).toHaveBeenCalledTimes(1);
  });

  it('Manage button click triggers onConnect without also opening details', () => {
    const onOpenDetails = vi.fn();
    const onConnect = vi.fn();
    render(
      <CatalogCard
        connector={buildConnector()}
        isConfigured
        profileCount={2}
        onConnect={onConnect}
        onOpenDetails={onOpenDetails}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^manage$/i }));
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(onOpenDetails).not.toHaveBeenCalled();
  });

  it('renders Manage label when isConfigured and shows the profile count', () => {
    render(
      <CatalogCard
        connector={buildConnector()}
        isConfigured
        profileCount={3}
        onConnect={vi.fn()}
        onOpenDetails={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /^manage$/i })).toBeInTheDocument();
    expect(screen.getByText(/3 profiles/i)).toBeInTheDocument();
  });

  it('does NOT render a Connect button on unconfigured cards', () => {
    render(
      <CatalogCard
        connector={buildConnector()}
        isConfigured={false}
        onConnect={vi.fn()}
        onOpenDetails={vi.fn()}
      />,
    );

    // Connect CTA was removed from the card — users open the side panel to connect.
    expect(screen.queryByRole('button', { name: /^connect$/i })).toBeNull();
    // Card body itself remains the click target.
    expect(screen.getByRole('button', { name: /view gmail details/i })).toBeInTheDocument();
  });
});
