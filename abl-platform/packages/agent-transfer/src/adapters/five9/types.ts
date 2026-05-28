/**
 * Five9 Adapter Types
 *
 * TypeScript interfaces for Five9 Virtual Contact Center API
 * communication, authentication, and webhook payloads.
 */

export interface Five9Credentials {
  tenantName: string;
  campaignName: string;
  host: string; // default: 'app.five9.com'
  authMode: 'anonymous' | 'supervisor';
  username?: string; // required when authMode === 'supervisor'
  password?: string; // required when authMode === 'supervisor'
  callbackUrl?: string; // override; default constructed from runtime URL
}

export interface Five9AuthResult {
  tokenId: string;
  orgId: string;
  farmId: string;
  targetHost: string; // resolved data center host
}

export interface Five9WebhookPayload {
  type: string;
  conversationId: string;
  data?: Record<string, unknown>;
  message?: string;
  agentInfo?: Record<string, unknown>;
  timestamp?: string;
}

/**
 * Five9 metadata/auth response shape.
 * The metadata endpoint returns the same shape as the auth response —
 * dataCenters live under `metadata`, and farmId under `context`.
 */
export interface Five9MetadataResponse {
  orgId: string;
  context: {
    farmId: string;
    cloudClientUrl?: string;
    cloudTokenUrl?: string;
  };
  metadata: {
    freedomUrl?: string;
    dataCenters: Array<{
      name: string;
      active?: boolean;
      uiUrls: Array<{ host: string; port: string; routeKey?: string; version?: string }>;
      apiUrls: Array<{ host: string; port: string; routeKey?: string; version?: string }>;
      loginUrls: Array<{ host: string; port: string; routeKey?: string; version?: string }>;
    }>;
  };
}

/**
 * Five9 conversation creation response shape.
 */
export interface Five9ConversationResponse {
  conversationId: string;
}

/**
 * Five9 authentication response shape.
 */
export interface Five9AuthResponse {
  tokenId: string;
  orgId: string;
  context: {
    farmId: string;
  };
}

/**
 * Five9 logged_in_profiles response shape.
 * GET /appsvcs/rs/svc/agents/{tokenId}/logged_in_profiles?profiles=...
 */
export interface Five9AgentProfileResponse {
  profileId: string;
  profileName: string;
  agentLoggedIn: boolean;
  noServiceMessage: string;
  emailRequired: boolean;
  restrictions: {
    maxNameLength: number;
    maxEmailLength: number;
    maxQuestionLength: number;
  };
  enableCustomerRequestChatTranscript: boolean;
  chatbotEnabled: boolean;
  enableRoutingAfterBusinessHours: boolean;
  enableRoutingWhenNoAgentsAreLoggedIn: boolean;
  openForBusiness: boolean;
}
