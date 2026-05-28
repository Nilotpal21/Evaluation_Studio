/**
 * ProjectInstallDialog Component Tests
 *
 * Tests the project install dialog states: idle form, loading, success, error.
 * Uses store.setState() to control the marketplace store's install state.
 *
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProjectInstallDialog } from '../../../components/marketplace/ProjectInstallDialog';
import { useMarketplaceStore } from '../../../store/marketplace-store';
import type {
  MarketplaceTemplate,
  MarketplaceTemplateVersion,
} from '../../../store/marketplace-store';

// Mock apiFetch — external API boundary
vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn(),
}));

// Mock the template-install API — external API boundary
vi.mock('@/api/template-install', () => ({
  installProjectTemplate: vi.fn(),
  previewAgentInstall: vi.fn(),
  applyAgentInstall: vi.fn(),
}));

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

describe('ProjectInstallDialog', () => {
  beforeEach(() => {
    useMarketplaceStore.setState({
      installLoading: false,
      installError: null,
      installResult: null,
    });
  });

  it('renders dialog with project name input in idle state', () => {
    const template = makeTemplate({ name: 'My Template' });
    const version = makeVersion();

    render(
      <ProjectInstallDialog
        open={true}
        onClose={vi.fn()}
        template={template}
        version={version}
        onInstallComplete={vi.fn()}
      />,
    );

    // Dialog title
    expect(screen.getByText('Create Project from Template')).toBeTruthy();
    // Project name input should be pre-populated with template name
    const input = document.querySelector('input');
    expect(input).toBeTruthy();
    expect(input?.value).toBe('My Template');
  });

  it('submit button is disabled when name is empty', () => {
    const template = makeTemplate({ name: '' });
    const version = makeVersion();

    render(
      <ProjectInstallDialog
        open={true}
        onClose={vi.fn()}
        template={template}
        version={version}
        onInstallComplete={vi.fn()}
      />,
    );

    // The "Create & Install" button should be disabled
    const buttons = screen.getAllByRole('button');
    const submitButton = buttons.find((b) => b.textContent?.includes('Create & Install'));
    expect(submitButton).toBeTruthy();
    expect(submitButton?.getAttribute('disabled')).not.toBeNull();
  });

  it('shows loading state during installation', () => {
    const template = makeTemplate();
    const version = makeVersion();

    useMarketplaceStore.setState({
      installLoading: true,
      installError: null,
      installResult: null,
    });

    render(
      <ProjectInstallDialog
        open={true}
        onClose={vi.fn()}
        template={template}
        version={version}
        onInstallComplete={vi.fn()}
      />,
    );

    expect(screen.getByText('Installing template...')).toBeTruthy();
  });

  it('shows error state on failure', () => {
    const template = makeTemplate();
    const version = makeVersion();

    useMarketplaceStore.setState({
      installLoading: false,
      installError: 'Something went wrong',
      installResult: null,
    });

    render(
      <ProjectInstallDialog
        open={true}
        onClose={vi.fn()}
        template={template}
        version={version}
        onInstallComplete={vi.fn()}
      />,
    );

    expect(screen.getByText('Installation failed')).toBeTruthy();
    expect(screen.getByText('Something went wrong')).toBeTruthy();
    // Should show Retry button
    expect(screen.getByText('Retry')).toBeTruthy();
  });

  it('shows success state with "Go to Project" button', () => {
    const template = makeTemplate();
    const version = makeVersion();

    useMarketplaceStore.setState({
      installLoading: false,
      installError: null,
      installResult: {
        project: { id: 'proj-1', name: 'My Project', slug: 'my-project' },
        applied: {
          created: 2,
          updated: 0,
          deleted: 0,
          toolsCreated: 3,
          toolsUpdated: 0,
          toolsDeleted: 0,
          localesCreated: 0,
          localesUpdated: 0,
          localesDeleted: 0,
          profilesCreated: 0,
          profilesUpdated: 0,
          profilesDeleted: 0,
          evalsCreated: 0,
          evalsUpdated: 0,
          evalsDeleted: 0,
          modelPoliciesUpserted: 0,
          modelPoliciesDeleted: 0,
        },
        entryAgentName: 'greeter',
        provisioningRequired: {
          envVars: [],
          connectors: [],
          mcpServers: [],
          authProfiles: [],
        },
      },
    });

    render(
      <ProjectInstallDialog
        open={true}
        onClose={vi.fn()}
        template={template}
        version={version}
        onInstallComplete={vi.fn()}
      />,
    );

    expect(screen.getByText('Template installed successfully')).toBeTruthy();
    expect(screen.getByText('Go to Project')).toBeTruthy();
  });

  it('calls onInstallComplete when "Go to Project" clicked in success state', () => {
    const template = makeTemplate();
    const version = makeVersion();
    const onInstallComplete = vi.fn();

    useMarketplaceStore.setState({
      installLoading: false,
      installError: null,
      installResult: {
        project: { id: 'proj-1', name: 'My Project', slug: 'my-project' },
        applied: {
          created: 1,
          updated: 0,
          deleted: 0,
          toolsCreated: 0,
          toolsUpdated: 0,
          toolsDeleted: 0,
          localesCreated: 0,
          localesUpdated: 0,
          localesDeleted: 0,
          profilesCreated: 0,
          profilesUpdated: 0,
          profilesDeleted: 0,
          evalsCreated: 0,
          evalsUpdated: 0,
          evalsDeleted: 0,
          modelPoliciesUpserted: 0,
          modelPoliciesDeleted: 0,
        },
        entryAgentName: null,
        provisioningRequired: {
          envVars: [],
          connectors: [],
          mcpServers: [],
          authProfiles: [],
        },
      },
    });

    render(
      <ProjectInstallDialog
        open={true}
        onClose={vi.fn()}
        template={template}
        version={version}
        onInstallComplete={onInstallComplete}
      />,
    );

    fireEvent.click(screen.getByText('Go to Project'));
    expect(onInstallComplete).toHaveBeenCalledWith('proj-1');
  });
});
