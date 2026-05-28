/**
 * SearchAI Server Entry Point
 */

// Load environment variables from .env file
import 'dotenv/config';

import { loadConfig } from './config/index.js';

// ─── Global Error Handlers ──────────────────────────────────────────────────
// BullMQ's RedisConnection emits 'error' when Redis drops the connection.
// Without these handlers Node treats them as unhandled and crashes the process.
// The workers/queues will reconnect automatically via ioredis retry strategy.
process.on('uncaughtException', (err) => {
  // Redis connection-closed errors are transient — ioredis reconnects automatically.
  // Log and continue instead of crashing the entire server.
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('Connection is closed') || msg.includes('ECONNREFUSED')) {
    console.error(`[search-ai] Redis connection error (will auto-reconnect): ${msg}`);
    return;
  }
  console.error('[search-ai] Uncaught exception:', err);
  // For truly fatal errors, still exit
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  if (msg.includes('Connection is closed') || msg.includes('ECONNREFUSED')) {
    console.error(`[search-ai] Redis rejection (will auto-reconnect): ${msg}`);
    return;
  }
  console.error('[search-ai] Unhandled rejection:', reason);
});

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
    console.error('Failed to start search-ai server:', error);
    process.exit(1);
  }
}

main();

// Note: Graceful shutdown (server.close, worker stop, DB disconnect) is
// handled by signal handlers registered in server.ts. Do NOT register
// competing handlers here that call process.exit() — they race against
// the server shutdown and prevent the port from being released cleanly.
