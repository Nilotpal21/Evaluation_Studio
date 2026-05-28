import type { PageContext } from '@agent-platform/arch-ai';

const TRACE_DIAGNOSIS_WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

const TRACE_DIAGNOSIS_CURRENT_SESSION_PATTERN =
  /\b(?:this|current|selected)\s+(?:session|trace|run)\b/i;
const TRACE_DIAGNOSIS_LAST_SESSION_PATTERN =
  /\b(?:my\s+)?(?:last|latest|most recent)\s+(?:session|trace|run)\b/i;
const TRACE_DIAGNOSIS_RECENT_SESSION_PATTERN = /\brecent\s+(?:sessions?|traces?|runs?)\b/i;
const TRACE_DIAGNOSIS_MINE_PATTERN =
  /\b(?:mine|my\s+(?:own\s+)?sessions?|my\s+(?:last|latest|recent)\s+(?:session|trace|run))\b/i;
const TRACE_DIAGNOSIS_GROUP_BY_ENVIRONMENT_PATTERN =
  /\b(?:by|per|across)\s+environments?\b|\bacross\s+envs?\b|\ball\s+environments?\b|\ball\s+envs?\b|\benvironment\s+breakdown\b/i;
const TRACE_DIAGNOSIS_COMPARE_ENVIRONMENT_PATTERN =
  /\b(?:compare|comparison|versus|vs\.?|against|between)\b/i;
const TRACE_DIAGNOSIS_ENVIRONMENT_ALIASES = [
  { canonical: 'production', aliases: ['production', 'prod'] },
  { canonical: 'staging', aliases: ['staging', 'stage', 'preprod', 'pre-production', 'uat', 'qa'] },
  { canonical: 'development', aliases: ['development', 'dev', 'local'] },
] as const;

export interface TraceDiagnosisInputShape {
  action: 'discover' | 'deep_dive' | 'aggregate' | 'compare' | 'errors' | 'explain';
  query?: string;
  sessionId?: string;
  compareWithSessionId?: string;
  compareWithTimeRange?: string;
  compareFrom?: string;
  compareTo?: string;
  environment?: string;
  compareWithEnvironment?: string;
  groupByEnvironment?: boolean;
  sessionRef?: string;
  agentName?: string;
  channel?: string;
  status?: string;
  disposition?: string;
  mine?: boolean;
  timeRange?: string;
  from?: string;
  to?: string;
  limit?: number;
  traceTypes?: string[];
  spanId?: string;
}

export interface ResolvedDiagnosisTimeRange {
  from: string;
  to: string;
  label: string;
  source: 'explicit' | 'relative';
}

export interface ResolvedTraceDiagnosisInput {
  action: TraceDiagnosisInputShape['action'];
  query?: string;
  sessionId?: string;
  compareWithSessionId?: string;
  environment?: string;
  compareWithEnvironment?: string;
  groupByEnvironment?: boolean;
  sessionSelector?: 'current' | 'last' | 'recent';
  agentName?: string;
  channel?: string;
  status?: string;
  disposition?: string;
  mine?: boolean;
  timeRange?: ResolvedDiagnosisTimeRange;
  compareTimeRange?: ResolvedDiagnosisTimeRange;
  limit: number;
  traceTypes: string[];
  spanId?: string;
  pageContextSessionId?: string;
}

function clampLimit(input: number | undefined): number {
  const DEFAULT_LIMIT = 20;
  const MAX_LIMIT = 100;

  if (typeof input !== 'number' || !Number.isFinite(input)) {
    return DEFAULT_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(input), 1), MAX_LIMIT);
}

function asValidDate(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

interface CalendarDateParts {
  year: number;
  month: number;
  day: number;
}

function isValidTimeZone(timeZone: string | undefined): timeZone is string {
  if (typeof timeZone !== 'string' || timeZone.trim().length === 0) {
    return false;
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function getZonedDateParts(date: Date, timeZone: string): ZonedDateParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const values: Partial<Record<keyof ZonedDateParts, number>> = {};

  for (const part of formatter.formatToParts(date)) {
    if (
      part.type === 'year' ||
      part.type === 'month' ||
      part.type === 'day' ||
      part.type === 'hour' ||
      part.type === 'minute' ||
      part.type === 'second'
    ) {
      values[part.type] = Number.parseInt(part.value, 10);
    }
  }

  return {
    year: values.year ?? date.getUTCFullYear(),
    month: values.month ?? date.getUTCMonth() + 1,
    day: values.day ?? date.getUTCDate(),
    hour: values.hour ?? date.getUTCHours(),
    minute: values.minute ?? date.getUTCMinutes(),
    second: values.second ?? date.getUTCSeconds(),
  };
}

function createCalendarDate(parts: CalendarDateParts): Date {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0));
}

