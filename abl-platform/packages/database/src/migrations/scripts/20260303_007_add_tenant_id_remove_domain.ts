/**
 * Migration: Add tenantId to ProjectAgent, remove domain field
 *
 * 1. Backfills tenantId from parent Project document
 * 2. Simplifies agentPath from projectId/domain/name to projectId/name
 * 3. Removes the domain field
 *
 * Date: 2026-03-03
 */

import mongoose from 'mongoose';
import type { Migration } from '../types.js';
import { validationFailed, validationPassed } from '../validation.js';

type Db = mongoose.mongo.Db;

export const migration: Migration = {
  version: '20260303_007',
  description: 'Add tenantId to project_agents and remove domain field',

  async up(db: Db) {
    const agentsCol = db.collection('project_agents');
    const projectsCol = db.collection('projects');

    // Step 1: Backfill tenantId from parent project
    console.log('[migration] Backfilling tenantId on project_agents...');

    const agentsWithoutTenant = await agentsCol.find({ tenantId: { $exists: false } }).toArray();

    console.log(`[migration] Found ${agentsWithoutTenant.length} agents without tenantId`);

    if (agentsWithoutTenant.length > 0) {
      // Build project → tenant map
      const projectIds = [...new Set(agentsWithoutTenant.map((a) => a.projectId))];
      const projects = await projectsCol
        .find({ _id: { $in: projectIds } }, { projection: { _id: 1, tenantId: 1 } })
        .toArray();
      const projectTenantMap = new Map(projects.map((p) => [String(p._id), p.tenantId]));

      let updated = 0;
      const bulkOps: any[] = [];

      for (const agent of agentsWithoutTenant) {
        const tenantId = projectTenantMap.get(String(agent.projectId));
        if (!tenantId) {
          console.warn(
            `[migration] Agent ${agent._id} has projectId ${agent.projectId} with no matching project — skipping`,
          );
          continue;
        }
        bulkOps.push({
          updateOne: {
            filter: { _id: agent._id },
            update: { $set: { tenantId } },
          },
        });
        updated++;
      }

      if (bulkOps.length > 0) {
        await agentsCol.bulkWrite(bulkOps);
      }
      console.log(`[migration] Backfilled tenantId on ${updated} agents`);
    }

    // Step 2: Simplify agentPath from projectId/domain/name to projectId/name
    console.log('[migration] Simplifying agentPath (removing domain segment)...');

    const agentsWithDomain = await agentsCol
      .find({
        // Match 3-segment paths: projectId/domain/name
        agentPath: { $regex: /^[^/]+\/[^/]+\/[^/]+$/ },
      })
      .toArray();

    console.log(`[migration] Found ${agentsWithDomain.length} agents with 3-segment paths`);

    if (agentsWithDomain.length > 0) {
      const pathOps: any[] = [];
      for (const agent of agentsWithDomain) {
        const parts = agent.agentPath.split('/');
        if (parts.length === 3) {
          // projectId/domain/name → projectId/name
          const newPath = `${parts[0]}/${parts[2]}`;
          pathOps.push({
            updateOne: {
              filter: { _id: agent._id },
              update: {
                $set: { agentPath: newPath },
                $unset: { domain: '' },
              },
            },
          });
        }
      }

      if (pathOps.length > 0) {
        await agentsCol.bulkWrite(pathOps);
      }
      console.log(`[migration] Updated ${pathOps.length} agent paths`);
    }

    // Step 3: Remove domain from any remaining agents
    const remaining = await agentsCol.updateMany(
      { domain: { $exists: true } },
      { $unset: { domain: '' } },
    );
    console.log(`[migration] Removed domain field from ${remaining.modifiedCount} agents`);

    // Step 4: Drop old domain index if it exists
    try {
      await agentsCol.dropIndex('domain_1');
      console.log('[migration] Dropped domain_1 index');
    } catch {
      // Index may not exist
    }

    console.log('[migration] Migration complete');
  },

  async down(db: Db) {
    const agentsCol = db.collection('project_agents');

    // Restore domain field with default value
    await agentsCol.updateMany({ domain: { $exists: false } }, { $set: { domain: 'default' } });

    // Restore 3-segment agentPath
    const agents = await agentsCol.find({ agentPath: { $regex: /^[^/]+\/[^/]+$/ } }).toArray();

    if (agents.length > 0) {
      const ops = agents.map((agent) => ({
        updateOne: {
          filter: { _id: agent._id },
          update: {
            $set: {
              agentPath: `${agent.projectId}/default/${agent.name}`,
            },
          },
        },
      }));
      await agentsCol.bulkWrite(ops);
    }

    // Note: tenantId is NOT removed in down() as it's a safety field
    console.log('[migration] Rollback complete (domain restored, tenantId preserved)');
  },

  async validate(db: Db) {
    const agentsCol = db.collection('project_agents');
    const [missingTenantId, lingeringDomainField, threeSegmentPaths] = await Promise.all([
      agentsCol.countDocuments({ tenantId: { $exists: false } }),
      agentsCol.countDocuments({ domain: { $exists: true } }),
      agentsCol.countDocuments({ agentPath: { $regex: /^[^/]+\/[^/]+\/[^/]+$/ } }),
    ]);

    if (missingTenantId > 0 || lingeringDomainField > 0 || threeSegmentPaths > 0) {
      return validationFailed('project_agents still contain pre-migration tenant/domain fields', {
        missingTenantId,
        lingeringDomainField,
        threeSegmentPaths,
      });
    }

    return validationPassed('project_agents have tenantId populated and no legacy domain segment', {
      missingTenantId,
      lingeringDomainField,
      threeSegmentPaths,
    });
  },
};

export default migration;
