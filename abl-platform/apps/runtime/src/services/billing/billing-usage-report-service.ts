import { createLogger } from '@abl/compiler/platform';
import { BillingUsagePublishedSession } from '@agent-platform/database/models';

const log = createLogger('billing-usage-report-service');

const DEFAULT_LOOKBACK_DAYS = 30;
const REPORT_TIMEZONE = 'UTC';
const MAX_BUCKETS_BY_GRANULARITY = {
  hour: 24 * 31,
  day: 366,
  week: 104,
  month: 60,
} as const;

export type BillingUsageReportGranularity = 'hour' | 'day' | 'week' | 'month';
export const BILLING_USAGE_REPORT_GRANULARITY_VALUES = ['hour', 'day', 'week', 'month'] as const;

export type BillingUsageReportErrorCode = 'INVALID_WINDOW_RANGE' | 'WINDOW_TOO_LARGE';

export class BillingUsageReportError extends Error {
  readonly code: BillingUsageReportErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: BillingUsageReportErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export interface GetBillingUsageReportInput {
  tenantId: string;
  projectId?: string;
  windowStart?: Date;
  windowEnd?: Date;
  granularity?: BillingUsageReportGranularity;
}

export interface GetPlatformBillingUsageReportInput {
  windowStart?: Date;
  windowEnd?: Date;
  granularity?: BillingUsageReportGranularity;
}

export interface BillingUsageReportMetricsView {
  examinedSessionCount: number;
  includedSessionCount: number;
  excludedSessionCount: number;
  durationSeconds: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolMessageCount: number;
  interactiveTurnCount: number;
  engagedSeconds: number;
  llmCallCount: number;
  toolCallCount: number;
  baseUnits: number;
  llmAddonUnits: number;
  toolAddonUnits: number;
  totalUnits: number;
}

export interface BillingUsageReportWindowView extends BillingUsageReportMetricsView {
  windowStart: string;
  windowEnd: string;
}

export interface BillingUsageProjectBreakdownView extends BillingUsageReportMetricsView {
  projectId: string;
}

export interface BillingUsageChannelBreakdownView extends BillingUsageReportMetricsView {
  channel: string;
}

export interface BillingUsageTenantBreakdownView extends BillingUsageReportMetricsView {
  tenantId: string;
  tenantName: string;
}

export interface BillingUsageReportView {
  tenantId: string;
  projectId: string | null;
  granularity: BillingUsageReportGranularity;
  range: {
    windowStart: string;
    windowEnd: string;
    timeZone: 'UTC';
  };
  totals: BillingUsageReportMetricsView;
  windows: BillingUsageReportWindowView[];
  projectBreakdown: BillingUsageProjectBreakdownView[];
  channelBreakdown: BillingUsageChannelBreakdownView[];
}

export interface PlatformBillingUsageReportView {
  tenantId: null;
  projectId: null;
  granularity: BillingUsageReportGranularity;
  range: {
    windowStart: string;
    windowEnd: string;
    timeZone: 'UTC';
  };
  totals: BillingUsageReportMetricsView;
  windows: BillingUsageReportWindowView[];
  tenantBreakdown: BillingUsageTenantBreakdownView[];
  projectBreakdown: BillingUsageProjectBreakdownView[];
  channelBreakdown: BillingUsageChannelBreakdownView[];
}

interface ResolvedReportWindow {
  start: Date;
  end: Date;
}

interface ReportWindowInput {
  windowStart?: Date;
  windowEnd?: Date;
}

interface AggregatedMetrics extends BillingUsageReportMetricsView {
  _id?: Date | string | null;
}

interface TenantNameRecord {
  _id: string;
  name?: string;
}

function createZeroMetrics(): BillingUsageReportMetricsView {
  return {
    examinedSessionCount: 0,
    includedSessionCount: 0,
    excludedSessionCount: 0,
    durationSeconds: 0,
    userMessageCount: 0,
    assistantMessageCount: 0,
    toolMessageCount: 0,
    interactiveTurnCount: 0,
    engagedSeconds: 0,
    llmCallCount: 0,
    toolCallCount: 0,
    baseUnits: 0,
    llmAddonUnits: 0,
    toolAddonUnits: 0,
    totalUnits: 0,
  };
}

function cloneMetrics(
  source: Partial<AggregatedMetrics> | undefined | null,
): BillingUsageReportMetricsView {
  const zero = createZeroMetrics();
  if (!source) {
    return zero;
  }

  return {
    examinedSessionCount: source.examinedSessionCount ?? 0,
    includedSessionCount: source.includedSessionCount ?? 0,
    excludedSessionCount: source.excludedSessionCount ?? 0,
    durationSeconds: source.durationSeconds ?? 0,
    userMessageCount: source.userMessageCount ?? 0,
    assistantMessageCount: source.assistantMessageCount ?? 0,
    toolMessageCount: source.toolMessageCount ?? 0,
    interactiveTurnCount: source.interactiveTurnCount ?? 0,
    engagedSeconds: source.engagedSeconds ?? 0,
    llmCallCount: source.llmCallCount ?? 0,
    toolCallCount: source.toolCallCount ?? 0,
    baseUnits: source.baseUnits ?? 0,
    llmAddonUnits: source.llmAddonUnits ?? 0,
    toolAddonUnits: source.toolAddonUnits ?? 0,
    totalUnits: source.totalUnits ?? 0,
  };
}

function buildMetricsAccumulator() {
  return {
    examinedSessionCount: { $sum: 1 },
    includedSessionCount: {
      $sum: {
        $cond: ['$included', 1, 0],
      },
    },
    excludedSessionCount: {
      $sum: {
        $cond: ['$included', 0, 1],
      },
    },
    durationSeconds: { $sum: '$durationSeconds' },
    userMessageCount: { $sum: '$userMessageCount' },
    assistantMessageCount: { $sum: '$assistantMessageCount' },
    toolMessageCount: { $sum: '$toolMessageCount' },
    interactiveTurnCount: { $sum: '$interactiveTurnCount' },
    engagedSeconds: { $sum: '$engagedSeconds' },
    llmCallCount: { $sum: '$llmCallCount' },
    toolCallCount: { $sum: '$toolCallCount' },
    baseUnits: { $sum: '$baseUnits' },
    llmAddonUnits: { $sum: '$llmAddonUnits' },
    toolAddonUnits: { $sum: '$toolAddonUnits' },
    totalUnits: { $sum: '$totalUnits' },
  };
}

function truncateToGranularity(value: Date, granularity: BillingUsageReportGranularity): Date {
  const year = value.getUTCFullYear();
  const month = value.getUTCMonth();
  const day = value.getUTCDate();
  const hour = value.getUTCHours();

  switch (granularity) {
    case 'hour':
      return new Date(Date.UTC(year, month, day, hour, 0, 0, 0));
    case 'day':
      return new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
    case 'week': {
      const startOfDay = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
      const dayOfWeek = startOfDay.getUTCDay();
      const mondayOffset = (dayOfWeek + 6) % 7;
      return new Date(startOfDay.getTime() - mondayOffset * 24 * 60 * 60 * 1000);
    }
    case 'month':
      return new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  }
}

function addBucket(value: Date, granularity: BillingUsageReportGranularity, count = 1): Date {
  switch (granularity) {
    case 'hour':
      return new Date(value.getTime() + count * 60 * 60 * 1000);
    case 'day':
      return new Date(value.getTime() + count * 24 * 60 * 60 * 1000);
    case 'week':
      return new Date(value.getTime() + count * 7 * 24 * 60 * 60 * 1000);
    case 'month':
      return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + count, 1, 0, 0, 0, 0));
  }
}

