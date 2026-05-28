/**
 * Capability Management API Routes - API-11 to API-16
 *
 * CRUD endpoints for managing system capabilities (aggregations, operators, sort functions).
 * Admin-only mutations with proper tenant isolation.
 *
 * **Routes:**
 * - GET    /capabilities                      - List capabilities (API-11)
 * - GET    /capabilities/:capabilityId        - Get capability by ID (API-12)
 * - POST   /capabilities                      - Create capability (API-13, Admin)
 * - PUT    /capabilities/:capabilityId        - Update capability (API-14, Admin)
 * - POST   /capabilities/:capabilityId/toggle - Toggle capability (API-15, Admin)
 * - DELETE /capabilities/:capabilityId        - Delete capability (API-16, Admin)
 */

import { Router, type Request, type Response, type IRouter } from 'express';
import { z } from 'zod';
import { CapabilityService } from '../services/capability/capability.service.js';
import { authMiddleware } from '../middleware/auth.js';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('CapabilitiesRoutes');
const router: IRouter = Router();
router.use(authMiddleware);

// ─── Validation Schemas ──────────────────────────────────────────────────

const CreateCapabilitySchema = z.object({
  name: z.string().min(1).max(50),
  type: z.enum(['aggregation', 'operator', 'sort']),
  description: z.string().min(1).max(500),
  supportedFieldTypes: z.array(z.string()).min(1),
  triggerKeywords: z.array(z.string()).min(1).max(20),
  examples: z.array(z.string()).min(1).max(10),
});

const UpdateCapabilitySchema = z.object({
  description: z.string().min(1).max(500).optional(),
  supportedFieldTypes: z.array(z.string()).min(1).optional(),
  triggerKeywords: z.array(z.string()).min(1).max(20).optional(),
  examples: z.array(z.string()).min(1).max(10).optional(),
});

// ─── Helper Functions ────────────────────────────────────────────────────

/**
 * Extract authenticated user context from request
 */
function getUserContext(req: Request): { tenantId: string; userId: string; role?: string } {
  const user = (req as any).user;
  if (!user || !user.tenantId) {
    throw new Error('UNAUTHORIZED: Missing user context');
  }
  return {
    tenantId: user.tenantId,
    userId: user.id || user.userId,
    role: user.role,
  };
}

/**
 * Check if user has admin role
 */
function isAdmin(role?: string): boolean {
  return role === 'admin' || role === 'owner';
}

/**
 * Standard error response
 */
function errorResponse(res: Response, error: unknown, defaultStatus = 500) {
  if (error instanceof Error) {
    const message = error.message;

    if (message.startsWith('CAPABILITY_NOT_FOUND')) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'CAPABILITY_NOT_FOUND',
          message: 'Capability not found',
        },
      });
    }

    if (message.startsWith('VALIDATION_ERROR')) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: message.replace('VALIDATION_ERROR: ', ''),
        },
      });
    }

    if (message.startsWith('UNAUTHORIZED')) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: message.replace('UNAUTHORIZED: ', ''),
        },
      });
    }

    if (message.startsWith('FORBIDDEN')) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: message.replace('FORBIDDEN: ', ''),
        },
      });
    }

    if (message.includes('already exists')) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'DUPLICATE_NAME',
          message,
        },
      });
    }
  }

  logger.error('Unhandled error in capabilities routes', {
    error: error instanceof Error ? error.message : String(error),
  });

  return res.status(defaultStatus).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    },
  });
}

// ─── API-11: List Capabilities ───────────────────────────────────────────

/**
 * API-11: List capabilities
 * GET /capabilities
 *
 * Public endpoint - returns all capabilities for tenant
 * Optional filters: type, enabled
 */
router.get('/capabilities', async (req: Request, res: Response) => {
  try {
    const { tenantId } = getUserContext(req);
    const { type, enabled } = req.query;

    const service = new CapabilityService();
    const capabilities = await service.listCapabilities({
      tenantId,
      type: type as 'aggregation' | 'operator' | 'sort' | undefined,
      enabled: enabled === 'true' ? true : enabled === 'false' ? false : undefined,
    });

    res.json({
      success: true,
      data: {
        capabilities,
        total: capabilities.length,
      },
    });

    logger.info('Capabilities listed', {
      tenantId,
      count: capabilities.length,
      filters: { type, enabled },
    });
  } catch (error) {
    errorResponse(res, error);
  }
});

// ─── API-12: Get Capability by ID ────────────────────────────────────────

/**
 * API-12: Get capability by ID
 * GET /capabilities/:capabilityId
 *
 * Public endpoint - returns single capability
 */
