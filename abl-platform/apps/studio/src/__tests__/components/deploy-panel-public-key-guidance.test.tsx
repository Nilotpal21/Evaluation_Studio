/**
 * @vitest-environment happy-dom
 */

import React from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { getTranslator } = vi.hoisted(() => {
  const messages = {
    deploy: {
      panel: {
        title: 'Deploy Widget',
        subtitle: 'Embed {projectName} on your website',
        tab_embed: 'Embed Code',
        tab_keys: 'Public Keys',
        tab_settings: 'Settings',
        load_widget_error: 'Failed to load widget',
      },
      embed_tab: {
        no_key_title: 'No Public Key Found',
        no_key_description: 'Create a public SDK key to generate your embed code',
        create_api_key: 'Create Public Key',
        chat_label: 'Chat',
        voice_label: 'Voice',
        enabled: 'Enabled',
        disabled: 'Disabled',
        mode_label: 'Mode',
        mode_chat: 'Chat',
        position_label: 'Position',
        position_bottom_right: 'Bottom Right',
        embed_code_title: 'Embed Code',
        copy: 'Copy',
        copied: 'Copied!',
        embed_channel_binding_help:
          'Set a default SDK channel in Settings, or use a channel-specific deploy surface when a project has multiple active SDK channels.',
        replace_key_hint: 'Replace YOUR_PUBLIC_API_KEY with your actual public key',
        quick_start_title: 'Quick Start',
        quick_start_step1: '1. Copy the embed code above',
        quick_start_step2:
          '2. Replace the placeholder with your public key from the "Public Keys" tab',
        quick_start_step3_prefix: '3. Paste the code before the closing',
        quick_start_step3_suffix: 'tag',
        quick_start_step4: '4. The widget will appear on your site automatically',
        auth_model_title: 'Authentication Model',
        auth_model_description:
          'Anonymous/public-key bootstrap lets the browser exchange a public SDK key for a short-lived Runtime session token.',
        browser_storage_title: 'Browser / client app',
        browser_storage_description:
          'Store the raw `pk_*` key, Runtime endpoint, and selected SDK channel here.',
        server_storage_title: 'Customer backend',
        server_storage_description: 'No ABL secret is required for anonymous mode.',
        security_title: 'Security disclaimers',
        security_public: 'The `pk_*` key is publishable. It is not a backend secret.',
        security_identity: 'This mode authenticates app bootstrap, not the end user.',
        security_origins:
          'Protect production usage with allowed origins and separate keys per environment.',
        secure_preview_title: 'Secure Preview Link',
        generating: 'Generating...',
        generate_link: 'Generate Link',
        copy_link: 'Copy Link',
        preview_description:
          'Generate a secure, time-limited link to share with users. The link expires after 7 days.',
        preview_expires: 'Share this secure link with users. It expires on {date}.',
        generate_new_link: 'Generate new link',
        voice_preview_title: 'Voice Preview (LiveKit)',
        livekit_not_configured:
          'LiveKit is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, and FEATURE_LIVEKIT_ENABLED=true on the runtime server.',
        voice_preview_description:
          'Generate a secure, time-limited link to share the voice preview. The link expires after 7 days.',
        voice_preview_expires: 'Share this voice preview link. It expires on {date}.',
      },
      keys_tab: {
        key_count: '{count, plural, one {# public key} other {# public keys}}',
        new_key: 'New Public Key',
        key_created_title: 'Public key "{name}" created successfully',
        key_created_warning:
          'Copy this public key now. It is safe for browser use, but you will not be able to see it again.',
        no_keys_title: 'No Public Keys',
        no_keys_description:
          'Create a public SDK key to bootstrap browser sessions for your widget',
        inactive: 'Inactive',
        created_date: 'Created {date}',
        last_used_date: 'Last used {date}',
        chat_label: 'Chat enabled',
        voice_label: 'Voice enabled',
        origins_title: 'Origins: {origins}',
        delete_key: 'Delete key',
        delete_confirm:
          'Delete this public key? This cannot be undone and may break existing integrations.',
        public_key_setup_title: 'Anonymous/Public-key setup',
        public_key_setup_description:
          'Use a public SDK key in browser code to bootstrap short-lived Runtime sessions.',
        browser_storage_title: 'Browser / client app',
        browser_storage_description:
          'Store the raw `pk_*` key, Runtime endpoint, and selected SDK channel here.',
        server_storage_title: 'Customer backend',
        server_storage_description:
          'Anonymous mode does not require any ABL secret or server-side signing.',
        security_title: 'Security disclaimers',
        security_public: 'The `pk_*` key is publishable. It is not a backend secret.',
        security_identity: 'This mode authenticates app bootstrap, not the end user.',
        security_origins:
          'Set allowed origins before go-live and use separate keys per environment.',
      },
      create_key_modal: {
        title: 'Create Public Key',
        name_label: 'Name',
        name_placeholder: 'e.g., Production Widget',
        security_title: 'Before you create this key',
        security_description:
          'Anonymous/public-key bootstrap is designed for browser and client-side SDK use.',
        browser_storage_title: 'Browser / client app',
        browser_storage_description:
          'Store the raw `pk_*` key in client configuration or frontend environment variables.',
        server_storage_title: 'Customer backend',
        server_storage_description:
          'No ABL secret is required on the customer server for anonymous mode.',
        security_warning_title: 'Security disclaimers',
        security_warning_public: 'This key is publishable and may ship in browser code.',
        security_warning_identity: 'It does not verify the end user.',
        security_warning_origins: 'Restrict allowed origins before using it in production.',
        permissions_label: 'Permissions',
        chat_label: 'Chat',
        voice_label: 'Voice',
        allowed_origins_label: 'Allowed Origins',
        allowed_origins_optional: '(optional)',
        origins_placeholder: 'https://example.com\nhttps://*.example.com',
        origins_hint: 'One URL per line. Supports wildcards. Recommended for every production key.',
        cancel: 'Cancel',
        creating: 'Creating...',
        create_key: 'Create Public Key',
        create_failed: 'Failed to create key',
      },
    },
  };

  const cache = new Map();

  const getNestedValue = (obj: Record<string, unknown>, keyPath: string): unknown => {
    return keyPath.split('.').reduce<unknown>((current, segment) => {
      if (!current || typeof current !== 'object') {
        return undefined;
      }
      return (current as Record<string, unknown>)[segment];
    }, obj);
  };

  const format = (template: string, params?: Record<string, unknown>) => {
    if (!params) {
      return template;
    }
    return template.replace(/\{(\w+)\}/g, (match, key) => {
      return params[key] !== undefined ? String(params[key]) : match;
    });
  };

  const getTranslator = (namespace = '') => {
    if (!cache.has(namespace)) {
      cache.set(namespace, (key: string, params?: Record<string, unknown>) => {
        const value = getNestedValue(messages, namespace ? `${namespace}.${key}` : key);
        return typeof value === 'string' ? format(value, params) : `${namespace}.${key}`;
      });
    }
    return cache.get(namespace);
  };

  return { getTranslator };
});

