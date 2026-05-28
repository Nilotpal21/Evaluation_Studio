import { describe, expect, it } from 'vitest';
import { BillingUsageUpdatedDataSchema } from '../schema/events/billing-events.js';

describe('BillingUsageUpdatedDataSchema', () => {
  it('accepts time-window materialization payloads', () => {
    const parsed = BillingUsageUpdatedDataSchema.parse({
      batch_id: 'batch-1',
      trigger_source: 'manual',
      project_scope: 'tenant',
      materialization_basis: 'time_window',
      window_start: '2026-03-30T10:00:00.000Z',
      window_end: '2026-03-30T11:00:00.000Z',
      examined_session_count: 4,
      base_units: 4,
      llm_addon_units: 8,
      tool_addon_units: 2,
      total_units: 14,
      project_breakdown: [
        {
          project_id: 'project-1',
          examined_session_count: 3,
          included_session_count: 3,
          excluded_session_count: 0,
          base_units: 4,
          llm_addon_units: 8,
          tool_addon_units: 2,
          total_units: 14,
        },
      ],
      channel_breakdown: [
        {
          channel: 'api',
          examined_session_count: 4,
          included_session_count: 4,
          excluded_session_count: 0,
          base_units: 4,
          llm_addon_units: 8,
          tool_addon_units: 2,
          total_units: 14,
        },
      ],
    });

    expect(parsed.batch_id).toBe('batch-1');
    expect(parsed.trigger_source).toBe('manual');
    expect(parsed.materialization_basis).toBe('time_window');
    expect(parsed.total_units).toBe(14);
    expect(parsed.project_breakdown?.[0]?.project_id).toBe('project-1');
    expect(parsed.channel_breakdown?.[0]?.channel).toBe('api');
  });

  it('accepts completed-session materialization payloads using camelCase aliases', () => {
    const parsed = BillingUsageUpdatedDataSchema.parse({
      batchId: 'batch-2',
      triggerSource: 'scheduled',
      projectId: 'project-123',
      projectScope: 'project',
      materializationBasis: 'completed_sessions',
      completedSessionCount: 25,
      examinedSessionCount: 25,
      includedSessionCount: 20,
      excludedSessionCount: 5,
      baseUnits: 10,
      totalUnits: 16,
      projectBreakdown: [
        {
          projectId: 'project-123',
          examinedSessionCount: 25,
          includedSessionCount: 20,
          excludedSessionCount: 5,
          baseUnits: 10,
          llmAddonUnits: 4,
          toolAddonUnits: 2,
          totalUnits: 16,
        },
      ],
      channelBreakdown: [
        {
          channel: 'api',
          examinedSessionCount: 25,
          includedSessionCount: 20,
          excludedSessionCount: 5,
          baseUnits: 10,
          llmAddonUnits: 4,
          toolAddonUnits: 2,
          totalUnits: 16,
        },
      ],
    });

    expect(parsed.batchId).toBe('batch-2');
    expect(parsed.projectScope).toBe('project');
    expect(parsed.materializationBasis).toBe('completed_sessions');
    expect(parsed.completedSessionCount).toBe(25);
    expect(parsed.excludedSessionCount).toBe(5);
    expect(parsed.projectBreakdown?.[0]?.projectId).toBe('project-123');
    expect(parsed.channelBreakdown?.[0]?.channel).toBe('api');
  });
});
