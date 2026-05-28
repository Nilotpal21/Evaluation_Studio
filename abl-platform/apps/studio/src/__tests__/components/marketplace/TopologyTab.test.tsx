/**
 * TopologyTab Component Tests
 *
 * Tests the topology display showing agents and tools from a template manifest.
 *
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TopologyTab } from '../../../components/marketplace/TopologyTab';
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

function makeVersion(
  manifest: Record<string, unknown> | null,
  overrides?: Partial<MarketplaceTemplateVersion>,
): MarketplaceTemplateVersion {
  return {
    _id: 'v1',
    templateId: 't1',
    version: '1.0.0',
    changelog: '',
    manifest,
    customizationSchema: null,
    status: 'published',
    publishedAt: '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('TopologyTab', () => {
  it('renders agents list from manifest', () => {
    const template = makeTemplate();
    const version = makeVersion({
      agents: {
        greeter: { description: 'Greets users' },
        resolver: { description: 'Resolves issues' },
      },
      tools: {},
    });

    render(<TopologyTab template={template} version={version} />);

    expect(screen.getByText('greeter')).toBeTruthy();
    expect(screen.getByText('Greets users')).toBeTruthy();
    expect(screen.getByText('resolver')).toBeTruthy();
    expect(screen.getByText('Resolves issues')).toBeTruthy();
    // Agent count badge
    expect(screen.getByText('(2)')).toBeTruthy();
  });

  it('renders tools list from manifest', () => {
    const template = makeTemplate();
    const version = makeVersion({
      agents: {},
      tools: {
        'search-kb': { path: './tools/search-kb.ts' },
        'send-email': { path: './tools/send-email.ts' },
      },
    });

    render(<TopologyTab template={template} version={version} />);

    expect(screen.getByText('search-kb')).toBeTruthy();
    expect(screen.getByText('send-email')).toBeTruthy();
  });

  it('shows "Entry" badge for entry agent', () => {
    const template = makeTemplate();
    const version = makeVersion({
      entry_agent: 'greeter',
      agents: {
        greeter: { description: 'The entry point' },
        helper: { description: 'A helper' },
      },
      tools: {},
    });

    render(<TopologyTab template={template} version={version} />);

    expect(screen.getByText('Entry')).toBeTruthy();
  });

  it('shows fallback summary when no manifest agents', () => {
    const template = makeTemplate({
      typeMetadata: { agentCount: 3, hasSupervisor: true, hasFlow: true },
    });
    // version with no agents in manifest (null manifest)
    const version = makeVersion(null);

    render(<TopologyTab template={template} version={version} />);

    // Should show the fallback summary from typeMetadata
    expect(screen.getByText(/3 agents/)).toBeTruthy();
    expect(screen.getByText(/includes supervisor/)).toBeTruthy();
  });

  it('shows "No agents" message when manifest has empty agents', () => {
    const template = makeTemplate();
    const version = makeVersion({
      agents: {},
      tools: {},
    });

    render(<TopologyTab template={template} version={version} />);

    expect(screen.getByText('No agent information available')).toBeTruthy();
  });

  it('shows "No tools" message when manifest has empty tools', () => {
    const template = makeTemplate();
    const version = makeVersion({
      agents: { bot: { description: 'A bot' } },
      tools: {},
    });

    render(<TopologyTab template={template} version={version} />);

    expect(screen.getByText('No tool information available')).toBeTruthy();
  });
});
