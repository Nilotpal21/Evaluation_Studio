/**
 * Deployment event schemas.
 *
 * Events related to deployment lifecycle.
 */

import { z } from 'zod';
import { eventRegistry } from '../event-registry.js';
import { EVENT_CATEGORIES } from '../event-categories.js';

// ─── deployment.created ────────────────────────────────────────────────────

export const DeploymentCreatedDataSchema = z
  .object({
    environment: z.string().optional(),
    entry_agent: z.string().optional(),
    entryAgent: z.string().optional(),
    agent_count: z.number().optional(),
    agentCount: z.number().optional(),
    created_by: z.string().optional(),
    createdBy: z.string().optional(),
  })
  .passthrough();

eventRegistry.register('deployment.created', DeploymentCreatedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.DEPLOYMENT,
  containsPII: false,
  description: 'New deployment created',
});

// ─── deployment.retired ────────────────────────────────────────────────────

export const DeploymentRetiredDataSchema = z
  .object({
    draining_started_at: z.string().optional(),
    drainingStartedAt: z.string().optional(),
    linked_channel_count: z.number().optional(),
    linkedChannelCount: z.number().optional(),
    retired_by: z.string().optional(),
    retiredBy: z.string().optional(),
  })
  .passthrough();

eventRegistry.register('deployment.retired', DeploymentRetiredDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.DEPLOYMENT,
  containsPII: false,
  description: 'Deployment retired (draining)',
});

// ─── deployment.rolled_back ────────────────────────────────────────────────

export const DeploymentRolledBackDataSchema = z
  .object({
    previous_deployment_id: z.string().optional(),
    previousDeploymentId: z.string().optional(),
    channels_updated: z.number().optional(),
    channelsUpdated: z.number().optional(),
    rolled_back_by: z.string().optional(),
    rolledBackBy: z.string().optional(),
  })
  .passthrough();

eventRegistry.register('deployment.rolled_back', DeploymentRolledBackDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.DEPLOYMENT,
  containsPII: false,
  description: 'Deployment rolled back to previous version',
});
