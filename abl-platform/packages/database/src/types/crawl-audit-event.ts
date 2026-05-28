export interface ICrawlAuditEvent {
  _id: string;
  tenantId: string;
  crawlJobId: string;
  userId?: string;
  eventType:
    | 'crawl.started'
    | 'crawl.paused'
    | 'crawl.resumed'
    | 'crawl.completed'
    | 'crawl.failed'
    | 'crawl.cancelled'
    | 'crawl.strategy_changed'
    | 'crawl.retry'
    | 'strategy.selected'
    | 'strategy.auto_applied'
    | 'strategy.user_overridden';
  description: string;
  changes?: {
    before?: Record<string, unknown>;
    after: Record<string, unknown>;
  };
  context: {
    strategy: string;
    urls: number;
    estimatedDocuments?: number;
    userAgent?: string;
    ipAddress?: string;
  };
  severity: 'info' | 'warning' | 'error';
  createdAt: Date;
  _v: number;
}
