/**
 * HubSpot CRM API Client
 *
 * Lightweight wrapper for HubSpot CRM API v3. Provides typed access to
 * deals, companies, and their associations. Requires HUBSPOT_API_KEY
 * environment variable to be configured.
 */

import { createLogger } from '@abl/compiler/platform';

const log = createLogger('hubspot-client');

// ─── Constants ───────────────────────────────────────────────────────────

const HUBSPOT_API_BASE = 'https://api.hubapi.com';

/** Request timeout in milliseconds */
const REQUEST_TIMEOUT_MS = 10_000;

// ─── Internal Helpers ────────────────────────────────────────────────────

function getApiKey(): string | null {
  return process.env.HUBSPOT_API_KEY || null;
}

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Fetch a single deal from HubSpot by ID.
 */
export async function getDeal(dealId: string): Promise<Record<string, unknown> | null> {
  const apiKey = getApiKey();
  if (!apiKey) {
    log.warn('HUBSPOT_API_KEY not configured');
    return null;
  }

  try {
    const response = await fetch(`${HUBSPOT_API_BASE}/crm/v3/objects/deals/${dealId}`, {
      headers: buildHeaders(apiKey),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      log.warn('HubSpot getDeal failed', { dealId, status: response.status });
      return null;
    }
    return (await response.json()) as Record<string, unknown>;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('HubSpot getDeal error', { dealId, error: message });
    return null;
  }
}

/**
 * Fetch a single company from HubSpot by ID.
 */
export async function getCompany(companyId: string): Promise<Record<string, unknown> | null> {
  const apiKey = getApiKey();
  if (!apiKey) {
    log.warn('HUBSPOT_API_KEY not configured');
    return null;
  }

  try {
    const response = await fetch(`${HUBSPOT_API_BASE}/crm/v3/objects/companies/${companyId}`, {
      headers: buildHeaders(apiKey),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      log.warn('HubSpot getCompany failed', { companyId, status: response.status });
      return null;
    }
    return (await response.json()) as Record<string, unknown>;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('HubSpot getCompany error', { companyId, error: message });
    return null;
  }
}

/**
 * List deal associations for a given company.
 */
export async function listDealsByCompany(
  companyId: string,
): Promise<Array<Record<string, unknown>>> {
  const apiKey = getApiKey();
  if (!apiKey) {
    log.warn('HUBSPOT_API_KEY not configured');
    return [];
  }

  try {
    const response = await fetch(
      `${HUBSPOT_API_BASE}/crm/v3/objects/companies/${companyId}/associations/deals`,
      {
        headers: buildHeaders(apiKey),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );

    if (!response.ok) {
      log.warn('HubSpot listDealsByCompany failed', { companyId, status: response.status });
      return [];
    }
    const data = (await response.json()) as { results?: Array<Record<string, unknown>> };
    return data.results || [];
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('HubSpot listDealsByCompany error', { companyId, error: message });
    return [];
  }
}

/**
 * Check whether HubSpot integration is configured.
 */
export function isHubSpotConfigured(): boolean {
  return getApiKey() !== null;
}
