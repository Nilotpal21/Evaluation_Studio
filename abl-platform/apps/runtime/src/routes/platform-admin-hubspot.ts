/**
 * Platform Admin — HubSpot Integration Routes
 *
 * Provides webhook endpoint for HubSpot deal lifecycle events and
 * manual sync capability for pulling deal data from HubSpot CRM.
 *
 * Key rules:
 * - POST /webhook — Open endpoint for HubSpot webhook delivery
 * - POST /sync — Requires `requirePlatformAdmin()` for manual sync
 * - Every mutation writes an audit log with `platform-admin:` prefix
 *
 * Mount: /api/platform/admin/hubspot
 */

import { Router } from 'express';
import { z } from 'zod';
import { requirePlatformAdmin, requirePlatformAdminIp } from '@agent-platform/shared-auth';
import { getCurrentRequestId } from '@agent-platform/shared-observability';
import { createLogger } from '@abl/compiler/platform';
import { getConfig } from '../config/index.js';
import { platformAdminAuthMiddleware } from '../middleware/auth.js';
import { writeAuditLog } from '../repos/auth-repo.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { getDeal as getHubSpotDeal, isHubSpotConfigured } from '../services/hubspot-client.js';

const log = createLogger('platform-admin-hubspot');
const router: ReturnType<typeof Router> = Router();

// ─── Validation ───────────────────────────────────────────────────────────

const syncSchema = z.object({
  hubspotDealId: z.string().min(1),
});

// ─── POST /webhook — HubSpot deal lifecycle events ──────────────────────

router.post('/webhook', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const events = Array.isArray(req.body) ? req.body : [req.body];
    const { Deal } = await import('@agent-platform/database/models');

    let processed = 0;

    for (const event of events) {
      const eventType = event.subscriptionType || event.eventType;
      const objectId = String(event.objectId || '');

      if (!objectId) continue;

      try {
        if (eventType === 'deal.creation') {
          // Fetch deal details from HubSpot
          const hubspotDeal = await getHubSpotDeal(objectId);
          if (hubspotDeal) {
            const properties =
              (hubspotDeal as { properties?: Record<string, unknown> }).properties || {};
            const existingDeal = await Deal.findOne({ hubspotDealId: objectId }).lean().exec();
            if (!existingDeal) {
              await Deal.create({
                organizationId: 'pending-assignment',
                hubspotDealId: objectId,
                name: String(properties.dealname || `HubSpot Deal ${objectId}`),
                status: 'active',
                scope: 'organization',
                aggregationMode: 'additive',
                overagePolicy: 'soft_cap',
                creditAllotment: {
                  totalCredits: 0,
                  sharedPoolCredits: 0,
                  featureCredits: {},
                  rolloverPolicy: 'none',
                },
              });
              log.info('Deal created from HubSpot webhook', { hubspotDealId: objectId });
            }
          }
          processed++;
        } else if (eventType === 'deal.propertyChange' || eventType === 'deal.stageChange') {
          const propertyName = event.propertyName;
          const propertyValue = event.propertyValue;

          const updateFields: Record<string, unknown> = {};

          if (propertyName === 'dealstage') {
            // Map HubSpot stages to our status
            const closedStages = ['closedwon', 'closedlost'];
            if (closedStages.includes(String(propertyValue).toLowerCase())) {
              updateFields.status = 'expired';
            }
          } else if (propertyName === 'dealname') {
            updateFields.name = String(propertyValue);
          }

          if (Object.keys(updateFields).length > 0) {
            await Deal.findOneAndUpdate({ hubspotDealId: objectId }, { $set: updateFields }).exec();
            log.info('Deal updated from HubSpot webhook', {
              hubspotDealId: objectId,
              updates: Object.keys(updateFields),
            });
          }
          processed++;
        } else if (eventType === 'deal.deletion') {
          await Deal.findOneAndUpdate(
            { hubspotDealId: objectId },
            { $set: { status: 'canceled' } },
          ).exec();
          log.info('Deal canceled from HubSpot deletion webhook', { hubspotDealId: objectId });
          processed++;
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        log.error('Failed to process HubSpot event', {
          eventType,
          objectId,
          error: message,
        });
      }
    }

    res.json({ success: true, processed });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('HubSpot webhook processing failed', { error: message, requestId });
    res.status(500).json({ success: false, error: 'Webhook processing failed' });
  }
});

// ─── Authenticated Routes ───────────────────────────────────────────────

router.use(platformAdminAuthMiddleware);
router.use(tenantRateLimit('request'));
router.use(requirePlatformAdmin());
router.use(requirePlatformAdminIp(() => getConfig().security.platformAdminAllowedIps));

// ─── POST /sync — Manual sync from HubSpot ─────────────────────────────

router.post('/sync', async (req, res) => {
  const requestId = getCurrentRequestId();
  try {
    if (!isHubSpotConfigured()) {
      res.status(503).json({
        success: false,
        error: 'HubSpot integration is not configured. Set HUBSPOT_API_KEY.',
      });
      return;
    }

    const parsed = syncSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid sync request',
        details: parsed.error.issues,
      });
      return;
    }

    const { hubspotDealId } = parsed.data;
    const adminUserId = req.tenantContext!.userId;

    // Fetch deal from HubSpot
    const hubspotDeal = await getHubSpotDeal(hubspotDealId);
    if (!hubspotDeal) {
      res.status(404).json({
        success: false,
        error: `HubSpot deal ${hubspotDealId} not found or API error`,
      });
      return;
    }

    const properties = (hubspotDeal as { properties?: Record<string, unknown> }).properties || {};
    const { Deal } = await import('@agent-platform/database/models');

    // Upsert deal
    const deal = await Deal.findOneAndUpdate(
      { hubspotDealId },
      {
        $set: {
          hubspotDealId,
          name: String(properties.dealname || `HubSpot Deal ${hubspotDealId}`),
        },
        $setOnInsert: {
          organizationId: 'pending-assignment',
          status: 'active',
          scope: 'organization',
          aggregationMode: 'additive',
          overagePolicy: 'soft_cap',
          creditAllotment: {
            totalCredits: 0,
            sharedPoolCredits: 0,
            featureCredits: {},
            rolloverPolicy: 'none',
          },
        },
      },
      { new: true, upsert: true },
    )
      .lean()
      .exec();

    log.info('HubSpot deal synced', {
      hubspotDealId,
      dealId: String(deal._id),
      adminUserId,
      requestId,
    });
    writeAuditLog({
      action: 'platform-admin:hubspot-sync',
      userId: adminUserId,
      tenantId: 'platform',
      metadata: { hubspotDealId, dealId: String(deal._id), requestId },
    });

    res.json({
      success: true,
      deal,
      hubspot: {
        id: hubspotDealId,
        properties,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('HubSpot sync failed', { error: message, requestId });
    res.status(500).json({ success: false, error: 'HubSpot sync failed' });
  }
});

// ─── GET /status — HubSpot integration status ──────────────────────────

router.get('/status', async (_req, res) => {
  res.json({
    success: true,
    configured: isHubSpotConfigured(),
  });
});

export default router;