function getCalendarDateParts(date: Date): CalendarDateParts {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function shiftCalendarDays(parts: CalendarDateParts, days: number): CalendarDateParts {
  const shifted = createCalendarDate(parts);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return getCalendarDateParts(shifted);
}

function shiftCalendarMonths(parts: CalendarDateParts, months: number): CalendarDateParts {
  const shifted = createCalendarDate(parts);
  shifted.setUTCMonth(shifted.getUTCMonth() + months);
  return getCalendarDateParts(shifted);
}

function zonedDateTimeToUtc(
  parts: CalendarDateParts & Pick<ZonedDateParts, 'hour' | 'minute' | 'second'>,
  timeZone: string,
): Date {
  let candidate = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0),
  );

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = getZonedDateParts(candidate, timeZone);
    const targetUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      0,
    );
    const actualUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
      0,
    );
    const deltaMs = targetUtc - actualUtc;

    if (deltaMs === 0) {
      return candidate;
    }

    candidate = new Date(candidate.getTime() + deltaMs);
  }

  return candidate;
}

function getTimeZoneAwareRelativeRange(
  label: 'today' | 'yesterday' | 'this week' | 'last week' | 'this month' | 'last month',
  now: Date,
  timeZone: string,
): ResolvedDiagnosisTimeRange {
  const nowParts = getZonedDateParts(now, timeZone);
  const currentDate = {
    year: nowParts.year,
    month: nowParts.month,
    day: nowParts.day,
  } satisfies CalendarDateParts;
  const currentDay = createCalendarDate(currentDate);
  const currentWeekday = currentDay.getUTCDay();
  const daysFromMonday = (currentWeekday + 6) % 7;
  const startOfCurrentDayUtc = zonedDateTimeToUtc(
    {
      ...currentDate,
      hour: 0,
      minute: 0,
      second: 0,
    },
    timeZone,
  );
  const startOfCurrentWeekDate = shiftCalendarDays(currentDate, -daysFromMonday);
  const startOfCurrentMonthDate = {
    year: currentDate.year,
    month: currentDate.month,
    day: 1,
  } satisfies CalendarDateParts;

  if (label === 'today') {
    return toIsoRange(startOfCurrentDayUtc, now, label, 'relative');
  }

  if (label === 'yesterday') {
    const startOfYesterdayDate = shiftCalendarDays(currentDate, -1);
    const startOfYesterdayUtc = zonedDateTimeToUtc(
      {
        ...startOfYesterdayDate,
        hour: 0,
        minute: 0,
        second: 0,
      },
      timeZone,
    );
    return toIsoRange(
      startOfYesterdayUtc,
      new Date(startOfCurrentDayUtc.getTime() - 1),
      label,
      'relative',
    );
  }

  if (label === 'this week') {
    const startOfWeekUtc = zonedDateTimeToUtc(
      {
        ...startOfCurrentWeekDate,
        hour: 0,
        minute: 0,
        second: 0,
      },
      timeZone,
    );
    return toIsoRange(startOfWeekUtc, now, label, 'relative');
  }

  if (label === 'last week') {
    const startOfCurrentWeekUtc = zonedDateTimeToUtc(
      {
        ...startOfCurrentWeekDate,
        hour: 0,
        minute: 0,
        second: 0,
      },
      timeZone,
    );
    const startOfLastWeekDate = shiftCalendarDays(startOfCurrentWeekDate, -7);
    const startOfLastWeekUtc = zonedDateTimeToUtc(
      {
        ...startOfLastWeekDate,
        hour: 0,
        minute: 0,
        second: 0,
      },
      timeZone,
    );
    return toIsoRange(
      startOfLastWeekUtc,
      new Date(startOfCurrentWeekUtc.getTime() - 1),
      label,
      'relative',
    );
  }

  if (label === 'this month') {
    const startOfMonthUtc = zonedDateTimeToUtc(
      {
        ...startOfCurrentMonthDate,
        hour: 0,
        minute: 0,
        second: 0,
      },
      timeZone,
    );
    return toIsoRange(startOfMonthUtc, now, label, 'relative');
  }

  const startOfCurrentMonthUtc = zonedDateTimeToUtc(
    {
      ...startOfCurrentMonthDate,
      hour: 0,
      minute: 0,
      second: 0,
    },
    timeZone,
  );
  const startOfLastMonthDate = shiftCalendarMonths(startOfCurrentMonthDate, -1);
  const startOfLastMonthUtc = zonedDateTimeToUtc(
    {
      ...startOfLastMonthDate,
      hour: 0,
      minute: 0,
      second: 0,
    },
    timeZone,
  );
  return toIsoRange(
    startOfLastMonthUtc,
    new Date(startOfCurrentMonthUtc.getTime() - 1),
    label,
    'relative',
  );
}

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function endOfDay(date: Date): Date {
  const copy = startOfDay(date);
  copy.setDate(copy.getDate() + 1);
  copy.setMilliseconds(copy.getMilliseconds() - 1);
  return copy;
}