function countBuckets(start: Date, end: Date, granularity: BillingUsageReportGranularity): number {
  let count = 0;
  let cursor = truncateToGranularity(start, granularity);
  while (cursor.getTime() < end.getTime()) {
    count += 1;
    cursor = addBucket(cursor, granularity);
  }
  return count;
}

function resolveWindow(input: ReportWindowInput): ResolvedReportWindow {
  const end = input.windowEnd ?? new Date();
  const start =
    input.windowStart ?? new Date(end.getTime() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  if (!(start instanceof Date) || Number.isNaN(start.getTime())) {
    throw new BillingUsageReportError(
      'INVALID_WINDOW_RANGE',
      'Billing usage report windowStart must be a valid date',
    );
  }

  if (!(end instanceof Date) || Number.isNaN(end.getTime())) {
    throw new BillingUsageReportError(
      'INVALID_WINDOW_RANGE',
      'Billing usage report windowEnd must be a valid date',
    );
  }

  if (start.getTime() >= end.getTime()) {
    throw new BillingUsageReportError(
      'INVALID_WINDOW_RANGE',
      'Billing usage report windowStart must be before windowEnd',
      {
        windowStart: start.toISOString(),
        windowEnd: end.toISOString(),
      },
    );
  }

  return { start, end };
}

function buildBucketExpression(granularity: BillingUsageReportGranularity) {
  return {
    $dateTrunc: {
      date: '$endedAt',
      unit: granularity,
      timezone: REPORT_TIMEZONE,
      ...(granularity === 'week' ? { startOfWeek: 'monday' } : {}),
    },
  };
}

function buildWindowsFromRows(
  rows: AggregatedMetrics[],
  window: ResolvedReportWindow,
  granularity: BillingUsageReportGranularity,
): BillingUsageReportWindowView[] {
  const windowMetricsByKey = new Map<string, BillingUsageReportMetricsView>();
  for (const row of rows) {
    if (!(row._id instanceof Date)) {
      continue;
    }
    windowMetricsByKey.set(row._id.toISOString(), cloneMetrics(row));
  }

  const windows: BillingUsageReportWindowView[] = [];
  let cursor = truncateToGranularity(window.start, granularity);
  while (cursor.getTime() < window.end.getTime()) {
    const next = addBucket(cursor, granularity);
    windows.push({
      windowStart: cursor.toISOString(),
      windowEnd: next.toISOString(),
      ...cloneMetrics(windowMetricsByKey.get(cursor.toISOString())),
    });
    cursor = next;
  }

  return windows;
}

async function loadTenantNameMap(tenantIds: string[]): Promise<Map<string, string>> {
  if (tenantIds.length === 0) {
    return new Map();
  }

  try {
    const { Tenant } = await import('@agent-platform/database/models');
    const rows = (await Tenant.find({ _id: { $in: tenantIds } }, { _id: 1, name: 1 })
      .lean()
      .exec()) as TenantNameRecord[];

    const tenantNameMap = new Map<string, string>();
    for (const row of rows) {
      if (row.name) {
        tenantNameMap.set(String(row._id), row.name);
      }
    }

    return tenantNameMap;
  } catch (error: unknown) {
    log.warn('Failed to enrich tenant names for platform billing usage report', {
      error: error instanceof Error ? error.message : String(error),
      tenantCount: tenantIds.length,
    });
    return new Map();
  }
}

export class BillingUsageReportService {
  async getUsageReport(input: GetBillingUsageReportInput): Promise<BillingUsageReportView> {
    const granularity = input.granularity ?? 'day';
    const window = resolveWindow(input);
    const bucketCount = countBuckets(window.start, window.end, granularity);
    const maxBuckets = MAX_BUCKETS_BY_GRANULARITY[granularity];

    if (bucketCount > maxBuckets) {
      throw new BillingUsageReportError(
        'WINDOW_TOO_LARGE',
        'Billing usage report range exceeds the supported bucket count',
        {
          granularity,
          bucketCount,
          maxBuckets,
        },
      );
    }

    const match: Record<string, unknown> = {
      tenantId: input.tenantId,
      endedAt: {
        $gte: window.start,
        $lt: window.end,
      },
    };

    if (input.projectId) {
      match.projectId = input.projectId;
    }

    const metricsAccumulator = buildMetricsAccumulator();
    const bucketExpression = buildBucketExpression(granularity);

    const [totalsRows, windowRows, projectRows, channelRows] = await Promise.all([
      BillingUsagePublishedSession.aggregate([
        { $match: match },
        { $group: { _id: null, ...metricsAccumulator } },
      ]),
      BillingUsagePublishedSession.aggregate([
        { $match: match },
        { $group: { _id: bucketExpression, ...metricsAccumulator } },
        { $sort: { _id: 1 } },
      ]),
      BillingUsagePublishedSession.aggregate([
        { $match: match },
        { $group: { _id: '$projectId', ...metricsAccumulator } },
        { $sort: { totalUnits: -1, examinedSessionCount: -1, _id: 1 } },
      ]),
      BillingUsagePublishedSession.aggregate([
        { $match: match },
        { $group: { _id: '$channel', ...metricsAccumulator } },
        { $sort: { totalUnits: -1, examinedSessionCount: -1, _id: 1 } },
      ]),
    ]);

    log.info('Generated billing usage report', {
      tenantId: input.tenantId,
      projectId: input.projectId ?? null,
      granularity,
      windowStart: window.start.toISOString(),
      windowEnd: window.end.toISOString(),
      bucketCount,
    });

    return {
      tenantId: input.tenantId,
      projectId: input.projectId ?? null,
      granularity,
      range: {
        windowStart: window.start.toISOString(),
        windowEnd: window.end.toISOString(),
        timeZone: 'UTC',
      },
      totals: cloneMetrics((totalsRows as AggregatedMetrics[])[0]),
      windows: buildWindowsFromRows(windowRows as AggregatedMetrics[], window, granularity),
      projectBreakdown: (projectRows as AggregatedMetrics[]).map((row) => ({
        projectId: String(row._id),
        ...cloneMetrics(row),
      })),
      channelBreakdown: (channelRows as AggregatedMetrics[]).map((row) => ({
        channel: String(row._id),
        ...cloneMetrics(row),
      })),
    };
  }

  async getPlatformUsageReport(
    input: GetPlatformBillingUsageReportInput,
  ): Promise<PlatformBillingUsageReportView> {
    const granularity = input.granularity ?? 'day';
    const window = resolveWindow(input);
    const bucketCount = countBuckets(window.start, window.end, granularity);
    const maxBuckets = MAX_BUCKETS_BY_GRANULARITY[granularity];

    if (bucketCount > maxBuckets) {
      throw new BillingUsageReportError(
        'WINDOW_TOO_LARGE',
        'Billing usage report range exceeds the supported bucket count',
        {
          granularity,
          bucketCount,
          maxBuckets,
        },
      );
    }

    const match: Record<string, unknown> = {
      endedAt: {
        $gte: window.start,
        $lt: window.end,
      },
    };

    const metricsAccumulator = buildMetricsAccumulator();
    const bucketExpression = buildBucketExpression(granularity);

    const [totalsRows, windowRows, tenantRows, projectRows, channelRows] = await Promise.all([
      BillingUsagePublishedSession.aggregate([
        { $match: match },
        { $group: { _id: null, ...metricsAccumulator } },
      ]),
      BillingUsagePublishedSession.aggregate([
        { $match: match },
        { $group: { _id: bucketExpression, ...metricsAccumulator } },
        { $sort: { _id: 1 } },
      ]),
      BillingUsagePublishedSession.aggregate([
        { $match: match },
        { $group: { _id: '$tenantId', ...metricsAccumulator } },
        { $sort: { totalUnits: -1, examinedSessionCount: -1, _id: 1 } },
      ]),
      BillingUsagePublishedSession.aggregate([
        { $match: match },
        { $group: { _id: '$projectId', ...metricsAccumulator } },
        { $sort: { totalUnits: -1, examinedSessionCount: -1, _id: 1 } },
      ]),
      BillingUsagePublishedSession.aggregate([
        { $match: match },
        { $group: { _id: '$channel', ...metricsAccumulator } },
        { $sort: { totalUnits: -1, examinedSessionCount: -1, _id: 1 } },
      ]),
    ]);

    const tenantBreakdownRows = tenantRows as AggregatedMetrics[];
    const tenantIds = tenantBreakdownRows.map((row) => String(row._id));
    const tenantNameMap = await loadTenantNameMap(tenantIds);

    log.info('Generated platform billing usage report', {
      granularity,
      windowStart: window.start.toISOString(),
      windowEnd: window.end.toISOString(),
      bucketCount,
      tenantCount: tenantBreakdownRows.length,
    });

    return {
      tenantId: null,
      projectId: null,
      granularity,
      range: {
        windowStart: window.start.toISOString(),
        windowEnd: window.end.toISOString(),
        timeZone: 'UTC',
      },
      totals: cloneMetrics((totalsRows as AggregatedMetrics[])[0]),
      windows: buildWindowsFromRows(windowRows as AggregatedMetrics[], window, granularity),
      tenantBreakdown: tenantBreakdownRows.map((row) => {
        const tenantId = String(row._id);
        return {
          tenantId,
          tenantName: tenantNameMap.get(tenantId) ?? tenantId,
          ...cloneMetrics(row),
        };
      }),
      projectBreakdown: (projectRows as AggregatedMetrics[]).map((row) => ({
        projectId: String(row._id),
        ...cloneMetrics(row),
      })),
      channelBreakdown: (channelRows as AggregatedMetrics[]).map((row) => ({
        channel: String(row._id),
        ...cloneMetrics(row),
      })),
    };
  }
}