vi.mock('next-intl', () => ({
  useTranslations: (namespace?: string) => getTranslator(namespace),
}));

vi.mock('lucide-react', () => {
  const Icon = (props: React.ComponentProps<'span'>) => <span aria-hidden="true" {...props} />;
  return {
    Code: Icon,
    Key: Icon,
    Copy: Icon,
    Check: Icon,
    RefreshCw: Icon,
    Trash2: Icon,
    Plus: Icon,
    Settings: Icon,
    Mic: Icon,
    MessageSquare: Icon,
    Globe: Icon,
    Lock: Icon,
    ExternalLink: Icon,
    Eye: Icon,
    EyeOff: Icon,
    AlertCircle: Icon,
  };
});

vi.mock('../../store/auth-store', () => ({
  useAuthStore: Object.assign(
    (selector?: (state: { accessToken: string }) => unknown) => {
      const state = { accessToken: 'test-token' };
      return selector ? selector(state) : state;
    },
    { getState: () => ({ accessToken: 'test-token' }) },
  ),
}));

const mockFetch = vi.fn();

const activeKey = {
  id: 'key_1',
  keyPrefix: 'pk_12345678',
  name: 'Production Website',
  allowedOrigins: ['https://app.example.com'],
  permissions: { chat: true, voice: false },
  isActive: true,
  lastUsedAt: null,
  createdAt: '2026-04-09T00:00:00.000Z',
  expiresAt: null,
};

