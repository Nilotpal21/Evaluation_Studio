/**
 * Omnichannel Routes
 *
 * HTTP endpoints for omnichannel session continuity features.
 * Mounted at /api/projects/:projectId/omnichannel
 *
 * POST  /recall                        — Bounded transcript recall for cross-channel continuity
 * GET   /                              — Read omnichannel project settings (for Studio)
 * PATCH /                              — Update omnichannel project settings (for Studio)
 * GET   /live-session                  — Discover active live session for a contact
 * POST  /live-session/:sessionId/join  — Join a live session via HTTP
 * POST  /live-session/:sessionId/detach — Detach from a live session
 * POST  /join-links                    — Issue a one-time join link
 */

import { Router, type Request, type Response, type Router as RouterType } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { createFailClosedFeatureGate } from '../middleware/feature-gate.js';
import { createLogger } from '@abl/compiler/platform';
import { RecallService } from '../services/omnichannel/recall-service.js';
import {
  getOmnichannelSettings,
  updateOmnichannelSettings,
} from '../services/omnichannel/omnichannel-settings-service.js';
import * as liveSessionService from '../services/omnichannel/live-session-service.js';
import { createJoinToken, getParticipants } from '../services/omnichannel/participant-registry.js';
import { queryAuditEvents } from '../services/omnichannel/omnichannel-audit.js';
import { isChannelUser } from '@agent-platform/shared-auth';
import { createParticipant, type ParticipantSurface } from '../services/omnichannel/types.js';

const log = createLogger('omnichannel-routes');

const router: RouterType = Router({ mergeParams: true });

// Middleware chain
router.use(authMiddleware);
router.use(requireProjectScope('projectId', { concealOutOfScope: true }));
router.use(tenantRateLimit('request'));
router.use(createFailClosedFeatureGate('omnichannel_session_continuity'));

// =============================================================================
// SCHEMAS
// =============================================================================

const RecallRequestSchema = z.object({
  /** Contact ID to recall messages for (required since contactId is not on tenantContext) */
  contactId: z.string().min(1),
  maxMessages: z.number().int().min(1).max(100).optional(),
  maxAgeDays: z.number().int().min(1).max(365).optional(),
  allowedChannels: z.array(z.string().min(1)).optional(),
});

