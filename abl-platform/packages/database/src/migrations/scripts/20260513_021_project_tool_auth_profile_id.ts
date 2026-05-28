/**
 * Migration: backfill authProfileId on project_tools
 *
 * Adds a denormalized `authProfileId` field to each ProjectTool by parsing
 * the tool's DSL for `auth_profile: <name>` and resolving the name to the
 * matching AuthProfile._id within the same (tenantId, projectId or
 * tenant-inherited) scope.
 *
 * Why: ProjectTool referenced auth profiles only via a free-form string
 * embedded in `dslContent`, so the consumer-count aggregation in
 * apps/studio/src/app/api/projects/[id]/auth-profiles/route.ts could never
 * tally HTTP tools — every other entity (MCPServerConfig, ChannelConnection,
 * ServiceNode, etc.) carries a structured `authProfileId` field, and the
 * aggregation matches on `{ authProfileId: { $in: profileIds } }`. ProjectTool
 * is now brought in line with that contract.
 *
 * Idempotent: only sets authProfileId on docs where the field is missing.
 * Re-runnable: safe to invoke multiple times — subsequent runs are no-ops.
 * Reversible: `down()` unsets the field.
 *
 * Date: 2026-05-13
 */

import mongoose from 'mongoose';
import type { Migration } from '../types.js';

type Db = mongoose.mongo.Db;

const log = {
  info: (msg: string) => process.stdout.write(`[migration] ${msg}\n`),
};

const COLLECTION = 'project_tools';
const AUTH_PROFILES = 'auth_profiles';

/**
 * Extract the auth_profile value from a tool DSL string. The DSL format is
 * line-based YAML-like: indented `auth_profile: <unquoted-or-quoted-name>`
 * under the top-level signature. We accept either form. Returns null when
 * not present or unparseable.
 */
function extractAuthProfileName(dslContent: string): string | null {
  if (typeof dslContent !== 'string' || dslContent.length === 0) return null;
  // Match the FIRST occurrence — DSL has a single tool definition per doc.
  // Allow optional surrounding double-quotes; trim trailing whitespace.
  const match = dslContent.match(/^[\t ]*auth_profile:[\t ]*"?([^"\r\n]+?)"?[\t ]*$/m);
  if (!match) return null;
  const name = match[1].trim();
  return name.length > 0 ? name : null;
}

export const migration: Migration = {
  version: '20260513_021',
  description: 'Backfill authProfileId on project_tools from DSL auth_profile reference',
  transactionMode: 'none',

  async up(db: Db) {
    const tools = db.collection(COLLECTION);
    const profiles = db.collection(AUTH_PROFILES);

    let updated = 0;
    let skippedNoRef = 0;
    let skippedUnresolved = 0;
    let alreadySet = 0;

    const cursor = tools.find({});
    while (await cursor.hasNext()) {
      const doc = await cursor.next();
      if (!doc) continue;

      // Skip docs that already have an explicit value (idempotent rerun).
      if (Object.prototype.hasOwnProperty.call(doc, 'authProfileId')) {
        alreadySet += 1;
        continue;
      }

      const name = extractAuthProfileName(typeof doc.dslContent === 'string' ? doc.dslContent : '');

      if (!name) {
        await tools.updateOne({ _id: doc._id }, { $set: { authProfileId: null } });
        skippedNoRef += 1;
        continue;
      }

      // Resolve in same tenant; prefer project-scoped, fall back to tenant-inherited.
      const profile = await profiles.findOne(
        {
          tenantId: doc.tenantId,
          name,
          $or: [{ projectId: doc.projectId }, { projectId: null }],
        },
        { projection: { _id: 1, projectId: 1 } },
      );

      if (!profile) {
        await tools.updateOne({ _id: doc._id }, { $set: { authProfileId: null } });
        skippedUnresolved += 1;
        continue;
      }

      await tools.updateOne({ _id: doc._id }, { $set: { authProfileId: String(profile._id) } });
      updated += 1;
    }

    log.info(
      `project_tools.authProfileId backfill — resolved=${updated} no-ref=${skippedNoRef} unresolved=${skippedUnresolved} already-set=${alreadySet}`,
    );
  },

  async down(db: Db) {
    const tools = db.collection(COLLECTION);
    const result = await tools.updateMany(
      { authProfileId: { $exists: true } },
      { $unset: { authProfileId: '' } },
    );
    log.info(`project_tools.authProfileId unset on ${result.modifiedCount} docs`);
  },
};
