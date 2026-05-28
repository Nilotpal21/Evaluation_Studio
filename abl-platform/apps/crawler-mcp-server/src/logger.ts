export interface Logger {
  error(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function writeLog(
  level: LogLevel,
  module: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  const entry = {
    level,
    module,
    message,
    timestamp: new Date().toISOString(),
    ...(data ? { data } : {}),
  };

  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

export function createLogger(module: string): Logger {
  return {
    error(message: string, data?: Record<string, unknown>) {
      writeLog('error', module, message, data);
    },
    warn(message: string, data?: Record<string, unknown>) {
      writeLog('warn', module, message, data);
    },
    info(message: string, data?: Record<string, unknown>) {
      writeLog('info', module, message, data);
    },
    debug(message: string, data?: Record<string, unknown>) {
      writeLog('debug', module, message, data);
    },
  };
}