const OmnichannelSettingsUpdateSchema = z.object({
  recall: z
    .object({
      enabled: z.boolean().optional(),
      maxMessages: z.number().int().min(1).max(100).optional(),
      maxAgeDays: z.number().int().min(1).max(365).optional(),
      defaultAllowedChannels: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  identity: z
    .object({
      requireVerification: z.boolean().optional(),
      minTier: z.number().int().min(0).max(2).optional(),
    })
    .optional(),
  consent: z
    .object({
      requireExplicitConsent: z.boolean().optional(),
      defaultCapabilities: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  liveSync: z
    .object({
      enabled: z.boolean().optional(),
      joinMode: z.enum(['prompt', 'auto']).optional(),
      transcriptMode: z.enum(['final_only', 'interim']).optional(),
    })
    .optional(),
  retention: z
    .object({
      maxRetentionDays: z.number().int().min(1).max(3650).optional(),
      enableAutoPurge: z.boolean().optional(),
    })
    .optional(),
});

const ProjectIdParamSchema = z.object({
  projectId: z.string().min(1),
});

const LiveSessionDiscoverSchema = z.object({
  contactId: z.string().min(1),
});

const LiveSessionJoinSchema = z.object({
  contactId: z.string().min(1),
  participantId: z.string().min(1),
  surface: z.enum(['voice', 'web', 'mobile', 'api']),
  label: z.string().optional(),
  joinToken: z.string().optional(),
});

const LiveSessionDetachSchema = z.object({
  participantId: z.string().min(1),
});

const SessionIdParamSchema = z.object({
  projectId: z.string().min(1),
  sessionId: z.string().min(1),
});

const JoinLinkSchema = z.object({
  sessionId: z.string().min(1),
  contactId: z.string().min(1),
});

// =============================================================================
// POST /recall — Bounded transcript recall
// Rate limited to 30 requests/minute per tenant (tighter than default)
// =============================================================================

router.post('/recall', tenantRateLimit('session_message'), async (req: Request, res: Response) => {
  try {
    if (!(await requireProjectPermission(req, res, 'session:read'))) return;

    const { projectId } = req.params;
    const tenantId = req.tenantContext?.tenantId;
    const sessionId = req.tenantContext?.sessionId;
    const identityTier = req.tenantContext?.identityTier ?? 0;

    if (!tenantId) {
      res.status(403).json({
        success: false,
        error: { code: 'AUTH_REQUIRED', message: 'Tenant context required' },
      });
      return;
    }

    // Validate projectId param
    const paramResult = ProjectIdParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: 'Invalid project ID' },
      });
      return;
    }

    // Validate request body
    const bodyResult = RecallRequestSchema.safeParse(req.body);
    if (!bodyResult.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid recall request parameters',
        },
      });
      return;
    }

    const { contactId } = bodyResult.data;

    // Require a session context for recall
    if (!sessionId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'NO_SESSION',
          message: 'No session context available for recall',
        },
      });
      return;
    }

    // Check identity requirements from settings
    const settings = await getOmnichannelSettings(tenantId, projectId);

    if (!settings.recall.enabled) {
      res.status(403).json({
        success: false,
        error: {
          code: 'RECALL_DISABLED',
          message: 'Cross-channel recall is not enabled for this project',
        },
      });
      return;
    }

    // Verify identity tier meets minimum requirement
    const minTier = settings.identity.minTier;
    if (identityTier < minTier) {
      log.info('Recall denied — insufficient identity tier', {
        sessionId,
        identityTier,
        minTier,
      });
      res.status(403).json({
        success: false,
        error: {
          code: 'IDENTITY_INSUFFICIENT',
          message: 'Identity verification required for cross-channel recall',
        },
      });
      return;
    }

    // Ownership check: SDK sessions can only recall their own contact's history
    if (req.authContext && isChannelUser(req.authContext)) {
      const callerContactId = req.authContext.callerIdentity?.contactId;
      if (callerContactId && callerContactId !== contactId) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Resource not found' },
        });
        return;
      }
    }

    const recallService = new RecallService(tenantId, projectId);
    const result = await recallService.getRecallMessages({
      sessionId,
      tenantId,
      projectId,
      contactId,
      maxMessages: bodyResult.data.maxMessages ?? settings.recall.maxMessages,
      maxAgeDays: bodyResult.data.maxAgeDays ?? settings.recall.maxAgeDays,
      allowedChannels:
        bodyResult.data.allowedChannels ??
        (settings.recall.defaultAllowedChannels.length > 0
          ? settings.recall.defaultAllowedChannels
          : undefined),
      retentionMaxDays: settings.retention?.maxRetentionDays,
    });

    res.json({ success: true, data: result });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Recall endpoint failed', { error: message });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to execute recall' },
    });
  }
});

// =============================================================================
// GET / — Read omnichannel settings
// =============================================================================

router.get('/', async (req: Request, res: Response) => {
  try {
    if (!(await requireProjectPermission(req, res, 'model_config:read'))) return;

    const { projectId } = req.params;
    const tenantId = req.tenantContext?.tenantId;

    if (!tenantId) {
      res.status(403).json({
        success: false,
        error: { code: 'AUTH_REQUIRED', message: 'Tenant context required' },
      });
      return;
    }

    const paramResult = ProjectIdParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: 'Invalid project ID' },
      });
      return;
    }

    const settings = await getOmnichannelSettings(tenantId, projectId);

    res.json({ success: true, data: settings });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to get omnichannel settings', { error: message });
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to get omnichannel settings',
      },
    });
  }
});

// =============================================================================
// PATCH / — Update omnichannel settings
// =============================================================================

