/**
 * AgentInstallPreviewDialog Component Tests
 *
 * Tests the agent install preview dialog phases: loading-preview, preview-ready,
 * applying, success, and error.
 *
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentInstallPreviewDialog } from '../../../components/marketplace/AgentInstallPreviewDialog';
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
    type: 'agent',
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

describe('AgentInstallPreviewDialog', () => {
  beforeEach(() => {
    useMarketplaceStore.setState({
      agentPreview: null,
      agentPreviewLoading: false,
      agentPreviewError: null,
      installLoading: false,
      installError: null,
      installResult: null,
      // Override store actions to no-ops so the useEffect doesn't
      // trigger real API calls or reset state we set in each test
      previewAgentInstall: vi.fn(),
      resetInstallState: vi.fn(),
      applyAgentInstall: vi.fn(),
    });
  });

  it('shows loading state when generating preview', () => {
    useMarketplaceStore.setState({
      agentPreviewLoading: true,
    });

    render(
      <AgentInstallPreviewDialog
        open={true}
        onClose={vi.fn()}
        template={makeTemplate()}
        version={makeVersion()}
        projectId="proj-1"
        projectName="My Project"
        onInstallComplete={vi.fn()}
      />,
    );

    expect(screen.getByText('Generating preview...')).toBeTruthy();
  });

  it('renders preview information with agents and tools to add', () => {
    useMarketplaceStore.setState({
      agentPreviewLoading: false,
      agentPreviewError: null,
      agentPreview: {
        preview: {
          layers: [],
          agentChanges: {
            added: ['greeter', 'resolver'],
            modified: [],
            removed: [],
            unchanged: [],
          },
          toolChanges: {
            added: ['search-kb'],
            modified: [],
            removed: [],
          },
          issues: [],
          hasBlockingIssues: false,
          previewDigest: 'abc123',
          entryAgentResolution: { resolved: 'greeter' },
        },
        previewDigest: 'abc123',
        warnings: [],
      },
    });

    render(
      <AgentInstallPreviewDialog
        open={true}
        onClose={vi.fn()}
        template={makeTemplate()}
        version={makeVersion()}
        projectId="proj-1"
        projectName="My Project"
        onInstallComplete={vi.fn()}
      />,
    );

    // Target project name
    expect(screen.getByText('My Project')).toBeTruthy();
    // Agents to add
    expect(screen.getByText('2 agents will be added')).toBeTruthy();
    expect(screen.getByText('greeter')).toBeTruthy();
    expect(screen.getByText('resolver')).toBeTruthy();
    // Tools to add
    expect(screen.getByText('1 tool will be added')).toBeTruthy();
    expect(screen.getByText('search-kb')).toBeTruthy();
    // Confirm button
    expect(screen.getByText('Install')).toBeTruthy();
  });

  it('shows confirm button that calls applyAgentInstall', () => {
    const applyAgentInstall = vi.fn();
    useMarketplaceStore.setState({
      agentPreviewLoading: false,
      agentPreview: {
        preview: {
          layers: [],
          agentChanges: { added: ['bot'], modified: [], removed: [], unchanged: [] },
          toolChanges: { added: [], modified: [], removed: [] },
          issues: [],
          hasBlockingIssues: false,
          previewDigest: 'digest-1',
          entryAgentResolution: { resolved: null },
        },
        previewDigest: 'digest-1',
        warnings: [],
      },
      applyAgentInstall,
    });

    render(
      <AgentInstallPreviewDialog
        open={true}
        onClose={vi.fn()}
        template={makeTemplate({ slug: 'tpl-slug' })}
        version={makeVersion({ version: '2.0.0' })}
        projectId="proj-1"
        projectName="My Project"
        onInstallComplete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('Install'));
    expect(applyAgentInstall).toHaveBeenCalledWith('proj-1', 'tpl-slug', '2.0.0', 'digest-1');
  });

  it('shows loading state during install', () => {
    useMarketplaceStore.setState({
      agentPreviewLoading: false,
      agentPreview: {
        preview: {
          layers: [],
          agentChanges: { added: [], modified: [], removed: [], unchanged: [] },
          toolChanges: { added: [], modified: [], removed: [] },
          issues: [],
          hasBlockingIssues: false,
          previewDigest: null,
          entryAgentResolution: { resolved: null },
        },
        previewDigest: null,
        warnings: [],
      },
      installLoading: true,
    });

    render(
      <AgentInstallPreviewDialog
        open={true}
        onClose={vi.fn()}
        template={makeTemplate()}
        version={makeVersion()}
        projectId="proj-1"
        projectName="My Project"
        onInstallComplete={vi.fn()}
      />,
    );

    expect(screen.getByText('Applying template...')).toBeTruthy();
  });

  it('shows cancel button that calls onClose', () => {
    const onClose = vi.fn();

    useMarketplaceStore.setState({
      agentPreviewLoading: false,
      agentPreview: {
        preview: {
          layers: [],
          agentChanges: { added: ['bot'], modified: [], removed: [], unchanged: [] },
          toolChanges: { added: [], modified: [], removed: [] },
          issues: [],
          hasBlockingIssues: false,
          previewDigest: null,
          entryAgentResolution: { resolved: null },
        },
        previewDigest: null,
        warnings: [],
      },
    });

    render(
      <AgentInstallPreviewDialog
        open={true}
        onClose={onClose}
        template={makeTemplate()}
        version={makeVersion()}
        projectId="proj-1"
        projectName="My Project"
        onInstallComplete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows error state with retry button', () => {
    useMarketplaceStore.setState({
      agentPreviewLoading: false,
      agentPreviewError: 'Preview generation failed',
      agentPreview: null,
    });

    render(
      <AgentInstallPreviewDialog
        open={true}
        onClose={vi.fn()}
        template={makeTemplate()}
        version={makeVersion()}
        projectId="proj-1"
        projectName="My Project"
        onInstallComplete={vi.fn()}
      />,
    );

    expect(screen.getByText('Installation failed')).toBeTruthy();
    expect(screen.getByText('Preview generation failed')).toBeTruthy();
    expect(screen.getByText('Retry')).toBeTruthy();
  });
});
