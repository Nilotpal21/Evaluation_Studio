/**
 * Connector Notification Service
 *
 * Manages notification preferences (email alerts, webhook) for connectors.
 * Also handles webhook test requests with SSRF protection.
 */

import dns from 'dns';
import { createLogger } from '@abl/compiler/platform';
import { ConnectorError } from './connector.service.js';
import { getLazyModel } from '../db/index.js';
import type { IConnectorConfig } from '@agent-platform/database/models';

const logger = createLogger('connector-notification-service');

// ─── Types ──────────────────────────────────────────────────────────────

export interface NotificationConfigData {
  emailAlertsEnabled: boolean;
  emailEvents: string[];
  webhookUrl: string | null;
  webhookEvents: string[];
}

// ─── SSRF Protection ────────────────────────────────────────────────────

const PRIVATE_IP_RANGES = [
  // 127.0.0.0/8
  { start: 0x7f000000, end: 0x7fffffff },
  // 10.0.0.0/8
  { start: 0x0a000000, end: 0x0affffff },
  // 172.16.0.0/12
  { start: 0xac100000, end: 0xac1fffff },
  // 192.168.0.0/16
  { start: 0xc0a80000, end: 0xc0a8ffff },
  // 169.254.0.0/16 (link-local)
  { start: 0xa9fe0000, end: 0xa9feffff },
];

function ipToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isPrivateIp(ip: string): boolean {
  // IPv6 loopback
  if (ip === '::1' || ip === '0:0:0:0:0:0:0:1') return true;

  // IPv4
  const num = ipToInt(ip);
  return PRIVATE_IP_RANGES.some((range) => num >= range.start && num <= range.end);
}

async function validateUrlNotPrivate(url: string): Promise<void> {
  const parsed = new URL(url);
  const hostname = parsed.hostname;

  try {
    const result = await dns.promises.lookup(hostname);
    if (isPrivateIp(result.address)) {
      throw new ConnectorError('SSRF_BLOCKED', 'URL resolves to a private/loopback address', 400);
    }
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    // DNS resolution failed — let the actual request fail naturally
    logger.warn('DNS lookup failed for webhook URL', { hostname });
  }
}

// ─── Service Functions ──────────────────────────────────────────────────

/** Get notification configuration for a connector. */
export async function getNotificationConfig(
  connectorId: string,
  tenantId: string,
): Promise<NotificationConfigData> {
  const ConnectorConfig = getLazyModel<IConnectorConfig>('ConnectorConfig');
  const connector = await ConnectorConfig.findOne({ _id: connectorId, tenantId }).lean();
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  const notifications = (connector as any).notifications;
  return {
    emailAlertsEnabled: notifications?.emailAlertsEnabled ?? false,
    emailEvents: notifications?.emailEvents ?? [],
    webhookUrl: notifications?.webhookUrl ?? null,
    webhookEvents: notifications?.webhookEvents ?? [],
  };
}

/** Update notification configuration (partial merge). */
export async function updateNotificationConfig(
  connectorId: string,
  tenantId: string,
  updates: Partial<NotificationConfigData>,
): Promise<NotificationConfigData> {
  const setFields: Record<string, unknown> = {};
  if (updates.emailAlertsEnabled !== undefined) {
    setFields['notifications.emailAlertsEnabled'] = updates.emailAlertsEnabled;
  }
  if (updates.emailEvents !== undefined) {
    setFields['notifications.emailEvents'] = updates.emailEvents;
  }
  if (updates.webhookUrl !== undefined) {
    setFields['notifications.webhookUrl'] = updates.webhookUrl;
  }
  if (updates.webhookEvents !== undefined) {
    setFields['notifications.webhookEvents'] = updates.webhookEvents;
  }

  if (Object.keys(setFields).length === 0) {
    return getNotificationConfig(connectorId, tenantId);
  }

  const ConnectorConfig = getLazyModel<IConnectorConfig>('ConnectorConfig');
  const updated = await ConnectorConfig.findOneAndUpdate(
    { _id: connectorId, tenantId },
    { $set: setFields },
    { new: true },
  ).lean();

  if (!updated) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  const notifications = (updated as any).notifications;
  return {
    emailAlertsEnabled: notifications?.emailAlertsEnabled ?? false,
    emailEvents: notifications?.emailEvents ?? [],
    webhookUrl: notifications?.webhookUrl ?? null,
    webhookEvents: notifications?.webhookEvents ?? [],
  };
}

/** Test a webhook URL by sending a sample payload. Includes SSRF protection. */
export async function testWebhook(
  url: string,
  connectorId: string,
  tenantId: string,
): Promise<{ success: boolean; statusCode?: number; error?: string }> {
  // SSRF protection: validate URL does not resolve to private IP
  try {
    await validateUrlNotPrivate(url);
  } catch (error) {
    if (error instanceof ConnectorError) {
      return { success: false, error: error.message };
    }
  }

  const payload = {
    event: 'test',
    connectorId,
    tenantId,
    severity: 'info',
    timestamp: new Date().toISOString(),
    message: 'Webhook test from ABL Platform',
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      logger.info('Webhook test successful', { connectorId, url, status: response.status });
      return { success: true, statusCode: response.status };
    }

    return {
      success: false,
      statusCode: response.status,
      error: `HTTP ${response.status} ${response.statusText}`,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn('Webhook test failed', { connectorId, url, error: msg });
    return { success: false, error: msg };
  }
}
