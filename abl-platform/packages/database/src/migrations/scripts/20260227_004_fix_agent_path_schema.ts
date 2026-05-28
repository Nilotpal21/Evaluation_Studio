/**
 * Migration: Fix Agent Path Schema
 *
 * Updates existing ProjectAgent documents to use the new 3-segment agentPath format:
 * `{projectId}/{domain}/{name}` instead of the old `{domain}/{name}` format.
 *
 * This ensures:
 * - Agent names can be reused across different projects
 * - Global uniqueness constraint on agentPath works correctly
 * - Consistent path schema across all agents (UI-created and imported)
 *
 * Date: 2026-02-27
 */

import mongoose from 'mongoose';
import type { Migration } from '../types.js';
import { validationFailed, validationPassed } from '../validation.js';

type Db = mongoose.mongo.Db;

export const migration: Migration = {
  version: '20260227_004',
  description: 'Update agentPath to include projectId prefix for cross-project uniqueness',

  async up(db: Db) {
    const collection = db.collection('project_agents');

    console.log('[migration] Checking project_agents for old path format...');

    // Find all agents where agentPath doesn't contain projectId prefix
    // Old format: "default/agent_name" or "domain/agent_name"
    // New format: "projectId/domain/agent_name"
    const agents = await collection
      .find({
        // Match documents where agentPath doesn't start with the projectId
        $expr: {
          $ne: [
            { $indexOfBytes: ['$agentPath', { $toString: '$projectId' }] },
            0, // Should start at position 0
          ],
        },
      })
      .toArray();

    console.log(`[migration] Found ${agents.length} agents with old path format`);

    if (agents.length === 0) {
      console.log('[migration] No agents need updating');
      return;
    }

    let updated = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const agent of agents) {
      try {
        const agentId = agent._id;
        const projectId = agent.projectId;
        const name = agent.name;
        const domain = agent.domain || 'default';
        const oldPath = agent.agentPath;

        // Build new path: projectId/domain/name
        const newPath = `${projectId}/${domain}/${name}`;

        // Check if the new path already exists (collision detection)
        const collision = await collection.findOne({
          agentPath: newPath,
          _id: { $ne: agentId },
        });

        if (collision) {
          console.warn(
            `[migration] WARNING: Path collision for agent ${agentId} (${name}): "${newPath}" already exists`,
          );
          errors.push(
            `Agent ${agentId} "${name}": path collision with existing agent ${collision._id}`,
          );
          skipped++;
          continue;
        }

        // Update the agentPath
        await collection.updateOne({ _id: agentId }, { $set: { agentPath: newPath } });

        updated++;

        if (updated % 10 === 0) {
          console.log(`[migration] Updated ${updated}/${agents.length} agents`);
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.error(`[migration] Error updating agent ${agent._id}:`, error);
        errors.push(`Agent ${agent._id}: ${error}`);
        skipped++;
      }
    }

    console.log(`[migration] Successfully updated ${updated} agents`);

    if (skipped > 0) {
      console.warn(`[migration] Skipped ${skipped} agents due to errors/collisions`);
    }

    if (errors.length > 0) {
      console.warn('[migration] Errors encountered:');
      errors.forEach((err) => console.warn(`  - ${err}`));
      console.warn('[migration] Some agents were not migrated. Review and fix manually if needed.');
    }
  },

  async down(db: Db) {
    const collection = db.collection('project_agents');

    console.log('[migration] Reverting agentPath changes...');

    // Find all agents where agentPath contains projectId prefix (3 segments)
    const agents = await collection
      .find({
        agentPath: { $regex: /^[^/]+\/[^/]+\/[^/]+$/ }, // Matches: segment/segment/segment
      })
      .toArray();

    console.log(`[migration] Found ${agents.length} agents with new path format`);

    if (agents.length === 0) {
      console.log('[migration] No agents need reverting');
      return;
    }

    let reverted = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const agent of agents) {
      try {
        const agentId = agent._id;
        const projectId = agent.projectId;
        const currentPath = agent.agentPath;

        // Remove projectId prefix to revert to old format
        // "projectId/domain/name" -> "domain/name"
        if (currentPath.startsWith(`${projectId}/`)) {
          const oldPath = currentPath.substring(String(projectId).length + 1); // +1 for the slash

          // Check for collision with old path
          const collision = await collection.findOne({
            agentPath: oldPath,
            _id: { $ne: agentId },
          });

          if (collision) {
            console.warn(
              `[migration] WARNING: Cannot revert agent ${agentId}: path "${oldPath}" already exists`,
            );
            errors.push(`Agent ${agentId}: cannot revert due to collision with ${collision._id}`);
            skipped++;
            continue;
          }

          await collection.updateOne({ _id: agentId }, { $set: { agentPath: oldPath } });

          reverted++;

          if (reverted % 10 === 0) {
            console.log(`[migration] Reverted ${reverted}/${agents.length} agents`);
          }
        } else {
          console.warn(`[migration] Agent ${agentId} path doesn't start with projectId, skipping`);
          skipped++;
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.error(`[migration] Error reverting agent ${agent._id}:`, error);
        errors.push(`Agent ${agent._id}: ${error}`);
        skipped++;
      }
    }

    console.log(`[migration] Successfully reverted ${reverted} agents`);

    if (skipped > 0) {
      console.warn(`[migration] Skipped ${skipped} agents due to errors/collisions`);
    }

    if (errors.length > 0) {
      console.warn('[migration] Errors encountered:');
      errors.forEach((err) => console.warn(`  - ${err}`));
    }
  },

  async validate(db: Db) {
    const collection = db.collection('project_agents');
    const remaining = await collection.countDocuments({
      $expr: {
        $ne: [{ $indexOfBytes: ['$agentPath', { $toString: '$projectId' }] }, 0],
      },
    });

    if (remaining > 0) {
      return validationFailed('Some project agents still use the legacy agentPath shape', {
        remaining,
      });
    }

    return validationPassed('All project agents are scoped by projectId in agentPath', {
      remaining,
    });
  },
};

export default migration;
