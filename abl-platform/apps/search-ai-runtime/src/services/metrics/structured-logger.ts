/**
 * Structured Logger (RFC-003 Phase 2)
 *
 * Replaces console.log/error with structured logging:
 * - Correlation IDs for request tracing
 * - Consistent log format
 * - Log levels (debug, info, warn, error)
 * - Component tagging
 * - JSON output for log aggregation
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  correlationId?: string;
  metadata?: Record<string, any>;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

export interface LoggerOptions {
  /** Component name (e.g., 'QueryPipeline', 'RerankerFactory') */
  component: string;
  /** Minimum log level to output */
  minLevel?: LogLevel;
  /** Pretty print in development */
  pretty?: boolean;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class StructuredLogger {
  private readonly component: string;
  private readonly minLevel: number;
  private readonly pretty: boolean;

  constructor(options: LoggerOptions) {
    this.component = options.component;
    this.minLevel = LOG_LEVELS[options.minLevel ?? 'info'];
    this.pretty = options.pretty ?? process.env.NODE_ENV === 'development';
  }

  /**
   * Log debug message (verbose, development only).
   */
  debug(message: string, metadata?: Record<string, any>, correlationId?: string): void {
    this.log('debug', message, metadata, correlationId);
  }

  /**
   * Log info message (normal operations).
   */
  info(message: string, metadata?: Record<string, any>, correlationId?: string): void {
    this.log('info', message, metadata, correlationId);
  }

  /**
   * Log warning (non-fatal issues).
   */
  warn(message: string, metadata?: Record<string, any>, correlationId?: string): void {
    this.log('warn', message, metadata, correlationId);
  }

  /**
   * Log error (failures, exceptions).
   */
  error(
    message: string,
    error?: Error | unknown,
    metadata?: Record<string, any>,
    correlationId?: string,
  ): void {
    const errorData =
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            stack: error.stack,
          }
        : undefined;

    this.log('error', message, metadata, correlationId, errorData);
  }

  /**
   * Create a child logger with a correlation ID.
   */
  withCorrelationId(correlationId: string): CorrelatedLogger {
    return new CorrelatedLogger(this, correlationId);
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private log(
    level: LogLevel,
    message: string,
    metadata?: Record<string, any>,
    correlationId?: string,
    error?: LogEntry['error'],
  ): void {
    if (LOG_LEVELS[level] < this.minLevel) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component: this.component,
      message,
      correlationId,
      metadata,
      error,
    };

    this.output(entry);
  }

  private output(entry: LogEntry): void {
    if (this.pretty) {
      this.prettyPrint(entry);
    } else {
      console.log(JSON.stringify(entry));
    }
  }

  private prettyPrint(entry: LogEntry): void {
    const levelColors: Record<LogLevel, string> = {
      debug: '\x1b[90m', // Gray
      info: '\x1b[36m', // Cyan
      warn: '\x1b[33m', // Yellow
      error: '\x1b[31m', // Red
    };

    const reset = '\x1b[0m';
    const color = levelColors[entry.level];

    const time = new Date(entry.timestamp).toLocaleTimeString();
    const correlationId = entry.correlationId ? ` [${entry.correlationId.slice(0, 8)}]` : '';

    console.log(
      `${color}[${time}] ${entry.level.toUpperCase()}${reset} [${entry.component}]${correlationId} ${entry.message}`,
    );

    if (entry.metadata && Object.keys(entry.metadata).length > 0) {
      console.log(`  ${JSON.stringify(entry.metadata, null, 2)}`);
    }

    if (entry.error) {
      console.log(`  ${color}Error: ${entry.error.message}${reset}`);
      if (entry.error.stack) {
        console.log(`  ${entry.error.stack.split('\n').slice(1, 3).join('\n')}`);
      }
    }
  }
}

/**
 * Logger with baked-in correlation ID for request tracing.
 */
export class CorrelatedLogger {
  constructor(
    private readonly logger: StructuredLogger,
    private readonly correlationId: string,
  ) {}

  debug(message: string, metadata?: Record<string, any>): void {
    this.logger.debug(message, metadata, this.correlationId);
  }

  info(message: string, metadata?: Record<string, any>): void {
    this.logger.info(message, metadata, this.correlationId);
  }

  warn(message: string, metadata?: Record<string, any>): void {
    this.logger.warn(message, metadata, this.correlationId);
  }

  error(message: string, error?: Error | unknown, metadata?: Record<string, any>): void {
    this.logger.error(message, error, metadata, this.correlationId);
  }
}
