import { describe, expect, it } from 'vitest';
import type { BillingUsageMaterializationSessionResult } from '../types/api.js';
import {
  buildTenantMaterializationApplyPath,
  buildTenantMaterializationApplicationPath,
  buildTenantMaterializationDetailPath,
  buildTenantMaterializationResultsPath,
  canApplyBillingPublicationBatch,
  canLoadBillingPublicationApplication,
  filterBillingSessionResults,
  getBillingSessionResultsFilterCounts,
  searchBillingSessionResults,
} from '../lib/billing-publication.js';

describe('billing publication helpers', () => {
  it('allows operator apply only for completed batches pending publication', () => {
    expect(
      canApplyBillingPublicationBatch({
        batchId: 'batch-1',
        projectId: null,
        triggerSource: 'scheduled',
        materializationStatus: 'completed',
        applicationStatus: 'missing',
        publicationStatus: 'pending',
        publicationReason: 'billing_usage_report_publication_pending',
        resultCount: 3,
        totalUnits: 9,
        eventDispatchAttempted: true,
        startedAt: '2026-04-01T00:00:00.000Z',
        completedAt: '2026-04-01T00:05:00.000Z',
        publishedAt: null,
        applicationId: null,
      }),
    ).toBe(true);
  });

  it('blocks apply for not-ready or already published batches', () => {
    expect(
      canApplyBillingPublicationBatch({
        batchId: 'batch-2',
        projectId: null,
        triggerSource: 'manual',
        materializationStatus: 'running',
        applicationStatus: 'missing',
        publicationStatus: 'not_ready',
        publicationReason: 'materialization_still_running',
        resultCount: 0,
        totalUnits: 0,
        eventDispatchAttempted: false,
        startedAt: '2026-04-01T00:00:00.000Z',
        completedAt: null,
        publishedAt: null,
        applicationId: null,
      }),
    ).toBe(false);

    expect(
      canApplyBillingPublicationBatch({
        batchId: 'batch-3',
        projectId: null,
        triggerSource: 'scheduled',
        materializationStatus: 'completed',
        applicationStatus: 'projected',
        publicationStatus: 'published',
        publicationReason: null,
        resultCount: 4,
        totalUnits: 12,
        eventDispatchAttempted: true,
        startedAt: '2026-04-01T00:00:00.000Z',
        completedAt: '2026-04-01T00:05:00.000Z',
        publishedAt: '2026-04-01T00:06:00.000Z',
        applicationId: 'application-1',
      }),
    ).toBe(false);
  });

  it('detects when application detail is available to load', () => {
    expect(
      canLoadBillingPublicationApplication({
        batchId: 'batch-4',
        projectId: null,
        triggerSource: 'scheduled',
        materializationStatus: 'completed',
        applicationStatus: 'projected',
        publicationStatus: 'published',
        publicationReason: null,
        resultCount: 4,
        totalUnits: 12,
        eventDispatchAttempted: true,
        startedAt: '2026-04-01T00:00:00.000Z',
        completedAt: '2026-04-01T00:05:00.000Z',
        publishedAt: '2026-04-01T00:06:00.000Z',
        applicationId: 'application-1',
      }),
    ).toBe(true);

    expect(
      canLoadBillingPublicationApplication({
        batchId: 'batch-5',
        projectId: null,
        triggerSource: 'scheduled',
        materializationStatus: 'completed',
        applicationStatus: 'missing',
        publicationStatus: 'pending',
        publicationReason: 'billing_usage_report_application_missing',
        resultCount: 2,
        totalUnits: 4,
        eventDispatchAttempted: true,
        startedAt: '2026-04-01T00:00:00.000Z',
        completedAt: '2026-04-01T00:05:00.000Z',
        publishedAt: null,
        applicationId: null,
      }),
    ).toBe(false);
  });

  it('builds tenant billing materialization paths with encoded tenant and batch ids', () => {
    expect(buildTenantMaterializationApplyPath('tenant-123', 'batch-123')).toBe(
      '/api/tenants/tenant-123/usage/materializations/batch-123/apply',
    );
    expect(buildTenantMaterializationDetailPath('tenant-123', 'batch-123')).toBe(
      '/api/tenants/tenant-123/usage/materializations/batch-123',
    );
    expect(buildTenantMaterializationApplicationPath('tenant-123', 'batch-123')).toBe(
      '/api/tenants/tenant-123/usage/materializations/batch-123/application',
    );
    expect(buildTenantMaterializationResultsPath('tenant-123', 'batch-123', 2, 5)).toBe(
      '/api/tenants/tenant-123/usage/materializations/batch-123/results?page=2&limit=5',
    );
    expect(
      buildTenantMaterializationApplyPath('tenant/needs encoding', 'batch/needs encoding'),
    ).toBe(
      '/api/tenants/tenant%2Fneeds%20encoding/usage/materializations/batch%2Fneeds%20encoding/apply',
    );
    expect(
      buildTenantMaterializationDetailPath('tenant/needs encoding', 'batch/needs encoding'),
    ).toBe(
      '/api/tenants/tenant%2Fneeds%20encoding/usage/materializations/batch%2Fneeds%20encoding',
    );
    expect(
      buildTenantMaterializationApplicationPath('tenant/needs encoding', 'batch/needs encoding'),
    ).toBe(
      '/api/tenants/tenant%2Fneeds%20encoding/usage/materializations/batch%2Fneeds%20encoding/application',
    );
    expect(
      buildTenantMaterializationResultsPath('tenant/needs encoding', 'batch/needs encoding', 3, 10),
    ).toBe(
      '/api/tenants/tenant%2Fneeds%20encoding/usage/materializations/batch%2Fneeds%20encoding/results?page=3&limit=10',
    );
  });

  it('derives included and excluded session counts for the current results page', () => {
    const counts = getBillingSessionResultsFilterCounts([
      {
        sessionId: 'session-1',
        projectId: 'project-1',
        subscriptionId: 'subscription-1',
        batchId: 'batch-1',
        sequence: 0,
        triggerSource: 'scheduled',
        materializationBasis: 'time_window',
        channel: 'web',
        status: 'completed',
        disposition: 'completed',
        sessionType: 'reactive',
        startedAt: '2026-04-01T00:00:00.000Z',
        endedAt: '2026-04-01T00:15:00.000Z',
        durationSeconds: 900,
        userMessageCount: 3,
        assistantMessageCount: 3,
        toolMessageCount: 0,
        interactiveTurnCount: 3,
        engagedSeconds: 720,
        llmCallCount: 2,
        toolCallCount: 0,
        metricsSource: 'clickhouse',
        included: true,
        exclusionReasons: [],
        baseUnits: 1,
        llmAddonUnits: 0,
        toolAddonUnits: 0,
        totalUnits: 1,
        createdAt: '2026-04-01T00:16:00.000Z',
        updatedAt: '2026-04-01T00:16:00.000Z',
      },
      {
        sessionId: 'session-2',
        projectId: 'project-1',
        subscriptionId: 'subscription-1',
        batchId: 'batch-1',
        sequence: 1,
        triggerSource: 'scheduled',
        materializationBasis: 'time_window',
        channel: 'voice',
        status: 'completed',
        disposition: 'completed',
        sessionType: 'proactive',
        startedAt: '2026-04-01T01:00:00.000Z',
        endedAt: '2026-04-01T01:02:00.000Z',
        durationSeconds: 120,
        userMessageCount: 0,
        assistantMessageCount: 1,
        toolMessageCount: 0,
        interactiveTurnCount: 0,
        engagedSeconds: 0,
        llmCallCount: 0,
        toolCallCount: 0,
        metricsSource: 'message_fallback',
        included: false,
        exclusionReasons: ['proactive_no_reply'],
        baseUnits: 0,
        llmAddonUnits: 0,
        toolAddonUnits: 0,
        totalUnits: 0,
        createdAt: '2026-04-01T01:03:00.000Z',
        updatedAt: '2026-04-01T01:03:00.000Z',
      },
      {
        sessionId: 'session-3',
        projectId: 'project-2',
        subscriptionId: 'subscription-1',
        batchId: 'batch-1',
        sequence: 2,
        triggerSource: 'manual',
        materializationBasis: 'completed_sessions',
        channel: 'sms',
        status: 'completed',
        disposition: 'completed',
        sessionType: 'reactive',
        startedAt: '2026-04-01T02:00:00.000Z',
        endedAt: '2026-04-01T02:10:00.000Z',
        durationSeconds: 600,
        userMessageCount: 1,
        assistantMessageCount: 1,
        toolMessageCount: 1,
        interactiveTurnCount: 1,
        engagedSeconds: 300,
        llmCallCount: 1,
        toolCallCount: 1,
        metricsSource: 'clickhouse',
        included: false,
        exclusionReasons: ['manual_review_excluded'],
        baseUnits: 0,
        llmAddonUnits: 0,
        toolAddonUnits: 0,
        totalUnits: 0,
        createdAt: '2026-04-01T02:11:00.000Z',
        updatedAt: '2026-04-01T02:11:00.000Z',
      },
    ]);

    expect(counts).toEqual({
      all: 3,
      included: 1,
      excluded: 2,
    });
  });

  it('filters session results by included and excluded outcomes', () => {
    const sessions: BillingUsageMaterializationSessionResult[] = [
      {
        sessionId: 'session-1',
        projectId: 'project-1',
        subscriptionId: 'subscription-1',
        batchId: 'batch-1',
        sequence: 0,
        triggerSource: 'scheduled',
        materializationBasis: 'time_window',
        channel: 'web',
        status: 'completed',
        disposition: 'completed',
        sessionType: 'reactive',
        startedAt: '2026-04-01T00:00:00.000Z',
        endedAt: '2026-04-01T00:15:00.000Z',
        durationSeconds: 900,
        userMessageCount: 3,
        assistantMessageCount: 3,
        toolMessageCount: 0,
        interactiveTurnCount: 3,
        engagedSeconds: 720,
        llmCallCount: 2,
        toolCallCount: 0,
        metricsSource: 'clickhouse',
        included: true,
        exclusionReasons: [],
        baseUnits: 1,
        llmAddonUnits: 0,
        toolAddonUnits: 0,
        totalUnits: 1,
        createdAt: '2026-04-01T00:16:00.000Z',
        updatedAt: '2026-04-01T00:16:00.000Z',
      },
      {
        sessionId: 'session-2',
        projectId: 'project-1',
        subscriptionId: 'subscription-1',
        batchId: 'batch-1',
        sequence: 1,
        triggerSource: 'scheduled',
        materializationBasis: 'time_window',
        channel: 'voice',
        status: 'completed',
        disposition: 'completed',
        sessionType: 'proactive',
        startedAt: '2026-04-01T01:00:00.000Z',
        endedAt: '2026-04-01T01:02:00.000Z',
        durationSeconds: 120,
        userMessageCount: 0,
        assistantMessageCount: 1,
        toolMessageCount: 0,
        interactiveTurnCount: 0,
        engagedSeconds: 0,
        llmCallCount: 0,
        toolCallCount: 0,
        metricsSource: 'message_fallback',
        included: false,
        exclusionReasons: ['proactive_no_reply'],
        baseUnits: 0,
        llmAddonUnits: 0,
        toolAddonUnits: 0,
        totalUnits: 0,
        createdAt: '2026-04-01T01:03:00.000Z',
        updatedAt: '2026-04-01T01:03:00.000Z',
      },
    ];

    expect(filterBillingSessionResults(sessions, 'all')).toEqual(sessions);
    expect(filterBillingSessionResults(sessions, 'included')).toEqual([sessions[0]]);
    expect(filterBillingSessionResults(sessions, 'excluded')).toEqual([sessions[1]]);
  });

  it('searches session results by session id, project, channel, and exclusion reason', () => {
    const sessions: BillingUsageMaterializationSessionResult[] = [
      {
        sessionId: 'session-web-123',
        projectId: 'project-alpha',
        subscriptionId: 'subscription-1',
        batchId: 'batch-1',
        sequence: 0,
        triggerSource: 'scheduled',
        materializationBasis: 'time_window',
        channel: 'web',
        status: 'completed',
        disposition: 'completed',
        sessionType: 'reactive',
        startedAt: '2026-04-01T00:00:00.000Z',
        endedAt: '2026-04-01T00:15:00.000Z',
        durationSeconds: 900,
        userMessageCount: 3,
        assistantMessageCount: 3,
        toolMessageCount: 0,
        interactiveTurnCount: 3,
        engagedSeconds: 720,
        llmCallCount: 2,
        toolCallCount: 0,
        metricsSource: 'clickhouse',
        included: true,
        exclusionReasons: [],
        baseUnits: 1,
        llmAddonUnits: 0,
        toolAddonUnits: 0,
        totalUnits: 1,
        createdAt: '2026-04-01T00:16:00.000Z',
        updatedAt: '2026-04-01T00:16:00.000Z',
      },
      {
        sessionId: 'session-voice-456',
        projectId: 'project-beta',
        subscriptionId: 'subscription-1',
        batchId: 'batch-1',
        sequence: 1,
        triggerSource: 'scheduled',
        materializationBasis: 'time_window',
        channel: 'voice',
        status: 'completed',
        disposition: 'completed',
        sessionType: 'proactive',
        startedAt: '2026-04-01T01:00:00.000Z',
        endedAt: '2026-04-01T01:02:00.000Z',
        durationSeconds: 120,
        userMessageCount: 0,
        assistantMessageCount: 1,
        toolMessageCount: 0,
        interactiveTurnCount: 0,
        engagedSeconds: 0,
        llmCallCount: 0,
        toolCallCount: 0,
        metricsSource: 'message_fallback',
        included: false,
        exclusionReasons: ['proactive_no_reply'],
        baseUnits: 0,
        llmAddonUnits: 0,
        toolAddonUnits: 0,
        totalUnits: 0,
        createdAt: '2026-04-01T01:03:00.000Z',
        updatedAt: '2026-04-01T01:03:00.000Z',
      },
    ];

    expect(searchBillingSessionResults(sessions, 'session-voice')).toEqual([sessions[1]]);
    expect(searchBillingSessionResults(sessions, 'project-alpha')).toEqual([sessions[0]]);
    expect(searchBillingSessionResults(sessions, 'VOICE')).toEqual([sessions[1]]);
    expect(searchBillingSessionResults(sessions, 'proactive_no_reply')).toEqual([sessions[1]]);
    expect(searchBillingSessionResults(sessions, '   ')).toEqual(sessions);
  });
});