function startOfWeek(date: Date): Date {
  const copy = startOfDay(date);
  const day = copy.getDay();
  const daysFromMonday = (day + 6) % 7;
  copy.setDate(copy.getDate() - daysFromMonday);
  return copy;
}

function endOfWeek(date: Date): Date {
  const copy = startOfWeek(date);
  copy.setDate(copy.getDate() + 7);
  copy.setMilliseconds(copy.getMilliseconds() - 1);
  return copy;
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0, 0);
}

function endOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
}

function toIsoRange(from: Date, to: Date, label: string, source: 'explicit' | 'relative') {
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    label,
    source,
  } satisfies ResolvedDiagnosisTimeRange;
}

function parseQuantity(token: string): number | null {
  const trimmed = token.trim().toLowerCase();
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }

  return TRACE_DIAGNOSIS_WORD_NUMBERS[trimmed] ?? null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeTraceDiagnosisEnvironment(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const normalized = trimmed.toLowerCase();
  for (const environment of TRACE_DIAGNOSIS_ENVIRONMENT_ALIASES) {
    if (environment.aliases.some((alias) => alias === normalized)) {
      return environment.canonical;
    }
  }

  return normalized;
}

function findEnvironmentMentions(text: string): string[] {
  const mentions: Array<{ environment: string; index: number }> = [];

  for (const environment of TRACE_DIAGNOSIS_ENVIRONMENT_ALIASES) {
    for (const alias of environment.aliases) {
      const pattern = new RegExp(`\\b${escapeRegex(alias)}\\b`, 'gi');
      for (const match of text.matchAll(pattern)) {
        if (typeof match.index === 'number') {
          mentions.push({ environment: environment.canonical, index: match.index });
        }
      }
    }
  }

  mentions.sort((left, right) => left.index - right.index);

  const orderedUnique: string[] = [];
  for (const mention of mentions) {
    if (!orderedUnique.includes(mention.environment)) {
      orderedUnique.push(mention.environment);
    }
  }

  return orderedUnique;
}

function parseRelativeQuantityWindow(
  text: string,
  now: Date,
): ResolvedDiagnosisTimeRange | undefined {
  const match = text.match(
    /\b(?:last|past)?\s*(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d+)\s*(hour|hours|hr|hrs|day|days|week|weeks|month|months|mo|mos|h|d|w)\b/i,
  );
  if (!match) {
    return undefined;
  }

  const quantity = parseQuantity(match[1] ?? '');
  if (!quantity || quantity < 1) {
    return undefined;
  }

  const unit = (match[2] ?? '').toLowerCase();
  const from = new Date(now);
  let labelUnit = quantity === 1 ? 'hour' : 'hours';

  if (unit === 'hour' || unit === 'hours' || unit === 'hr' || unit === 'hrs' || unit === 'h') {
    from.setHours(from.getHours() - quantity);
  } else if (unit === 'day' || unit === 'days' || unit === 'd') {
    from.setDate(from.getDate() - quantity);
    labelUnit = quantity === 1 ? 'day' : 'days';
  } else if (unit === 'week' || unit === 'weeks' || unit === 'w') {
    from.setDate(from.getDate() - quantity * 7);
    labelUnit = quantity === 1 ? 'week' : 'weeks';
  } else {
    from.setMonth(from.getMonth() - quantity);
    labelUnit = quantity === 1 ? 'month' : 'months';
  }

  return toIsoRange(from, now, `last ${quantity} ${labelUnit}`, 'relative');
}

