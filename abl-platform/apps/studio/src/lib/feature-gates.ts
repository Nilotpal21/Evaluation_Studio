/**
 * Feature gate utilities for Studio API routes.
 * Fail-closed: returns false on any error.
 */

import { ensureDb } from './ensure-db';

/**
 * Check if code tools are enabled for a tenant.
 * Reads tenant.settings.codeToolsEnabled from MongoDB.
 * Fails closed: returns false on any error.
 */
export async function isCodeToolsEnabled(tenantId: string): Promise<boolean> {
  try {
    await ensureDb();
    const { Tenant } = await import('@agent-platform/database/models');
    const tenant = await Tenant.findOne({ _id: tenantId }, { 'settings.codeToolsEnabled': 1 })
      .lean()
      .exec();
    return (tenant as any)?.settings?.codeToolsEnabled === true;
  } catch {
    return false; // Fail closed
  }
}