router.patch('/', async (req: Request, res: Response) => {
  try {
    if (!(await requireProjectPermission(req, res, 'model_config:write'))) return;

    const { projectId } = req.params;
    const tenantId = req.tenantContext?.tenantId;

    if (!tenantId) {
      res.status(403).json({
        success: false,
        error: { code: 'AUTH_REQUIRED', message: 'Tenant context required' },
      });
      return;
    }

    const paramResult = ProjectIdParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: 'Invalid project ID' },
      });
      return;
    }

    const bodyResult = OmnichannelSettingsUpdateSchema.safeParse(req.body);
    if (!bodyResult.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid settings update',
        },
      });
      return;
    }

    const settings = await updateOmnichannelSettings(tenantId, projectId, bodyResult.data);

    log.info('Omnichannel settings updated via API', {
      tenantId,
      projectId,
    });

    res.json({ success: true, data: settings });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to update omnichannel settings', { error: message });
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to update omnichannel settings',
      },
    });
  }
});

// =============================================================================
// GET /audit — Query recent omnichannel audit events
// =============================================================================

const AuditQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((val) => {
      if (!val) return 50;
      const parsed = parseInt(val, 10);
      return isNaN(parsed) || parsed < 1 ? 50 : Math.min(parsed, 200);
    }),
});

router.get('/audit', async (req: Request, res: Response) => {
  try {
    if (!(await requireProjectPermission(req, res, 'model_config:read'))) return;

    const { projectId } = req.params;
    const tenantId = req.tenantContext?.tenantId;

    if (!tenantId) {
      res.status(403).json({
        success: false,
        error: { code: 'AUTH_REQUIRED', message: 'Tenant context required' },
      });
      return;
    }

    const paramResult = ProjectIdParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: 'Invalid project ID' },
      });
      return;
    }

    const queryResult = AuditQuerySchema.safeParse(req.query);
    const maxEntries = queryResult.success ? queryResult.data.limit : 50;

    const events = await queryAuditEvents(tenantId, projectId, maxEntries);

    res.json({ success: true, data: { events } });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to query audit events', { error: message });
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to query audit events',
      },
    });
  }
});

// =============================================================================
// GET /live-session — Discover active live session
// =============================================================================

router.get('/live-session', async (req: Request, res: Response) => {
  try {
    if (!(await requireProjectPermission(req, res, 'session:read'))) return;

    const { projectId } = req.params;
    const tenantId = req.tenantContext?.tenantId;
    const identityTier = req.tenantContext?.identityTier ?? 0;

    if (!tenantId) {
      res.status(403).json({
        success: false,
        error: { code: 'AUTH_REQUIRED', message: 'Tenant context required' },
      });
      return;
    }

    const paramResult = ProjectIdParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: 'Invalid project ID' },
      });
      return;
    }

    // contactId from query string
    const queryResult = LiveSessionDiscoverSchema.safeParse(req.query);
    if (!queryResult.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'contactId query parameter required' },
      });
      return;
    }

    const { contactId } = queryResult.data;

    // Ownership check: SDK sessions can only discover their own contact's sessions
    if (req.authContext && isChannelUser(req.authContext)) {
      const callerContactId = req.authContext.callerIdentity?.contactId;
      if (callerContactId && callerContactId !== contactId) {
        res.json({ success: true, data: null });
        return;
      }
    }

    const result = await liveSessionService.discoverLiveSession(
      tenantId,
      projectId,
      contactId,
      identityTier,
    );

    if (!result) {
      res.json({ success: true, data: null });
      return;
    }

    res.json({ success: true, data: result });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Live session discovery failed', { error: message });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to discover live session' },
    });
  }
});

// =============================================================================
// POST /live-session/:sessionId/join — Join a live session via HTTP
// Rate limited to 30 requests/minute per tenant (tighter than default)
// =============================================================================