export function parseDiagnosisTimeRange(
  input: Pick<TraceDiagnosisInputShape, 'from' | 'to' | 'timeRange' | 'query'>,
  now = new Date(),
  timeZone?: string,
): ResolvedDiagnosisTimeRange | undefined {
  const explicitFrom = asValidDate(input.from);
  const explicitTo = asValidDate(input.to);
  if (explicitFrom || explicitTo) {
    const to = explicitTo ?? now;
    const from = explicitFrom ?? new Date(to);
    return toIsoRange(from, to, 'explicit window', 'explicit');
  }

  const text = [input.timeRange, input.query].filter(Boolean).join(' ').trim().toLowerCase();
  if (!text) {
    return undefined;
  }
  const normalizedTimeZone = isValidTimeZone(timeZone) ? timeZone : undefined;

  if (text.includes('today')) {
    return normalizedTimeZone
      ? getTimeZoneAwareRelativeRange('today', now, normalizedTimeZone)
      : toIsoRange(startOfDay(now), now, 'today', 'relative');
  }

  if (text.includes('yesterday')) {
    if (normalizedTimeZone) {
      return getTimeZoneAwareRelativeRange('yesterday', now, normalizedTimeZone);
    }

    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    return toIsoRange(startOfDay(yesterday), endOfDay(yesterday), 'yesterday', 'relative');
  }

  if (text.includes('this week')) {
    return normalizedTimeZone
      ? getTimeZoneAwareRelativeRange('this week', now, normalizedTimeZone)
      : toIsoRange(startOfWeek(now), now, 'this week', 'relative');
  }

  if (text.includes('last week')) {
    if (normalizedTimeZone) {
      return getTimeZoneAwareRelativeRange('last week', now, normalizedTimeZone);
    }

    const previousWeek = new Date(now);
    previousWeek.setDate(previousWeek.getDate() - 7);
    return toIsoRange(startOfWeek(previousWeek), endOfWeek(previousWeek), 'last week', 'relative');
  }

  if (text.includes('this month')) {
    return normalizedTimeZone
      ? getTimeZoneAwareRelativeRange('this month', now, normalizedTimeZone)
      : toIsoRange(startOfMonth(now), now, 'this month', 'relative');
  }

  if (text.includes('last month')) {
    if (normalizedTimeZone) {
      return getTimeZoneAwareRelativeRange('last month', now, normalizedTimeZone);
    }

    const previousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return toIsoRange(
      startOfMonth(previousMonth),
      endOfMonth(previousMonth),
      'last month',
      'relative',
    );
  }

  return parseRelativeQuantityWindow(text, now);
}

function parseExplicitCompareTimeRange(
  input: Pick<TraceDiagnosisInputShape, 'compareFrom' | 'compareTo' | 'compareWithTimeRange'>,
  now: Date,
  timeZone?: string,
): ResolvedDiagnosisTimeRange | undefined {
  if (!input.compareFrom && !input.compareTo && !input.compareWithTimeRange) {
    return undefined;
  }

  return parseDiagnosisTimeRange(
    {
      from: input.compareFrom,
      to: input.compareTo,
      timeRange: input.compareWithTimeRange,
    },
    now,
    timeZone,
  );
}

function indexOfCalendarTerm(text: string, term: string): number {
  const match = new RegExp(`\\b${escapeRegex(term)}\\b`, 'i').exec(text);
  return match?.index ?? -1;
}

function parseCalendarRangeByLabel(
  label: 'today' | 'yesterday' | 'this week' | 'last week' | 'this month' | 'last month',
  now: Date,
  timeZone?: string,
): ResolvedDiagnosisTimeRange {
  return parseDiagnosisTimeRange({ timeRange: label }, now, timeZone)!;
}

