/**
 * Search Runtime Server Entry Point
 */

// Load environment variables from .env file
import 'dotenv/config';

// Catch unhandled ioredis NOAUTH errors that crash the process.
// Some ioredis connections emit 'error' events before our .on('error')
// handlers are registered. This prevents the process from crashing.
process.on('uncaughtException', (err) => {
  if (err.message?.includes('NOAUTH')) {
    // Suppress — Redis auth errors are non-fatal for the query pipeline
    return;
  }
  console.error('[search-ai-runtime] Uncaught exception:', err);
  process.exit(1);
});

import { loadConfig } from './config/index.js';

async function main(): Promise<void> {
  try {
    await loadConfig({
      vaultType: 'env',
      throwOnError: true,
      logSummary: true,
    });

    const { startServer } = await import('./server.js');
    await startServer();
  } catch (error) {
    console.error('Failed to start search-ai-runtime server:', error);
    process.exit(1);
  }
}

main();

// Note: Graceful shutdown handled by signal handlers in server.ts
