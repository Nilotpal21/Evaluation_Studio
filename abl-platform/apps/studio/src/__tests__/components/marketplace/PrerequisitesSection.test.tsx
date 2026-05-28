/**
 * PrerequisitesSection Component Tests
 *
 * Tests the prerequisites display component with various combinations
 * of environment variables, connectors, models, etc.
 *
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PrerequisitesSection } from '../../../components/marketplace/PrerequisitesSection';
import type { TemplatePrerequisites } from '@/store/marketplace-store';

const emptyPrerequisites: TemplatePrerequisites = {
  envVars: [],
  connectors: [],
  mcpServers: [],
  authProfiles: [],
  models: [],
};

describe('PrerequisitesSection', () => {
  it('renders env vars section with Key icon when envVars non-empty', () => {
    const prerequisites: TemplatePrerequisites = {
      ...emptyPrerequisites,
      envVars: ['OPENAI_API_KEY', 'DATABASE_URL'],
    };
    render(<PrerequisitesSection prerequisites={prerequisites} />);

    // Should render the env vars label
    expect(screen.getByText('Required Environment Variables')).toBeTruthy();
    // Should render the env var items
    expect(screen.getByText('OPENAI_API_KEY')).toBeTruthy();
    expect(screen.getByText('DATABASE_URL')).toBeTruthy();
    // Key icon should be rendered (lucide stub)
    expect(document.querySelector('[data-testid="icon-key"]')).toBeTruthy();
  });

  it('renders connectors section when connectors non-empty', () => {
    const prerequisites: TemplatePrerequisites = {
      ...emptyPrerequisites,
      connectors: ['Slack', 'GitHub'],
    };
    render(<PrerequisitesSection prerequisites={prerequisites} />);

    expect(screen.getByText('Required Connectors')).toBeTruthy();
    expect(screen.getByText('Slack')).toBeTruthy();
    expect(screen.getByText('GitHub')).toBeTruthy();
    // Plug icon should be rendered
    expect(document.querySelector('[data-testid="icon-plug"]')).toBeTruthy();
  });

  it('renders models section when models non-empty', () => {
    const prerequisites: TemplatePrerequisites = {
      ...emptyPrerequisites,
      models: ['gpt-4o', 'claude-3-opus'],
    };
    render(<PrerequisitesSection prerequisites={prerequisites} />);

    expect(screen.getByText('Required Models')).toBeTruthy();
    expect(screen.getByText('gpt-4o')).toBeTruthy();
    expect(screen.getByText('claude-3-opus')).toBeTruthy();
    // Cpu icon should be rendered
    expect(document.querySelector('[data-testid="icon-cpu"]')).toBeTruthy();
  });

  it('renders no-prerequisites message when all arrays are empty', () => {
    render(<PrerequisitesSection prerequisites={emptyPrerequisites} />);

    // The i18n key prerequisites.noPrerequisites resolves to this text
    expect(screen.getByText(/no prerequisites/i)).toBeTruthy();
  });

  it('only renders non-empty categories', () => {
    const prerequisites: TemplatePrerequisites = {
      envVars: ['API_KEY'],
      connectors: [],
      mcpServers: [],
      authProfiles: [],
      models: ['gpt-4o'],
    };
    render(<PrerequisitesSection prerequisites={prerequisites} />);

    // Should render env vars and models
    expect(screen.getByText('Required Environment Variables')).toBeTruthy();
    expect(screen.getByText('Required Models')).toBeTruthy();
    expect(screen.getByText('API_KEY')).toBeTruthy();
    expect(screen.getByText('gpt-4o')).toBeTruthy();

    // Should NOT render connectors, mcp servers, or auth profiles
    expect(screen.queryByText('Required Connectors')).toBeNull();
    expect(screen.queryByText('Required MCP Servers')).toBeNull();
    expect(screen.queryByText('Required Auth Profiles')).toBeNull();
  });
});
