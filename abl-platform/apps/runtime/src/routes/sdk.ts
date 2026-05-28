/**
 * SDK Routes (Runtime)
 *
 * Runtime-only SDK endpoint: read-only widget config for embedded widgets.
 * Design-time SDK endpoints (key management, config editing) live in Studio.
 */

import { type Router as RouterType } from 'express';
import { createHash } from 'crypto';
import { createOpenAPIRouter, getValidatedRequestData } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import {
  findActivePublicApiKey,
  findPublicApiKeyForSdk,
  findWidgetConfig,
} from '../repos/channel-repo.js';
import {
  originMatchesAllowlist,
  parseAllowedOrigins,
  resolveSdkCorsOrigin,
} from '../middleware/sdk-auth.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('sdk-routes');

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/v1/sdk',
  tags: ['SDK'],
  validateRequests: true,
  wrapAsyncHandlers: true,
});
const router: RouterType = openapi.router;

// =============================================================================
// HELPERS
// =============================================================================

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

// =============================================================================
// SCHEMAS
// =============================================================================

const GetConfigParamsSchema = z.object({
  projectId: z.string().describe('Project ID'),
});

const WidgetThemeSchema = z.record(z.unknown()).optional();

const WidgetConfigSchema = z.object({
  mode: z.string().describe('Widget mode (e.g., "chat")'),
  position: z.string().describe('Widget position (e.g., "bottom-right")'),
  theme: WidgetThemeSchema.describe('Widget theme configuration'),
  welcomeMessage: z.string().optional().describe('Welcome message text'),
  placeholderText: z.string().optional().describe('Input placeholder text'),
  voiceEnabled: z.boolean().describe('Whether voice is enabled'),
  chatEnabled: z.boolean().describe('Whether chat is enabled'),
});

const GetConfigResponseSchema = z.object({
  projectId: z.string().describe('Project ID'),
  permissions: z.record(z.unknown()).describe('API key permissions'),
  config: WidgetConfigSchema.describe('Widget configuration'),
});

// =============================================================================
// ENDPOINTS
// =============================================================================

/**
 * GET /api/v1/sdk/config/:projectId
 * Get widget configuration (public endpoint for embedded widgets)
 * Read-only — does NOT update lastUsedAt (that's a design-time concern)
 */
openapi.route(
  'get',
  '/config/:projectId',
  {
    summary: 'Get widget configuration',
    description:
      'Retrieve widget configuration for embedded SDK integration (requires X-API-Key header)',
    params: GetConfigParamsSchema,
    response: GetConfigResponseSchema,
    auth: false,
  },
  async (req, res) => {
    const validatedParams = getValidatedRequestData(res)?.params as
      | z.infer<typeof GetConfigParamsSchema>
      | undefined;
    const projectId = validatedParams?.projectId ?? req.params.projectId;
    const apiKey = req.headers['x-api-key'] as string;

    if (!apiKey) {
      res.status(401).json({ error: 'API key required' });
      return;
    }

    try {
      // Validate API key
      const keyHash = hashKey(apiKey);
      const publicKey = await findActivePublicApiKey(keyHash, projectId);

      if (!publicKey) {
        res.status(401).json({ error: 'Invalid or expired API key' });
        return;
      }

      // Validate origin
      const allowedOrigins = parseAllowedOrigins(publicKey.allowedOrigins);
      if (
        allowedOrigins &&
        allowedOrigins.length > 0 &&
        !originMatchesAllowlist(allowedOrigins, req.headers.origin)
      ) {
        res.status(403).json({ error: 'Origin not allowed' });
        return;
      }

      const widgetTenantId =
        typeof publicKey.tenantId === 'string' && publicKey.tenantId.length > 0
          ? publicKey.tenantId
          : (await findPublicApiKeyForSdk(keyHash))?.project?.tenantId;
      const widgetConfig =
        typeof widgetTenantId === 'string' && widgetTenantId.length > 0
          ? await findWidgetConfig(projectId, widgetTenantId)
          : null;

      const permissions =
        typeof publicKey.permissions === 'string'
          ? JSON.parse(publicKey.permissions)
          : publicKey.permissions;

      // Set CORS headers for widget access
      const corsOrigin = resolveSdkCorsOrigin(allowedOrigins, req.headers.origin);
      if (corsOrigin) {
        if (corsOrigin === '*') {
          res.setHeader('Access-Control-Allow-Origin', '*');
        } else {
          res.setHeader('Access-Control-Allow-Origin', corsOrigin); // nosemgrep: javascript.express.security.cors-misconfiguration.cors-misconfiguration -- corsOrigin is the normalized origin returned from a validated allowlist/wildcard match.
        }
        res.setHeader('Access-Control-Allow-Headers', 'X-API-Key, Content-Type');
        if (corsOrigin !== '*') {
          res.setHeader('Vary', 'Origin');
        }
      }

      const theme = widgetConfig?.theme
        ? typeof widgetConfig.theme === 'string'
          ? JSON.parse(widgetConfig.theme)
          : widgetConfig.theme
        : {};

      res.json({
        projectId,
        permissions,
        config: widgetConfig
          ? {
              mode: widgetConfig.mode,
              position: widgetConfig.position,
              theme,
              welcomeMessage: widgetConfig.welcomeMessage,
              placeholderText: widgetConfig.placeholderText,
              voiceEnabled: widgetConfig.voiceEnabled,
              chatEnabled: widgetConfig.chatEnabled,
            }
          : {
              mode: 'chat',
              position: 'bottom-right',
              theme: {},
              chatEnabled: true,
              voiceEnabled: false,
            },
      });

      log.info('SDK config served', { projectId });
    } catch (error) {
      log.error('SDK config error', { error });
      res.status(500).json({ error: 'Failed to fetch configuration' });
    }
  },
);

export default router;