function inferNaturalCompareTimeRanges(
  input: Pick<TraceDiagnosisInputShape, 'action' | 'query'>,
  now: Date,
  timeZone?: string,
): {
  primary?: ResolvedDiagnosisTimeRange;
  secondary?: ResolvedDiagnosisTimeRange;
} {
  if (input.action !== 'compare' || typeof input.query !== 'string') {
    return {};
  }

  const text = input.query.toLowerCase();
  const pairs = [
    ['today', 'yesterday'],
    ['this week', 'last week'],
    ['this month', 'last month'],
  ] as const;

  for (const [currentLabel, previousLabel] of pairs) {
    const currentIndex = indexOfCalendarTerm(text, currentLabel);
    const previousIndex = indexOfCalendarTerm(text, previousLabel);
    if (currentIndex < 0 || previousIndex < 0) {
      continue;
    }

    const currentRange = parseCalendarRangeByLabel(currentLabel, now, timeZone);
    const previousRange = parseCalendarRangeByLabel(previousLabel, now, timeZone);

    if (previousIndex < currentIndex) {
      return { primary: previousRange, secondary: currentRange };
    }

    return { primary: currentRange, secondary: previousRange };
  }

  return {};
}

function resolveCompareTimeRanges(
  input: TraceDiagnosisInputShape,
  now: Date,
  timeZone?: string,
): {
  primary?: ResolvedDiagnosisTimeRange;
  secondary?: ResolvedDiagnosisTimeRange;
} {
  const naturalRanges = inferNaturalCompareTimeRanges(input, now, timeZone);
  const explicitSecondary = parseExplicitCompareTimeRange(input, now, timeZone);
  const secondary = explicitSecondary ?? naturalRanges.secondary;

  return {
    ...(naturalRanges.primary ? { primary: naturalRanges.primary } : {}),
    ...(secondary ? { secondary } : {}),
  };
}

export function inferMineFilter(input: Pick<TraceDiagnosisInputShape, 'mine' | 'query'>): boolean {
  if (typeof input.mine === 'boolean') {
    return input.mine;
  }

  return typeof input.query === 'string' ? TRACE_DIAGNOSIS_MINE_PATTERN.test(input.query) : false;
}

function inferEnvironmentSelection(
  input: Pick<
    TraceDiagnosisInputShape,
    'action' | 'query' | 'environment' | 'compareWithEnvironment' | 'groupByEnvironment'
  >,
): {
  environment?: string;
  compareWithEnvironment?: string;
  groupByEnvironment?: boolean;
} {
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  const mentionedEnvironments = query.length > 0 ? findEnvironmentMentions(query) : [];
  const explicitEnvironment = normalizeTraceDiagnosisEnvironment(input.environment);
  const explicitCompareEnvironment = normalizeTraceDiagnosisEnvironment(
    input.compareWithEnvironment,
  );
  const comparisonRequested =
    explicitCompareEnvironment !== undefined ||
    input.action === 'compare' ||
    (query.length > 0 && TRACE_DIAGNOSIS_COMPARE_ENVIRONMENT_PATTERN.test(query));
  let groupByEnvironment =
    input.groupByEnvironment === true ||
    (query.length > 0 && TRACE_DIAGNOSIS_GROUP_BY_ENVIRONMENT_PATTERN.test(query));
  let environment = explicitEnvironment;
  let compareWithEnvironment = explicitCompareEnvironment;

  if (!environment && mentionedEnvironments.length === 1) {
    environment = mentionedEnvironments[0];
  }

  if (comparisonRequested) {
    const primaryEnvironment =
      environment ??
      mentionedEnvironments.find((candidate) => candidate !== compareWithEnvironment);
    const secondaryEnvironment =
      compareWithEnvironment ??
      mentionedEnvironments.find((candidate) => candidate !== primaryEnvironment);

    environment = primaryEnvironment;
    compareWithEnvironment = secondaryEnvironment;
  } else if (!explicitEnvironment && mentionedEnvironments.length > 1) {
    groupByEnvironment = true;
    environment = undefined;
  }

  return {
    ...(environment ? { environment } : {}),
    ...(compareWithEnvironment ? { compareWithEnvironment } : {}),
    ...(groupByEnvironment ? { groupByEnvironment: true } : {}),
  };
}