router.get('/capabilities/:capabilityId', async (req: Request, res: Response) => {
  try {
    const { tenantId } = getUserContext(req);
    const { capabilityId } = req.params;

    const service = new CapabilityService();
    const capability = await service.getCapabilityById(tenantId, capabilityId);

    if (!capability) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'CAPABILITY_NOT_FOUND',
          message: 'Capability not found',
        },
      });
    }

    res.json({
      success: true,
      data: { capability },
    });

    logger.info('Capability retrieved', {
      tenantId,
      capabilityId,
    });
  } catch (error) {
    errorResponse(res, error);
  }
});

// ─── API-13: Create Capability ───────────────────────────────────────────

/**
 * API-13: Create capability
 * POST /capabilities
 *
 * Admin only - creates new capability
 */
router.post('/capabilities', async (req: Request, res: Response) => {
  try {
    const { tenantId, role } = getUserContext(req);

    // Check admin role
    if (!isAdmin(role)) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Admin role required',
        },
      });
    }

    // Validate request body
    const validation = CreateCapabilitySchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request body',
          details: validation.error.errors,
        },
      });
    }

    const service = new CapabilityService();
    const capability = await service.createCapability({
      tenantId,
      ...validation.data,
      createdBy: 'admin',
    });

    res.status(201).json({
      success: true,
      data: {
        capability,
        message: 'Capability created successfully',
      },
    });

    logger.info('Capability created', {
      tenantId,
      capabilityId: capability._id,
      name: capability.name,
      type: capability.type,
    });
  } catch (error) {
    errorResponse(res, error);
  }
});

// ─── API-14: Update Capability ───────────────────────────────────────────

/**
 * API-14: Update capability
 * PUT /capabilities/:capabilityId
 *
 * Admin only - updates existing capability
 */
router.put('/capabilities/:capabilityId', async (req: Request, res: Response) => {
  try {
    const { tenantId, role } = getUserContext(req);
    const { capabilityId } = req.params;

    // Check admin role
    if (!isAdmin(role)) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Admin role required',
        },
      });
    }

    // Validate request body
    const validation = UpdateCapabilitySchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request body',
          details: validation.error.errors,
        },
      });
    }

    const service = new CapabilityService();
    const capability = await service.updateCapability(tenantId, capabilityId, validation.data);

    if (!capability) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'CAPABILITY_NOT_FOUND',
          message: 'Capability not found',
        },
      });
    }

    res.json({
      success: true,
      data: {
        capability,
        message: 'Capability updated successfully',
      },
    });

    logger.info('Capability updated', {
      tenantId,
      capabilityId,
      updatedFields: Object.keys(validation.data),
    });
  } catch (error) {
    errorResponse(res, error);
  }
});

// ─── API-15: Toggle Capability ───────────────────────────────────────────

/**
 * API-15: Toggle capability
 * POST /capabilities/:capabilityId/toggle
 *
 * Admin only - enable/disable capability
 */
router.post('/capabilities/:capabilityId/toggle', async (req: Request, res: Response) => {
  try {
    const { tenantId, role } = getUserContext(req);
    const { capabilityId } = req.params;
    const { enabled } = req.body;

    // Check admin role
    if (!isAdmin(role)) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Admin role required',
        },
      });
    }

    // Validate enabled field
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'enabled field must be a boolean',
        },
      });
    }

    const service = new CapabilityService();
    const capability = await service.toggleCapability(tenantId, capabilityId, enabled);

    if (!capability) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'CAPABILITY_NOT_FOUND',
          message: 'Capability not found',
        },
      });
    }

    res.json({
      success: true,
      data: {
        capability,
        message: `Capability ${enabled ? 'enabled' : 'disabled'} successfully`,
      },
    });

    logger.info('Capability toggled', {
      tenantId,
      capabilityId,
      enabled,
    });
  } catch (error) {
    errorResponse(res, error);
  }
});

// ─── API-16: Delete Capability ───────────────────────────────────────────

/**
 * API-16: Delete capability
 * DELETE /capabilities/:capabilityId
 *
 * Admin only - delete capability (use with caution)
 */
router.delete('/capabilities/:capabilityId', async (req: Request, res: Response) => {
  try {
    const { tenantId, role } = getUserContext(req);
    const { capabilityId } = req.params;

    // Check admin role
    if (!isAdmin(role)) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Admin role required',
        },
      });
    }

    const service = new CapabilityService();
    const deleted = await service.deleteCapability(tenantId, capabilityId);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'CAPABILITY_NOT_FOUND',
          message: 'Capability not found',
        },
      });
    }

    res.json({
      success: true,
      data: {
        deleted: true,
        message: 'Capability deleted successfully',
      },
    });

    logger.warn('Capability deleted', {
      tenantId,
      capabilityId,
    });
  } catch (error) {
    errorResponse(res, error);
  }
});

// ─── Export ──────────────────────────────────────────────────────────────

export default router;
