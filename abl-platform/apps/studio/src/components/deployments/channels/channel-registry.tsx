/**
 * Channel Registry — single source of truth for all channel type definitions.
 *
 * Each entry defines the channel's metadata, capabilities, credential schema,
 * setup instructions, and webhook URL template. The registry is keyed by
 * ChannelTypeId so lookups are O(1).
 */

import { createElement } from 'react';
import {
  Globe,
  Webhook,
  Mail,
  Smartphone,
  MessageSquare,
  Mic,
  FileAudio,
  Radio,
  Phone,
  Headphones,
} from 'lucide-react';
import {
  WhatsAppIcon,
  SlackIcon,
  LineIcon,
  TeamsIcon,
  MessengerIcon,
  InstagramIcon,
  ZendeskIcon,
  TelegramIcon,
  AGUIIcon,
  A2AIcon,
  AIforWorkIcon,
} from './channel-icons';
import type { ChannelTypeId, ChannelTypeDef, ChannelInstance, ProviderOption } from './types';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const CHANNEL_REGISTRY: Record<ChannelTypeId, ChannelTypeDef> = {
  // ── Messaging channels ──────────────────────────────────────────────────

  slack: {
    id: 'slack',
    name: 'Slack',
    description: 'Deploy agents as Slack bots for team collaboration',
    icon: createElement(SlackIcon, { className: 'w-4 h-4' }),
    available: true,
    category: 'messaging',
    capabilities: {
      multiConnection: true,
      hasCredentials: true,
      hasWebhookUrl: true,
      supportsTest: false,
      supportsDeliveryLog: false,
      autoGenerateIdentifier: false,
      supportsPauseResume: false,
      supportsOAuth: true,
    },
    credentialFields: [
      {
        key: 'bot_token',
        label: 'Bot Token',
        placeholder: 'xoxb-...',
        type: 'password',
        required: true,
        validation: (v: string) =>
          v && !v.startsWith('xoxb-') ? 'Bot token must start with xoxb-' : null,
      },
      {
        key: 'signing_secret',
        label: 'Signing Secret',
        placeholder: 'Enter signing secret',
        type: 'password',
        required: true,
      },
    ],
    setupInstructions: (
      <ol className="list-decimal list-inside space-y-1.5">
        <li>
          Go to{' '}
          <a
            href="https://api.slack.com/apps"
            target="_blank"
            rel="noopener noreferrer"
            className="text-info hover:underline"
          >
            api.slack.com/apps
          </a>{' '}
          and click <strong>Create New App</strong>
        </li>
        <li>
          Choose <strong>From scratch</strong>, name your app, and select your workspace
        </li>
        <li>
          Go to <strong>Event Subscriptions</strong> and enable Events
        </li>
        <li>
          Set the <strong>Request URL</strong> to the webhook URL below
        </li>
        <li>
          Under <strong>Subscribe to bot events</strong>, add:{' '}
          <code className="text-xs bg-background-muted px-1 py-0.5 rounded">message.im</code>,{' '}
          <code className="text-xs bg-background-muted px-1 py-0.5 rounded">app_mention</code>
        </li>
        <li>
          Go to <strong>OAuth &amp; Permissions</strong> and add scopes:{' '}
          <code className="text-xs bg-background-muted px-1 py-0.5 rounded">chat:write</code>,{' '}
          <code className="text-xs bg-background-muted px-1 py-0.5 rounded">im:history</code>,{' '}
          <code className="text-xs bg-background-muted px-1 py-0.5 rounded">app_mentions:read</code>
        </li>
        <li>
          <strong>Install to Workspace</strong> and copy the <strong>Bot User OAuth Token</strong>
        </li>
        <li>
          Go to <strong>Basic Information</strong> and copy the <strong>Signing Secret</strong>,{' '}
          <strong>App ID</strong>, and your workspace <strong>Team ID</strong> (found in workspace
          settings URL)
        </li>
        <li>
          Optional: for Slack slash commands, go to <strong>Slash Commands</strong> and point the{' '}
          <strong>Request URL</strong> to{' '}
          <code className="text-xs bg-background-muted px-1 py-0.5 rounded">
            /api/v1/channels/slack/slash/&lt;Team ID:App ID&gt;
          </code>
        </li>
      </ol>
    ),
    webhookPath: '/api/v1/channels/slack/webhook',
    externalIdentifierLabel: 'Slack Team ID:App ID',
    externalIdentifierPlaceholder: 'e.g. T01ABCD2EFG:A01BCDE2FGH',
  },

  line: {
    id: 'line',
    name: 'LINE',
    description: 'Connect agents to LINE Official Accounts for chat and media messaging',
    icon: createElement(LineIcon, { className: 'w-4 h-4' }),
    available: true,
    category: 'messaging',
    capabilities: {
      multiConnection: true,
      hasCredentials: true,
      hasWebhookUrl: true,
      supportsTest: false,
      supportsDeliveryLog: false,
      autoGenerateIdentifier: false,
      supportsPauseResume: false,
    },
    credentialFields: [
      {
        key: 'channel_access_token',
        label: 'Channel Access Token',
        placeholder: 'Enter channel access token',
        type: 'password',
        required: true,
      },
      {
        key: 'channel_secret',
        label: 'Channel Secret',
        placeholder: 'Enter channel secret',
        type: 'password',
        required: true,
      },
    ],
    setupInstructions: (
      <ol className="list-decimal list-inside space-y-1.5">
        <li>
          Open the{' '}
          <a
            href="https://manager.line.biz/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-info hover:underline"
          >
            LINE Official Account Manager
          </a>{' '}
          and select your bot
        </li>
        <li>
          In the Messaging API settings, copy the <strong>Channel secret</strong>
        </li>
        <li>
          Issue or copy the long-lived <strong>Channel access token</strong>
        </li>
        <li>
          Copy the bot <strong>Destination ID</strong> and paste it as the external identifier
        </li>
        <li>Set the webhook URL shown below in the Messaging API settings and enable webhooks</li>
      </ol>
    ),
    webhookPath: '/api/v1/channels/line/webhook',
    externalIdentifierLabel: 'Destination ID',
    externalIdentifierPlaceholder: 'e.g. U0123456789abcdef0123456789abcd',
  },

  msteams: {
    id: 'msteams',
    name: 'Microsoft Teams',
    description: 'Integrate agents into Teams channels and chats',
    icon: createElement(TeamsIcon, { className: 'w-4 h-4' }),
    available: true,
    category: 'messaging',
    capabilities: {
      multiConnection: true,
      hasCredentials: true,
      hasWebhookUrl: true,
      supportsTest: false,
      supportsDeliveryLog: false,
      autoGenerateIdentifier: false,
      supportsPauseResume: false,
    },
    credentialFields: [
      {
        key: 'app_id',
        label: 'App ID',
        placeholder: 'Enter Microsoft App ID',
        type: 'text',
        required: true,
      },
      {
        key: 'client_secret',
        label: 'Client Secret',
        placeholder: 'Enter client secret',
        type: 'password',
        required: true,
      },
      {
        key: 'tenant_id',
        label: 'Azure Tenant ID',
        placeholder: 'Enter tenant ID',
        type: 'text',
        required: true,
      },
    ],
    setupInstructions: (
      <ol className="list-decimal list-inside space-y-1.5">
        <li>
          Go to{' '}
          <a
            href="https://portal.azure.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-info hover:underline"
          >
            Azure Portal
          </a>{' '}
          and navigate to <strong>Azure Bot</strong> &rarr; <strong>Create</strong>
        </li>
        <li>
          In Bot settings, set <strong>Messaging endpoint</strong> to the webhook URL below
        </li>
        <li>
          Under <strong>Configuration</strong>, copy the <strong>Microsoft App ID</strong>
        </li>
        <li>
          Go to <strong>App Registrations</strong> &rarr; find your bot &rarr;{' '}
          <strong>Certificates &amp; secrets</strong> &rarr; create a{' '}
          <strong>New client secret</strong> and copy the value
        </li>
        <li>
          Copy the <strong>Directory (tenant) ID</strong> from the Overview page
        </li>
        <li>
          Go to <strong>Channels</strong> &rarr; add <strong>Microsoft Teams</strong> channel
        </li>
        <li>
          In the Teams app manifest, set{' '}
          <code className="text-xs bg-background-muted px-1 py-0.5 rounded">
            bots[0].supportsFiles
          </code>{' '}
          to <code className="text-xs bg-background-muted px-1 py-0.5 rounded">true</code>
        </li>
        <li>
          Attachment ingestion currently supports <strong>personal chat</strong> scope only
        </li>
      </ol>
    ),
    webhookPath: '/api/v1/channels/msteams/webhook',
    externalIdentifierLabel: 'Bot App ID',
    externalIdentifierPlaceholder: 'e.g. your Microsoft App ID',
  },

  email: {
    id: 'email',
    name: 'Email',
    description: 'Process inbound emails and send agent responses via email',
    icon: createElement(Mail, { className: 'w-4 h-4' }),
    available: true,
    category: 'messaging',
    capabilities: {
      multiConnection: true,
      hasCredentials: false,
      hasWebhookUrl: false,
      supportsTest: false,
      supportsDeliveryLog: false,
      autoGenerateIdentifier: true,
      supportsPauseResume: false,
    },
    credentialFields: [],
    setupInstructions: (
      <ol className="list-decimal list-inside space-y-1.5">
        <li>
          Click <strong>Connect Channel</strong> to generate an inbound email address
        </li>
        <li>
          Configure your email provider to forward/route emails to that address (the platform&apos;s
          SMTP server listens on{' '}
          <code className="text-xs bg-background-muted px-1 py-0.5 rounded">port 2525</code>)
        </li>
        <li>Incoming emails will be routed to the selected agent version</li>
      </ol>
    ),
    webhookPath: null,
    externalIdentifierLabel: 'Inbound Email Address',
    externalIdentifierPlaceholder: 'Auto-generated on connect',
  },

  whatsapp: {
    id: 'whatsapp',
    name: 'WhatsApp',
    description: 'Connect agents to WhatsApp Business for customer messaging',
    icon: createElement(WhatsAppIcon, { className: 'w-4 h-4' }),
    available: true,
    category: 'messaging',
    capabilities: {
      multiConnection: true,
      hasCredentials: true,
      hasWebhookUrl: true,
      supportsTest: false,
      supportsDeliveryLog: false,
      autoGenerateIdentifier: false,
      supportsPauseResume: false,
    },
    credentialFields: [
      {
        key: 'access_token',
        label: 'Access Token',
        placeholder: 'Enter WhatsApp Business API access token',
        type: 'password',
        required: true,
      },
      {
        key: 'phone_number_id',
        label: 'Phone Number ID',
        placeholder: 'e.g. 123456789012345',
        type: 'text',
        required: true,
      },
      {
        key: 'app_secret',
        label: 'App Secret',
        placeholder: 'Enter Meta App Secret',
        type: 'password',
        required: true,
      },
      {
        key: 'verify_token',
        label: 'Verify Token',
        placeholder: 'Choose a secret string for webhook verification',
        type: 'password',
        required: true,
      },
    ],
    setupInstructions: (
      <ol className="list-decimal list-inside space-y-1.5">
        <li>
          Go to{' '}
          <a
            href="https://developers.facebook.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-info hover:underline"
          >
            Meta for Developers
          </a>{' '}
          and create a WhatsApp Business app
        </li>
        <li>
          Under <strong>WhatsApp &rarr; API Setup</strong>, copy your <strong>Access Token</strong>{' '}
          and <strong>Phone Number ID</strong>
        </li>
        <li>
          Copy the <strong>App Secret</strong> from <strong>Settings &rarr; Basic</strong>
        </li>
        <li>
          Choose a <strong>Verify Token</strong> (any secret string) and enter it here — you will
          use the same string when configuring the webhook URL in Meta&apos;s dashboard
        </li>
        <li>
          Configure the <strong>Webhook URL</strong> below in your Meta App settings, using the
          Verify Token you chose
        </li>
      </ol>
    ),
    webhookPath: '/api/v1/channels/whatsapp/webhook',
    providerOptions: [
      {
        id: 'meta_cloud',
        name: 'Meta Cloud API',
        credentialFields: [
          {
            key: 'access_token',
            label: 'Access Token',
            placeholder: 'Enter WhatsApp Business API access token',
            type: 'password',
            required: true,
          },
          {
            key: 'phone_number_id',
            label: 'Phone Number ID',
            placeholder: 'e.g. 123456789012345',
            type: 'text',
            required: true,
          },
          {
            key: 'app_secret',
            label: 'App Secret',
            placeholder: 'Enter Meta App Secret',
            type: 'password',
            required: true,
          },
          {
            key: 'verify_token',
            label: 'Verify Token',
            placeholder: 'Choose a secret string for webhook verification',
            type: 'password',
            required: true,
          },
        ],
        setupInstructions: (
          <ol className="list-decimal list-inside space-y-1.5">
            <li>
              Go to{' '}
              <a
                href="https://developers.facebook.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-info hover:underline"
              >
                Meta for Developers
              </a>{' '}
              and create a WhatsApp Business app
            </li>
            <li>
              Under <strong>WhatsApp &rarr; API Setup</strong>, copy your{' '}
              <strong>Access Token</strong> and <strong>Phone Number ID</strong>
            </li>
            <li>
              Copy the <strong>App Secret</strong> from <strong>Settings &rarr; Basic</strong>
            </li>
            <li>
              Choose a <strong>Verify Token</strong> (any secret string) and enter it here — you
              will use the same string when configuring the webhook URL in Meta&apos;s dashboard
            </li>
            <li>
              Configure the <strong>Webhook URL</strong> below in your Meta App settings, using the
              Verify Token you chose
            </li>
          </ol>
        ),
        webhookPath: '/api/v1/channels/whatsapp/webhook',
        externalIdentifierLabel: 'Phone Number ID',
        externalIdentifierPlaceholder: 'e.g. 123456789012345',
      },
      {
        id: 'infobip',
        name: 'Infobip',
        credentialFields: [
          {
            key: 'base_url',
            label: 'API Base URL',
            placeholder: 'https://xxxxx.api.infobip.com',
            type: 'text',
            required: true,
            validation: (value: string) => {
              try {
                const url = new URL(value.trim());
                return url.protocol === 'http:' || url.protocol === 'https:'
                  ? null
                  : 'API Base URL must include http:// or https://';
              } catch {
                return 'API Base URL must include http:// or https://';
              }
            },
          },
          {
            key: 'api_key',
            label: 'API Key',
            placeholder: 'Enter Infobip API key',
            type: 'password',
            required: false,
          },
          {
            key: 'username',
            label: 'Username',
            placeholder: 'Enter Infobip username',
            type: 'text',
            required: false,
          },
          {
            key: 'password',
            label: 'Password',
            placeholder: 'Enter Infobip password',
            type: 'password',
            required: false,
          },
        ],
        setupInstructions: (
          <ol className="list-decimal list-inside space-y-1.5">
            <li>
              Log in to your{' '}
              <a
                href="https://portal.infobip.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-info hover:underline"
              >
                Infobip account
              </a>
            </li>
            <li>
              Go to <strong>Channels and Numbers &rarr; WhatsApp</strong>
            </li>
            <li>
              Copy your <strong>API Base URL</strong> from the homepage
            </li>
            <li>
              Go to <strong>Developer Tools &rarr; API Keys</strong> and copy your API key
            </li>
            <li>
              Under <strong>WhatsApp &rarr; Senders</strong>, click{' '}
              <strong>Edit Configuration</strong> and set the webhook URL below
            </li>
          </ol>
        ),
        webhookPath: '/api/v1/channels/whatsapp/infobip/webhook',
        externalIdentifierLabel: 'WhatsApp Phone Number',
        externalIdentifierPlaceholder: 'Digits only, e.g. 447415774332',
      },
      {
        id: 'gupshup',
        name: 'Gupshup',
        credentialFields: [
          {
            key: 'username',
            label: 'API Username',
            placeholder: 'Enter Gupshup API username',
            type: 'text',
            required: true,
          },
          {
            key: 'password',
            label: 'API Password',
            placeholder: 'Enter Gupshup API password',
            type: 'password',
            required: true,
          },
          {
            key: 'webhook_secret',
            label: 'Webhook JWT Secret (optional)',
            placeholder: 'Enter JWT secret for webhook verification',
            type: 'password',
            required: false,
          },
        ],
        setupInstructions: (
          <ol className="list-decimal list-inside space-y-1.5">
            <li>
              Log in to your{' '}
              <a
                href="https://www.gupshup.io"
                target="_blank"
                rel="noopener noreferrer"
                className="text-info hover:underline"
              >
                Gupshup account
              </a>
            </li>
            <li>
              Go to <strong>Dashboard</strong> and select your WhatsApp app
            </li>
            <li>
              Copy your <strong>API Username</strong> and <strong>Password</strong> from the app
              settings
            </li>
            <li>
              Under <strong>Webhooks</strong>, set the callback URL to the webhook URL below
            </li>
            <li>
              (Optional) Configure a <strong>JWT secret</strong> for webhook verification
            </li>
          </ol>
        ),
        webhookPath: '/api/v1/channels/whatsapp/gupshup/webhook',
        externalIdentifierLabel: 'WhatsApp Business Phone Number',
        externalIdentifierPlaceholder: 'e.g. 917012345678',
      },
    ],
    externalIdentifierLabel: 'Phone Number ID',
    externalIdentifierPlaceholder: 'e.g. 123456789012345',
  },

  messenger: {
    id: 'messenger',
    name: 'Messenger',
    description: 'Connect agents to Facebook Messenger for customer support',
    icon: createElement(MessengerIcon, { className: 'w-4 h-4' }),
    available: true,
    category: 'messaging',
    capabilities: {
      multiConnection: true,
      hasCredentials: true,
      hasWebhookUrl: true,
      supportsTest: false,
      supportsDeliveryLog: false,
      autoGenerateIdentifier: false,
      supportsPauseResume: false,
    },
    credentialFields: [
      {
        key: 'page_access_token',
        label: 'Page Access Token',
        placeholder: 'Enter Facebook Page access token',
        type: 'password',
        required: true,
      },
      {
        key: 'app_secret',
        label: 'App Secret',
        placeholder: 'Enter Meta App Secret',
        type: 'password',
        required: true,
      },
      {
        key: 'verify_token',
        label: 'Verify Token',
        placeholder: 'Choose a secret string for webhook verification',
        type: 'password',
        required: false,
      },
    ],
    setupInstructions: (
      <ol className="list-decimal list-inside space-y-1.5">
        <li>
          Go to{' '}
          <a
            href="https://developers.facebook.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-info hover:underline"
          >
            Meta for Developers
          </a>{' '}
          and create a new app with <strong>Business</strong> type
        </li>
        <li>
          Add the <strong>Messenger</strong> product to your app
        </li>
        <li>
          Under <strong>Messenger Settings</strong>, add your Facebook Page and generate a{' '}
          <strong>Page Access Token</strong>
        </li>
        <li>
          Go to <strong>Settings &rarr; Basic</strong> and copy the <strong>App Secret</strong>
        </li>
        <li>
          Choose a <strong>Verify Token</strong> (any secret string you pick) and enter it above
        </li>
        <li>
          In <strong>Messenger Settings &rarr; Webhooks</strong>, set the{' '}
          <strong>Callback URL</strong> to the webhook URL below and use your Verify Token
        </li>
        <li>
          Subscribe to{' '}
          <code className="text-xs bg-background-muted px-1 py-0.5 rounded">messages</code> and{' '}
          <code className="text-xs bg-background-muted px-1 py-0.5 rounded">
            messaging_postbacks
          </code>{' '}
          events
        </li>
      </ol>
    ),
    webhookPath: '/api/v1/channels/messenger/webhook',
    externalIdentifierLabel: 'Facebook Page ID',
    externalIdentifierPlaceholder: 'e.g. 123456789012345',
  },

  twilio_sms: {
    id: 'twilio_sms',
    name: 'Twilio SMS',
    description: 'Send and receive SMS messages via Twilio for customer engagement',
    icon: createElement(MessageSquare, { className: 'w-4 h-4' }),
    available: true,
    category: 'messaging',
    capabilities: {
      multiConnection: true,
      hasCredentials: true,
      hasWebhookUrl: true,
      supportsTest: false,
      supportsDeliveryLog: false,
      autoGenerateIdentifier: false,
      supportsPauseResume: false,
    },
    credentialFields: [
      {
        key: 'account_sid',
        label: 'Account SID',
        placeholder: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        type: 'text',
        required: true,
        validation: (v: string) =>
          v && !v.startsWith('AC') ? 'Account SID must start with AC' : null,
      },
      {
        key: 'auth_token',
        label: 'Auth Token',
        placeholder: 'Enter your Twilio Auth Token',
        type: 'password',
        required: true,
      },
      {
        key: 'messaging_service_sid',
        label: 'Messaging Service SID',
        placeholder: 'MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx (optional)',
        type: 'text',
        required: false,
        validation: (v: string) =>
          v && v.length > 0 && !v.startsWith('MG')
            ? 'Messaging Service SID must start with MG'
            : null,
      },
    ],
    setupInstructions: (
      <ol className="list-decimal list-inside space-y-1.5">
        <li>
          Sign in to your{' '}
          <a
            href="https://console.twilio.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-info hover:underline"
          >
            Twilio Console
          </a>
        </li>
        <li>
          Copy your <strong>Account SID</strong> and <strong>Auth Token</strong> from the dashboard
        </li>
        <li>
          (Optional) Create a{' '}
          <a
            href="https://console.twilio.com/us1/develop/sms/services"
            target="_blank"
            rel="noopener noreferrer"
            className="text-info hover:underline"
          >
            Messaging Service
          </a>{' '}
          and copy its SID
        </li>
        <li>
          In Twilio Console, go to your phone number settings and set the{' '}
          <strong>Webhook URL</strong> for incoming messages to the URL shown below
        </li>
        <li>
          Set the webhook method to <strong>HTTP POST</strong>
        </li>
      </ol>
    ),
    webhookPath: '/api/v1/channels/twilio_sms/webhook',
    externalIdentifierLabel: 'Connection Identifier',
    externalIdentifierPlaceholder: 'e.g. my-sms-channel',
  },

  telegram: {
    id: 'telegram',
    name: 'Telegram',
    description: 'Connect agents to Telegram bots for messaging and group conversations',
    icon: createElement(TelegramIcon, { className: 'w-4 h-4' }),
    available: true,
    category: 'messaging',
    capabilities: {
      multiConnection: true,
      hasCredentials: true,
      hasWebhookUrl: true,
      supportsTest: false,
      supportsDeliveryLog: false,
      autoGenerateIdentifier: false,
      supportsPauseResume: false,
    },
    credentialFields: [
      {
        key: 'bot_token',
        label: 'Bot Token',
        placeholder: 'Enter bot token from @BotFather',
        type: 'password' as const,
        required: true,
      },
    ],
    setupInstructions: (
      <ol className="list-decimal list-inside space-y-1.5">
        <li>
          Open Telegram and message{' '}
          <a
            href="https://t.me/BotFather"
            target="_blank"
            rel="noopener noreferrer"
            className="text-info hover:underline"
          >
            @BotFather
          </a>
        </li>
        <li>
          Send <code className="text-xs bg-background-muted px-1 py-0.5 rounded">/newbot</code> and
          follow the prompts to create a bot
        </li>
        <li>
          Copy the <strong>bot token</strong> (format:{' '}
          <code className="text-xs bg-background-muted px-1 py-0.5 rounded">
            123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
          </code>
          )
        </li>
        <li>Paste the token above and set the external identifier to your bot username</li>
        <li>The webhook URL will be automatically registered with Telegram on connect</li>
      </ol>
    ),
    webhookPath: '/api/v1/channels/telegram/webhook',
    externalIdentifierLabel: 'Bot Username',
    externalIdentifierPlaceholder: 'e.g. my_cool_bot',
  },

  zendesk: {
    id: 'zendesk',
    name: 'Zendesk',
    description: 'Connect agents to Zendesk Sunshine Conversations for customer support',
    icon: createElement(ZendeskIcon, { className: 'w-4 h-4' }),
    available: true,
    category: 'messaging',
    capabilities: {
      multiConnection: true,
      hasCredentials: true,
      hasWebhookUrl: true,
      supportsTest: false,
      supportsDeliveryLog: false,
      autoGenerateIdentifier: false,
      supportsPauseResume: false,
    },
    credentialFields: [
      {
        key: 'app_id',
        label: 'App ID',
        placeholder: 'Enter Zendesk Sunshine app ID',
        type: 'text',
        required: true,
      },
      {
        key: 'key_id',
        label: 'API Key ID',
        placeholder: 'Enter API key ID',
        type: 'password',
        required: true,
      },
      {
        key: 'key_secret',
        label: 'API Key Secret',
        placeholder: 'Enter API key secret',
        type: 'password',
        required: true,
      },
      {
        key: 'webhook_secret',
        label: 'Webhook Secret (optional)',
        placeholder: 'Enter webhook secret for HMAC verification',
        type: 'password',
        required: false,
      },
    ],
    setupInstructions: (
      <ol className="list-decimal list-inside space-y-1.5">
        <li>
          Log in to your{' '}
          <a
            href="https://app.smooch.io"
            target="_blank"
            rel="noopener noreferrer"
            className="text-info hover:underline"
          >
            Zendesk Sunshine Conversations
          </a>{' '}
          dashboard
        </li>
        <li>
          Create or select an app and copy the <strong>App ID</strong>
        </li>
        <li>
          Go to <strong>Settings &rarr; API Keys</strong> and create a new key
        </li>
        <li>
          Copy the <strong>Key ID</strong> and <strong>Key Secret</strong>
        </li>
        <li>
          Under <strong>Webhooks</strong>, add a new webhook pointing to the URL below
        </li>
        <li>
          (Optional) Set a <strong>Webhook Secret</strong> to enable HMAC-SHA256 signature
          verification on inbound messages
        </li>
        <li>
          Subscribe to the{' '}
          <code className="text-xs bg-background-muted px-1 py-0.5 rounded">
            conversation:message
          </code>{' '}
          event
        </li>
      </ol>
    ),
    webhookPath: '/api/v1/channels/zendesk/webhook',
    externalIdentifierLabel: 'App ID',
    externalIdentifierPlaceholder: 'e.g. 5e4af71a31e2a0002267c395',
  },

  instagram: {
    id: 'instagram',
    name: 'Instagram',
    description: 'Connect agents to Instagram Messaging for direct customer conversations',
    icon: createElement(InstagramIcon, { className: 'w-4 h-4' }),
    available: true,
    category: 'messaging',
    capabilities: {
      multiConnection: true,
      hasCredentials: true,
      hasWebhookUrl: true,
      supportsTest: false,
      supportsDeliveryLog: false,
      autoGenerateIdentifier: false,
      supportsPauseResume: false,
    },
    credentialFields: [
      {
        key: 'page_access_token',
        label: 'Page Access Token',
        placeholder: 'Enter Instagram-linked Facebook Page access token',
        type: 'password',
        required: true,
      },
      {
        key: 'app_secret',
        label: 'App Secret',
        placeholder: 'Enter Meta App Secret',
        type: 'password',
        required: true,
      },
      {
        key: 'verify_token',
        label: 'Verify Token',
        placeholder: 'Choose a secret string for webhook verification',
        type: 'password',
        required: true,
      },
    ],
    setupInstructions: (
      <ol className="list-decimal list-inside space-y-1.5">
        <li>
          Go to{' '}
          <a
            href="https://developers.facebook.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-info hover:underline"
          >
            Meta for Developers
          </a>{' '}
          and create or select a Business app
        </li>
        <li>
          Add the <strong>Instagram</strong> product to your app
        </li>
        <li>
          Under <strong>Instagram Settings</strong>, connect your Instagram Professional account and
          generate a <strong>Page Access Token</strong>
        </li>
        <li>
          Go to <strong>Settings &rarr; Basic</strong> and copy the <strong>App Secret</strong>
        </li>
        <li>
          Choose a <strong>Verify Token</strong> (any secret string) and enter it above
        </li>
        <li>
          In <strong>Webhooks</strong>, set the <strong>Callback URL</strong> to the webhook URL
          below and use your Verify Token
        </li>
        <li>
          Subscribe to{' '}
          <code className="text-xs bg-background-muted px-1 py-0.5 rounded">messages</code> and{' '}
          <code className="text-xs bg-background-muted px-1 py-0.5 rounded">
            messaging_postbacks
          </code>{' '}
          events
        </li>
      </ol>
    ),
    webhookPath: '/api/v1/channels/instagram/webhook',
    externalIdentifierLabel: 'Instagram Account ID',
    externalIdentifierPlaceholder: 'e.g. 17841400123456789',
  },

  genesys: {
    id: 'genesys',
    name: 'Genesys',
    description: 'Connect agents to Genesys Cloud as a Bot Connector for contact center automation',
    icon: createElement(Headphones, { className: 'w-4 h-4' }),
    available: true,
    category: 'messaging',
    capabilities: {
      multiConnection: true,
      hasCredentials: true,
      hasWebhookUrl: true,
      supportsTest: false,
      supportsDeliveryLog: false,
      autoGenerateIdentifier: false,
      supportsPauseResume: false,
    },
    credentialFields: [
      {
        key: 'client_secret',
        label: 'Client Secret',
        placeholder: 'Enter the bearer token for webhook authentication',
        type: 'password',
        required: true,
      },
    ],
    setupInstructions: (
      <ol className="list-decimal list-inside space-y-1.5">
        <li>
          In <strong>Genesys Cloud Admin</strong>, go to{' '}
          <strong>Integrations &rarr; Bot Connector</strong>
        </li>
        <li>
          Create a new Bot Connector integration and note the <strong>Stream ID</strong>
        </li>
        <li>
          Set the <strong>Bot Connector URL</strong> to the webhook URL below
        </li>
        <li>
          Configure a <strong>Client Secret</strong> (bearer token) in the Bot Connector settings
          and enter the same value above
        </li>
        <li>
          In the Architect flow, add a <strong>Call Bot Connector</strong> action pointing to this
          integration
        </li>
      </ol>
    ),
    webhookPath: '/api/v1/channels/genesys/hooks',
    externalIdentifierLabel: 'Stream ID',
    externalIdentifierPlaceholder: 'e.g. ab12cd34-ef56-7890-gh12-ij34kl56mn78',
  },

  ai4w: {
    id: 'ai4w',
    name: 'AIforWork',
    description:
      "Kore.ai's Employee Experience (EX) platform — bidirectional agent messaging integration",
    icon: createElement(AIforWorkIcon, { className: 'w-4 h-4' }),
    available: true,
    category: 'messaging',
    capabilities: {
      multiConnection: true,
      hasCredentials: false,
      hasWebhookUrl: true,
      supportsTest: false,
      supportsDeliveryLog: false,
      autoGenerateIdentifier: true,
      supportsPauseResume: true,
    },
    credentialFields: [],
    setupInstructions: (
      <ol className="list-decimal list-inside space-y-1.5">
        <li>
          Create a connection below — ABL auto-generates the endpoint URL and a connection secret
        </li>
        <li>
          Copy the <strong>Endpoint URL</strong> and <strong>Connection Secret</strong> shown
          immediately after creation (the secret is revealed only once)
        </li>
        <li>
          In AIforWork, register a new <strong>ABL Agent</strong> and paste the endpoint URL and
          connection secret into its configuration
        </li>
        <li>
          Configure the <strong>response mode</strong> (sync, stream, or async) to match your AI4W
          agent setup
        </li>
        <li>
          AIforWork will sign requests with HMAC-SHA256 and include a JWT Bearer token — ABL
          verifies both automatically
        </li>
        <li>Send a test message from AIforWork to confirm the integration is working end-to-end</li>
      </ol>
    ),
    webhookPath: null,
    externalIdentifierLabel: 'Connection ID',
    externalIdentifierPlaceholder: 'Auto-generated',
  },

  // ── SDK channels ────────────────────────────────────────────────────────

  sdk_web: {
    id: 'sdk_web',
    name: 'Web SDK',
    description: 'Embed a chat widget in your website with a single script tag',
    icon: createElement(Globe, { className: 'w-4 h-4' }),
    available: true,
    category: 'sdk',
    capabilities: {
      multiConnection: true,
      hasCredentials: false,
      hasWebhookUrl: false,
      supportsTest: true,
      supportsDeliveryLog: false,
      autoGenerateIdentifier: false,
      supportsPauseResume: false,
      supportsWidgetConfiguration: true,
    },
    credentialFields: [],
    setupInstructions: (
      <ol className="list-decimal list-inside space-y-1.5">
        <li>Create a channel and select a deployment and API key</li>
        <li>
          Copy the embed snippet and add it to your website&apos;s{' '}
          <code className="text-xs bg-background-muted px-1 py-0.5 rounded">&lt;head&gt;</code> or
          before{' '}
          <code className="text-xs bg-background-muted px-1 py-0.5 rounded">&lt;/body&gt;</code>
        </li>
        <li>The widget will appear on your site and connect to the selected agent</li>
      </ol>
    ),
    webhookPath: null,
    externalIdentifierLabel: 'Channel Name',
    externalIdentifierPlaceholder: 'e.g. web_widget_prod',
  },

  sdk_mobile: {
    id: 'sdk_mobile',
    name: 'Mobile SDK',
    description: 'Native iOS and Android SDKs for in-app agent experiences',
    icon: createElement(Smartphone, { className: 'w-4 h-4' }),
    available: false,
    category: 'sdk',
    capabilities: {
      multiConnection: true,
      hasCredentials: false,
      hasWebhookUrl: false,
      supportsTest: false,
      supportsDeliveryLog: false,
      autoGenerateIdentifier: false,
      supportsPauseResume: false,
      supportsWidgetConfiguration: false,
    },
    credentialFields: [],
    setupInstructions: (
      <p className="text-sm text-muted">
        Mobile SDK integration guides will be available when this channel type launches.
      </p>
    ),
    webhookPath: null,
    externalIdentifierLabel: 'App Bundle ID',
    externalIdentifierPlaceholder: 'e.g. com.example.myapp',
  },

  sdk_api: {
    id: 'sdk_api',
    name: 'API',
    description: 'Programmatic access via REST API for server-to-server integration',
    icon: createElement(MessageSquare, { className: 'w-4 h-4' }),
    available: true,
    category: 'sdk',
    capabilities: {
      multiConnection: true,
      hasCredentials: false,
      hasWebhookUrl: false,
      supportsTest: false,
      supportsDeliveryLog: false,
      autoGenerateIdentifier: false,
      supportsPauseResume: false,
      supportsWidgetConfiguration: false,
    },
    credentialFields: [],
    setupInstructions: (
      <ol className="list-decimal list-inside space-y-1.5">
        <li>Create a channel and bind it to the public API key that should bootstrap sessions</li>
        <li>
          Exchange that key on{' '}
          <code className="text-xs bg-background-muted px-1 py-0.5 rounded">
            POST /api/v1/sdk/init
          </code>{' '}
          using the{' '}
          <code className="text-xs bg-background-muted px-1 py-0.5 rounded">X-Public-Key</code>{' '}
          header
        </li>
        <li>
          Call{' '}
          <code className="text-xs bg-background-muted px-1 py-0.5 rounded">
            POST /api/v1/chat/agent
          </code>{' '}
          with the returned{' '}
          <code className="text-xs bg-background-muted px-1 py-0.5 rounded">X-SDK-Token</code>
        </li>
        <li>
          Use this channel ID in the bootstrap payload to bind traffic to the correct API lane
        </li>
        <li>
          The API Integration section below includes copyable endpoints, cURL examples, and docs
        </li>
      </ol>
    ),
    webhookPath: null,
    externalIdentifierLabel: 'Channel Name',
    externalIdentifierPlaceholder: 'e.g. api_backend_prod',
  },

  // ── Webhook channels ───────────────────────────────────────────────────

  http_async: {
    id: 'http_async',
    name: 'Webhooks (HTTP Async)',
    description: 'Receive agent responses via webhook callbacks to your server',
    icon: createElement(Webhook, { className: 'w-4 h-4' }),
    available: true,
    category: 'webhook',
    capabilities: {
      multiConnection: true,
      hasCredentials: false,
      hasWebhookUrl: false,
      supportsTest: true,
      supportsDeliveryLog: true,
      autoGenerateIdentifier: false,
      supportsPauseResume: true,
    },
    credentialFields: [],
    setupInstructions: (
      <ol className="list-decimal list-inside space-y-1.5">
        <li>Add a subscription with your callback URL</li>
        <li>
          Send messages via{' '}
          <code className="text-xs bg-background-muted px-1 py-0.5 rounded">
            POST /api/v1/channels/http-async/message
          </code>
        </li>
        <li>Agent responses are delivered to your callback URL as webhook events</li>
        <li>Use the webhook secret to verify delivery signatures with HMAC-SHA256</li>
      </ol>
    ),
    webhookPath: null,
    externalIdentifierLabel: 'Callback URL',
    externalIdentifierPlaceholder: 'https://your-server.com/webhook',
  },

  // ── Voice channels ─────────────────────────────────────────────────────

  voice_realtime: {
    id: 'voice_realtime',
    name: 'Realtime LLM Voice',
    description:
      'Live voice conversations using realtime LLM models (OpenAI Realtime, Gemini Live) via Kore.ai Voice Gateway',
    icon: createElement(Radio, { className: 'w-4 h-4' }),
    available: true,
    category: 'voice',
    capabilities: {
      multiConnection: true,
      hasCredentials: false,
      hasWebhookUrl: false,
      supportsTest: false,
      supportsDeliveryLog: false,
      autoGenerateIdentifier: false,
      supportsPauseResume: false,
    },
    credentialFields: [],
    setupInstructions: (
      <ol className="list-decimal list-inside space-y-1.5">
        <li>Select a voice provider (defaults to Kore.ai Voice Gateway)</li>
        <li>Buy a phone number via Twilio in the Configuration tab</li>
        <li>Choose your realtime LLM model (OpenAI Realtime or Gemini Live)</li>
        <li>Select ASR and TTS model preferences</li>
        <li>Assign the channel to a deployment environment</li>
      </ol>
    ),
    webhookPath: null,
    externalIdentifierLabel: 'Connection Name',
    externalIdentifierPlaceholder: 'e.g. realtime-voice-prod',
  },

  voice_pipeline: {
    id: 'voice_pipeline',
    name: 'Pipeline Voice',
    description:
      'Traditional STT → LLM → TTS voice pipeline via Kore.ai Voice Gateway with configurable ASR/TTS models',
    icon: createElement(Mic, { className: 'w-4 h-4' }),
    available: true,
    category: 'voice',
    capabilities: {
      multiConnection: true,
      hasCredentials: false,
      hasWebhookUrl: false,
      supportsTest: false,
      supportsDeliveryLog: false,
      autoGenerateIdentifier: false,
      supportsPauseResume: false,
    },
    credentialFields: [],
    setupInstructions: (
      <ol className="list-decimal list-inside space-y-1.5">
        <li>Select a voice provider (defaults to Kore.ai Voice Gateway)</li>
        <li>Buy a phone number via Twilio in the Configuration tab</li>
        <li>Choose ASR (speech-to-text) and TTS (text-to-speech) vendors and models</li>
        <li>Set barge-in behavior and speech timeout</li>
        <li>Assign the channel to a deployment environment</li>
      </ol>
    ),
    webhookPath: null,
    externalIdentifierLabel: 'Connection Name',
    externalIdentifierPlaceholder: 'e.g. pipeline-voice-prod',
  },

  voice_vxml: {
    id: 'voice_vxml',
    name: 'VXML IVR',
    description:
      'VoiceXML 2.1 gateway for traditional IVR systems with DTMF and prompt-based navigation',
    icon: createElement(FileAudio, { className: 'w-4 h-4' }),
    available: true,
    category: 'voice',
    capabilities: {
      multiConnection: true,
      hasCredentials: false,
      hasWebhookUrl: false,
      supportsTest: false,
      supportsDeliveryLog: false,
      autoGenerateIdentifier: false,
      supportsPauseResume: false,
    },
    credentialFields: [],
    setupInstructions: (
      <ol className="list-decimal list-inside space-y-1.5">
        <li>Create a connection and provide your VXML document URL</li>
        <li>The platform serves VoiceXML 2.1 documents for your IVR system to consume</li>
        <li>Configure fallback URL and error handling in the Configuration tab</li>
      </ol>
    ),
    webhookPath: null,
    externalIdentifierLabel: 'IVR System Name',
    externalIdentifierPlaceholder: 'e.g. main-ivr-menu',
  },

  audiocodes: {
    id: 'audiocodes',
    name: 'AudioCodes',
    description: 'Connect voice calls via AudioCodes VoiceAI Connect',
    icon: createElement(Phone, { className: 'w-4 h-4' }),
    available: true,
    category: 'voice',
    capabilities: {
      multiConnection: true,
      hasCredentials: true,
      hasWebhookUrl: true,
      supportsTest: false,
      supportsDeliveryLog: false,
      autoGenerateIdentifier: false,
      supportsPauseResume: false,
    },
    credentialFields: [
      {
        key: 'inboundAuthToken',
        label: 'Authentication Token',
        placeholder: 'Enter the static token configured in AudioCodes',
        type: 'password' as const,
        required: true,
      },
    ],
    setupInstructions: createElement(
      'ol',
      { className: 'list-decimal list-inside space-y-1.5' },
      createElement('li', null, 'In the AudioCodes VoiceAI Connect admin, create a new Bot.'),
      createElement('li', null, 'Set the Bot URL to the webhook URL shown below.'),
      createElement(
        'li',
        null,
        'Configure a static authentication token in AudioCodes and enter the same token in the Authentication Token field above.',
      ),
      createElement('li', null, 'Set up your STT and TTS providers in AudioCodes.'),
      createElement('li', null, 'Route a phone number to the bot in AudioCodes.'),
    ),
    webhookPath: '/api/v1/channels/audiocodes/webhook',
    externalIdentifierLabel: 'Bot Identifier',
    externalIdentifierPlaceholder: 'e.g. my-voicebot',
  },

  // ── Protocol channels ──────────────────────────────────────────────────

  ag_ui: {
    id: 'ag_ui',
    name: 'AG-UI (CopilotKit)',
    description:
      'Server-sent events protocol for React/Next.js frontend agent UIs with streaming support',
    icon: createElement(AGUIIcon, { className: 'w-4 h-4' }),
    available: true,
    category: 'protocol',
    capabilities: {
      multiConnection: true,
      hasCredentials: false,
      hasWebhookUrl: false,
      supportsTest: false,
      supportsDeliveryLog: false,
      autoGenerateIdentifier: false,
      supportsPauseResume: false,
    },
    credentialFields: [],
    setupInstructions: (
      <ol className="list-decimal list-inside space-y-1.5">
        <li>Create a connection and assign it to a deployment</li>
        <li>Use the AG-UI SDK in your React/Next.js frontend to connect</li>
        <li>The agent streams responses as SSE events with structured payloads</li>
      </ol>
    ),
    webhookPath: null,
    externalIdentifierLabel: 'Frontend App Name',
    externalIdentifierPlaceholder: 'e.g. copilot-dashboard',
  },

  a2a: {
    id: 'a2a',
    name: 'Agent-to-Agent (A2A)',
    description: 'Google A2A protocol for inter-agent communication with task lifecycle management',
    icon: createElement(A2AIcon, { className: 'w-4 h-4' }),
    available: true,
    category: 'protocol',
    capabilities: {
      multiConnection: true,
      hasCredentials: false,
      hasWebhookUrl: false,
      supportsTest: false,
      supportsDeliveryLog: false,
      autoGenerateIdentifier: false,
      supportsPauseResume: false,
    },
    credentialFields: [],
    setupInstructions: (
      <ol className="list-decimal list-inside space-y-1.5">
        <li>Create a connection to expose this agent via the A2A protocol</li>
        <li>Other A2A-compatible agents can discover and interact with your agent</li>
        <li>Supports task lifecycle: submitted → working → completed</li>
      </ol>
    ),
    webhookPath: null,
    externalIdentifierLabel: 'Agent Endpoint Name',
    externalIdentifierPlaceholder: 'e.g. booking-agent-a2a',
  },
};