const widgetConfig = {
  channelId: 'sdk_1',
  mode: 'chat',
  position: 'bottom-right',
  welcomeMessage: null,
  placeholderText: null,
  voiceEnabled: false,
  chatEnabled: true,
  showActivityUpdates: false,
  theme: {},
};

describe('DeployPanel public key guidance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('/api/sdk/keys?projectId=')) {
        return new Response(JSON.stringify({ keys: [activeKey] }), { status: 200 });
      }

      if (url.includes('/api/sdk/widget/')) {
        return new Response(JSON.stringify(widgetConfig), { status: 200 });
      }

      if (url.includes('/api/sdk/embed/')) {
        return new Response(JSON.stringify({ snippet: '<script>window.agent = 1;</script>' }), {
          status: 200,
        });
      }

      if (url.includes('/api/livekit/capabilities')) {
        return new Response(JSON.stringify({ configured: false }), { status: 200 });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal('fetch', mockFetch);
  });

  test('shows browser/server storage guidance and security disclaimers across deploy surfaces', async () => {
    const { DeployPanel } = await import('../../components/deploy/DeployPanel');

    render(<DeployPanel projectId="proj_1" projectName="Acme Support" />);

    await screen.findByText('Authentication Model');
    expect(screen.getByText('Browser / client app')).toBeInTheDocument();
    expect(screen.getByText('Customer backend')).toBeInTheDocument();
    expect(
      screen.getByText('The `pk_*` key is publishable. It is not a backend secret.'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Public Keys/ }));

    await screen.findByText('Anonymous/Public-key setup');
    expect(
      screen.getByText('Anonymous mode does not require any ABL secret or server-side signing.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New Public Key' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'New Public Key' }));

    await screen.findByRole('heading', { name: 'Create Public Key' });
    expect(screen.getByText('Before you create this key')).toBeInTheDocument();
    expect(
      screen.getByText('No ABL secret is required on the customer server for anonymous mode.'),
    ).toBeInTheDocument();
  });

  test('renames the deploy tab to Public Keys', async () => {
    const { DeployPanel } = await import('../../components/deploy/DeployPanel');

    render(<DeployPanel projectId="proj_1" projectName="Acme Support" />);

    await waitFor(() => expect(screen.getByRole('button', { name: /Public Keys/ })).toBeVisible());
  });

  test('hides a revoked key after delete refresh returns it as inactive', async () => {
    let currentKeys = [{ ...activeKey }];

    mockFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.includes('/api/sdk/keys?projectId=')) {
        return new Response(JSON.stringify({ keys: currentKeys }), { status: 200 });
      }

      if (url.includes('/api/sdk/keys/key_1') && init?.method === 'DELETE') {
        currentKeys = [{ ...activeKey, isActive: false }];
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }

      if (url.includes('/api/sdk/widget/')) {
        return new Response(JSON.stringify(widgetConfig), { status: 200 });
      }

      if (url.includes('/api/sdk/embed/')) {
        return new Response(JSON.stringify({ snippet: '<script>window.agent = 1;</script>' }), {
          status: 200,
        });
      }

      if (url.includes('/api/livekit/capabilities')) {
        return new Response(JSON.stringify({ configured: false }), { status: 200 });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    const { DeployPanel } = await import('../../components/deploy/DeployPanel');

    render(<DeployPanel projectId="proj_1" projectName="Acme Support" />);

    fireEvent.click(await screen.findByRole('button', { name: /Public Keys/ }));
    await screen.findByText('Production Website');

    fireEvent.click(screen.getByTitle('Delete key'));

    await waitFor(() => expect(screen.getByText('No Public Keys')).toBeInTheDocument());
    expect(screen.queryByText('Production Website')).not.toBeInTheDocument();
  });
});
