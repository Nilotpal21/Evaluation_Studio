/**
 * InstallButton Component Tests
 *
 * Tests the install button for project vs agent template types,
 * disabled state when no version, and callback dispatching.
 *
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InstallButton } from '../../../components/marketplace/InstallButton';
import type {
  MarketplaceTemplate,
  MarketplaceTemplateVersion,
} from '../../../store/marketplace-store';

function makeTemplate(overrides?: Partial<MarketplaceTemplate>): MarketplaceTemplate {
  return {
    _id: 't1',
    slug: 'test-template',
    name: 'Test Template',
    shortDescription: 'A test',
    longDescription: 'A longer test description',
    type: 'project',
    typeMetadata: null,
    detailSections: [],
    category: 'general',
    subcategory: null,
    tags: [],
    complexity: 'starter',
    publisherId: 'pub1',
    publisherTenantId: 'platform',
    publisherName: 'Publisher',
    publisherVerified: false,
    installCount: 0,
    viewCount: 0,
    ratingAverage: 0,
    ratingCount: 0,
    featuredOrder: null,
    publishedAt: null,
    media: [],
    prerequisites: {
      envVars: [],
      connectors: [],
      mcpServers: [],
      authProfiles: [],
      models: [],
    },
    reviewStatus: 'approved',
    demoConversation: [],
    iconUrl: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeVersion(overrides?: Partial<MarketplaceTemplateVersion>): MarketplaceTemplateVersion {
  return {
    _id: 'v1',
    templateId: 't1',
    version: '1.0.0',
    changelog: '',
    manifest: null,
    customizationSchema: null,
    status: 'published',
    publishedAt: '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('InstallButton', () => {
  it('renders "Create Project from Template" for project type templates', () => {
    const template = makeTemplate({ type: 'project' });
    const version = makeVersion();

    render(
      <InstallButton
        template={template}
        version={version}
        onProjectInstall={vi.fn()}
        onAgentInstall={vi.fn()}
      />,
    );

    expect(screen.getByText('Create Project from Template')).toBeTruthy();
  });

  it('renders "Add to Project" for agent type templates', () => {
    const template = makeTemplate({ type: 'agent' });
    const version = makeVersion();

    render(
      <InstallButton
        template={template}
        version={version}
        onProjectInstall={vi.fn()}
        onAgentInstall={vi.fn()}
      />,
    );

    expect(screen.getByText('Add to Project')).toBeTruthy();
  });

  it('calls onProjectInstall when project button clicked', () => {
    const template = makeTemplate({ type: 'project' });
    const version = makeVersion();
    const onProjectInstall = vi.fn();
    const onAgentInstall = vi.fn();

    render(
      <InstallButton
        template={template}
        version={version}
        onProjectInstall={onProjectInstall}
        onAgentInstall={onAgentInstall}
      />,
    );

    fireEvent.click(screen.getByText('Create Project from Template'));

    expect(onProjectInstall).toHaveBeenCalledTimes(1);
    expect(onAgentInstall).not.toHaveBeenCalled();
  });

  it('calls onAgentInstall when agent button clicked', () => {
    const template = makeTemplate({ type: 'agent' });
    const version = makeVersion();
    const onProjectInstall = vi.fn();
    const onAgentInstall = vi.fn();

    render(
      <InstallButton
        template={template}
        version={version}
        onProjectInstall={onProjectInstall}
        onAgentInstall={onAgentInstall}
      />,
    );

    fireEvent.click(screen.getByText('Add to Project'));

    expect(onAgentInstall).toHaveBeenCalledTimes(1);
    expect(onProjectInstall).not.toHaveBeenCalled();
  });

  it('shows disabled state with message when no version available', () => {
    const template = makeTemplate({ type: 'project' });

    render(
      <InstallButton
        template={template}
        version={null}
        onProjectInstall={vi.fn()}
        onAgentInstall={vi.fn()}
      />,
    );

    // The button should be disabled
    const button = screen.getByRole('button');
    expect(button.getAttribute('disabled')).not.toBeNull();

    // Should show the "no version available" message
    expect(screen.getByText('No published version available')).toBeTruthy();
  });
});
