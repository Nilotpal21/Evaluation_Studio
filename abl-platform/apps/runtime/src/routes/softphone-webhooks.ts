/**
 * Softphone Webhook Routes (Runtime)
 *
 * Jambonz-facing webhook endpoints for WebRTC softphone SIP device applications.
 * These are called by Jambonz (not by Studio directly), so they are unauthenticated.
 *
 * POST /register   — SIP device registration hook (sipdevicereg-<tenantId>)
 * POST /call       — SIP device call hook (sipdevicecall-<tenantId>)
 */

import express, { type Router as RouterType } from 'express';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('softphone-webhooks');

const router: RouterType = express.Router();

// Parse JSON bodies (Jambonz sends webhooks as application/json)
router.use(express.json());

/**
 * POST /api/v1/voice/softphone/register
 *
 * Called by Jambonz when a WebRTC device registers via the sipdevicereg-<tenantId>
 * application. Returns 200 OK to accept the registration.
 */
router.post('/register', (req, res) => {
  log.info('Softphone SIP device registration webhook', {
    from: req.body?.from,
    sip_realm: req.body?.sip?.headers?.['X-Sip-Realm'],
  });

  res.json({ status: 'ok' });
});

/**
 * POST /api/v1/voice/softphone/call
 *
 * Called by Jambonz when a WebRTC device initiates an outbound call via the
 * sipdevicecall-<tenantId> application. Extracts the destination phone number
 * from the SIP URI, looks up the application configured for that number in
 * Jambonz, and returns a redirect verb to hand off to that application's
 * call_hook — so the call gets the same instructions as an inbound call.
 */
router.post('/call', async (req, res) => {
  try {
    const { to, from, call_sid } = req.body;

    log.info('Softphone outbound call webhook', { call_sid, from, to });

    if (!to) {
      log.warn('Softphone call webhook missing "to" field', { call_sid });
      res.json([{ verb: 'hangup' }]);
      return;
    }

    // Extract phone number from SIP URI: "sip:+15551234567@domain" → "+15551234567"
    // Also handles plain phone numbers without sip: prefix
    let phoneNumber = to;
    if (phoneNumber.startsWith('sip:')) {
      phoneNumber = phoneNumber.slice(4);
    }
    if (phoneNumber.includes('@')) {
      phoneNumber = phoneNumber.split('@')[0];
    }

    if (!phoneNumber) {
      log.warn('Could not extract phone number from "to" field', { to, call_sid });
      res.json([{ verb: 'hangup' }]);
      return;
    }

    log.info('Softphone looking up application for number', { phoneNumber, call_sid });

    // Look up the phone number in Jambonz to find its configured application
    const { getJambonzProvisioningService } =
      await import('../services/voice/jambonz-provisioning.service.js');
    const jambonz = getJambonzProvisioningService();
    const phoneRecord = await jambonz.findPhoneNumberByNumber(phoneNumber);

    if (!phoneRecord?.application_sid) {
      log.warn('No application configured for phone number', { phoneNumber, call_sid });
      res.json([{ verb: 'hangup' }]);
      return;
    }

    const app = await jambonz.getApplication(phoneRecord.application_sid);
    const callHookUrl = app.call_hook?.url;

    if (!callHookUrl) {
      log.warn('Application has no call_hook URL', {
        applicationSid: phoneRecord.application_sid,
        call_sid,
      });
      res.json([{ verb: 'hangup' }]);
      return;
    }

    log.info('Softphone redirecting to application', {
      phoneNumber,
      applicationSid: phoneRecord.application_sid,
      applicationName: app.name,
      callHookUrl,
      call_sid,
    });

    res.json([
      {
        verb: 'redirect',
        actionHook: callHookUrl,
      },
    ]);
  } catch (err) {
    log.error('Softphone call webhook error', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.json([{ verb: 'hangup' }]);
  }
});

export default router;
