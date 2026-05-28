/**
 * Billing event schemas.
 *
 * Events emitted by the billing domain after usage materialization.
 */

import { z } from 'zod';
import { eventRegistry } from '../event-registry.js';
import { EVENT_CATEGORIES } from '../event-categories.js';

const BILLING_USAGE_UPDATED_BASIS_VALUES = ['time_window', 'completed_sessions'] as const;

const BillingUsageUpdatedBreakdownCountsSchema = z
  .object({
    examined_session_count: z.number().int().min(0).optional(),
    examinedSessionCount: z.number().int().min(0).optional(),
    included_session_count: z.number().int().min(0).optional(),
    includedSessionCount: z.number().int().min(0).optional(),
    excluded_session_count: z.number().int().min(0).optional(),
    excludedSessionCount: z.number().int().min(0).optional(),
    base_units: z.number().min(0).optional(),
    baseUnits: z.number().min(0).optional(),
    llm_addon_units: z.number().min(0).optional(),
    llmAddonUnits: z.number().min(0).optional(),
    tool_addon_units: z.number().min(0).optional(),
    toolAddonUnits: z.number().min(0).optional(),
    total_units: z.number().min(0).optional(),
    totalUnits: z.number().min(0).optional(),
  })
  .passthrough();

const BillingUsageUpdatedProjectBreakdownSchema = BillingUsageUpdatedBreakdownCountsSchema.extend({
  project_id: z.string().optional(),
  projectId: z.string().optional(),
}).passthrough();

const BillingUsageUpdatedChannelBreakdownSchema = BillingUsageUpdatedBreakdownCountsSchema.extend({
  channel: z.string().optional(),
}).passthrough();

export const BillingUsageUpdatedDataSchema = z
  .object({
    batch_id: z.string().optional(),
    batchId: z.string().optional(),
    trigger_source: z.enum(['manual', 'scheduled']).optional(),
    triggerSource: z.enum(['manual', 'scheduled']).optional(),
    project_id: z.string().optional(),
    projectId: z.string().optional(),
    project_scope: z.enum(['tenant', 'project']).optional(),
    projectScope: z.enum(['tenant', 'project']).optional(),
    materialization_basis: z.enum(BILLING_USAGE_UPDATED_BASIS_VALUES).optional(),
    materializationBasis: z.enum(BILLING_USAGE_UPDATED_BASIS_VALUES).optional(),
    period_label: z.string().optional(),
    periodLabel: z.string().optional(),
    window_start: z.string().optional(),
    windowStart: z.string().optional(),
    window_end: z.string().optional(),
    windowEnd: z.string().optional(),
    completed_session_count: z.number().int().min(0).optional(),
    completedSessionCount: z.number().int().min(0).optional(),
    examined_session_count: z.number().int().min(0).optional(),
    examinedSessionCount: z.number().int().min(0).optional(),
    included_session_count: z.number().int().min(0).optional(),
    includedSessionCount: z.number().int().min(0).optional(),
    excluded_session_count: z.number().int().min(0).optional(),
    excludedSessionCount: z.number().int().min(0).optional(),
    base_units: z.number().min(0).optional(),
    baseUnits: z.number().min(0).optional(),
    llm_addon_units: z.number().min(0).optional(),
    llmAddonUnits: z.number().min(0).optional(),
    tool_addon_units: z.number().min(0).optional(),
    toolAddonUnits: z.number().min(0).optional(),
    total_units: z.number().min(0).optional(),
    totalUnits: z.number().min(0).optional(),
    project_breakdown: z.array(BillingUsageUpdatedProjectBreakdownSchema).optional(),
    projectBreakdown: z.array(BillingUsageUpdatedProjectBreakdownSchema).optional(),
    channel_breakdown: z.array(BillingUsageUpdatedChannelBreakdownSchema).optional(),
    channelBreakdown: z.array(BillingUsageUpdatedChannelBreakdownSchema).optional(),
  })
  .passthrough();

export type BillingUsageUpdatedData = z.infer<typeof BillingUsageUpdatedDataSchema>;

eventRegistry.register('billing.usage.updated', BillingUsageUpdatedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.BILLING,
  containsPII: false,
  description: 'Billing usage materialized for dashboard consumption',
});