export function inferSessionSelector(params: {
  action: TraceDiagnosisInputShape['action'];
  query?: string;
  sessionRef?: string;
  pageContext?: PageContext | null;
  sessionId?: string;
}): { sessionSelector?: 'current' | 'last' | 'recent'; pageContextSessionId?: string } {
  const pageContextSessionId =
    params.pageContext?.entity?.type === 'session' ? params.pageContext.entity.id : undefined;
  if (params.sessionId) {
    return { pageContextSessionId };
  }

  const combinedText = [params.sessionRef, params.query].filter(Boolean).join(' ').trim();
  if (TRACE_DIAGNOSIS_CURRENT_SESSION_PATTERN.test(combinedText)) {
    return {
      sessionSelector: 'current',
      pageContextSessionId,
    };
  }

  if (TRACE_DIAGNOSIS_LAST_SESSION_PATTERN.test(combinedText)) {
    return {
      sessionSelector: 'last',
      pageContextSessionId,
    };
  }

  if (TRACE_DIAGNOSIS_RECENT_SESSION_PATTERN.test(combinedText)) {
    return {
      sessionSelector: 'recent',
      pageContextSessionId,
    };
  }

  if (
    pageContextSessionId &&
    (params.action === 'deep_dive' || params.action === 'explain') &&
    combinedText.length === 0
  ) {
    return {
      sessionSelector: 'current',
      pageContextSessionId,
    };
  }

  return { pageContextSessionId };
}

export function resolveTraceDiagnosisInput(
  input: TraceDiagnosisInputShape,
  pageContext?: PageContext | null,
  now = new Date(),
): ResolvedTraceDiagnosisInput {
  const sessionResolution = inferSessionSelector({
    action: input.action,
    query: input.query,
    sessionRef: input.sessionRef,
    pageContext,
    sessionId: input.sessionId,
  });
  const pageAgentName =
    pageContext?.entity?.type === 'agent'
      ? (pageContext.entity.name ?? pageContext.entity.id)
      : undefined;
  const compareTimeRanges = resolveCompareTimeRanges(input, now, pageContext?.timeZone);
  const resolvedTimeRange =
    compareTimeRanges.primary ?? parseDiagnosisTimeRange(input, now, pageContext?.timeZone);
  const resolvedEnvironment = inferEnvironmentSelection(input);

  return {
    action: input.action,
    ...(typeof input.query === 'string' && input.query.trim().length > 0
      ? { query: input.query.trim() }
      : {}),
    ...(typeof input.sessionId === 'string' && input.sessionId.trim().length > 0
      ? { sessionId: input.sessionId.trim() }
      : {}),
    ...(typeof input.compareWithSessionId === 'string' &&
    input.compareWithSessionId.trim().length > 0
      ? { compareWithSessionId: input.compareWithSessionId.trim() }
      : {}),
    ...(resolvedEnvironment.environment ? { environment: resolvedEnvironment.environment } : {}),
    ...(resolvedEnvironment.compareWithEnvironment
      ? { compareWithEnvironment: resolvedEnvironment.compareWithEnvironment }
      : {}),
    ...(resolvedEnvironment.groupByEnvironment ? { groupByEnvironment: true } : {}),
    ...(sessionResolution.sessionSelector
      ? { sessionSelector: sessionResolution.sessionSelector }
      : {}),
    ...(sessionResolution.pageContextSessionId
      ? { pageContextSessionId: sessionResolution.pageContextSessionId }
      : {}),
    ...(typeof input.agentName === 'string' && input.agentName.trim().length > 0
      ? { agentName: input.agentName.trim() }
      : pageAgentName
        ? { agentName: pageAgentName }
        : {}),
    ...(typeof input.channel === 'string' && input.channel.trim().length > 0
      ? { channel: input.channel.trim() }
      : {}),
    ...(typeof input.status === 'string' && input.status.trim().length > 0
      ? { status: input.status.trim() }
      : {}),
    ...(typeof input.disposition === 'string' && input.disposition.trim().length > 0
      ? { disposition: input.disposition.trim() }
      : {}),
    ...(inferMineFilter(input) ? { mine: true } : {}),
    ...(resolvedTimeRange ? { timeRange: resolvedTimeRange } : {}),
    ...(compareTimeRanges.secondary ? { compareTimeRange: compareTimeRanges.secondary } : {}),
    limit: clampLimit(input.limit),
    traceTypes: Array.isArray(input.traceTypes)
      ? input.traceTypes.filter((value): value is string => typeof value === 'string')
      : [],
    ...(typeof input.spanId === 'string' && input.spanId.trim().length > 0
      ? { spanId: input.spanId.trim() }
      : {}),
  };
}
