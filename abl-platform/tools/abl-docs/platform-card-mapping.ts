import type { CardMappingEntry } from './card-mapping.js';

/**
 * Platform knowledge card mappings — auto-generated from docs-internal MDX.
 *
 * These cards cover operational features (channels, deployments, auth, etc.)
 * as opposed to the ABL language cards in card-mapping.ts.
 *
 * Higher maxTokens (2500) than ABL cards (800) because platform features
 * need more context (credential fields, API endpoints, lifecycle states).
 */
export const PLATFORM_CARD_MAPPINGS: CardMappingEntry[] = [
  // ═══════════════════════════════════════════════════════════════
  // Channels
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'channels-overview',
    exportName: 'CHANNELS_OVERVIEW_CARD',
    title: 'Channels — Types, Categories & Capabilities',
    maxTokens: 2500,
    sources: [
      {
        file: 'guides/channels.mdx',
        sections: ['Deploy on Web', 'Set Up Slack', 'Set Up WhatsApp', 'Set Up Voice'],
      },
    ],
  },
  {
    id: 'channels-messaging',
    exportName: 'CHANNELS_MESSAGING_CARD',
    title: 'Messaging Channels — Slack, WhatsApp, Teams, Telegram',
    maxTokens: 2500,
    sources: [
      {
        file: 'guides/channels.mdx',
        sections: [
          'Set Up Slack',
          'Set Up WhatsApp',
          'Rich Content',
          'Slack with Threaded Replies',
          'Multi-Workspace Slack App',
        ],
      },
    ],
  },
  {
    id: 'channels-voice',
    exportName: 'CHANNELS_VOICE_CARD',
    title: 'Voice Channels — S2S, Pipeline, VXML, AudioCodes',
    maxTokens: 2500,
    sources: [{ file: 'guides/channels.mdx', sections: ['Set Up Voice'] }],
  },
  {
    id: 'channels-sdk',
    exportName: 'CHANNELS_SDK_CARD',
    title: 'SDK Channels — Web, Mobile, API',
    maxTokens: 2500,
    sources: [
      {
        file: 'api-reference/sdks.mdx',
        sections: [
          'Web SDK',
          'Installation',
          'Quick start',
          'AgentSDK',
          'ChatClient',
          'VoiceClient',
          'React hooks',
          'Styling and theming',
          'API key management',
        ],
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════
  // Deployments
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'deployments-lifecycle',
    exportName: 'DEPLOYMENTS_LIFECYCLE_CARD',
    title: 'Deployments — Environments, Versioning, Promotion',
    maxTokens: 2500,
    sources: [
      {
        file: 'guides/publishing-and-operations.mdx',
        sections: ['Publish an Agent', 'Set Up Environments'],
      },
      { file: 'api-reference/management-apis.mdx', sections: ['Deployments'] },
    ],
  },

  // ═══════════════════════════════════════════════════════════════
  // Auth Profiles
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'auth-profiles',
    exportName: 'AUTH_PROFILES_CARD',
    title: 'Auth Profiles — Types, Credentials, OAuth Flows',
    maxTokens: 2500,
    sources: [
      {
        file: 'admin/security-and-authentication.mdx',
        sections: ['Authentication for Integrations'],
      },
      { file: 'guides/tools-and-integrations.mdx', sections: ['OAuth Configuration'] },
    ],
  },

  // ═══════════════════════════════════════════════════════════════
  // Connections & Integrations
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'connections-integrations',
    exportName: 'CONNECTIONS_INTEGRATIONS_CARD',
    title: 'Connections — Connector Catalog & Integration Wiring',
    maxTokens: 2500,
    sources: [
      { file: 'studio/tools-knowledge-connections.mdx', sections: ['Connections', 'Workflows'] },
    ],
  },

  // ═══════════════════════════════════════════════════════════════
  // Knowledge Bases
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'kb-administration',
    exportName: 'KB_ADMINISTRATION_CARD',
    title: 'Knowledge Bases — Creation, Ingestion, Connectors, Search',
    maxTokens: 2500,
    sources: [{ file: 'guides/knowledge-bases.mdx' }],
  },

  // ═══════════════════════════════════════════════════════════════
  // Workflows
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'workflows-authoring',
    exportName: 'WORKFLOWS_AUTHORING_CARD',
    title: 'Workflows — Nodes, Triggers, Execution, Approvals',
    maxTokens: 2500,
    sources: [
      { file: 'studio/tools-knowledge-connections.mdx', sections: ['Workflows'] },
      { file: 'studio/testing-deployment-operations.mdx', sections: ['Operations'] },
    ],
  },

  // ═══════════════════════════════════════════════════════════════
  // Testing & Evaluation
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'testing-evals',
    exportName: 'TESTING_EVALS_CARD',
    title: 'Testing & Evaluation — Personas, Scenarios, Judges, Batches',
    maxTokens: 2500,
    sources: [{ file: 'guides/testing-and-evaluation.mdx' }],
  },

  // ═══════════════════════════════════════════════════════════════
  // API Management
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'api-management',
    exportName: 'API_MANAGEMENT_CARD',
    title: 'Management APIs — Agents, Deployments, Tools, Callbacks',
    maxTokens: 2500,
    sources: [{ file: 'api-reference/management-apis.mdx' }],
  },

  // ═══════════════════════════════════════════════════════════════
  // External Agents & A2A
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'external-agents-a2a',
    exportName: 'EXTERNAL_AGENTS_A2A_CARD',
    title: 'External Agents & A2A — Registration, Protocol, Health',
    maxTokens: 2500,
    sources: [
      { file: 'examples/orchestration-and-integration.mdx' },
      { file: 'api-reference/channels.mdx', sections: ['A2A'] },
    ],
  },
];