router.post(
  '/live-session/:sessionId/join',
  tenantRateLimit('session_message'),
  async (req: Request, res: Response) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:send_message'))) return;

      const tenantId = req.tenantContext?.tenantId;
      const identityTier = req.tenantContext?.identityTier ?? 0;

      if (!tenantId) {
        res.status(403).json({
          success: false,
          error: { code: 'AUTH_REQUIRED', message: 'Tenant context required' },
        });
        return;
      }

      const paramResult = SessionIdParamSchema.safeParse(req.params);
      if (!paramResult.success) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_PARAMS', message: 'Invalid project ID or session ID' },
        });
        return;
      }

      const bodyResult = LiveSessionJoinSchema.safeParse(req.body);
      if (!bodyResult.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Invalid join request parameters' },
        });
        return;
      }

      const { projectId, sessionId } = paramResult.data;
      const { contactId, participantId, surface, label, joinToken } = bodyResult.data;

      // Ownership check: SDK sessions can only join as their own contactId
      if (req.authContext && isChannelUser(req.authContext)) {
        const callerContactId = req.authContext.callerIdentity?.contactId;
        if (callerContactId && callerContactId !== contactId) {
          res.status(404).json({
            success: false,
            error: { code: 'NOT_FOUND', message: 'Resource not found' },
          });
          return;
        }
      }

      const result = await liveSessionService.joinLiveSession(
        tenantId,
        projectId,
        sessionId,
        createParticipant({
          participantId,
          sessionId,
          contactId,
          surface: surface as ParticipantSurface,
          label,
        }),
        contactId,
        identityTier,
        joinToken,
      );

      if (!result.success) {
        res.status(403).json({ success: false, error: result.error });
        return;
      }

      res.json({ success: true, data: result });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Live session join failed', { error: message });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to join live session' },
      });
    }
  },
);

// =============================================================================
// POST /live-session/:sessionId/detach — Explicit detach
// =============================================================================

router.post('/live-session/:sessionId/detach', async (req: Request, res: Response) => {
  try {
    if (!(await requireProjectPermission(req, res, 'session:send_message'))) return;

    const tenantId = req.tenantContext?.tenantId;

    if (!tenantId) {
      res.status(403).json({
        success: false,
        error: { code: 'AUTH_REQUIRED', message: 'Tenant context required' },
      });
      return;
    }

    const paramResult = SessionIdParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: 'Invalid project ID or session ID' },
      });
      return;
    }

    const bodyResult = LiveSessionDetachSchema.safeParse(req.body);
    if (!bodyResult.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'participantId required' },
      });
      return;
    }

    const { projectId, sessionId } = paramResult.data;
    const { participantId } = bodyResult.data;

    // Ownership check: SDK sessions can only detach their own participants
    if (req.authContext && isChannelUser(req.authContext)) {
      const callerContactId = req.authContext.callerIdentity?.contactId;
      if (callerContactId) {
        const sessionParticipants = await getParticipants(sessionId);
        const targetParticipant = sessionParticipants.find(
          (p) => p.participantId === participantId,
        );
        if (targetParticipant && targetParticipant.contactId !== callerContactId) {
          res.status(404).json({
            success: false,
            error: { code: 'NOT_FOUND', message: 'Resource not found' },
          });
          return;
        }
      }
    }

    await liveSessionService.detachParticipant(sessionId, participantId, tenantId, projectId);

    res.json({ success: true, data: { detached: true } });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Live session detach failed', { error: message });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to detach from live session' },
    });
  }
});

// =============================================================================
// POST /join-links — Issue a one-time join link
// Rate limited to 30 requests/minute per tenant (tighter than default)
// =============================================================================

router.post(
  '/join-links',
  tenantRateLimit('session_message'),
  async (req: Request, res: Response) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:send_message'))) return;

      const { projectId } = req.params;
      const tenantId = req.tenantContext?.tenantId;
      const identityTier = req.tenantContext?.identityTier ?? 0;

      if (!tenantId) {
        res.status(403).json({
          success: false,
          error: { code: 'AUTH_REQUIRED', message: 'Tenant context required' },
        });
        return;
      }

      // Require verified identity
      if (identityTier < 2) {
        res.status(403).json({
          success: false,
          error: {
            code: 'IDENTITY_INSUFFICIENT',
            message: 'Verified identity required to create join links',
          },
        });
        return;
      }

      const paramResult = ProjectIdParamSchema.safeParse(req.params);
      if (!paramResult.success) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_PARAMS', message: 'Invalid project ID' },
        });
        return;
      }

      const bodyResult = JoinLinkSchema.safeParse(req.body);
      if (!bodyResult.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'sessionId and contactId required' },
        });
        return;
      }

      const { sessionId, contactId } = bodyResult.data;

      const token = await createJoinToken({
        sessionId,
        contactId,
        projectId,
        tenantId,
      });

      res.json({ success: true, data: { token } });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Join link creation failed', { error: message });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to create join link' },
      });
    }
  },
);

export default router;
