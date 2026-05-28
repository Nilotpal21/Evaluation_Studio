import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { StatusSection } from '../../components/settings/GitIntegrationTab';

const mockFetchGitStatus = vi.fn();

vi.mock('../../api/project-io', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/project-io')>();
  return {
    ...actual,
    fetchGitStatus: (...args: unknown[]) => mockFetchGitStatus(...args),
  };
});

const messages = {
  settings: {
    git: {
      local_state: 'Local State',
      local_agents: 'Local Agents',
      locale_assets: 'Locale Assets',
      git_managed_layers: 'Git-managed Layers',
      optional_layers: 'Available but Off by Default',
      optional_layers_hint:
        'These layers contain local data, but the default git sync does not include them.',
      entity_count: '{count} {count, plural, one {entity} other {entities}}',
      scope_shared: 'Shared',
      scope_agent: 'Agent',
    },
  },
};

function renderStatus() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <StatusSection projectId="project-1" syncKey={0} />
    </NextIntlClientProvider>,
  );
}

describe('StatusSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchGitStatus.mockResolvedValue({
      integration: {
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support-ops',
        defaultBranch: 'main',
        lastSyncAt: null,
        lastSyncCommit: null,
        lastSyncStatus: 'success',
      },
      defaultLayers: ['core', 'connections', 'guardrails', 'workflows'],
      localLayers: [
        { name: 'core', defaultMode: 'always', entityCount: 4 },
        { name: 'connections', defaultMode: 'always', entityCount: 2 },
        { name: 'guardrails', defaultMode: 'on', entityCount: 1 },
        { name: 'workflows', defaultMode: 'on', entityCount: 0 },
        { name: 'evals', defaultMode: 'off', entityCount: 3 },
      ],
      localAgents: [
        {
          name: 'support_agent',
          sourceHash: 'hash-support',
          lastEditedAt: '2026-05-02T10:00:00.000Z',
        },
      ],
      localLocaleFiles: [
        {
          id: 'locale-1',
          relativePath: 'en/shared.json',
          filePath: 'locales/en/shared.json',
          localeCode: 'en',
          scope: 'shared',
          updatedAt: '2026-05-02T10:05:00.000Z',
        },
      ],
      message: 'Status shows canonical git-managed local state.',
    });
  });

  it('renders tracked git layers and highlights populated off-by-default layers', async () => {
    renderStatus();

    await waitFor(() => {
      expect(screen.getByText('Git-managed Layers')).toBeDefined();
    });

    expect(screen.getByText('Core')).toBeDefined();
    expect(screen.getByText('Connections')).toBeDefined();
    expect(screen.getByText('Guardrails')).toBeDefined();
    expect(screen.getByText('Available but Off by Default')).toBeDefined();
    expect(screen.getByText('Evals')).toBeDefined();
    expect(
      screen.getByText(
        'These layers contain local data, but the default git sync does not include them.',
      ),
    ).toBeDefined();
    expect(screen.getByText('Local Agents')).toBeDefined();
    expect(screen.getByText('Locale Assets')).toBeDefined();
  });

  it('does not render the off-by-default section when optional layers are empty', async () => {
    mockFetchGitStatus.mockResolvedValueOnce({
      integration: {
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support-ops',
        defaultBranch: 'main',
        lastSyncAt: null,
        lastSyncCommit: null,
        lastSyncStatus: 'success',
      },
      defaultLayers: ['core'],
      localLayers: [{ name: 'core', defaultMode: 'always', entityCount: 1 }],
      localAgents: [],
      localLocaleFiles: [],
      message: 'Status shows canonical git-managed local state.',
    });

    renderStatus();

    await waitFor(() => {
      expect(screen.getByText('Git-managed Layers')).toBeDefined();
    });

    expect(screen.queryByText('Available but Off by Default')).toBeNull();
  });
});
