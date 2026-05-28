/**
 * Tests for the ProfileConnectorBadges component (FR-11 — All Profiles tab
 * connector badge and usage-mode badge rendering).
 *
 * Extracted from AuthProfilesPage as a pure component so the badge logic
 * can be verified without mounting the full page or mocking internal hooks.
 *
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProfileConnectorBadges } from '@/components/auth-profiles/ProfileConnectorBadges';

const t = (key: string) => key;

describe('ProfileConnectorBadges — connector badge', () => {
  it('shows the connector name when connector is set', () => {
    render(
      <ProfileConnectorBadges
        connector="salesforce"
        authType="api_key"
        usageMode={undefined}
        t={t}
      />,
    );
    expect(screen.getByText('salesforce')).toBeDefined();
  });

  it('shows the custom_badge translation key when connector is undefined', () => {
    render(
      <ProfileConnectorBadges
        connector={undefined}
        authType="api_key"
        usageMode={undefined}
        t={t}
      />,
    );
    expect(screen.getByText('integrations.custom_badge')).toBeDefined();
  });

  it('shows the custom_badge translation key when connector is an empty string', () => {
    render(<ProfileConnectorBadges connector="" authType="bearer" usageMode={undefined} t={t} />);
    // Empty string is falsy — falls back to t(...)
    expect(screen.getByText('integrations.custom_badge')).toBeDefined();
  });
});

describe('ProfileConnectorBadges — usage-mode badge', () => {
  it('shows the usage-mode label for oauth2_app profiles with a known usageMode', () => {
    render(
      <ProfileConnectorBadges
        connector="salesforce"
        authType="oauth2_app"
        usageMode="preconfigured"
        t={t}
      />,
    );
    expect(screen.getByText('Preconfigured')).toBeDefined();
  });

  it('shows "JIT (Just-in-Time)" for jit usageMode', () => {
    render(
      <ProfileConnectorBadges connector={undefined} authType="oauth2_app" usageMode="jit" t={t} />,
    );
    expect(screen.getByText('JIT (Just-in-Time)')).toBeDefined();
  });

  it('falls back to the raw usageMode value when label is not in the options map', () => {
    render(
      <ProfileConnectorBadges
        connector={undefined}
        authType="oauth2_app"
        usageMode={'unknown_mode' as never}
        t={t}
      />,
    );
    expect(screen.getByText('unknown_mode')).toBeDefined();
  });

  it('does NOT render the usage-mode badge for non-oauth2_app profiles', () => {
    const { container } = render(
      <ProfileConnectorBadges
        connector="salesforce"
        authType="api_key"
        usageMode="preconfigured"
        t={t}
      />,
    );
    // Only the connector badge — no "Preconfigured" badge
    expect(screen.queryByText('Preconfigured')).toBeNull();
    const badges = container.querySelectorAll('span');
    expect(badges).toHaveLength(1);
  });

  it('does NOT render the usage-mode badge when usageMode is undefined, even for oauth2_app', () => {
    render(
      <ProfileConnectorBadges
        connector={undefined}
        authType="oauth2_app"
        usageMode={undefined}
        t={t}
      />,
    );
    // Only the connector (custom) badge — no usage-mode badge
    expect(screen.getByText('integrations.custom_badge')).toBeDefined();
    expect(screen.queryByText('Preconfigured')).toBeNull();
    expect(screen.queryByText('JIT (Just-in-Time)')).toBeNull();
  });
});
