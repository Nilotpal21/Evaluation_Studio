/**
 * Agent Transfer Configuration Loader
 *
 * Parses agent transfer config from environment variables and returns
 * a validated AgentTransferConfig. SmartAssist settings are optional —
 * the transfer subsystem boots by default unless explicitly kill-switched.
 */

import {
  AgentTransferConfigSchema,
  type AgentTransferConfig,
} from '@agent-platform/agent-transfer';

/** Whether the agent transfer subsystem should be enabled at boot. */
export function isAgentTransferEnabled(): boolean {
  const rawValue = process.env.AGENT_TRANSFER_ENABLED?.trim().toLowerCase();
  return !(
    rawValue === 'false' ||
    rawValue === '0' ||
    rawValue === 'off' ||
    rawValue === 'no' ||
    rawValue === 'disabled'
  );
}

/**
 * Load and validate agent transfer config from environment variables.
 * Returns null only when AGENT_TRANSFER_ENABLED explicitly disables the subsystem.
 */
export function loadAgentTransferConfig(): AgentTransferConfig | null {
  if (!isAgentTransferEnabled()) {
    return null;
  }

  const raw: Record<string, unknown> = {};

  // Session TTLs
  const sessionTtl: Record<string, unknown> = {};
  if (process.env.TRANSFER_SESSION_TTL_CHAT) {
    sessionTtl.chat = Number(process.env.TRANSFER_SESSION_TTL_CHAT);
  }
  if (process.env.TRANSFER_SESSION_TTL_EMAIL) {
    sessionTtl.email = Number(process.env.TRANSFER_SESSION_TTL_EMAIL);
  }
  if (process.env.TRANSFER_SESSION_TTL_VOICE) {
    sessionTtl.voice = Number(process.env.TRANSFER_SESSION_TTL_VOICE);
  }
  if (process.env.TRANSFER_SESSION_TTL_MESSAGING) {
    sessionTtl.messaging = Number(process.env.TRANSFER_SESSION_TTL_MESSAGING);
  }
  if (process.env.TRANSFER_SESSION_TTL_DEFAULT) {
    sessionTtl.default = Number(process.env.TRANSFER_SESSION_TTL_DEFAULT);
  }
  if (Object.keys(sessionTtl).length > 0) {
    raw.session = { ttl: sessionTtl };
  }

  // SmartAssist (optional — requires both baseUrl and apiKey)
  // Support both SMARTASSIST_API_URL (canonical) and SMARTASSIST_URL (legacy alias)
  const smartassistBaseUrl = process.env.SMARTASSIST_API_URL || process.env.SMARTASSIST_URL;
  const smartassistApiKey = process.env.SMARTASSIST_API_KEY;
  if (smartassistBaseUrl && smartassistApiKey) {
    const smartassist: Record<string, unknown> = {
      baseUrl: smartassistBaseUrl,
      apiKey: smartassistApiKey,
    };
    if (process.env.SMARTASSIST_TIMEOUT_MS) {
      smartassist.timeoutMs = Number(process.env.SMARTASSIST_TIMEOUT_MS);
    }
    if (process.env.SMARTASSIST_WEBHOOK_SECRET) {
      smartassist.webhookSecret = process.env.SMARTASSIST_WEBHOOK_SECRET;
    }
    if (process.env.SMARTASSIST_APP_ID) {
      smartassist.appId = process.env.SMARTASSIST_APP_ID;
    }
    if (process.env.SMARTASSIST_ORG_ID || process.env.KORE_ORG_ID) {
      smartassist.orgId = process.env.SMARTASSIST_ORG_ID || process.env.KORE_ORG_ID;
    }
    if (process.env.SMARTASSIST_ACCOUNT_ID || process.env.KORE_ACCOUNT_ID) {
      smartassist.accountId = process.env.SMARTASSIST_ACCOUNT_ID || process.env.KORE_ACCOUNT_ID;
      smartassist.koreAccountId = process.env.KORE_ACCOUNT_ID || process.env.SMARTASSIST_ACCOUNT_ID;
    }
    if (process.env.SMARTASSIST_BOT_SIP_URI) {
      smartassist.botSIPURI = process.env.SMARTASSIST_BOT_SIP_URI;
    }
    if (process.env.SMARTASSIST_CSAT_VOICE_PROMPT) {
      smartassist.csatVoicePrompt = process.env.SMARTASSIST_CSAT_VOICE_PROMPT;
    }
    if (process.env.SMARTASSIST_CSAT_VOICE_THANKYOU) {
      smartassist.csatVoiceThankYou = process.env.SMARTASSIST_CSAT_VOICE_THANKYOU;
    }
    if (process.env.KORE_HOST) {
      smartassist.koreHost = process.env.KORE_HOST;
    }
    if (process.env.KORE_INTERNAL_API_KEY) {
      smartassist.koreApiKey = process.env.KORE_INTERNAL_API_KEY;
    }
    // ABL webhook base URL — tells AgentAssist to dispatch events back to this runtime
    // instead of KoreServer. Uses the same RUNTIME_PUBLIC_BASE_URL / RUNTIME_BASE_URL
    // that other webhook registrations use, or a dedicated override.
    const ablWebhookBaseUrl =
      process.env.ABL_WEBHOOK_BASE_URL ||
      process.env.RUNTIME_PUBLIC_BASE_URL ||
      process.env.RUNTIME_BASE_URL;
    if (ablWebhookBaseUrl) {
      smartassist.ablWebhookBaseUrl = ablWebhookBaseUrl;
    }

    raw.smartassist = smartassist;
  }

  // Voice gateway
  if (process.env.VOICE_GATEWAY_TYPE) {
    raw.voice = { type: process.env.VOICE_GATEWAY_TYPE };
  }

  return AgentTransferConfigSchema.parse(raw);
}
