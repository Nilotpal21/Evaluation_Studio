/**
 * Template Install Helpers
 *
 * Server-side functions for the template install flow.
 * Bundle fetch uses internal HTTP to the template-store service
 * (NOT through the browser — server-to-server via TEMPLATE_STORE_URL).
 */

import 'server-only';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { AppError } from '@agent-platform/shared/errors';

const log = createLogger('template-install');

// ─── Constants ──────────────────────────────────────────────────────────

function getTemplateStoreUrl(): string {
  return process.env.TEMPLATE_STORE_URL || 'http://localhost:3115';
}

// ─── Validation Schemas ─────────────────────────────────────────────────

const SLUG_REGEX = /^[a-z0-9-]+$/;
const SEMVER_REGEX = /^\d+\.\d+\.\d+$/;

export const ProjectInstallBodySchema = z.object({
  templateSlug: z.string().min(1).max(100).regex(SLUG_REGEX, 'Invalid template slug format'),
  version: z.string().min(1).max(20).regex(SEMVER_REGEX, 'Invalid version format'),
  projectName: z.string().trim().min(1, 'Project name is required').max(100),
  projectSlug: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens')
    .optional(),
  description: z.string().trim().max(500).optional(),
});
export type ProjectInstallBody = z.infer<typeof ProjectInstallBodySchema>;

export const AgentPreviewBodySchema = z.object({
  templateSlug: z.string().min(1).max(100).regex(SLUG_REGEX, 'Invalid template slug format'),
  version: z.string().min(1).max(20).regex(SEMVER_REGEX, 'Invalid version format'),
});
export type AgentPreviewBody = z.infer<typeof AgentPreviewBodySchema>;

export const AgentApplyBodySchema = z.object({
  templateSlug: z.string().min(1).max(100).regex(SLUG_REGEX, 'Invalid template slug format'),
  version: z.string().min(1).max(20).regex(SEMVER_REGEX, 'Invalid version format'),
  previewDigest: z.string().nullable().optional(),
  acknowledgedIssueIds: z.array(z.string()).optional(),
});
export type AgentApplyBody = z.infer<typeof AgentApplyBodySchema>;

// ─── Bundle Fetch ───────────────────────────────────────────────────────

/**
 * Fetch a template bundle from the template-store service (server-side).
 * Uses internal HTTP — NOT through the Studio proxy or browser.
 *
 * @param slug - Template slug
 * @param version - Semver version string
 * @param authorization - Authorization header value from the original request
 *                        (forwarded to template-store for auth)
 * @returns Record<string, string> — the files bundle (relative path → content)
 */
export async function fetchTemplateBundle(
  slug: string,
  version: string,
  authorization: string,
  tenantId?: string,
): Promise<Record<string, string>> {
  const baseUrl = getTemplateStoreUrl();
  // Pass tenantId as query param so the bundle endpoint can scope to tenant templates.
  // The auth header may not be verifiable by template-store (different JWT context).
  const queryParams = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : '';
  const url = `${baseUrl}/api/v1/marketplace/templates/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}/bundle${queryParams}`;

  log.info('Fetching template bundle', { slug, version, baseUrl });

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        // No Authorization header — bundle endpoint is public.
        // Forwarding Studio's JWT causes 401 because template-store
        // uses a different JWT secret and optionalAuth rejects invalid tokens.
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Template-store connection failed', { slug, version, error: message });
    throw new AppError('Template store service is unavailable', {
      code: 'TEMPLATE_STORE_UNAVAILABLE',
      statusCode: 502,
    });
  }

  if (!response.ok) {
    if (response.status === 404) {
      throw new AppError(`Template "${slug}" version "${version}" not found`, {
        code: 'TEMPLATE_NOT_FOUND',
        statusCode: 404,
      });
    }
    const body = await response.text().catch(() => '');
    log.error('Bundle fetch failed', { slug, version, status: response.status, body });
    throw new AppError(`Failed to fetch template bundle (${response.status})`, {
      code: 'BUNDLE_FETCH_FAILED',
      statusCode: 502,
    });
  }

  const data = await response.json();
  const files = data?.data?.files;

  if (!files || typeof files !== 'object') {
    throw new AppError('Template bundle response has unexpected format', {
      code: 'BUNDLE_INVALID',
      statusCode: 502,
    });
  }

  log.info('Template bundle fetched', {
    slug,
    version,
    fileCount: Object.keys(files).length,
  });

  return files as Record<string, string>;
}

// ─── Install Event Notification ─────────────────────────────────────────

/**
 * Notify the template-store service of a successful install.
 * Fire-and-forget — errors are logged but not thrown.
 */
export async function notifyInstallEvent(input: {
  slug: string;
  version: string;
  userId: string;
  tenantId: string;
  projectId: string;
  authorization: string;
}): Promise<void> {
  const baseUrl = getTemplateStoreUrl();
  const url = `${baseUrl}/api/v1/marketplace/templates/${encodeURIComponent(input.slug)}/install-event`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // No Authorization — install-event endpoint uses optionalAuth
        // and Studio/template-store have different JWT secrets
      },
      body: JSON.stringify({
        userId: input.userId,
        tenantId: input.tenantId,
        projectId: input.projectId,
        version: input.version,
      }),
    });

    if (!response.ok) {
      log.warn('Install event notification failed', {
        slug: input.slug,
        status: response.status,
      });
    } else {
      log.info('Install event recorded', { slug: input.slug, projectId: input.projectId });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('Install event notification error', { slug: input.slug, error: message });
  }
}

// ─── Provisioning Report ────────────────────────────────────────────────

/**
 * Fetch template prerequisites from the template-store detail endpoint
 * and return as the provisioning report.
 * Falls back to empty arrays if the fetch fails.
 */
export async function fetchTemplatePrerequisites(
  slug: string,
  authorization: string,
): Promise<{
  envVars: string[];
  connectors: string[];
  mcpServers: string[];
  authProfiles: string[];
}> {
  const baseUrl = getTemplateStoreUrl();
  const url = `${baseUrl}/api/v1/marketplace/templates/${encodeURIComponent(slug)}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        // No Authorization — template detail endpoint is public
      },
    });

    if (!response.ok) {
      return { envVars: [], connectors: [], mcpServers: [], authProfiles: [] };
    }

    const data = await response.json();
    const prereqs = data?.data?.template?.prerequisites;
    if (!prereqs || typeof prereqs !== 'object') {
      return { envVars: [], connectors: [], mcpServers: [], authProfiles: [] };
    }

    return {
      envVars: Array.isArray(prereqs.envVars) ? prereqs.envVars : [],
      connectors: Array.isArray(prereqs.connectors) ? prereqs.connectors : [],
      mcpServers: Array.isArray(prereqs.mcpServers) ? prereqs.mcpServers : [],
      authProfiles: Array.isArray(prereqs.authProfiles) ? prereqs.authProfiles : [],
    };
  } catch {
    return { envVars: [], connectors: [], mcpServers: [], authProfiles: [] };
  }
}