// ---------------------------------------------------------------------------
// Display order — grouped by category
// ---------------------------------------------------------------------------

export const CHANNEL_CATALOG_ORDER: ChannelTypeId[] = [
  // Messaging
  'slack',
  'line',
  'msteams',
  'whatsapp',
  'messenger',
  'twilio_sms',
  'telegram',
  'zendesk',
  'instagram',
  'genesys',
  'email',
  'ai4w',
  // SDK
  'sdk_web',
  'sdk_api',
  'sdk_mobile',
  // Voice
  'voice_realtime',
  'voice_pipeline',
  'voice_vxml',
  'audiocodes',
  // Webhook
  'http_async',
  // Protocols
  'ag_ui',
  'a2a',
];

// ---------------------------------------------------------------------------
// Lookup helper
// ---------------------------------------------------------------------------

export function getChannelDef(id: ChannelTypeId): ChannelTypeDef {
  return CHANNEL_REGISTRY[id];
}

/**
 * Resolve the active ProviderOption for an instance based on its config.provider.
 * Returns null if the channel has no providerOptions or the provider is not found.
 */
export function getActiveProviderOption(
  def: ChannelTypeDef,
  instance: ChannelInstance,
): ProviderOption | null {
  if (!def.providerOptions || def.providerOptions.length === 0) return null;
  const providerId = instance.config?.provider as string | undefined;
  if (!providerId) return null;
  return def.providerOptions.find((p) => p.id === providerId) ?? null;
}
